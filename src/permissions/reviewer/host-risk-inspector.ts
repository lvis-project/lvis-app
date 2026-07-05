/**
 * Host Risk Inspector — derives a tool call's EFFECTIVE permission category
 * from HOST-OWNED signals only, never from the plugin-declared
 * `toolSchemas.category`.
 *
 * Rationale (docs/architecture/architecture.md §6.3/§8;
 * project_permission_review_redesign): a tool that grades its own danger is
 * structurally not a control — the MCP spec is explicit that tool annotations
 * are untrusted hints ("a server can lie"). Real agent CLIs (Claude Code,
 * Codex) all classify risk on the HOST side by parsing the command/args, and
 * default-deny mutation/network. This module is the LVIS analogue.
 *
 * Design constraints honoured here:
 *  - DEFAULT-STRICT: anything NOT confidently classifiable as read-only is
 *    treated as write-equivalent (`"write"`/`"shell"`/`"network"`), the safe
 *    direction. The inspector never auto-classifies DOWN to `"read"` without
 *    positive evidence.
 *  - HOST-OWNED SIGNALS ONLY: shell commands are parsed from the call args and
 *    matched against a built-in read-only command set; filesystem reach is
 *    inferred from the actual path arguments and checked against
 *    `allowedDirectories`; network reach is inferred from URL-shaped args —
 *    none of these read the declared category.
 *  - NO GLOBAL STATE. Path containment reuses the same `sensitive-paths`
 *    canonicalization as {@link RuleBasedRiskClassifier} — a bounded `realpath`
 *    walk-up on the call's path ARGUMENTS (the only I/O here) — so containment
 *    math is identical across the two modules. The `allowedDirectories` arrive
 *    already canonicalized/case-folded (frozen-canonical contract) and are used
 *    as-is, without re-walking.
 *
 * This module does NOT make the final permission decision and does NOT touch
 * {@link LlmRiskClassifier}. It only produces the effective `ToolCategory` that
 * the category × source × trust matrix and the reviewer lane then consume,
 * exactly where the declared category was consumed before.
 */
import type { ToolCategory } from "../../tools/types.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../sensitive-paths.js";
import { tokenizeShell, type ShellLeaf } from "../../main/shell-tokenizer.js";

/**
 * Built-in read-only command set (Claude Code / Codex model). A compound shell
 * command is read-only ONLY IF every leaf command's head verb is in this set.
 * Anything unknown or mutating escalates to `"shell"` (default-strict).
 *
 * Kept deliberately conservative — the cost of omitting a genuinely read-only
 * command is an extra approval prompt (safe); the cost of wrongly including a
 * mutating command would be a silent classify-down (unsafe). New entries must
 * be provably side-effect-free in their bare form.
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "less", "more", "pwd", "echo", "printf",
  "grep", "egrep", "fgrep", "rg", "ag", "find", "fd", "wc", "stat", "file",
  "du", "df", "tree", "which", "type", "whoami", "id", "hostname", "uname",
  "date", "env", "printenv", "uptime", "ps", "top", "sort", "uniq", "cut",
  // NOTE: `awk` is intentionally ABSENT. awk has its own output-redirection
  // (`print > "file"`), pipe-to-command (`print | "cmd"`), and system() that
  // execute arbitrary code inside the awk-program string. These are opaque to
  // shell tokenization (correctly so — the shell sees a single-quoted literal
  // string). Classifying awk as read-only would require a full awk-language
  // parser; without one the classifier cannot distinguish `awk '{print $1}'`
  // from `awk 'BEGIN{system("rm -rf /")}'`. Any awk call therefore classifies
  // as `shell` (extra approval prompt — the safe, stated discipline of this module).
  "sed", "diff", "cmp", "basename", "dirname", "realpath", "readlink",
  "true", "false", "test", "sleep", "seq", "yes", "tr", "nl", "tac", "rev",
  "column", "comm", "join", "paste", "expand", "unexpand", "fold", "split",
]);

/**
 * Read-only verbs that nonetheless MUTATE when carrying certain flags. Even
 * though the head verb is in {@link READ_ONLY_COMMANDS}, a call carrying one of
 * these flags edits/creates/destroys files and must escalate to `"shell"`.
 *
 * `null` means the verb is ALWAYS mutating regardless of flags (it has no
 * side-effect-free form worth the read fast-path).
 *
 * Defense-in-depth note: `tee`, `dd`, `truncate`, and `split` are NOT in
 * {@link READ_ONLY_COMMANDS} and already fail closed as unknown verbs. Their
 * `null` entries here are retained so the MUTATING_FLAGS table stays accurate
 * if those verbs are ever added to READ_ONLY_COMMANDS in the future.
 *
 * Flag matching — three modes, all applied:
 *  1. Long flags: exact-token (`--in-place`) or `--flag=value` prefix
 *     (`--in-place=.bak`), never a substring.
 *  2. Short-flag clusters: for verbs in this table, a single-dash non-`--` arg
 *     is mutating if any mutating SHORT LETTER appears in its leading
 *     letter-cluster. This catches `-i`, `-i.bak` (glued suffix), `-ibak`,
 *     `-ni` (combined with other flags), and `-iinplace` (gawk form). The
 *     cluster is the maximal run of ASCII letters at the start of the arg
 *     (stopping at the first non-letter, which for GNU sed/gawk can be a glued
 *     backup suffix). Example: `-ni.bak` → cluster `ni` → contains `i` → mutating.
 *  3. Dollar-expansion fail-closed: for mutating-CAPABLE verbs (those with a
 *     MUTATING_FLAGS entry), any argv token containing an unexpanded `$`
 *     (e.g. `$IFS`, `${IFS}`, `$var`) escalates to shell. This closes the
 *     `sed $IFS-i f` word-splitting vector where a runtime-expanded arg could
 *     smuggle a mutating flag past the flag scanner. Scoped to mutating-capable
 *     verbs only — `grep "$pattern" f` and `cat "$file"` stay read.
 */
