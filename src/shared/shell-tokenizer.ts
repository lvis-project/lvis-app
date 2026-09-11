/**
 * Shell Tokenizer — the single source of truth for splitting a shell command
 * string into leaf commands, quote/subshell/redirect aware.
 *
 * WHY this exists: two independent modules used to disagree about what a "leaf"
 * of a compound command is. {@link isReadOnlyCommand} in
 * `src/permissions/reviewer/host-risk-inspector.ts` split on `\s+` after a naive
 * char-class guard, so a quoted argument containing whitespace
 * (`grep "a b" .`) was mis-tokenized, and a read-only head verb carrying a
 * MUTATING flag (`sed -i`, `find -delete`) slipped through as `read`. Meanwhile
 * `src/main/bash-ast-validator.ts` matched raw regexes with yet another notion
 * of a boundary. Divergent leaf definitions are a classic read-down hole. This
 * module gives both callers ONE parse so the boundary is identical.
 *
 * Scope discipline: this is a PURPOSE-BUILT tokenizer for host-side risk
 * classification, NOT a full POSIX shell parser. It recognises exactly the
 * constructs a risk classifier must reason about — quoting, command/process
 * substitution, redirects, compound separators, wrapper commands and leading
 * assignments — and it fails CLOSED (`parseError: true`) on anything it cannot
 * balance, so callers escalate rather than guess. Keeping the grammar small is
 * itself a security property: less parser surface, fewer differential bugs.
 */

/** Commands that delegate to a real command in a later operand. Stripped to
 * reach the effective verb. The first operand that is not itself a wrapper or a
 * wrapper option/duration is the real verb. */
const WRAPPER_COMMANDS: ReadonlySet<string> = new Set([
  "timeout", "nice", "ionice", "nohup", "stdbuf", "env", "command", "xargs",
  "time", "watch",
]);

/** A single parsed leaf of a compound command. */
export interface ShellLeaf {
  /**
   * The leaf's argument vector AFTER wrapper-strip and leading-assignment strip.
   * `argv[0]` is the effective head verb (basename-reduced by the caller if it
   * wants path-independence). Empty when the leaf was only assignments/wrappers.
   */
  argv: string[];
  /** Targets of output redirects (`>`, `>>`, `>|`, `2>`, `&>`, `n>`). Input
   * redirects (`<`, `<<`) are NOT collected here — they are reads, not writes.
   * Note: fd-duplication operators (`>&m`, `n>&m`) are output redirects but
   * have no file target — they do NOT appear here, but they DO set
   * {@link hasOutputRedirect}. */
  redirectTargets: string[];
  /**
   * True when the leaf contained any output redirect operator (`>`, `>>`, `>|`,
   * `2>`, `&>`, `n>`, `>&m`, `n>&m`). Callers that want to fail closed on ALL
   * output redirection (including fd-dup) should check this flag rather than
   * `redirectTargets.length > 0`, because fd-dup operators have no file target.
   */
  hasOutputRedirect: boolean;
  /** True when the leaf contained an input redirect (`<`, `<<`). These do not
   * write, but they reach a file the argv-path check cannot see, so a
   * default-strict caller may still choose to treat the leaf as non-read. */
  hasInputRedirect: boolean;
  /**
   * Sources named by input redirects (`< file`). Reported for the same reason
   * {@link redirectTargets} is: a containment check has to see every file the
   * leaf reaches, and `tr -d x < ~/.ssh/id_rsa` names that file nowhere else.
   * The source word was previously consumed and discarded, which left a flat
   * whole-command scan as the only layer able to see it.
   *
   * A heredoc's delimiter word is NOT collected — it names no file.
   */
  inputRedirectTargets: string[];
  /** True when the leaf contained `$(...)` or backtick command substitution. */
  hasCommandSubstitution: boolean;
  /** True when the leaf contained `<(...)` or `>(...)` process substitution. */
  hasProcessSubstitution: boolean;
  /**
   * Parallel to {@link argv}: whether that argument carries a `$` the shell
   * will actually expand.
   *
   * A caller that fails closed on `$` does so because expansion happens AFTER
   * this tokenizer runs, so `sed $IFS-i f` can split into a `-i` the flag scan
   * never saw. That reasoning does not apply to a `$` inside `'...'`, where no
   * expansion occurs at all — `rg 'foo$'` is a regex anchor. Double quotes DO
   * count: they suppress word splitting but not expansion, and an expanded
   * value can be a flag in its entirety (`rg "$FLAG" p`).
   */
  argvHasExpandableDollar: boolean[];
  /**
   * Basenames of the wrapper commands (`timeout`, `env`, …) stripped from the
   * front of this leaf, in order. Lets a caller recover the verb of a bare
   * wrapper (`env` alone → prints the environment) when `argv` is empty.
   */
  strippedWrappers: string[];
  /**
   * The leading `NAME=value` assignments stripped from the front of the leaf,
   * in source order, INCLUDING the ones consumed as `env`/`command` operands.
   *
   * Stripping them is what exposes the effective verb, but an assignment is not
   * inert: `LESSOPEN='|/bin/sh %s' less f` and `GIT_EXTERNAL_DIFF=/bin/sh git
   * diff` both run a shell that the verb scan never sees. A classifier that
   * discards the assignments cannot notice. They are reported here so the
   * caller decides, rather than being silently dropped.
   */
  assignments: string[];
  /** The raw text of the leaf, trimmed, before any stripping. */
  raw: string;
}

/** Result of {@link tokenizeShell}. `parseError` is true on unbalanced quotes
 * or parentheses so callers can fail closed. */
export interface TokenizeResult {
  leaves: ShellLeaf[];
  parseError: boolean;
}

interface ShellSource {
  text: string;
  original: string;
  offsets?: number[];
}

/**
 * Remove escaped newlines before recognizing words or operators. The source
 * map keeps a leaf's raw text tied to the input the caller will execute.
 * Quoted heredoc bodies, single quotes and comments retain their bytes.
 */
