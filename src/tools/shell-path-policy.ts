import { homedir } from "node:os";
import { isAbsolute, resolve as pathResolve } from "node:path";

import { t } from "../i18n/index.js";
import { stripCommandPath, tokenizeShell } from "../shared/shell-tokenizer.js";
import { validateSandboxPath } from "../sandbox/path-validator.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "../permissions/sensitive-paths.js";
import { errorMessage } from "../shared/error-message.js";

export type ShellPathPolicyViolationKind =
  | "dynamic-path"
  | "invalid-path"
  | "recursive-traversal"
  | "sandbox-boundary"
  | "sensitive-path";

export interface ShellPathPolicyViolation {
  kind: ShellPathPolicyViolationKind;
  reason: string;
  candidate?: string;
  path?: string;
}

const DYNAMIC_PATH_COMPOSITION_COMMANDS = new Set([
  "join-path",
  "resolve-path",
  "convert-path",
  "new-psdrive",
]);

const BARE_SENSITIVE_FILENAMES = [
  /^\.env(?:\..*)?$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.npmrc$/i,
  /^\.bash_history$/i,
  /^\.zsh_history$/i,
  /^\.python_history$/i,
  /^\.psql_history$/i,
  /^\.viminfo$/i,
  /^id_(?:rsa|ed25519|ecdsa)(?:\.pub)?$/i,
  /^credentials$/i,
  /^config\.json$/i,
  /^Login Data$/i,
];

const RECURSIVE_TRAVERSAL_COMMANDS = new Set([
  "fd",
  "fdfind",
  "find",
  "rg",
  "tar",
  "tree",
  "unzip",
  "zip",
]);

const RECURSIVE_FLAG_COMMANDS = new Map<string, readonly string[]>([
  ["cp", ["-r", "-R", "--recursive"]],
  ["du", ["-a", "--all"]],
  ["egrep", ["-r", "-R", "--recursive", "--dereference-recursive"]],
  ["fgrep", ["-r", "-R", "--recursive", "--dereference-recursive"]],
  ["grep", ["-r", "-R", "--recursive", "--dereference-recursive"]],
  ["ls", ["-R"]],
  ["mv", ["-r", "-R", "--recursive"]],
]);

const SHELL_NULL_DEVICE_PATH = "/dev/null";

export function validateShellWorkingDirectory(
  cwd: string,
  sandboxRoot: string,
  extraAllowedDirectories: readonly string[],
): string | null {
  const sensitive = isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(cwd)));
  if (sensitive) {
    return `Sensitive path: cwd ${cwd} matches ${sensitive}`;
  }
  const check = validateSandboxPath(cwd, sandboxRoot, [...extraAllowedDirectories]);
  return check.allowed ? null : `Sandbox: ${check.reason}`;
}