const MUTATING_FLAGS: ReadonlyMap<string, ReadonlySet<string> | null> = new Map([
  ["sed",  new Set(["-i", "--in-place"])],
  // `awk` is NOT listed here — it is not in READ_ONLY_COMMANDS (see above),
  // so hasMutatingFlag is never called for awk. Entry removed to avoid confusion.
  ["find", new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir",
                    "-fprint", "-fprintf", "-fls"])],
  ["fd",   new Set(["-x", "--exec", "-X", "--exec-batch"])],
  ["sort", new Set(["-o", "--output"])],
  // Always-mutating (no side-effect-free bare form):
  ["tee",      null],  // always writes to every named file
  ["dd",       null],  // always reads/writes block devices or files
  ["truncate", null],  // always modifies file size
  ["split",    null],  // always writes output files (xaa… / prefix-based)
]);

/**
 * Short mutating flag letters per verb, for cluster/glued-suffix detection
 * (mode 2 above). Keyed by the same verb names as {@link MUTATING_FLAGS}.
 * A single-dash arg whose leading letter-cluster contains any of these letters
 * is treated as mutating regardless of what follows (glued suffix or combined
 * flags). Long-flag-only verbs (find, fd, sort) have no short mutating letter
 * and are handled by exact/prefix matching alone.
 */
const MUTATING_SHORT_LETTERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["sed", new Set(["i"])],
  // `awk` removed — awk is not in READ_ONLY_COMMANDS, so this entry is dead.
]);

/**
 * git subcommands that are unconditionally read-only (no mutation possible
 * regardless of flags). Subcommands that are read-only ONLY for certain flag
 * forms (`config`, `tag`, `branch`, `remote`) are NOT listed here — they are
 * handled by {@link isReadOnlyGitLeaf} which inspects the post-subcommand args.
 */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "rev-parse",
  "describe", "blame", "shortlog", "ls-files", "ls-tree", "cat-file",
  "for-each-ref", "reflog", "whatchanged",
]);

/**
 * Flags that keep an otherwise-ambiguous git subcommand in read-only territory.
 * For `config`, `tag`, `branch`, and `remote` the PRESENCE of a non-flag
 * operand (beyond the subcommand itself) or a write-mode flag means mutation.
 * These sets list the ONLY flags that are unambiguously read — everything else
 * escalates. Default-strict: unknown flags → shell.
 */