function shellContinuationSource(command: string): ShellSource | null {
  if (!command.includes("\\\n")) return { text: command, original: command };
  const offsets: number[] = [];
  let text = "";
  const append = (start: number, end: number): void => {
    text += command.slice(start, end);
    for (let index = start; index < end; index += 1) offsets.push(index);
  };
  const nextLogicalIndex = (index: number): number => {
    while (command[index] === "\\" && command[index + 1] === "\n") index += 2;
    return index;
  };
  type Context = { quote: "'" | '"' | null; close?: ")" | "`"; depth: number; heredocs: number[]; wordActive: boolean };
  const contexts: Context[] = [{ quote: null, depth: 0, heredocs: [], wordActive: false }];
  let i = 0;
  while (i < command.length) {
    const context = contexts.at(-1)!;
    const ch = command[i]!;
    if (context.quote === "'") {
      append(i, i + 1);
      if (ch === "'") context.quote = null;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      if (command[i + 1] === "\n") i += 2;
      else {
        append(i, Math.min(i + 2, command.length));
        context.wordActive = true;
        i += 2;
      }
      continue;
    }
    if (ch === '"') {
      context.quote = context.quote === '"' ? null : '"';
      context.wordActive = true;
      append(i, i + 1);
      i += 1;
      continue;
    }
    if (ch === "'" && context.quote === null) {
      context.quote = "'";
      context.wordActive = true;
      append(i, i + 1);
      i += 1;
      continue;
    }
    const next = nextLogicalIndex(i + 1);
    if ((ch === "$" || (context.quote === null && (ch === "<" || ch === ">")))
      && command[next] === "(") {
      append(i, i + 1);
      append(next, next + 1);
      context.wordActive = true;
      contexts.push({ quote: null, close: ")", depth: 1, heredocs: [], wordActive: false });
      i = next + 1;
      continue;
    }
    if (ch === "`") {
      if (context.close === "`" && context.quote === null) contexts.pop();
      else {
        context.wordActive = true;
        contexts.push({ quote: null, close: "`", depth: 0, heredocs: [], wordActive: false });
      }
      append(i, i + 1);
      i += 1;
      continue;
    }
    if (context.quote === null) {
      if (ch === "#" && !context.wordActive && startsShellComment(text + "#", text.length)) {
        const newline = command.indexOf("\n", i);
        const end = newline === -1 ? command.length : newline;
        append(i, end);
        i = end;
        continue;
      }
      if (context.close === ")") {
        if (ch === "(") context.depth += 1;
        if (ch === ")" && --context.depth === 0) contexts.pop();
      }
      if (ch === "<" && command[next] === "<" && text.at(-1) !== "<") {
        const after = nextLogicalIndex(next + 1);
        if (command[after] !== "<") context.heredocs.push(text.length);
      }
      if (ch === "\n" && context.heredocs.length > 0) {
        context.wordActive = false;
        append(i, i + 1);
        i += 1;
        for (const start of context.heredocs) {
          const opened = readHeredocDelimiter(text, start);
          const end = opened ? findHeredocTerminator(command, i, opened) : null;
          // An unknown body boundary cannot leave a partly normalized command:
          // later continued words could then hide their actual file operands.
          if (end === null) return null;
          // Expandable bodies join physical lines before looking for the
          // terminator. Quotes and comment markers in the body are data and
          // must not change that rule, even inside a substitution's text.
          if (opened!.quoted) append(i, end);
          else {
            let chunkStart = i;
            while (i < end) {
              if (command[i] === "\\") {
                if (command[i + 1] === "\n") {
                  append(chunkStart, i);
                  chunkStart = i + 2;
                }
                i += 2;
              } else i += 1;
            }
            append(chunkStart, end);
          }
          i = end;
        }
        context.heredocs.length = 0;
        continue;
      }
      context.wordActive = !/[ \t\r\n;&|<>()]/.test(ch);
    }
    append(i, i + 1);
    i += 1;
  }
  offsets.push(command.length);
  return { text, original: command, offsets };
}

/**
 * Shared logical-line view for policy scanners; execution keeps the original.
 * Null means a heredoc boundary prevents complete continuation analysis.
 */
export function normalizeShellLineContinuations(command: string): string | null {
  return shellContinuationSource(command)?.text ?? null;
}

interface RawWord {
  /** The word's textual value with quotes removed but content preserved. */
  value: string;
  /** True when this word is a redirect operator token (`>`, `2>`, `<`, …). */
  isRedirectOperator: boolean;
  /** For a redirect operator, whether it is an OUTPUT redirect (writes a
   * target). Input redirects (`<`, `<<`) are false. */
  isOutputRedirect: boolean;
  hasCommandSubstitution: boolean;
  hasProcessSubstitution: boolean;
  /** See {@link ShellLeaf.argvWithExpandableDollar}. */
  hasExpandableDollar: boolean;
}

interface RawLeaf {
  words: RawWord[];
  raw: string;
}

/**
 * Tokenize a shell command into leaf commands.
 *
 * Recognised grammar:
 *  - `'...'` single quotes: literal, whitespace inside is NOT a separator.
 *  - `"..."` double quotes: whitespace inside is NOT a separator; `$(...)` and
 *    backticks inside still count as command substitution.
 *  - `$(...)` / backtick: command substitution (`hasCommandSubstitution`).
 *  - `<(...)` / `>(...)`: process substitution (`hasProcessSubstitution`).
 *  - redirects `>`, `>>`, `>|`, `2>`, `&>`, `n>`: the following word is an output
 *    redirect target. `<`, `<<` are reads, recorded as operators but not targets.
 *  - compound separators `|`, `&&`, `||`, `;`, `&`, newline: leaf boundaries
 *    (only outside quotes/substitution).
 *  - leading `FOO=bar` assignments and wrapper commands are stripped from each
 *    leaf's argv to expose the effective verb.
 *  - `<<'WORD'` / `<<"WORD"` heredoc bodies are removed before scanning (see
 *    {@link redactHeredocBodies}); they are data on the consumer's stdin, not
 *    commands.
 *
 * Fails closed (`parseError: true`) on unbalanced quotes or parentheses.
 * `heredocBodies: "preserve"` retains stdin text for structural guards.
 * `literalDataProof` additionally rejects unresolved heredocs, here-strings,
 * unquoted escapes, and unbalanced ordinary grouping before relaxing a deny.
 * `simpleCommandList` implies literal proof and accepts only complete direct
 * commands connected by `;`, newline, `&&` or `||`. Pipes, background execution
 * and unquoted groups need a consumer relationship this proof does not model.
 */