export function findShellPathPolicyViolation(
  command: string,
  cwd: string,
  sandboxRoot: string,
  extraAllowedDirectories: readonly string[],
): ShellPathPolicyViolation | null {
  const cwdSensitive = isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(cwd)));
  if (cwdSensitive) {
    return {
      kind: "sensitive-path",
      reason: `Sensitive path: cwd ${cwd} matches ${cwdSensitive}`,
      path: cwd,
    };
  }
  const cwdCheck = validateSandboxPath(cwd, sandboxRoot, [...extraAllowedDirectories]);
  if (!cwdCheck.allowed) {
    return {
      kind: "sandbox-boundary",
      reason: `Sandbox: ${cwdCheck.reason}`,
      path: cwd,
    };
  }

  const recursiveTraversal = findUnsafeRecursiveTraversal(command);
  if (recursiveTraversal) {
    return { kind: "recursive-traversal", reason: recursiveTraversal };
  }
  const dynamicPathComposition = findDynamicPathComposition(command);
  if (dynamicPathComposition) {
    return { kind: "dynamic-path", reason: dynamicPathComposition };
  }
  // Operands are checked twice, against two different base directories.
  //
  // The scan below resolves every candidate against the SESSION cwd. That is
  // the historical check and it stays exactly as it was, so nothing that used
  // to be caught stops being caught.
  //
  // What it cannot see is `cd`. A relative operand means nothing without the
  // directory it resolves against, and `cd` changes that directory mid-command.
  // Resolving everything against the session cwd let
  // `cd /tmp && cat ../../etc/passwd` through: statically that reads
  // `<session cwd>/../../etc/passwd`, comfortably inside the boundary, while
  // the shell reads `/etc/passwd`. The per-leaf walk below resolves each
  // operand against the cwd actually in effect when that leaf runs.
  //
  // Two checks rather than one replacing the other: the per-leaf walk reads
  // operands out of the shared tokenizer's argv, which is a different extractor
  // from the flat scan. Any candidate one of them does not see, the other
  // still does. For a containment check, missing an operand is the failure that
  // matters, so both run.
  const leafViolation = findCwdAwareLeafViolation(command, cwd, sandboxRoot, extraAllowedDirectories);
  if (leafViolation) return leafViolation;

  const candidates = extractPathCandidates(command);
  for (const candidate of candidates) {
    if (isIgnoredShellDeviceCandidate(candidate)) {
      continue;
    }
    let absolute: string;
    try {
      absolute = resolveCandidatePath(candidate, cwd);
    } catch (err) {
      return {
        kind: "invalid-path",
        reason: errorMessage(err),
        candidate,
      };
    }
    if (isIgnoredShellDevicePath(absolute)) {
      continue;
    }
    const sensitive = isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(absolute)));
    if (sensitive) {
      return {
        kind: "sensitive-path",
        reason: `Sensitive path: command operand ${candidate} matches ${sensitive}`,
        candidate,
        path: absolute,
      };
    }
    const check = validateSandboxPath(absolute, sandboxRoot, [...extraAllowedDirectories]);
    if (!check.allowed) {
      return {
        kind: "sandbox-boundary",
        reason: `Sandbox: ${check.reason}`,
        candidate,
        path: absolute,
      };
    }
  }
  return null;
}

/**
 * Walk the command's leaves in order, tracking the working directory each one
 * actually runs in, and check that leaf's operands against THAT directory.
 *
 * Leaf boundaries come from the shared {@link tokenizeShell} SOT — the same one
 * the risk classifier splits on — so the two agree on what a command is. This
 * module's own flat tokenizer has no notion of a leaf and therefore no notion
 * of order, which is why it cannot do this.
 *
 * Every reference agent host that gates shell commands evaluates a compound
 * command per segment rather than as one string, because an allowed segment
 * otherwise becomes a prefix that carries an arbitrary one after it. This is
 * that same rule applied to path containment: `cd` is the segment whose effect
 * is to redefine what the following segments' relative operands mean.
 *
 * Conservative where it cannot be precise:
 *  - a `cd` whose destination is not decidable from argv alone stops the walk
 *    with a violation rather than being skipped. Skipping re-opens the escape
 *    for exactly the inputs an attacker controls.
 *  - a `cd` is treated as affecting every later leaf even where the shell would
 *    scope it (a subshell, or a pipeline stage). Over-applying it can only
 *    reject a command that would have stayed inside the boundary; under-
 *    applying it is what produced the escape.
 */
