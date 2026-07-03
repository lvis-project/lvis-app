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
  /** True when the leaf contained `$(...)` or backtick command substitution. */
  hasCommandSubstitution: boolean;
  /** True when the leaf contained `<(...)` or `>(...)` process substitution. */
  hasProcessSubstitution: boolean;
  /**
   * Basenames of the wrapper commands (`timeout`, `env`, …) stripped from the
   * front of this leaf, in order. Lets a caller recover the verb of a bare
   * wrapper (`env` alone → prints the environment) when `argv` is empty.
   */
  strippedWrappers: string[];
  /** The raw text of the leaf, trimmed, before any stripping. */
  raw: string;
}

/** Result of {@link tokenizeShell}. `parseError` is true on unbalanced quotes
 * or parentheses so callers can fail closed. */
export interface TokenizeResult {
  leaves: ShellLeaf[];
  parseError: boolean;
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
 *
 * Fails closed (`parseError: true`) on unbalanced quotes or parentheses.
 */
export function tokenizeShell(command: string): TokenizeResult {
  const scan = scanLeaves(command);
  if (scan.parseError) {
    return { leaves: [], parseError: true };
  }
  const leaves: ShellLeaf[] = [];
  for (const rawLeaf of scan.leaves) {
    leaves.push(buildLeaf(rawLeaf));
  }
  return { leaves, parseError: false };
}

/**
 * Character-level scan that segments the command into raw leaves and words,
 * tracking quote and substitution nesting. Returns `parseError` when a quote or
 * paren never closes.
 */
function scanLeaves(command: string): { leaves: RawLeaf[]; parseError: boolean } {
  const leaves: RawLeaf[] = [];
  let words: RawWord[] = [];
  let leafStart = 0;

  let current = "";
  let currentHasCmdSubst = false;
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
      });
    }
    current = "";
    currentHasCmdSubst = false;
    currentHasProcSubst = false;
    wordActive = false;
  };

  const pushOperator = (value: string, isOutput: boolean): void => {
    pushWord();
    words.push({
      value,
      isRedirectOperator: true,
      isOutputRedirect: isOutput,
      hasCommandSubstitution: false,
      hasProcessSubstitution: false,
    });
  };

  const endLeaf = (endIndex: number, nextStart: number): void => {
    pushWord();
    leaves.push({ words, raw: command.slice(leafStart, endIndex).trim() });
    words = [];
    leafStart = nextStart;
  };

  const n = command.length;
  let i = 0;
  while (i < n) {
    const ch = command[i]!;

    // Single quote: literal run to the next single quote. No expansion.
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return { leaves: [], parseError: true };
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
      // NOT a command substitution (no execution, only value lookup).
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
      if (command[i + 1] === "&") { endLeaf(i, i + 2); i += 2; continue; }
      // `&>` / `&>>` redirect (bash: redirect both stdout+stderr).
      if (command[i + 1] === ">") {
        const opLen = command[i + 2] === ">" ? 3 : 2;
        pushOperator(command.slice(i, i + opLen), true);
        i += opLen;
        continue;
      }
      // Bare `&` background operator — leaf boundary.
      endLeaf(i, i + 1);
      i += 1;
      continue;
    }
    if (ch === "|") {
      if (command[i + 1] === "|") { endLeaf(i, i + 2); i += 2; continue; }
      // `>|` is handled in the `>` branch; a bare `|` is a pipe boundary.
      endLeaf(i, i + 1);
      i += 1;
      continue;
    }
    if (ch === ";") {
      endLeaf(i, i + 1);
      i += 1;
      continue;
    }

    // Redirects. A leading file-descriptor digit (`2>`, `1>`) is consumed as
    // part of the operator when immediately followed by `>` (no intervening
    // space). `<`/`<<` are input reads (recorded, no target).
    if (ch === ">") {
      // `>>` append, `>|` clobber, `>` truncate — all output redirects.
      // NOTE: `>&m` (fd-dup, e.g. `>&2`, `2>&1`) duplicates a file descriptor
      // rather than naming a FILE target. We recognise it here and record it as
      // an output redirect operator with NO subsequent word token consumed as a
      // target, so the fd digit after `>&` stays out of `redirectTargets` and
      // does not produce a spurious leaf token like `["1"]` or `["2"]`.
      if (command[i + 1] === "&") {
        // `>&m` or `>>&m` — consume operator + optional trailing digit(s).
        let opEnd = i + 2;
        while (opEnd < n && command[opEnd]! >= "0" && command[opEnd]! <= "9") opEnd += 1;
        pushOperator(command.slice(i, opEnd), true);
        i = opEnd;
        // The fd number was already consumed into the operator string; do NOT
        // treat it as a redirect-target word. Advance past any trailing space.
        continue;
      }
      const opLen = command[i + 1] === ">" || command[i + 1] === "|" ? 2 : 1;
      pushOperator(command.slice(i, i + opLen), true);
      i += opLen;
      continue;
    }
    if (ch === "<") {
      const opLen = command[i + 1] === "<" ? 2 : 1;
      pushOperator(command.slice(i, i + opLen), false);
      i += opLen;
      continue;
    }

    // A digit immediately followed by `>` is a numbered fd output redirect
    // (e.g. `2>file`, `2>&1`, `2>>file`). When it is `n>&m` (fd-dup), the `m`
    // digit belongs to the operator and must NOT be consumed as a target word.
    if (ch >= "0" && ch <= "9" && command[i + 1] === ">" && !wordActive) {
      const afterDigit = i + 1;
      // `n>&m` fd-duplication: consume operator + destination-fd digits.
      if (command[afterDigit + 1] === "&") {
        let opEnd = afterDigit + 2;
        while (opEnd < n && command[opEnd]! >= "0" && command[opEnd]! <= "9") opEnd += 1;
        pushOperator(command.slice(i, opEnd), true);
        i = opEnd;
        continue;
      }
      const opLen = command[afterDigit + 1] === ">" || command[afterDigit + 1] === "|" ? 2 : 1;
      pushOperator(command.slice(i, afterDigit + opLen), true);
      i = afterDigit + opLen;
      continue;
    }

    // Ordinary character — part of the current word.
    current += ch;
    wordActive = true;
    i += 1;
  }

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
): { text: string; next: number; hasCommandSubstitution: boolean } | null {
  let text = "";
  let hasCommandSubstitution = false;
  let i = open + 1;
  const n = command.length;
  while (i < n) {
    const ch = command[i]!;
    if (ch === "\\") {
      // Backslash escapes the next char inside double quotes.
      if (i + 1 < n) {
        text += command[i + 1]!;
        i += 2;
        continue;
      }
      return null;
    }
    if (ch === '"') {
      return { text, next: i + 1, hasCommandSubstitution };
    }
    if (ch === "`") {
      const close = command.indexOf("`", i + 1);
      if (close === -1) return null;
      text += command.slice(i, close + 1);
      hasCommandSubstitution = true;
      i = close + 1;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      const close = matchParen(command, i + 1);
      if (close === -1) return null;
      text += command.slice(i, close + 1);
      hasCommandSubstitution = true;
      i = close + 1;
      continue;
    }
    text += ch;
    i += 1;
  }
  return null;
}