export function tokenizeShell(
  command: string,
  options: { heredocBodies?: "redact" | "preserve"; literalDataProof?: boolean; simpleCommandList?: boolean } = {},
): TokenizeResult {
  // Structural guards can retain stdin text conservatively: a shell consumer
  // may execute it. Default risk/path callers continue to omit those bodies.
  const logical = shellContinuationSource(command);
  if (logical === null) return { leaves: [], parseError: true };
  const literalDataProof = options.literalDataProof || options.simpleCommandList;
  const removed: Array<{ start: number; end: number }> = [];
  const redacted = redactHeredocCommand(logical.text, literalDataProof ?? false, (start, end) => {
    removed.push({ start, end });
  });
  if (redacted === null) return { leaves: [], parseError: true };
  const scanSource = options.heredocBodies === "preserve" || redacted === logical.text
    ? logical
    : redactShellSource(logical, redacted, removed);
  const scan = scanLeaves(
    options.heredocBodies === "preserve" ? logical.text : redacted,
    literalDataProof,
    scanSource,
    options.simpleCommandList,
  );
  if (scan.parseError) {
    return { leaves: [], parseError: true };
  }
  const leaves: ShellLeaf[] = [];
  for (const rawLeaf of scan.leaves) {
    for (let i = 0; i < rawLeaf.words.length; i += 1) {
      const word = rawLeaf.words[i]!;
      if (!word.isRedirectOperator || isCompleteDescriptorRedirect(word.value)) continue;
      const target = rawLeaf.words[++i];
      // An explicitly quoted empty word is present; an operator is not a target.
      if (!target || target.isRedirectOperator) return { leaves: [], parseError: true };
    }
    leaves.push(buildLeaf(rawLeaf));
  }
  return { leaves, parseError: false };
}

function redactShellSource(
  source: ShellSource,
  text: string,
  removed: readonly { start: number; end: number }[],
): ShellSource {
  const offsets: number[] = [];
  let rangeIndex = 0;
  for (let index = 0; index < source.text.length; index += 1) {
    const range = removed[rangeIndex];
    if (range && index === range.start) {
      index = range.end - 1;
      rangeIndex += 1;
      continue;
    }
    offsets.push(source.offsets?.[index] ?? index);
  }
  offsets.push(source.original.length);
  return { text, original: source.original, offsets };
}

/**
 * Remove the BODY of every quoted-delimiter heredoc (`<<'EOF'` / `<<"EOF"`,
 * and the tab-stripping `<<-` forms) from a command string.
 *
 * WHY: the scanner ends a leaf at every newline, so without this a heredoc body
 * became a run of pseudo-leaves whose first word was read as a head verb. A
 * Python snippet fed to `python3 - <<'EOF'` was therefore classified as a
 * sequence of shell commands, and its text was mined for path operands — which
 * is where `nstep = int(2.0 / model.opt.timestep)` produced a filesystem-root
 * operand and a JavaScript `//` comment produced another. A heredoc body is
 * stdin data for the consuming command, and the PARSING shell never executes it
 * as part of this command line.
 *
 * It is NOT inert, though, and the distinction matters: `bash <<'EOF'` hands
 * the body to a shell that does run every line of it. What contains that is
 * named under WHAT DEPENDS ON THIS below — not any claim that the text is
 * harmless.
 *
 * QUOTED DELIMITERS ONLY. With an unquoted delimiter (`<<EOF`) the shell still
 * performs parameter expansion and command substitution inside the body, so a
 * `$(…)` there really does execute and the body must keep being scanned. Those
 * are left exactly as they were.
 *
 * By default every failure returns the input unchanged — an unbalanced
 * quote, a heredoc whose terminator never arrives — so a command this cannot
 * read confidently keeps the behaviour it had before. The opt-in
 * `literalDataProof` mode returns null instead and rejects unsupported forms.
 *
 * Terminators must match the whole line; only `<<-` strips leading tabs.
 *
 * NOT a relaxation of the read/write classifier: `<<` is an input redirect, and
 * {@link ShellLeaf.hasInputRedirect} on the consuming leaf already makes the
 * whole command non-read regardless of what the body says.
 *
 * WHAT DEPENDS ON THIS. This runs inside {@link tokenizeShell}, so
 * BOTH of the tokenizer's callers stop seeing heredoc bodies: the leaf guard in
 * `src/main/bash-ast-validator.ts` and the read verdict in
 * `src/permissions/reviewer/host-risk-inspector.ts`. Neither loses coverage
 * today — the AST validator also matches its dangerous-command patterns against
 * the RAW command string, which still contains the body (`sh <<'EOF'` carrying
 * `rm -rf /` is refused by the raw-string layer, not the leaf guard), and the
 * read verdict fails closed on `hasInputRedirect` before it ever looks at what
 * the body says. Both of those are load-bearing for this redaction being safe.
 * A structural rule that narrows its raw-string match must request
 * `heredocBodies: "preserve"`, as the eval guard does, so its inspection still
 * receives the body. Default read classification keeps the redirect guard.
 *
 * A `#` comment is honoured, and that is a security property rather than a
 * nicety: a `<<'X'` written inside a comment opens no heredoc in bash, so
 * treating it as one would erase every following line up to `X` from the scan
 * while the shell went on running those lines.
 */
export function redactHeredocBodies(command: string): string;
export function redactHeredocBodies(command: string, literalDataProof: boolean): string | null;
export function redactHeredocBodies(command: string, literalDataProof = false): string | null {
  return redactHeredocCommand(command, literalDataProof);
}