function findCwdAwareLeafViolation(
  command: string,
  cwd: string,
  sandboxRoot: string,
  extraAllowedDirectories: readonly string[],
): ShellPathPolicyViolation | null {
  const { leaves, parseError } = tokenizeShell(command);
  // A command the SOT tokenizer cannot parse has no trustworthy leaf order, so
  // this walk claims nothing about it. The flat scan below still runs, as do
  // the recursive-traversal and dynamic-composition guards above, and the risk
  // classifier independently fails a parse error closed.
  if (parseError) return null;

  let current = cwd;
  for (const leaf of leaves) {
    const operands = [...leaf.argv, ...leaf.redirectTargets];
    // `/`-only basename reduction, matching the risk classifier — the two must
    // agree on what verb a leaf runs. A Windows-style `C:\\tools\\cd` is not
    // reduced by either, so both see the full token and neither treats it as
    // `cd`; that is a shared gap, not a disagreement, and closing it belongs
    // with the shared helper rather than here.
    const isCd = leaf.argv.length > 0 && stripCommandPath(leaf.argv[0]!) === "cd";

    // `cd`'s own destination is checked as an operand like any other, so a
    // `cd` that leaves the boundary is caught here and not merely tracked.
    for (const operand of isCd ? operands.slice(1) : operands) {
      const violation = checkOperandAgainstBase(operand, current, sandboxRoot, extraAllowedDirectories);
      if (violation) return violation;
    }

    if (!isCd) continue;

    const destination = resolveCdDestination(leaf.argv.slice(1), current);
    if (destination === null) {
      return {
        kind: "dynamic-path",
        reason:
          `Dynamic path: cd destination in \`${leaf.argv.join(" ")}\` cannot be resolved before running, ` +
          "so the paths used after it cannot be checked. Use an absolute path, or set the working directory on the call instead.",
      };
    }

    // Check the RESOLVED destination, not just the operand text that produced
    // it. A bare `cd` carries no operand at all and goes home, so an
    // operand-only check waved it through — and since a bare filename is not a
    // path candidate, every `cat foo` after it went unchecked too.
    //
    // Confining the destination is what makes those bare operands safe to keep
    // ignoring: if every directory the command can stand in is inside the
    // boundary, a name resolved against one of them is inside it as well.
    const destinationViolation = checkResolvedPath(destination, leaf.argv.join(" "), sandboxRoot, extraAllowedDirectories);
    if (destinationViolation) return destinationViolation;

    current = destination;
  }
  return null;
}

/**
 * Run one operand through the same sensitive-path and sandbox checks the flat
 * scan applies, but against a caller-chosen base directory.
 */
function checkOperandAgainstBase(
  operand: string,
  base: string,
  sandboxRoot: string,
  extraAllowedDirectories: readonly string[],
): ShellPathPolicyViolation | null {
  for (const part of splitCandidateParts(operand)) {
    const candidate = normalizeCandidate(part);
    if (!candidate || !looksLikePath(candidate)) continue;
    if (isIgnoredShellDeviceCandidate(candidate)) continue;

    let absolute: string;
    try {
      absolute = resolveCandidatePath(candidate, base);
    } catch (err) {
      return {
        kind: "invalid-path",
        reason: errorMessage(err),
        candidate,
      };
    }
    if (isIgnoredShellDevicePath(absolute)) continue;

    const violation = checkResolvedPath(absolute, candidate, sandboxRoot, extraAllowedDirectories);
    if (violation) return violation;
  }
  return null;
}

/**
 * Apply the sensitive-path and sandbox-boundary rules to an already-resolved
 * absolute path. `label` is what the violation reports as the operand, so the
 * message names something the user can find in the command they wrote.
 */
function checkResolvedPath(
  absolute: string,
  label: string,
  sandboxRoot: string,
  extraAllowedDirectories: readonly string[],
): ShellPathPolicyViolation | null {
  const sensitive = isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(absolute)));
  if (sensitive) {
    return {
      kind: "sensitive-path",
      reason: `Sensitive path: command operand ${label} matches ${sensitive}`,
      candidate: label,
      path: absolute,
    };
  }
  const check = validateSandboxPath(absolute, sandboxRoot, [...extraAllowedDirectories]);
  if (!check.allowed) {
    return {
      kind: "sandbox-boundary",
      reason: `Sandbox: ${check.reason}`,
      candidate: label,
      path: absolute,
    };
  }
  return null;
}