const GIT_READ_ONLY_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // `git config --list`, `git config --get key`, `git config --get-all key`
  // are reads. `git config section.key value` or any write flag mutates.
  ["config", new Set(["-l", "--list", "--get", "--get-all", "--get-regexp",
                      "--get-urlmatch", "--global", "--system", "--local",
                      "--worktree", "--show-origin", "--show-scope",
                      "--type", "--bool", "--int", "--bool-or-int",
                      "--path", "--expiry-date", "--null", "-z",
                      "--name-only", "--includes", "--no-includes",
                      "--default", "-e", "--edit"])],
  // `git tag` / `git tag -l` / `git tag --list` are reads.
  // `git tag v2`, `git tag -d v1`, `git tag -a v2` etc. mutate.
  ["tag",    new Set(["-l", "--list", "--sort", "--format", "--color",
                      "--column", "--no-column", "--merged", "--no-merged",
                      "--contains", "--no-contains", "--points-at",
                      "--create-reflog"])],
  // `git branch` / `git branch -a` / `git branch -r` / `git branch --list`
  // are reads. `git branch -D f`, `git branch -m f g`, `git branch newname`
  // mutate.
  ["branch", new Set(["-a", "--all", "-r", "--remotes", "-l", "--list",
                      "-v", "--verbose", "-vv", "--format", "--sort",
                      "--color", "--no-color", "--column", "--no-column",
                      "--merged", "--no-merged", "--contains", "--no-contains",
                      "--points-at", "--show-current"])],
  // `git remote` / `git remote -v` / `git remote show <name>` are reads.
  // `git remote add`, `git remote remove`, `git remote set-url` mutate.
  ["remote", new Set(["-v", "--verbose", "show", "get-url"])],
]);

/** Argument selectors that commonly carry a shell command string. */
const SHELL_COMMAND_FIELDS: readonly string[] = ["command", "cmd", "script", "shellCommand"];

/** Argument selectors that commonly carry a network endpoint. */
const NETWORK_FIELDS: readonly string[] = ["url", "endpoint", "uri"];

/** Signals the host owns about the observed call. The inspector reads ONLY these. */
export interface HostRiskSignals {
  /** Where the tool came from. Network MCP servers are foreign peers. */
  source: "builtin" | "plugin" | "mcp";
  /** The actual, post-hook tool-call arguments. */
  finalInput: Record<string, unknown>;
  /**
   * Path-bearing argument selectors INFERRED for this tool (dotted selectors
   * supported). These are the tool's `pathFields`, kept as advisory hints —
   * the inspector still verifies containment of
   * whatever paths actually appear in the args.
   */
  pathFields: readonly string[];
  /** Canonicalized allowed directories (Layer 1 scope). */
  allowedDirectories: readonly string[];
}

/**
 * Derive the effective {@link ToolCategory} from host-owned signals.
 *
 * Order (first decisive signal wins), all default-strict on ambiguity:
 *  1. Shell — a command-bearing arg present → parse it; a fully read-only
 *     compound → `"read"`, otherwise `"shell"`. Checked before network so a
 *     command that invokes `curl`/`wget` stays shell-domain (higher risk).
 *  2. Network — a URL-shaped arg on a non-shell tool → `"network"`.
 *  3. Filesystem — a path arg that escapes `allowedDirectories` → `"write"`
 *     (out-of-scope reach is mutation-equivalent for policy); a contained path
 *     arg with no read-only proof → `"write"`.
 *  4. Default-strict — no positive read-only evidence → `"write"`.
 */