function redactHeredocCommand(
  command: string,
  literalDataProof: boolean,
  onRemoved?: (start: number, end: number) => void,
  dataInspection?: { omitExpandableBody: (body: string) => boolean; onUnresolved: () => void },
): string | null {
  if (!command.includes("<<")) return command;
  const n = command.length;
  // Delimiters opened on the current line, in the order their bodies follow it.
  const pending: HeredocDelimiter[] = [];
  let out = "";
  let i = 0;
  while (i < n) {
    const ch = command[i]!;
    if (ch === "\\" && i + 1 < n) {
      out += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return literalDataProof ? null : command;
      out += command.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      const res = consumeDoubleQuote(command, i);
      if (res === null) return literalDataProof ? null : command;
      out += command.slice(i, res.next);
      i = res.next;
      continue;
    }
    if (ch === "`") {
      const close = command.indexOf("`", i + 1);
      if (close === -1) return literalDataProof ? null : command;
      out += command.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    // A `#` that starts a word begins a comment that runs to end of line. The
    // preceding-character test is what separates it from a `#` INSIDE a word,
    // where it is ordinary text — `curl http://example.test/x#frag` is one
    // argument, not a comment. The newline is left for the loop below, so a
    // heredoc opened earlier on this line still gets its body consumed.
    if (ch === "#" && startsShellComment(command, i)) {
      const newline = command.indexOf("\n", i);
      const end = newline === -1 ? n : newline;
      out += command.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "<" && command.slice(i, i + 3) === "<<<") {
      if (literalDataProof) return null;
      // The last two characters must not become a new heredoc opener on the
      // next iteration: a here-string has no following body to remove.
      out += "<<<";
      i += 3;
      continue;
    }
    // `<<` heredoc, but NOT `<<<` (a here-STRING, whose operand is one word on
    // the same line and therefore has no body to remove).
    if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      const opened = readHeredocDelimiter(command, i);
      if (opened && (!literalDataProof || opened.quoted)) {
        pending.push(opened);
        out += command.slice(i, opened.next);
        i = opened.next;
        continue;
      }
      if (literalDataProof) return null;
      dataInspection?.onUnresolved();
      out += "<<";
      i += 2;
      continue;
    }
    if (ch === "\n" && pending.length > 0) {
      out += "\n";
      i += 1;
      for (const delimiter of pending) {
        const bodyEnd = findHeredocTerminator(command, i, delimiter);
        if (bodyEnd === null) {
          // EOF still supplies an unquoted heredoc's body to the shell, which
          // performs its expansions despite warning about the missing marker.
          if (!delimiter.quoted) dataInspection?.omitExpandableBody(command.slice(i));
          return literalDataProof ? null : command;
        }
        if (delimiter.quoted || dataInspection?.omitExpandableBody(command.slice(i, bodyEnd))) onRemoved?.(i, bodyEnd);
        else out += command.slice(i, bodyEnd);
        i = bodyEnd;
      }
      pending.length = 0;
      continue;
    }
    out += ch;
    i += 1;
  }
  if (literalDataProof && pending.length > 0) return null;
  return out;
}

/**
 * Path analysis may omit an unquoted body only after proving that no expansion
 * occurs and the whole command proves an independent data consumer. Bodies with
 * expansions remain in the conservative scan, and their
 * executable substitutions are also returned independently: quotes and `#`
 * inside heredoc data cannot conceal those commands as shell text operands.
 */