/**
 * Given the index of an opening `(`, return the index of its matching `)`,
 * honouring nested parens and quoted regions. Returns -1 when unbalanced.
 */
function matchParen(command: string, openParen: number): number {
  let depth = 0;
  let i = openParen;
  const n = command.length;
  while (i < n) {
    const ch = command[i]!;
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return -1;
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      const res = consumeDoubleQuote(command, i);
      if (res === null) return -1;
      i = res.next;
      continue;
    }
    if (ch === "(") { depth += 1; i += 1; continue; }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

/** Reduce `/usr/bin/ls` → `ls`; leave bare verbs unchanged. */
function stripPath(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash >= 0 ? token.slice(slash + 1) : token;
}

/** Turn a raw scanned leaf into a {@link ShellLeaf}: separate argv from
 * redirect targets, strip leading assignments and wrapper commands. */
function buildLeaf(raw: RawLeaf): ShellLeaf {
  const argvWords: string[] = [];
  const redirectTargets: string[] = [];
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
        // Input redirects: consume the source word so it is not mistaken for argv.
        const src = words[i + 1];
        if (src && !src.isRedirectOperator) {
          if (src.hasCommandSubstitution) hasCommandSubstitution = true;
          if (src.hasProcessSubstitution) hasProcessSubstitution = true;
          i += 1;
        }
      }
      continue;
    }
    argvWords.push(w.value);
  }

  const { argv, strippedWrappers } = stripAssignmentsAndWrappers(argvWords);
  return {
    argv,
    redirectTargets,
    hasOutputRedirect,
    hasInputRedirect,
    hasCommandSubstitution,
    hasProcessSubstitution,
    strippedWrappers,
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
 * before the verb (`env X=1 ls`). Returns the residual argv plus the basenames
 * of any wrappers stripped, so callers can recover a bare wrapper's verb. */
function stripAssignmentsAndWrappers(
  words: string[],
): { argv: string[]; strippedWrappers: string[] } {
  let i = 0;
  const strippedWrappers: string[] = [];
  // Leading VAR=value assignments (value may have been a quoted string with
  // spaces — already collapsed into a single word by the scanner).
  while (i < words.length && ASSIGNMENT_RE.test(words[i]!)) i += 1;
  // Wrapper commands and their option/duration/assignment operands.
  while (i < words.length) {
    const head = stripPath(words[i]!);
    if (!WRAPPER_COMMANDS.has(head)) break;
    strippedWrappers.push(head);
    i += 1;
    // Skip option flags belonging to the wrapper (e.g. `nice -n 5`).
    while (i < words.length && words[i]!.startsWith("-")) i += 1;
    // Skip a single numeric/duration operand (e.g. `timeout 5s ls`).
    if (i < words.length && /^[0-9]+[smhd]?$/.test(words[i]!)) i += 1;
    // `env`/`command` accept VAR=value operands before the verb (`env X=1 ls`).
    while (i < words.length && ASSIGNMENT_RE.test(words[i]!)) i += 1;
  }
  return { argv: words.slice(i), strippedWrappers };
}