export function inspectHostRisk(signals: HostRiskSignals): ToolCategory {
  // External MCP tools are foreign peers — the host assigns them `"network"`
  // when adapting them (mcp-tool-adapter). Argument heuristics must never
  // classify such a tool DOWN below network on the strength of its args, so a
  // foreign-peer call is host-owned default-strict `"network"` regardless of
  // what its arguments look like.
  if (signals.source === "mcp") return "network";

  // (1) Shell — a command-bearing arg means this is a shell tool, and the
  // command (including any URL it hands to `curl`/`wget`) is shell-domain. Shell
  // carries a HIGHER risk weight + shell-specific path policy than network, so
  // classify it BEFORE the network scan — otherwise `{ command: "curl https://…" }`
  // would be downgraded to `"network"` and skip the shell checks.
  const command = extractShellCommand(signals.finalInput);
  if (command !== null) {
    return isReadOnlyCommand(command) ? "read" : "shell";
  }

  // (2) Network — a URL-shaped argument on a non-shell tool.
  if (hasNetworkTarget(signals.finalInput)) return "network";

  // (3) Filesystem — inspect the actual path arguments.
  const paths = extractCallPaths(signals.finalInput, signals.pathFields);
  if (paths.length > 0) {
    // `allowedDirectories` are already canonical/case-folded (frozen contract) —
    // re-canonicalizing would reintroduce realpath I/O and TOCTOU drift.
    const escapes = paths.some((p) => !isInsideAllowed(p, signals.allowedDirectories));
    if (escapes) return "write";
    // A contained path argument with no read-only verb proof is still a
    // potential mutation. Default-strict: treat as write.
    return "write";
  }

  // (4) No host-owned signal proved read-only → default-strict write-equivalent.
  return "write";
}

/** True when a string carries a parseable URL with a network scheme. */
function isNetworkUrl(value: string): boolean {
  if (value.length === 0) return false;
  try {
    const u = new URL(value);
    return (
      u.protocol === "http:" ||
      u.protocol === "https:" ||
      u.protocol === "ws:" ||
      u.protocol === "wss:"
    );
  } catch {
    return false;
  }
}

/**
 * True when any argument is a network target. Checks the named URL-bearing
 * fields and a bare `host` field, then — default-strict toward `"network"` —
 * scans EVERY top-level string value for URL-shaped content, so a URL hidden
 * under an arbitrary key still escalates instead of slipping past the heuristic.
 */
function hasNetworkTarget(input: Record<string, unknown>): boolean {
  for (const key of NETWORK_FIELDS) {
    const value = input[key];
    if (typeof value === "string" && isNetworkUrl(value)) return true;
  }
  const host = input.host;
  if (typeof host === "string" && host.length > 0) return true;
  // Default-strict: a network URL under any other key is still a network target.
  for (const value of Object.values(input)) {
    if (typeof value === "string" && isNetworkUrl(value)) return true;
  }
  return false;
}