export function inspectShellHeredocData(
  command: string,
): { command: string; expansionCommands: string[] } | null {
  const expansionCommands: string[] = [];
  let unresolvedExpansion = false;
  let omittedExpandableData = false;
  const inspectExpandableBody = (body: string): boolean => {
    let literal = true;
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i]!;
      const next = body[i + 1];
      // Unlike command text, quotes and comment markers have no syntax here.
      if (ch === "\\" && next !== undefined && "\\$`".includes(next)) { i += 1; continue; }
      if (ch === "`") {
        literal = false;
        const close = body.indexOf("`", i + 1);
        // Escaped legacy substitution syntax needs another decoding pass.
        // Refuse it rather than inspect a different command than the shell.
        if (close === -1 || body.slice(i + 1, close).includes("\\")) {
          unresolvedExpansion = true;
          return false;
        }
        expansionCommands.push(body.slice(i + 1, close));
        i = close;
      } else if (ch === "$" && next !== undefined && /[A-Za-z0-9_({\[?#!*@\-$]/.test(next)) {
        literal = false;
        // Arithmetic and parameter operators can perform further expansions.
        // Keep their boundary closed until that grammar can be inspected.
        if (next === "{" || next === "[" || (next === "(" && body[i + 2] === "(")) {
          unresolvedExpansion = true;
          return false;
        }
        if (next === "(") {
          const close = findShellSubstitutionEnd(body, i + 1, { strict: true });
          if (close === -1) {
            unresolvedExpansion = true;
            return false;
          }
          expansionCommands.push(body.slice(i + 2, close));
          i = close;
        }
      }
    }
    omittedExpandableData ||= literal;
    return literal;
  };
  const projected = redactHeredocCommand(command, false, undefined, {
    onUnresolved: () => { unresolvedExpansion = true; },
    omitExpandableBody: inspectExpandableBody,
  });
  if (unresolvedExpansion) return null;
  if (omittedExpandableData) {
    // A local cat header can sit inside a group whose output is piped to a
    // shell. Prove the WHOLE projected command is one independent consumer;
    // complete raw coverage also excludes dangling control operators.
    const parsed = tokenizeShell(projected!);
    const leaf = parsed.leaves[0];
    const independentDataConsumer = !parsed.parseError && parsed.leaves.length === 1 && leaf !== undefined
      && leaf.raw === projected!.trim()
      && stripCommandPath(leaf.argv[0] ?? "") === "cat"
      && leaf.assignments.length === 0
      && leaf.strippedWrappers.every((wrapper) => wrapper === "command")
      && !leaf.hasCommandSubstitution && !leaf.hasProcessSubstitution
      && !leaf.argvHasExpandableDollar.some(Boolean);
    if (!independentDataConsumer) return { command: redactHeredocBodies(command), expansionCommands };
  }
  return { command: projected!, expansionCommands };
}

/**
 * True when the `#` at `index` begins a comment rather than sitting inside a
 * word. Bash starts a comment only where a word could start: at the beginning
 * of the input, or after whitespace or one of the operators that end a word.
 *
 * Exported because every scanner that walks a command character by character
 * needs this same answer, and each one that lacked it could be blinded by a
 * single unbalanced quote in a comment: `ls # don't` leaves the scanner inside
 * a quoted run, so the newline and everything after it — a whole second
 * command — is read as quoted text and never inspected. The callers must agree
 * about where a comment starts, so they share the rule instead of restating it.
 */
export function startsShellComment(command: string, index: number): boolean {
  if (index === 0) return true;
  const previous = command[index - 1]!;
  return previous === " " || previous === "\t" || previous === "\n" || previous === "\r"
    || previous === ";" || previous === "&" || previous === "|" || previous === "(";
}

/**
 * At `start` (the first `<` of a `<<`), read a simple bare or quoted delimiter.
 * Quote-removal and tab-stripping metadata keep boundary detection separate
 * from deciding whether a caller may omit that body's contents.
 */
interface HeredocDelimiter {
  delimiter: string;
  next: number;
  quoted: boolean;
  stripTabs: boolean;
}

function readHeredocDelimiter(
  command: string,
  start: number,
): HeredocDelimiter | null {
  let i = start + 2;
  const stripTabs = command[i] === "-";
  if (stripTabs) i += 1;
  while (command[i] === " " || command[i] === "\t") i += 1;
  const quote = command[i];
  const quoted = quote === "'" || quote === '"';
  const startWord = quoted ? i + 1 : i;
  if (quoted) {
    i = command.indexOf(quote, startWord);
    if (i === -1) return null;
  } else {
    while (i < command.length && !/[ \t\n;&|<>()'"\\`]/.test(command[i]!)) {
      if (command[i] === "$" && command[i + 1] === "(") return null;
      i += 1;
    }
  }
  const delimiter = command.slice(startWord, i);
  const next = quoted ? i + 1 : i;
  // Concatenated quotes, escapes and expansion-shaped delimiter words need
  // more quote-removal grammar. Do not guess a boundary from a word prefix.
  if (delimiter.length === 0 || /[\\\n]/.test(delimiter)
    || (next < command.length && !/[ \t\n;&|<>()]/.test(command[next]!))) return null;
  return { delimiter, next, quoted, stripTabs };
}

/**
 * Index just past the heredoc terminator line that closes a body starting at
 * `from`, or null when the terminator never arrives.
 */
function findHeredocTerminator(command: string, from: number, opened: HeredocDelimiter): number | null {
  let lineStart = from;
  const n = command.length;
  while (lineStart <= n) {
    let i = lineStart;
    let line = "";
    while (i < n && command[i] !== "\n") {
      if (!opened.quoted && command[i] === "\\") {
        if (command[i + 1] !== "\n") line += command.slice(i, i + 2);
        i += 2;
      } else line += command[i++]!;
    }
    if ((opened.stripTabs ? line.replace(/^\t+/, "") : line) === opened.delimiter) {
      return Math.min(i + 1, n);
    }
    if (i >= n) return null;
    lineStart = i + 1;
  }
  return null;
}

/** Descriptor duplication/closing already contains its operand. */
function isCompleteDescriptorRedirect(operator: string): boolean {
  return /^\d*[<>]&(?:\d+-?|-)$/.test(operator);
}

/**
 * Character-level scan that segments the command into raw leaves and words,
 * tracking quote and substitution nesting. Returns `parseError` when a quote or
 * paren never closes.
 */
function scanLeaves(command: string, literalDataProof = false, source?: ShellSource, simpleCommandList = false): { leaves: RawLeaf[]; parseError: boolean } {
  let parentheses = 0;
  let braces = 0;
  const leaves: RawLeaf[] = [];
  let words: RawWord[] = [];
  let leafStart = 0;
  // A conditional connector still needs its right-hand command after any
  // number of blank/comment lines. Sequence terminators need no such operand.
  let pendingListOperand = false;

  let current = "";
  let currentHasCmdSubst = false;
  // A `$` that the shell will actually expand. Text taken from a single-quoted
  // run never sets this: inside `'...'` a `$` is literal, so the word-splitting
  // vector the caller guards against cannot arise there.
  let currentHasExpandableDollar = false;
  let currentHasProcSubst = false;
  let wordActive = false;

  const pushWord = (): void => {
    if (wordActive) {
      words.push({
        value: current,
        isRedirectOperator: false,
        isOutputRedirect: false,
        hasCommandSubstitution: currentHasCmdSubst,
        hasProcessSubstitution: currentHasProcSubst,
        hasExpandableDollar: currentHasExpandableDollar,
      });
    }
    current = "";
    currentHasCmdSubst = false;
    currentHasExpandableDollar = false;
    currentHasProcSubst = false;
    wordActive = false;
  };

  const pushOperator = (value: string, isOutput: boolean): void => {
    pushWord();
    words.push({
      value,
      isRedirectOperator: true,
      isOutputRedirect: isOutput,
      hasExpandableDollar: false,
      hasCommandSubstitution: false,
      hasProcessSubstitution: false,
    });
  };

  const endLeaf = (endIndex: number, nextStart: number): void => {
    pushWord();
    if (words.length > 0) pendingListOperand = false;
    const raw = source
      ? source.original.slice(source.offsets?.[leafStart] ?? leafStart, source.offsets?.[endIndex] ?? endIndex).trim()
      : command.slice(leafStart, endIndex).trim();
    leaves.push({ words, raw });
    words = [];
    leafStart = nextStart;
  };

  const n = command.length;
  let i = 0;
  while (i < n) {
    const ch = command[i]!;

    // Decode escaped delimiters in redirect operands. Other backslashes retain
    // the existing path representation, including native path separators.
    // Callers requesting literal proof still reject all unquoted escapes.
    const pendingRedirect = words.at(-1);
    if (ch === "\\" && pendingRedirect?.isRedirectOperator
      && !isCompleteDescriptorRedirect(pendingRedirect.value)) {
      if (literalDataProof || i + 1 >= n) return { leaves: [], parseError: true };
      const next = command[i + 1]!;
      if (/[ \t\r\n#'"`$;&|<>()]/.test(next)) {
        if (next !== "\n") {
          current += next;
          wordActive = true;
        }
        i += 2;
        continue;
      }
    }

    // Comment: `#` where a word could start runs to end of line. The newline is
    // left in place so it still ends the leaf.
    if (ch === "#" && !wordActive && startsShellComment(command, i)) {
      pushWord();
      let end = i + 1;
      while (end < n && command[end] !== "\n") end += 1;
      // A line holding only a comment is no leaf at all. Without moving the
      // leaf start past it the comment text becomes the leaf's raw string, and
      // a leaf with a raw string survives the empty-leaf filter.
      if (words.length === 0) leafStart = end;
      i = end;
      continue;
    }

    // Single quote: literal run to the next single quote. No expansion.
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return { leaves: [], parseError: true };
      // Deliberately does NOT set currentHasExpandableDollar — see its
      // declaration. `rg 'foo$'` is a regex anchor, not an expansion.
      current += command.slice(i + 1, close);
      wordActive = true;
      i = close + 1;
      continue;
    }

    // Double quote: expansion-active run to the next unescaped double quote.
    // Command substitution inside still counts.
    if (ch === '"') {
      const res = consumeDoubleQuote(command, i);
      if (res === null) return { leaves: [], parseError: true };
      current += res.text;
      // Double quotes suppress word splitting but NOT expansion, and an
      // expanded value can be a flag in its entirety (`rg "$FLAG" p`), so this
      // still counts.
      if (res.text.includes("$")) currentHasExpandableDollar = true;
      if (res.hasCommandSubstitution) currentHasCmdSubst = true;
      wordActive = true;
      i = res.next;
      continue;
    }

    // Backtick command substitution.
    if (ch === "`") {
      const close = command.indexOf("`", i + 1);
      if (close === -1) return { leaves: [], parseError: true };
      current += command.slice(i, close + 1);
      currentHasCmdSubst = true;
      wordActive = true;
      i = close + 1;
      continue;
    }

    // Process substitution `<(...)` / `>(...)`.
    if ((ch === "<" || ch === ">") && command[i + 1] === "(") {
      const close = matchParen(command, i + 1);
      if (close === -1) return { leaves: [], parseError: true };
      current += command.slice(i, close + 1);
      currentHasProcSubst = true;
      wordActive = true;
      i = close + 1;
      continue;
    }

    // `$(...)` command substitution or `$var` / `${var}` / `$((arith))`.
    if (ch === "$") {
      if (command[i + 1] === "(") {
        // This matches both `$(cmd)` (command substitution) and `$((expr))`
        // (arithmetic expansion). We conservatively set hasCommandSubstitution
        // for BOTH — arithmetic expansion cannot execute arbitrary commands but
        // distinguishing `$(` from `$((` adds parser complexity for minimal gain:
        // any `$((…))` that contains side effects would be unusual, and treating
        // it as substitution keeps the classifier safely closed. Callers that
        // care only about execution risk (not arithmetic) accept this over-
        // approximation as the safe direction.
        const close = matchParen(command, i + 1);
        if (close === -1) return { leaves: [], parseError: true };
        current += command.slice(i, close + 1);
        currentHasCmdSubst = true;
        wordActive = true;
        i = close + 1;
        continue;
      }
      // Plain parameter expansion (`$var`, `${var}`) — part of the current word,
      // NOT a command substitution (no execution, only value lookup). It IS an
      // expansion though, and unquoted it also word-splits, which is the whole
      // point of the flag.
      currentHasExpandableDollar = true;
      current += ch;
      wordActive = true;
      i += 1;
      continue;
    }

    // Whitespace (outside quotes) ends a word. Newline also ends a leaf.
    if (ch === "\n") {
      endLeaf(i, i + 1);
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      pushWord();
      i += 1;
      continue;
    }

    // Compound separators.
    if (ch === "&") {
      if (command[i + 1] === "&") {
        if (simpleCommandList && !wordActive && words.length === 0) return { leaves: [], parseError: true };
        endLeaf(i, i + 2);
        pendingListOperand = true;
        i += 2;
        continue;
      }
      // `&>` / `&>>` redirect (bash: redirect both stdout+stderr).
      if (command[i + 1] === ">") {
        const opLen = command[i + 2] === ">" ? 3 : 2;
        pushOperator(command.slice(i, i + opLen), true);
        i += opLen;
        continue;
      }
      // Bare `&` background operator — leaf boundary.
      if (simpleCommandList) return { leaves: [], parseError: true };
      endLeaf(i, i + 1);
      i += 1;
      continue;
    }
    if (ch === "|") {
      if (command[i + 1] === "|") {
        if (simpleCommandList && !wordActive && words.length === 0) return { leaves: [], parseError: true };
        endLeaf(i, i + 2);
        pendingListOperand = true;
        i += 2;
        continue;
      }
      // `>|` is handled in the `>` branch; a bare `|` is a pipe boundary.
      if (simpleCommandList) return { leaves: [], parseError: true };
      endLeaf(i, i + 1);
      i += 1;
      continue;
    }
    if (ch === ";") {
      if (simpleCommandList && !wordActive && words.length === 0) return { leaves: [], parseError: true };
      endLeaf(i, i + 1);
      i += 1;
      continue;
    }

    // Redirect operators may have a multi-digit descriptor prefix. Complete
    // descriptor duplication/closing consumes no following argv word.
    let operatorStart = i;
    if (!wordActive) {
      while (operatorStart < n && /[0-9]/.test(command[operatorStart]!)) operatorStart += 1;
    }
    const direction = command[operatorStart];
    if (direction === ">" || direction === "<") {
      let end = operatorStart + 1;
      if (command[end] === "&") {
        end += 1;
        const operandStart = end;
        while (end < n && /[0-9]/.test(command[end]!)) end += 1;
        if (command[end] === "-") end += 1;
        // A numeric prefix is not a complete descriptor when the shell word
        // continues (e.g. >&1report or >&1"report" names a file).
        if (end < n && !/[ \t\n;&|<>]/.test(command[end]!)) end = operandStart;
      } else if (direction === "<" && command[end] === "<") {
        end += 1;
        if (command[end] === "<" || command[end] === "-") end += 1;
      } else if (direction === ">" && (command[end] === ">" || command[end] === "|")) {
        end += 1;
      } else if (direction === "<" && command[end] === ">") {
        // Read/write opening must retain the stricter output-target effect.
        end += 1;
      }
      pushOperator(command.slice(i, end), direction === ">" || command[operatorStart + 1] === ">");
      i = end;
      continue;
    }

    // A caller relaxing a raw structural deny needs stronger lexical proof.
    // Unquoted escapes are outside this scanner's grammar; never guess how
    // they change a comment/word boundary. Balance ordinary grouping too.
    if (literalDataProof) {
      if (ch === "\\") return { leaves: [], parseError: true };
      if (simpleCommandList && "(){}".includes(ch)) return { leaves: [], parseError: true };
      if (ch === "(") parentheses += 1;
      if (ch === ")" && --parentheses < 0) return { leaves: [], parseError: true };
      if (ch === "{") braces += 1;
      if (ch === "}" && --braces < 0) return { leaves: [], parseError: true };
    }

    // Ordinary character — part of the current word. A `$` never reaches here;
    // it is claimed by the expansion branch above, which sets the flag.
    current += ch;
    wordActive = true;
    i += 1;
  }

  if (literalDataProof && (parentheses !== 0 || braces !== 0)) return { leaves: [], parseError: true };
  if (simpleCommandList && pendingListOperand && !wordActive && words.length === 0) return { leaves: [], parseError: true };
  endLeaf(command.length, command.length);
  // Drop leaves that are entirely empty (e.g. trailing separators).
  const nonEmpty = leaves.filter((l) => l.words.length > 0 || l.raw.length > 0);
  return { leaves: nonEmpty, parseError: false };
}

/**
 * Consume a double-quoted run starting at `open` (the opening `"`). Returns the
 * inner text (quotes removed, escapes preserved as literal chars) and the index
 * just past the closing quote, or null when unterminated.
 */
function consumeDoubleQuote(
  command: string,
  open: number,
  strictBoundary = false,
): { text: string; next: number; hasCommandSubstitution: boolean } | null {
  let text = "";
  let hasCommandSubstitution = false;
  let i = open + 1;
  const n = command.length;
  while (i < n) {
    const ch = command[i]!;
    if (ch === "\\") {
      // Double quotes preserve a backslash before ordinary characters. Only
      // shell expansion/quoting characters and newline consume the backslash.
      if (i + 1 < n) {
        const next = command[i + 1]!;
        if (next !== "\n") {
          text += '$`"\\'.includes(next) ? next : `\\${next}`;
        }
        i += 2;
        continue;
      }
      return null;
    }
    if (ch === '"') {
      return { text, next: i + 1, hasCommandSubstitution };
    }
    if (ch === "`") {
      if (strictBoundary) return null;
      const close = command.indexOf("`", i + 1);
      if (close === -1) return null;
      text += command.slice(i, close + 1);
      hasCommandSubstitution = true;
      i = close + 1;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      const close = matchParen(command, i + 1, strictBoundary);
      if (close === -1) return null;
      text += command.slice(i, close + 1);
      hasCommandSubstitution = true;
      i = close + 1;
      continue;
    }
    if (strictBoundary && ch === "$" && (command[i + 1] === "{" || command[i + 1] === "[")) return null;
    text += ch;
    i += 1;
  }
  return null;
}

/**
 * Given the index of an opening `(`, return the index of its matching `)`,
 * honouring nested parens and quoted regions. Returns -1 when unbalanced.
 */
function matchParen(command: string, openParen: number, strictBoundary = false): number {
  let depth = 0;
  let i = openParen;
  let wordActive = false;
  const n = command.length;
  while (i < n) {
    const ch = command[i]!;
    if (ch === "\\") { wordActive = true; i += 2; continue; }
    if (ch === "#" && !wordActive && startsShellComment(command, i)) {
      const newline = command.indexOf("\n", i);
      if (newline === -1) return -1;
      i = newline;
      continue;
    }
    // Case patterns use ')' without opening a parenthesized group. Strict
    // expansion inspection must refuse that unsupported grammar, including
    // nested legacy substitutions, instead of ending the body prematurely.
    if (strictBoundary && (ch === "`" || (!wordActive && command.slice(i, i + 4) === "case"
      && /[ \t\r\n;&|<>()]/.test(command[i + 4] ?? "")))) return -1;
    if (strictBoundary && ((ch === "$" && "{['\"".includes(command[i + 1] ?? " "))
      || (ch === "(" && command[i + 1] === "(")
      || ((ch === "<" || ch === ">") && command[i + 1] === "("))) return -1;
    // Nested heredoc bodies have their own data grammar: a literal ')' in a
    // body must not end this substitution before later executable commands.
    // Here-strings also need an operand proof outside this bounded scanner.
    if (strictBoundary && ch === "<" && command[i + 1] === "<") return -1;
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return -1;
      wordActive = true;
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      const res = consumeDoubleQuote(command, i, strictBoundary);
      if (res === null) return -1;
      wordActive = true;
      i = res.next;
      continue;
    }
    if (ch === "(") { wordActive = false; depth += 1; i += 1; continue; }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
      wordActive = false;
      i += 1;
      continue;
    }
    wordActive = !/[ \t\r\n;&|<>]/.test(ch);
    i += 1;
  }
  return -1;
}

/**
 * Shared quote/comment-aware substitution boundary. Strict inspection refuses
 * unsupported nested syntax before granting a new executable-data exemption.
 */
export function findShellSubstitutionEnd(
  command: string,
  openParen: number,
  options: { strict?: boolean } = {},
): number {
  return command[openParen] === "(" ? matchParen(command, openParen, options.strict ?? false) : -1;
}

/** Reduce `/usr/bin/ls` → `ls`; leave bare verbs unchanged. */
/**
 * Reduce a command token to its basename, so `/usr/bin/cat` and `cat` are the
 * same verb to every caller.
 *
 * Shared because there were three copies and they had begun to differ: one
 * also split on `\\`, which meant two classifiers looking at the same Windows
 * path could disagree about what verb was being run. Verb extraction is part
 * of reading a shell command, so it belongs with the tokenizer that does that.
 *
 * Deliberately `/`-only. A Windows-style separator is a real gap — see the
 * note in shell-path-policy — but widening it here would silently reclassify
 * commands, which is a behaviour change and not this function's job.
 */
export function stripCommandPath(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash >= 0 ? token.slice(slash + 1) : token;
}

/** Turn a raw scanned leaf into a {@link ShellLeaf}: separate argv from
 * redirect targets, strip leading assignments and wrapper commands. */
function buildLeaf(raw: RawLeaf): ShellLeaf {
  const argvWords: string[] = [];
  const argvWordsExpandable: boolean[] = [];
  const redirectTargets: string[] = [];
  const inputRedirectTargets: string[] = [];
  let hasOutputRedirect = false;
  let hasInputRedirect = false;
  let hasCommandSubstitution = false;
  let hasProcessSubstitution = false;

  const words = raw.words;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    if (w.hasCommandSubstitution) hasCommandSubstitution = true;
    if (w.hasProcessSubstitution) hasProcessSubstitution = true;
    if (w.isRedirectOperator) {
      if (isCompleteDescriptorRedirect(w.value)) {
        if (w.isOutputRedirect) hasOutputRedirect = true;
        else hasInputRedirect = true;
        continue;
      }
      if (w.isOutputRedirect) {
        hasOutputRedirect = true;
        // The next non-operator word is a file target (not a fd-dup digit,
        // since those were already consumed into the operator string by the
        // scanner). Collect it only when it is a real word token.
        const target = words[i + 1];
        if (target && !target.isRedirectOperator) {
          redirectTargets.push(target.value);
          if (target.hasCommandSubstitution) hasCommandSubstitution = true;
          if (target.hasProcessSubstitution) hasProcessSubstitution = true;
          i += 1;
        }
      } else {
        hasInputRedirect = true;
        // Input redirects: consume the source word so it is not mistaken for
        // argv, and REPORT it. Consuming it silently made the file unreachable
        // to any caller reading leaves — `tr -d x < key` names it nowhere else.
        // A heredoc's delimiter is not a file, so it is consumed but not
        // reported.
        const src = words[i + 1];
        if (src && !src.isRedirectOperator) {
          // `<<` (heredoc delimiter) and `<<<` (here-string literal) name no
          // file; only a plain `<` does.
          if (!w.value.replace(/^\d+/, "").startsWith("<<")) inputRedirectTargets.push(src.value);
          if (src.hasCommandSubstitution) hasCommandSubstitution = true;
          if (src.hasProcessSubstitution) hasProcessSubstitution = true;
          i += 1;
        }
      }
      continue;
    }
    argvWords.push(w.value);
    argvWordsExpandable.push(w.hasExpandableDollar);
  }

  const { argv, strippedWrappers, assignments, argvStart } =
    stripAssignmentsAndWrappers(argvWords);
  return {
    argv,
    // Sliced at the same index argv was, so the two stay aligned by
    // construction rather than by a second pass that could drift from it.
    argvHasExpandableDollar: argvWordsExpandable.slice(argvStart),
    redirectTargets,
    inputRedirectTargets,
    hasOutputRedirect,
    hasInputRedirect,
    hasCommandSubstitution,
    hasProcessSubstitution,
    strippedWrappers,
    assignments,
    raw: raw.raw,
  };
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Strip leading `FOO=bar` assignments and wrapper commands (+ their option and
 * duration operands) so `argv[0]` is the effective verb.
 *
 * Wrapper-option handling is deliberately conservative: skipping a genuine
 * option flag (`nice -n 5`) is safe, but over-skipping could hide the real
 * verb, so only leading `-flag` tokens and a single numeric/duration operand
 * are consumed. `env`/`command` additionally accept `VAR=value` operands
 * before the verb (`env X=1 ls`). Returns the residual argv, the basenames of
 * any wrappers stripped (so callers can recover a bare wrapper's verb), and the
 * assignments themselves — stripped from argv but REPORTED, because an
 * assignment can select the interpreter the verb then runs. */
function stripAssignmentsAndWrappers(
  words: string[],
): { argv: string[]; strippedWrappers: string[]; assignments: string[]; argvStart: number } {
  let i = 0;
  const strippedWrappers: string[] = [];
  const assignments: string[] = [];
  // Leading VAR=value assignments (value may have been a quoted string with
  // spaces — already collapsed into a single word by the scanner).
  while (i < words.length && ASSIGNMENT_RE.test(words[i]!)) {
    assignments.push(words[i]!);
    i += 1;
  }
  // Wrapper commands and their option/duration/assignment operands.
  while (i < words.length) {
    const head = stripCommandPath(words[i]!);
    if (!WRAPPER_COMMANDS.has(head)) break;
    strippedWrappers.push(head);
    i += 1;
    // Skip option flags belonging to the wrapper (e.g. `nice -n 5`).
    while (i < words.length && words[i]!.startsWith("-")) i += 1;
    // Skip a single numeric/duration operand (e.g. `timeout 5s ls`).
    if (i < words.length && /^[0-9]+[smhd]?$/.test(words[i]!)) i += 1;
    // `env`/`command` accept VAR=value operands before the verb (`env X=1 ls`).
    while (i < words.length && ASSIGNMENT_RE.test(words[i]!)) {
      assignments.push(words[i]!);
      i += 1;
    }
  }
  return { argv: words.slice(i), strippedWrappers, assignments, argvStart: i };
}