/**
 * Where a `cd` leaf lands, or `null` when argv alone does not decide it.
 *
 * `null` is returned for `cd -` (OLDPWD) and for an operand still carrying an
 * unexpanded `$…` — both name a value the command text does not contain.
 * A bare `cd` IS decidable: it goes to the home directory, which is then
 * checked against the boundary like any other destination.
 *
 * `-L`/`-P` select how symlinks are resolved, not where to go, so they are
 * skipped rather than mistaken for the destination.
 */
function resolveCdDestination(args: readonly string[], from: string): string | null {
  const operands = args.filter((arg) => arg !== "-L" && arg !== "-P" && arg !== "--");
  if (operands.length === 0) return homedir();
  const operand = operands[0]!;
  if (operand === "-") return null;
  try {
    const resolved = resolveCandidatePath(operand, from);
    return resolved.includes("$") ? null : resolved;
  } catch {
    return null;
  }
}

function isIgnoredShellDevicePath(canonicalPath: string): boolean {
  return canonicalPath === SHELL_NULL_DEVICE_PATH;
}

function isIgnoredShellDeviceCandidate(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, "/").toLowerCase();
  return normalized === SHELL_NULL_DEVICE_PATH || normalized === "nul";
}

export function validateShellCommandPathPolicy(
  command: string,
  cwd: string,
  sandboxRoot: string,
  extraAllowedDirectories: readonly string[],
): string | null {
  return findShellPathPolicyViolation(command, cwd, sandboxRoot, extraAllowedDirectories)?.reason ?? null;
}

/**
 * Map of recursive-traversal shell commands → equivalent LVIS builtin tool.
 *
 * The block message threads this hint through so the LLM agent (or human
 * operator reading the error) can retry with a sandbox-aware alternative
 * instead of re-narrowing into an unrelated subdirectory — the failure mode
 * observed when a model fell back from `find /Users/example/Documents` to
 * `list_files /Users/example/Documents/journals` (a guessed sub-path) rather
 * than `list_files /Users/example/Documents` (the original target).
 *
 * Entries that map to "(no direct LVIS equivalent)" still receive the
 * "preserve the original target path" instruction so the LLM doesn't
 * silently scope down on retry.
 */
/**
 * Map keys MUST be a subset of `RECURSIVE_TRAVERSAL_COMMANDS` ∪
 * `RECURSIVE_FLAG_COMMANDS` — any key outside that union is dead code (the
 * lookup site is only reached when one of those two sets matches). Tests in
 * `__tests__/shell-path-policy.test.ts` lock the mapped-vs-fallback contract.
 */
const LVIS_ALTERNATIVE_BY_COMMAND: Readonly<Record<string, string>> = {
  // Traversal commands (RECURSIVE_TRAVERSAL_COMMANDS):
  find: "be_shellPathPolicy.altFind",
  fd: "be_shellPathPolicy.altFd",
  fdfind: "be_shellPathPolicy.altFdfind",
  rg: "be_shellPathPolicy.altRg",
  tree: "be_shellPathPolicy.altTree",
  tar: "be_shellPathPolicy.altTar",
  unzip: "be_shellPathPolicy.altUnzip",
  zip: "be_shellPathPolicy.altZip",
  // Flag-recursive commands (RECURSIVE_FLAG_COMMANDS):
  grep: "be_shellPathPolicy.altGrep",
  egrep: "be_shellPathPolicy.altEgrep",
  fgrep: "be_shellPathPolicy.altFgrep",
  cp: "be_shellPathPolicy.altCp",
  mv: "be_shellPathPolicy.altMv",
};

function buildRecursiveBlockMessage(
  commandToken: string,
  commandName: string,
  flag?: string,
): string {
  const head = flag
    ? `Sandbox: recursive shell filesystem traversal is not allowed: ${commandToken} ${flag}`
    : `Sandbox: recursive shell filesystem traversal is not allowed: ${commandToken}`;
  const altKey = LVIS_ALTERNATIVE_BY_COMMAND[commandName];
  const alt = altKey ? t(altKey) : undefined;
  const guidance = alt
    ? ` ${t("be_shellPathPolicy.guidanceWithAlt", { alt })}`
    : ` ${t("be_shellPathPolicy.guidanceNoAlt")}`;
  return head + guidance;
}

