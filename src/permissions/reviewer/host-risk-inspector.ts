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
  "awk", "sed", "diff", "cmp", "basename", "dirname", "realpath", "readlink",
  "true", "false", "test", "sleep", "seq", "yes", "tr", "nl", "tac", "rev",
  "column", "comm", "join", "paste", "expand", "unexpand", "fold", "split",
]);

/**
 * Wrapper commands that delegate to a real command in a later operand. Claude
 * Code strips these before classifying. The effective verb is the first
 * operand that is not itself a wrapper or an option flag.
 */
const WRAPPER_COMMANDS: ReadonlySet<string> = new Set([
  "timeout", "nice", "ionice", "nohup", "stdbuf", "env", "command", "xargs",
  "time", "watch",
]);

/** git subcommands that are read-only (no mutation of the working tree / refs). */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "branch", "remote", "config", "rev-parse",
  "describe", "blame", "shortlog", "ls-files", "ls-tree", "cat-file",
  "for-each-ref", "reflog", "tag", "whatchanged",
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
 * subcommand). Compound separators `&& || ; |` and newlines split leaves;
 * wrapper commands (`timeout`, `nice`, `xargs`, …) are stripped to reach the
 * real verb. Any unknown verb fails the whole command closed.
 */
export function isReadOnlyCommand(command: string): boolean {
  // Redirections (`>`, `>>`, `<`) and command substitution (`$(…)`, backticks)
  // can write files or execute hidden commands the head-verb scan cannot see
  // (`echo hi > out`, `ls $(rm -rf /)`). Default-strict: a command carrying any
  // of these is not provably read-only. (Bare `${VAR}` parameter expansion does
  // NOT execute, so it is not treated as mutating.)
  if (/[<>`]|\$\(/.test(command)) return false;
  const leaves = splitCompound(command);
  if (leaves.length === 0) return false;
  return leaves.every((leaf) => isReadOnlyLeaf(leaf));
}

/** Split a compound command on `&& || ; | & \n` into trimmed non-empty leaves. */
function splitCompound(command: string): string[] {
  return command
    .split(/(?:&&|\|\||[;|&\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isReadOnlyLeaf(leaf: string): boolean {
  const tokens = tokenize(leaf);
  let i = 0;
  // Strip leading VAR=value assignments (e.g. `FOO=bar ls`).
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i += 1;
  // Strip wrapper commands and their option flags to reach the real verb.
  let lastWrapper: string | undefined;
  while (i < tokens.length) {
    const head = stripPath(tokens[i]!);
    if (WRAPPER_COMMANDS.has(head)) {
      lastWrapper = head;
      i += 1;
      // Skip option flags that belong to the wrapper (e.g. `timeout -s KILL 5s`).
      while (i < tokens.length && tokens[i]!.startsWith("-")) i += 1;
      // For wrappers that take a non-flag operand before the command
      // (e.g. `timeout 5s ls`, `nice -n 5 ls`), skip a single numeric/duration
      // operand so the next token is the real verb.
      if (i < tokens.length && /^[0-9]+[smhd]?$/.test(tokens[i]!)) i += 1;
      continue;
    }
    break;
  }
  // A wrapper used with no following command (bare `env`, which prints the
  // environment) is read-only iff the wrapper verb is itself a read-only
  // command. `timeout`/`nice` alone are incomplete → non-read-only (safe).
  if (i >= tokens.length) {
    return lastWrapper !== undefined && READ_ONLY_COMMANDS.has(lastWrapper);
  }
  const verb = stripPath(tokens[i]!);
  if (verb === "git") {
    const sub = tokens[i + 1];
    return typeof sub === "string" && READ_ONLY_GIT_SUBCOMMANDS.has(sub);
  }
  return READ_ONLY_COMMANDS.has(verb);
}

/** Naive whitespace tokenizer — sufficient for head-verb identification. */
function tokenize(leaf: string): string[] {
  return leaf.split(/\s+/).filter((t) => t.length > 0);
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