/** Pull a shell command string out of the call args, if any. */
function extractShellCommand(input: Record<string, unknown>): string | null {
  for (const key of SHELL_COMMAND_FIELDS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * A compound shell command is read-only iff EVERY leaf command's effective
 * head verb is in {@link READ_ONLY_COMMANDS} (or is a read-only `git`
 * subcommand / flag-form) AND carries no mutating flag ({@link MUTATING_FLAGS}).
 * Leaf boundaries, quoting, redirects and substitution come from the shared
 * {@link tokenizeShell} SOT so this module and {@link BashAstValidator} agree
 * on what a leaf is.
 *
 * Tool-internal mini-languages: this classifier operates primarily at the
 * SHELL grammar layer. It only models tool-internal languages where there is a
 * small conservative scanner with bounded false positives. `sed` is covered
 * for write/exec program forms (`w`/`W`/`r`/`R`/`e`, `s///w`, `s///e`, and
 * script-file loading). `awk` is intentionally excluded from READ_ONLY_COMMANDS
 * because safe classification would require a full awk-language parser.
 *
 * Tighten-only claim (precise): every `read→shell` transition introduced by
 * this change is a genuine tighten — a command that WAS safe to classify read
 * is now escalated because we detect a mutating flag or write git subcommand
 * form. A small enumerated set of `shell→read` transitions also exists; these
 * are NOT hardenings — they are CORRECTIONS of prior mis-classifications where
 * the old naive tokenizer wrongly classified a benign command as shell:
 *   - `grep "a && b" f`   — `&&` was inside a quoted arg, not a separator
 *   - `grep '$(whoami)' f`— `$(` was inside a single-quoted arg (no execution)
 *   - `echo '\`rm\`' f`   — backtick inside single quotes (no execution)
 *   - `env X=1 ls`        — old tokenizer did not strip env-style assignments
 * Each of these is provably side-effect-free and is tested explicitly below.
 * The differential/property test in the test file asserts the full enumerated
 * correction set and proves no other shell→read transition occurs.
 *
 * Fails closed to non-read-only on:
 *  - a parse error (unbalanced quotes/parens),
 *  - any command/process substitution (`$(…)`, backticks, `<(…)`, `>(…)`) —
 *    hidden commands the head-verb scan cannot see,
 *  - any redirect, input OR output (`>`, `>>`, `2>`, `&>`, `<`, `<<`). Output
 *    redirects write a file; input redirects reach a file the argv-path check
 *    cannot contain. Failing closed on BOTH preserves the prior fail-closed
 *    set (a char-class guard on `< > \` $(`).
 */
export function isReadOnlyCommand(command: string): boolean {
  const { leaves, parseError } = tokenizeShell(command);
  if (parseError) return false;
  if (leaves.length === 0) return false;
  return leaves.every((leaf) => isReadOnlyLeaf(leaf));
}

function isReadOnlyLeaf(leaf: ShellLeaf): boolean {
  // Any hidden execution or redirect (output OR input) taints the whole
  // command (default-strict — see the doc comment on isReadOnlyCommand).
  // hasOutputRedirect covers both file-target redirects AND fd-dup (>&m, n>&m)
  // so `ls 2>&1` / `ls >&2` correctly stay shell — they have an output-redirect
  // operator even though no file target is named.
  if (leaf.hasCommandSubstitution || leaf.hasProcessSubstitution) return false;
  if (leaf.hasOutputRedirect || leaf.hasInputRedirect) return false;

  const argv = leaf.argv;
  if (argv.length === 0) {
    // The leaf was only assignments/wrappers. A bare read-only wrapper verb
    // (`env`, which prints the environment) is read-only; a bare incomplete
    // wrapper (`timeout`, `nice`) is not. The first stripped wrapper is the
    // effective verb the leaf would have run.
    const bareVerb = leaf.strippedWrappers[0];
    return bareVerb !== undefined && READ_ONLY_COMMANDS.has(bareVerb);
  }

  const verb = stripPath(argv[0]!);
  if (verb === "git") {
    return isReadOnlyGitLeaf(argv);
  }
  if (!READ_ONLY_COMMANDS.has(verb)) return false;
  // A read-only verb still MUTATES when carrying a mutating flag (`sed -i`,
  // `find … -delete`, …). Escalate to non-read-only.
  if (hasMutatingFlag(verb, argv.slice(1))) return false;
  return true;
}

/**
 * True when the git leaf (full argv, `argv[0] === "git"`) is read-only.
 *
 * Unconditionally-read subcommands pass immediately. Ambiguous subcommands
 * (`config`, `tag`, `branch`, `remote`) are read-only ONLY when EVERY
 * post-subcommand token is a flag listed in {@link GIT_READ_ONLY_FLAGS} — any
 * non-flag operand or write-mode flag escalates to shell. Default-strict:
 * unlisted subcommands (including `commit`, `push`, `merge`, …) are shell.
 */
function isReadOnlyGitLeaf(argv: readonly string[]): boolean {
  const sub = argv[1];
  if (typeof sub !== "string") return false;
  if (READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return true;
  const readFlags = GIT_READ_ONLY_FLAGS.get(sub);
  if (readFlags === undefined) return false; // unlisted → shell
  // Every token after the subcommand must be in the read-only flag set.
  // A bare `git remote` (no args after sub) and `git branch` (no args) are
  // read-only listing forms — allowed when postArgs is empty.
  const postArgs = argv.slice(2);
  return postArgs.every((t) => readFlags.has(t));
}

/**
 * True when `verb`'s argument tokens carry a flag that turns a read-only verb
 * into a mutating one (per {@link MUTATING_FLAGS} / {@link MUTATING_SHORT_LETTERS}).
 *
 * Three matching modes (all applied):
 *  1. Exact-token long flags: `-i`, `--in-place`, `-delete`, etc.
 *  2. `--flag=value` prefix: `--in-place=.bak` matches `--in-place`.
 *  3. Short-flag cluster/glue (for verbs in {@link MUTATING_SHORT_LETTERS}):
 *     a single-dash non-`--` arg is mutating if any mutating letter appears in
 *     its leading letter-cluster. `-ni.bak` → cluster `ni` → contains `i` →
 *     mutating. `-ibak` → cluster `ibak` → contains `i` → mutating.
 *  4. Dollar-expansion fail-closed (for any mutating-capable verb): if an argv
 *     token contains an unexpanded `$`, the runtime shell may expand it into a
 *     mutating flag (e.g. `sed $IFS-i f`). Fail closed → shell.
 */
function hasMutatingFlag(verb: string, args: readonly string[]): boolean {
  if (!MUTATING_FLAGS.has(verb)) return false;
  // `.get()` is always defined here because `.has()` just returned true;
  // TypeScript cannot narrow Map.get() through .has() so we assert non-null.
  const flagSet = MUTATING_FLAGS.get(verb)!;
  if (flagSet === null) return true; // always-mutating verb

  const shortLetters = MUTATING_SHORT_LETTERS.get(verb);

  for (const arg of args) {
    // Mode 4: dollar-expansion in any arg for this mutating-capable verb.
    if (arg.includes("$")) return true;

    // Mode 1: exact token.
    if (flagSet.has(arg)) return true;

    // Mode 2: `--flag=value` prefix for long flags.
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0 && flagSet.has(arg.slice(0, eq))) return true;
      continue; // long flag — skip short-cluster check
    }

    // Mode 3: short-flag cluster/glue matching.
    // Applies only to single-dash args and verbs with known mutating letters.
    if (arg.startsWith("-") && shortLetters !== undefined) {
      // Extract the leading letter-cluster (stops at first non-ASCII-letter).
      const cluster = /^-([A-Za-z]+)/.exec(arg);
      if (cluster !== null) {
        for (const letter of cluster[1]!) {
          if (shortLetters.has(letter)) return true;
        }
      }
    }
  }
  if (verb === "sed" && hasMutatingSedProgram(args)) return true;
  return false;
}

function hasMutatingSedProgram(args: readonly string[]): boolean {
  let expressionExpected = false;
  let implicitScriptSeen = false;

  for (const arg of args) {
    if (expressionExpected) {
      if (sedScriptHasWriteOrExec(arg)) return true;
      expressionExpected = false;
      continue;
    }

    if (arg === "-e" || arg === "--expression") {
      expressionExpected = true;
      continue;
    }
    if (arg.startsWith("--expression=")) {
      if (sedScriptHasWriteOrExec(arg.slice("--expression=".length))) return true;
      continue;
    }
    if (arg.startsWith("-e") && arg.length > 2) {
      if (sedScriptHasWriteOrExec(arg.slice(2))) return true;
      continue;
    }

    if (arg === "-f" || arg === "--file" || arg.startsWith("-f") || arg.startsWith("--file=")) {
      return true;
    }

    if (arg === "--") {
      implicitScriptSeen = false;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    if (!implicitScriptSeen) {
      implicitScriptSeen = true;
      if (sedScriptHasWriteOrExec(arg)) return true;
    }
  }

  return expressionExpected;
}

function sedScriptHasWriteOrExec(script: string): boolean {
  let i = 0;
  while (i < script.length) {
    i = skipSedSeparators(script, i);
    if (i >= script.length) break;

    const commandStart = skipSedAddresses(script, i);
    if (commandStart < 0 || commandStart >= script.length) break;
    i = commandStart;

    if (script[i] === "!") {
      i = skipSedWhitespace(script, i + 1);
      if (i >= script.length) break;
    }

    const command = script[i];
    if (command === "#") {
      i = skipToSedLineEnd(script, i + 1);
      continue;
    }
    if (command === "{") {
      i += 1;
      continue;
    }
    if (command === "}") {
      i += 1;
      continue;
    }
    if (command === "w" || command === "W" || command === "e" || command === "r" || command === "R") {
      return true;
    }
    if (command === "s") {
      const result = parseSedSubstitute(script, i);
      if (result.mutating) return true;
      i = result.next;
      continue;
    }

    i = skipToNextSedCommand(script, i + 1);
  }
  return false;
}

function skipSedSeparators(script: string, i: number): number {
  while (i < script.length) {
    const ch = script[i];
    if (ch === ";" || ch === "\n" || ch === "\r" || /\s/.test(ch)) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function skipSedWhitespace(script: string, i: number): number {
  while (i < script.length && /\s/.test(script[i]!)) i += 1;
  return i;
}

function skipSedAddresses(script: string, start: number): number {
  let i = start;
  for (let count = 0; count < 2; count += 1) {
    i = skipSedWhitespace(script, i);
    const next = skipSedAddress(script, i);
    if (next === i) break;
    i = skipSedWhitespace(script, next);
    if (script[i] === ",") {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function skipSedAddress(script: string, i: number): number {
  const ch = script[i];
  if (ch === undefined) return i;
  if (/[0-9]/.test(ch)) {
    i += 1;
    while (i < script.length && /[0-9~+]/.test(script[i]!)) i += 1;
    return i;
  }
  if ((ch === "+" || ch === "~") && /[0-9]/.test(script[i + 1] ?? "")) {
    i += 2;
    while (i < script.length && /[0-9]/.test(script[i]!)) i += 1;
    return i;
  }
  if (ch === "$") return i + 1;
  if (ch === "/") return skipSedDelimited(script, i + 1, "/");
  if (ch === "\\" && i + 1 < script.length) {
    return skipSedDelimited(script, i + 2, script[i + 1]!);
  }
  return i;
}

function parseSedSubstitute(script: string, start: number): { mutating: boolean; next: number } {
  if (start + 1 >= script.length) return { mutating: false, next: start + 1 };
  const delimiter = script[start + 1]!;
  if (/\s/.test(delimiter)) return { mutating: false, next: start + 1 };
  const patternEnd = skipSedDelimited(script, start + 2, delimiter);
  if (patternEnd >= script.length) return { mutating: false, next: patternEnd };
  const replacementEnd = skipSedDelimited(script, patternEnd, delimiter);
  if (replacementEnd >= script.length) return { mutating: false, next: replacementEnd };

  let i = replacementEnd;
  while (i < script.length && script[i] !== ";" && script[i] !== "\n" && script[i] !== "\r") {
    const flag = script[i]!;
    if (flag === "w" || flag === "e") return { mutating: true, next: i + 1 };
    i += 1;
  }
  return { mutating: false, next: i };
}

function skipSedDelimited(script: string, start: number, delimiter: string): number {
  let escaped = false;
  for (let i = start; i < script.length; i += 1) {
    const ch = script[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === delimiter) return i + 1;
  }
  return script.length;
}

function skipToNextSedCommand(script: string, start: number): number {
  let escaped = false;
  for (let i = start; i < script.length; i += 1) {
    const ch = script[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "\r") return i + 1;
  }
  return script.length;
}

function skipToSedLineEnd(script: string, start: number): number {
  for (let i = start; i < script.length; i += 1) {
    if (script[i] === "\n" || script[i] === "\r") return i + 1;
  }
  return script.length;
}

/** Reduce `/usr/bin/ls` → `ls`; leave bare verbs unchanged. */
function stripPath(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash >= 0 ? token.slice(slash + 1) : token;
}

/**
 * Collect canonicalized path arguments from the call. Uses `pathFields` as the
 * primary selectors but the containment check below is what closes the
 * traversal vector — the declaration alone is advisory.
 */
function extractCallPaths(
  input: Record<string, unknown>,
  pathFields: readonly string[],
): string[] {
  const paths: string[] = [];
  for (const field of pathFields) {
    const candidate = getDottedFieldValue(input, field);
    const values = Array.isArray(candidate) ? candidate : [candidate];
    for (const value of values) {
      if (typeof value === "string" && value.length > 0) {
        paths.push(caseFoldForMatch(canonicalizePathForMatch(value)));
      }
    }
  }
  return [...new Set(paths)];
}

function getDottedFieldValue(input: Record<string, unknown>, field: string): unknown {
  let current: unknown = input;
  for (const segment of field.split(".")) {
    if (segment.length === 0) return undefined;
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Containment check against canonicalized allowed dirs. Inputs MUST already be
 * canonicalized (same invariant as {@link RuleBasedRiskClassifier}).
 */
function isInsideAllowed(path: string, allowed: readonly string[]): boolean {
  for (const a of allowed) {
    if (path === a || path.startsWith(a + "/")) return true;
  }
  return false;
}