function findUnsafeRecursiveTraversal(command: string): string | null {
  for (const segment of splitCommandSegments(command)) {
    const tokens = tokenizeCommand(segment);
    const commandIndex = tokens.findIndex((token) => !isAssignmentToken(token));
    if (commandIndex < 0) continue;
    const commandName = normalizeCommandName(tokens[commandIndex]);
    if (!commandName) continue;
    if (RECURSIVE_TRAVERSAL_COMMANDS.has(commandName)) {
      return buildRecursiveBlockMessage(tokens[commandIndex], commandName);
    }
    const recursiveFlags = RECURSIVE_FLAG_COMMANDS.get(commandName);
    if (recursiveFlags) {
      const args = tokens.slice(commandIndex + 1);
      const flag = args.find((arg) => recursiveFlags.some((candidate) => hasShellFlag(arg, candidate)));
      if (flag) {
        return buildRecursiveBlockMessage(tokens[commandIndex], commandName, flag);
      }
    }
  }
  return null;
}

function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let segment = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaping = false;
  for (const ch of command) {
    if (escaping) {
      segment += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      segment += ch;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      segment += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      segment += ch;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      if (segment.trim()) segments.push(segment);
      segment = "";
      continue;
    }
    segment += ch;
  }
  if (segment.trim()) segments.push(segment);
  return segments;
}

function isAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function normalizeCommandName(token: string): string {
  const cleaned = token
    .replace(/^[({]+/g, "")
    .replace(/[),]+$/g, "")
    .trim();
  const basename = cleaned.split(/[\\/]/).pop() ?? cleaned;
  return basename.toLowerCase();
}

function hasShellFlag(token: string, flag: string): boolean {
  if (token === flag) return true;
  if (flag.length === 2 && /^-[A-Za-z]+$/.test(token)) {
    return token.slice(1).includes(flag[1]);
  }
  if (flag.startsWith("--")) {
    return token === flag || token.startsWith(flag + "=");
  }
  return false;
}

function findDynamicPathComposition(command: string): string | null {
  if (hasDynamicPathExpression(command)) {
    return "Sandbox: dynamic path composition is not allowed";
  }
  for (const token of tokenizeCommand(command)) {
    const normalized = token
      .replace(/^[({]+/g, "")
      .replace(/[),]+$/g, "")
      .trim()
      .toLowerCase();
    if (DYNAMIC_PATH_COMPOSITION_COMMANDS.has(normalized)) {
      return `Sandbox: dynamic path composition is not allowed: ${token}`;
    }
  }
  return null;
}

function hasDynamicPathExpression(command: string): boolean {
  return (
    /\[(?:system\.)?io\.path\]::combine\s*\(/i.test(command) ||
    /\$(?:home|env:home|pwd|env:pwd|tmpdir|env:tmpdir)\b[^|;\n]*\+/.test(command) ||
    /\+[^|;\n]*\$(?:home|env:home|pwd|env:pwd|tmpdir|env:tmpdir)\b/i.test(command)
  );
}

function extractPathCandidates(command: string): string[] {
  const candidates: string[] = [];
  for (const token of tokenizeCommand(command)) {
    for (const part of splitCandidateParts(token)) {
      const normalized = normalizeCandidate(part);
      if (normalized && looksLikePath(normalized)) {
        candidates.push(normalized);
      }
    }
  }
  return [...new Set(candidates)];
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaping = false;
  for (const ch of command) {
    if (escaping) {
      token += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      token += ch;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch) || ch === "|" || ch === ";") {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += ch;
  }
  if (token) tokens.push(token);
  return tokens;
}

function splitCandidateParts(token: string): string[] {
  const parts: string[] = [];
  // Glued short-flag value: `-o/Users/x/.ssh/authorized_keys`, `-I/etc`.
  // Without this the whole token is the only candidate, and because it starts
  // with `-` it resolves RELATIVE to the sandbox cwd (`<cwd>/-o/Users/…`) — a
  // path that is inside the sandbox, so the real target was never checked.
  // Splitting off the value after the leading letter-cluster gives the policy
  // the path the command will actually open. It goes FIRST so the violation the
  // caller reports names the real target rather than the pseudo-relative one.
  //
  // The value alternatives are what makes this work on both platforms. A POSIX
  // target starts the value at `/`, `~`, or `.`; a Windows one starts it at a
  // drive letter (`-oC:\\Users\\…`) or a root-relative separator. Without the
  // drive alternative the cluster swallowed the drive letter, the colon matched
  // nothing, and the token fell through to the pseudo-relative resolution this
  // split exists to prevent — so on Windows the glued form was never checked at
  // all. The cluster is lazy so the value alternatives decide where it ends;
  // for a POSIX token that lands on exactly the same split as the greedy form.
  const glued = /^-[A-Za-z]+?([/~.\\].*|[A-Za-z]:[\\/].*)$/.exec(token);
  if (glued && !token.startsWith("--")) {
    parts.push(glued[1]!);
  }
  parts.push(token);
  const eq = token.indexOf("=");
  if (eq > 0 && eq < token.length - 1) {
    parts.push(token.slice(eq + 1));
  }
  for (const part of token.split(/\d*(?:>>?|<<?|&>|2>|2>>)+/g)) {
    if (part && part !== token) parts.push(part);
  }
  return parts;
}

function normalizeCandidate(token: string): string | null {
  const trimmed = token
    .replace(/^\d*(?:>>?|<<?|&>|2>|2>>)+/, "")
    .replace(/[),]+$/g, "")
    .trim();
  return trimmed.length > 0 ? trimmed : null;
}

function looksLikePath(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (BARE_SENSITIVE_FILENAMES.some((pattern) => pattern.test(value))) return true;
  return (
    value === "~" ||
    /^~[^/\\]+$/.test(value) ||
    /^~[^/\\]+[/\\]/.test(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith("~/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.includes("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function resolveCandidatePath(value: string, cwd: string): string {
  const expandedVars = expandShellPathVariables(value, cwd);
  if (expandedVars.includes("$") || expandedVars.includes("%")) {
    throw new Error(`Sandbox: unresolved shell variable in path operand ${value}`);
  }
  if (
    expandedVars.startsWith("~") &&
    expandedVars !== "~" &&
    !expandedVars.startsWith("~/") &&
    !expandedVars.startsWith("~\\")
  ) {
    throw new Error(`Sandbox: unsupported user-home expansion in path operand ${value}`);
  }
  const expanded = expandedVars === "~"
    ? homedir()
    : expandedVars.startsWith("~/") || expandedVars.startsWith("~\\")
      ? pathResolve(homedir(), expandedVars.slice(2))
      : expandedVars;
  const resolved = isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)
    ? pathResolve(expanded)
    : pathResolve(cwd, expanded);
  return canonicalizePathForMatch(resolved);
}

function expandShellPathVariables(value: string, cwd: string): string {
  const tmpDir = process.env.TMPDIR;
  return value
    .replace(/\$\{HOME\}|\$HOME|\$env:HOME/g, homedir())
    .replace(/\$\{PWD\}|\$PWD|\$env:PWD/g, cwd)
    .replace(/\$\{TMPDIR\}|\$TMPDIR|\$env:TMPDIR/g, tmpDir ?? "$TMPDIR")
    .replace(/%USERPROFILE%/gi, homedir())
    .replace(/%CD%/gi, cwd)
    .replace(/%TMP%|%TEMP%/gi, tmpDir ?? "%TMP%");
}
