import { homedir } from "node:os";
import { isAbsolute, resolve as pathResolve } from "node:path";

import { t } from "../i18n/index.js";
import { redactHeredocBodies, stripCommandPath, tokenizeShell } from "../shared/shell-tokenizer.js";
import { validateSandboxPath } from "../sandbox/path-validator.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "../permissions/sensitive-paths.js";
import { sedScriptHasWriteOrExec } from "../permissions/reviewer/host-risk-inspector.js";
import { errorMessage } from "../shared/error-message.js";
import { expandLeadingTilde } from "../shared/home-tilde.js";

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
  return findViolationInCommand(command, cwd, sandboxRoot, extraAllowedDirectories, 0);
}

/**
 * How deep {@link findViolationInCommand} follows `$(…)` nesting before it
 * stops descending. A substitution nested past this is still checked as TEXT by
 * the enclosing scan (its `$` keeps a path operand dynamic); only the extra
 * command-level pass is dropped, so the bound trades depth for termination
 * without giving anything up.
 */
const COMMAND_SUBSTITUTION_SCAN_DEPTH = 4;

function findViolationInCommand(
  rawCommand: string,
  cwd: string,
  sandboxRoot: string,
  extraAllowedDirectories: readonly string[],
  depth: number,
): ShellPathPolicyViolation | null {
  // A quoted heredoc body is stdin data, not commands — see
  // `redactHeredocBodies`. Removing it here rather than inside each extractor
  // keeps the flat scan and the leaf walk reading the same text.
  const command = redactHeredocBodies(rawCommand);
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
  // `$(…)` and backticks hold COMMANDS, so their operands are checked by
  // running this whole policy over the substitution body. Without this pass the
  // body was only ever read as path text: `$(wc -l < /tmp/x)` reported an
  // unresolved variable and `/tmp/x` itself was never judged. Nothing is
  // subtracted here — the enclosing scan still sees the substitution text, so a
  // path operand built out of one (`/tmp/$(basename "$f")`) stays a dynamic
  // path.
  // A `sh -c '…'` payload is a command line too, and one this policy can read.
  // Re-entering it is what makes `sh -c 'cat /etc/passwd'` visible: the value
  // is program text, so exempting it as such left the operand inside
  // completely unexamined.
  if (depth < COMMAND_SUBSTITUTION_SCAN_DEPTH) {
    for (const body of [
      ...extractCommandSubstitutionBodies(command),
      ...extractNestedShellCommands(command),
    ]) {
      const violation = findViolationInCommand(
        body,
        cwd,
        sandboxRoot,
        extraAllowedDirectories,
        depth + 1,
      );
      if (violation) return violation;
    }
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
    // Redirect targets on BOTH sides are files whatever the verb is, so they
    // are never eligible for the non-path-operand skip. Input sources matter as
    // much as output ones: `tr -d x < key` reaches a file that appears in no
    // argv position at all.
    const slots = classifyOperandSlots(leaf.argv);
    const nonPathArgv = slots.nonPathIndices;
    const operands = [
      ...leaf.argv.filter((_, index) => !nonPathArgv.has(index)),
      ...slots.extraCandidates,
      ...leaf.redirectTargets,
      ...leaf.inputRedirectTargets,
    ];
    // `/`-only basename reduction, matching the risk classifier — the two must
    // agree on what verb a leaf runs. A Windows-style `C:\\tools\\cd` is not
    // reduced by either, so both see the full token and neither treats it as
    // `cd`; that is a shared gap, not a disagreement, and closing it belongs
    // with the shared helper rather than here.
    //
    // The verb is read PAST any leading shell keyword, for the same reason the
    // slot rules are: a loop body arrives as `do cd "$f"`, and a scan that
    // stops at `do` never sees the `cd` — so the dynamic-destination guard
    // below did not run and every later relative operand was resolved against
    // a directory the command had already left.
    const verbIndex = leadingKeywordCount(leaf.argv);
    const verb = leaf.argv[verbIndex];
    const isCd = verb !== undefined && stripCommandPath(verb) === "cd";

    // `cd`'s own destination is checked as an operand like any other, so a
    // `cd` that leaves the boundary is caught here and not merely tracked.
    for (const operand of isCd ? operands.slice(verbIndex + 1) : operands) {
      const violation = checkOperandAgainstBase(operand, current, sandboxRoot, extraAllowedDirectories);
      if (violation) return violation;
    }

    if (!isCd) continue;

    const destination = resolveCdDestination(leaf.argv.slice(verbIndex + 1), current);
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

/**
 * Which argument slots a command reads as PROGRAM TEXT, a PATTERN or an output
 * FORMAT rather than as a filesystem path.
 *
 * DENY-LIST, NOT ALLOW-LIST. The policy's default stays "any operand that looks
 * like a path is one" — an unknown command, and every option this table has
 * never heard of, keeps being checked exactly as before. Only slots whose
 * meaning is fixed by the command's own interface are exempted. Inverting it
 * (treating an operand as a path only where an allow-list says so) would stop
 * checking `--output=/etc/passwd` on any tool not yet listed, which is the
 * failure this control exists to prevent.
 *
 * WHAT IT BUYS. A quoted script is a single token, so the scan was reading
 * `awk '{print $1}'` and `Rscript -e 'read.csv("…")'` as path operands and
 * refusing them for carrying a `$`. It never gained anything by doing so: an
 * embedded path sits mid-token, and a mid-token path resolves RELATIVE to the
 * cwd (`<cwd>/read.csv("/app/x.csv"`), which lands inside the boundary. The
 * check produced noise and no containment, and what really confines an
 * interpreter's own file access is the OS sandbox the child runs under.
 */
interface NonPathOperandSpec {
  /** Options whose value — next token, or `--opt=value` — is code/pattern/format. */
  valueOptions?: ReadonlySet<string>;
  /**
   * Options that take a value which stays path-checked. Listing them is not
   * decoration: an unconsumed value becomes the next POSITIONAL, so for a
   * command whose first positional is its program (`awk`), `-v f=<path>` would
   * otherwise be mistaken for the awk program and exempted.
   */
  pathValueOptions?: ReadonlySet<string>;
  /** Cluster form of a code-carrying option, e.g. perl's `-ne` / `-lpe`. */
  clusteredCodeOption?: RegExp;
  /** True when the first non-option operand is the program/pattern. */
  firstPositionalIsProgram?: true;
  /** Options that supply the program elsewhere, freeing the first positional to be a path again. */
  programSuppliedBy?: ReadonlySet<string>;
  /**
   * Decline the exemption when the value is a BARE path — one word, shaped like
   * a path. Set for slots whose value the command will open or execute if it
   * happens to be one: `sh -c /etc/evil.sh` runs that file, and a grep pattern
   * that is a lone path is the same string a filename operand would be.
   *
   * NOT set for `sed`/`awk`, where a lone `/…/` is address or regex syntax and
   * declining would refuse `sed -e '/^class/p'`. Their real file access is
   * covered instead by {@link sedScriptHasWriteOrExec} and, for awk, by awk
   * being excluded from the read-only verb set so every call is reviewed.
   */
  declineBarePathValue?: true;
  /**
   * Options whose value is a shell command LINE, not opaque program text.
   * `sh -c 'cat /etc/passwd'` is a command this policy can read, so its value
   * is re-entered through the whole policy the way a `$(…)` body is, instead
   * of being exempted and forgotten.
   */
  nestedCommandOptions?: ReadonlySet<string>;
}

/**
 * Code-carrying options, PER INTERPRETER.
 *
 * There is no shared set, and the absence is the point. One list applied to
 * every interpreter swallowed the operand after any flag that happened to
 * spell the same letter somewhere else: `bash -e` is errexit and `python3 -E`
 * ignores the environment, so `bash -e /etc/evil.sh` read as "`-e` carries
 * code" and exempted the script path that followed. Same for `php -e`
 * (extended info — php's code option is `-r`) and `deno -c` (a config FILE).
 * Every entry below is a flag that verb documents as taking program text.
 */
const SHELL_CODE_OPTIONS = new Set(["-c"]);
const PYTHON_CODE_OPTIONS = new Set(["-c"]);
const NODE_CODE_OPTIONS = new Set(["-e", "--eval", "-p", "--print"]);
const DENO_CODE_OPTIONS = new Set(["-e", "--eval"]);
/** php: `-r` runs code, `-B`/`-R`/`-E` are begin/each-line/end code. `-F` takes a FILE. */
const PHP_CODE_OPTIONS = new Set(["-r", "-B", "-R", "-E"]);
const EXPRESSION_CODE_OPTIONS = new Set(["-e", "--eval"]);
/** perl/ruby: `-e` and perl's feature-enabled `-E`. */
const PERL_CODE_OPTIONS = new Set(["-e", "-E"]);
/** perl/ruby cluster options ending in `e` take the program as the next word (`-ne`, `-lpe`). */
const PERL_CLUSTERED_CODE_OPTION = /^-[A-Za-z]*[eE]$/;

const NON_PATH_OPERAND_SPECS: ReadonlyMap<string, NonPathOperandSpec> = new Map<string, NonPathOperandSpec>([
  // Shell family: `-c` carries a command LINE, so its value is re-entered as a
  // command rather than merely exempted — see `nestedCommandOption`.
  ...(["sh", "bash", "zsh", "dash", "ksh"] as const).map((verb) => [verb, {
    valueOptions: SHELL_CODE_OPTIONS,
    nestedCommandOptions: SHELL_CODE_OPTIONS,
    declineBarePathValue: true,
  }] as [string, NonPathOperandSpec]),
  ...(["python", "python2", "python3"] as const).map((verb) => [verb, {
    valueOptions: PYTHON_CODE_OPTIONS,
    declineBarePathValue: true,
  }] as [string, NonPathOperandSpec]),
  ["node", { valueOptions: NODE_CODE_OPTIONS, declineBarePathValue: true }],
  ...(["deno", "bun"] as const).map((verb) => [verb, {
    valueOptions: DENO_CODE_OPTIONS,
    declineBarePathValue: true,
  }] as [string, NonPathOperandSpec]),
  ["php", { valueOptions: PHP_CODE_OPTIONS, declineBarePathValue: true }],
  ...(["rscript", "r", "lua", "osascript"] as const).map((verb) => [verb, {
    valueOptions: EXPRESSION_CODE_OPTIONS,
    declineBarePathValue: true,
  }] as [string, NonPathOperandSpec]),
  ...(["perl", "ruby"] as const).map((verb) => [verb, {
    valueOptions: PERL_CODE_OPTIONS,
    clusteredCodeOption: PERL_CLUSTERED_CODE_OPTION,
    declineBarePathValue: true,
  }] as [string, NonPathOperandSpec]),
  // awk: the program is the first positional unless `-f` names a program FILE
  // (which is a path, and stays one). `-v`/`-F` carry assignments and field
  // separators.
  // awk: `-v` is deliberately ABSENT. An awk variable can name a file the
  // program then opens (`getline < f`), so exempting its value would hand awk
  // an unchecked path; the field separator cannot be one.
  ...(["awk", "gawk", "mawk", "nawk"] as const).map((verb) => [verb, {
    valueOptions: new Set(["-F", "--field-separator", "--source"]),
    pathValueOptions: new Set(["-v", "--assign", "-f", "--file"]),
    firstPositionalIsProgram: true,
    programSuppliedBy: new Set(["-f", "--file", "--source"]),
  }] as [string, NonPathOperandSpec]),
  ["sed", {
    valueOptions: new Set(["-e", "--expression"]),
    firstPositionalIsProgram: true,
    programSuppliedBy: new Set(["-e", "--expression", "-f", "--file"]),
  }],
  // grep-family: the first positional is the PATTERN; `--include`/`--exclude`
  // are filename globs matched against what the walk finds, not operands the
  // command opens.
  ...(["grep", "egrep", "fgrep", "rg", "ag", "ack"] as const).map((verb) => [verb, {
    valueOptions: new Set([
      "-e", "--regexp", "-g", "--glob",
      "--include", "--exclude", "--include-dir", "--exclude-dir",
    ]),
    firstPositionalIsProgram: true,
    programSuppliedBy: new Set(["-e", "--regexp", "-f", "--file"]),
    declineBarePathValue: true,
  }] as [string, NonPathOperandSpec]),
  ["curl", { valueOptions: new Set(["-w", "--write-out", "-H", "--header"]) }],
  // Only `-subj`. openssl's passphrase options accept a `file:` source, so
  // their values can name a path and stay checked.
  ["openssl", { valueOptions: new Set(["-subj"]) }],
  // `echo` and `tr` are deliberately ABSENT, though neither opens an operand
  // itself. Their arguments become the NEXT process's operands across a pipe or
  // a substitution — `echo /etc/shadow | xargs cat` opens the file `echo` only
  // printed — and this policy cannot see where a stream ends up. Exempting them
  // bought one measured command and cost that whole class.
  // printf's first positional is the FORMAT string; the arguments it formats
  // follow it and are checked normally. A format that is a bare path is
  // declined for the same pipe reason.
  ["printf", { firstPositionalIsProgram: true, declineBarePathValue: true }],
  // Format-string options. A format carries `%` placeholders and `\n` escapes,
  // and the `\` is enough to make the token look like a Windows path.
  ["stat", { valueOptions: new Set(["-c", "--format", "--printf"]) }],
  ["dpkg-query", { valueOptions: new Set(["-f", "--showformat"]) }],
  ...(["identify", "convert", "magick"] as const).map((verb) => [verb, {
    valueOptions: new Set(["-format"]),
  }] as [string, NonPathOperandSpec]),
]);

/**
 * Shell keywords that stand in front of the real verb of a segment.
 *
 * The segment `do echo "=== $d/x.log ==="` has `do` at argv[0], so a rule keyed
 * on the verb reads a keyword and finds nothing. Stripping them here rather
 * than in the shared tokenizer keeps this local to path-slot lookup: the risk
 * classifier's verb scan is unchanged, so a keyword-led leaf still fails closed
 * there as an unknown verb.
 */
const LEADING_SHELL_KEYWORDS: ReadonlySet<string> = new Set([
  "do", "then", "else", "elif", "if", "while", "until", "!", "{", "(",
]);

/**
 * How many leading tokens of `argv` are shell keywords standing in front of the
 * real verb. `do cd "$f"` has one.
 */
function leadingKeywordCount(argv: readonly string[]): number {
  let index = 0;
  while (
    index < argv.length
    && LEADING_SHELL_KEYWORDS.has(stripCommandPath(argv[index]!).toLowerCase())
  ) {
    index += 1;
  }
  return index;
}

/**
 * The result of reading a leaf's argument vector for path-operand purposes.
 */
interface OperandSlotClassification {
  /** Indices in `argv` that hold code, a pattern or a format rather than a path. */
  nonPathIndices: ReadonlySet<number>;
  /**
   * Paths recovered from INSIDE an operand that is otherwise not one. A sed
   * script is a single token, so the filename in `1r /etc/shadow` is reachable
   * no other way.
   */
  extraCandidates: readonly string[];
}

/**
 * Read `argv` (`argv[0]` is the head verb) and say which slots are not paths,
 * plus any path recovered from inside one that is not.
 *
 * `--` ends option parsing, so everything after it is positional — which is how
 * `grep -- -pattern file` keeps naming its file.
 */
function classifyOperandSlots(argv: readonly string[]): OperandSlotClassification {
  const skip = new Set<number>();
  const extraCandidates: string[] = [];
  const empty = { nonPathIndices: skip, extraCandidates };
  const verbIndex = leadingKeywordCount(argv);
  const head = argv[verbIndex];
  if (head === undefined) return empty;
  const verb = stripCommandPath(head).toLowerCase();
  const spec = NON_PATH_OPERAND_SPECS.get(verb);
  if (!spec) return empty;
  const isSed = verb === "sed";

  /**
   * Decide one candidate exemption. Returns false — meaning "keep checking this
   * as a path" — for a value the command would open or execute even though the
   * slot usually holds code.
   */
  const exempts = (value: string): boolean => {
    // `@` is the "contents of this file" sigil several of these options accept
    // (`curl -w @format`); a value wearing it names a path.
    if (isFileSigilValue(value)) return false;
    // A one-word value shaped like a path IS one for slots that execute or open
    // what they are given: `sh -c /etc/evil.sh` runs that file.
    if (spec.declineBarePathValue && isBarePathValue(value)) return false;
    // A sed script with a file-access command letter (`r R w W`, `s///w`,
    // `s///e`) reads or writes the operand after the letter. The letters are
    // recognised by the host's own sed scanner rather than a second copy of it;
    // the operand is then recovered by word-splitting, which is safe here
    // BECAUSE the scanner already said this script touches files.
    if (isSed && sedScriptHasWriteOrExec(value)) {
      for (const word of value.split(/\s+/)) {
        if (word.length > 0) extraCandidates.push(word);
      }
      return false;
    }
    return true;
  };

  let programTaken = spec.firstPositionalIsProgram !== true;
  let optionsEnded = false;
  for (let i = verbIndex + 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("-") && token.length > 1) {
      const equals = token.indexOf("=");
      const name = equals > 0 ? token.slice(0, equals) : token;
      if (spec.programSuppliedBy?.has(name)) programTaken = true;
      if (spec.pathValueOptions?.has(name) === true) {
        // Consume the value so it is not mistaken for the first positional,
        // but leave it in the candidate set: it is a path.
        if (equals < 0) i += 1;
        continue;
      }
      const carriesCode = spec.valueOptions?.has(name) === true
        || spec.clusteredCodeOption?.test(token) === true;
      if (!carriesCode) continue;
      if (equals > 0) {
        // `--opt=value` — the value never becomes its own token.
        if (exempts(token.slice(equals + 1))) skip.add(i);
        continue;
      }
      if (i + 1 < argv.length) {
        if (exempts(argv[i + 1]!)) skip.add(i + 1);
        i += 1;
      }
      continue;
    }
    if (!programTaken) {
      if (exempts(token)) skip.add(i);
      programTaken = true;
    }
  }
  return { nonPathIndices: skip, extraCandidates };
}

/**
 * True when a value is a lone word shaped like a path — no whitespace, and
 * path-shaped as a whole.
 *
 * The whitespace test is what keeps a real program out of this: `python3 -c
 * "import os; print(os.sep)"` and `sed -n '/a b/,/c d/p'` are prose with a
 * slash in them, while `/etc/evil.sh` is a filename and nothing else.
 */
function isBarePathValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && !/\s/.test(trimmed) && hasPathShape(trimmed);
}

/**
 * Command lines carried as the value of an option — today `sh -c '…'` and its
 * family. Read out of the shared tokenizer's leaves so the option's value is
 * the same string the shell would hand its child.
 */
function extractNestedShellCommands(command: string): string[] {
  const { leaves, parseError } = tokenizeShell(command);
  if (parseError) return [];
  const nested: string[] = [];
  for (const leaf of leaves) {
    // Past any leading keyword, for the same reason every other verb lookup is:
    // a loop body arrives as `do sh -c '…'`.
    const verbIndex = leadingKeywordCount(leaf.argv);
    const head = leaf.argv[verbIndex];
    if (head === undefined) continue;
    const spec = NON_PATH_OPERAND_SPECS.get(stripCommandPath(head).toLowerCase());
    const options = spec?.nestedCommandOptions;
    if (!options) continue;
    for (let i = verbIndex + 1; i < leaf.argv.length; i += 1) {
      const carried = readOptionValue(leaf.argv, i, options);
      if (!carried) continue;
      nested.push(carried.value);
      if (carried.consumedNext) i += 1;
    }
  }
  return nested;
}

/**
 * The value an option in `options` carries at `argv[index]`, in any of the
 * three forms a short option can wear it.
 *
 * Matching only the exact token missed two of them. `bash -lc 'cmd'` clusters
 * the flag with `-l`, and `sh -c'cmd'` attaches the value — the tokenizer has
 * already removed the quotes by the time this runs, so that argument arrives as
 * one word, `-ccmd`. Both forms run the payload exactly as `-c cmd` does.
 */
function readOptionValue(
  argv: readonly string[],
  index: number,
  options: ReadonlySet<string>,
): { value: string; consumedNext: boolean } | null {
  const token = argv[index]!;
  const equals = token.indexOf("=");
  if (equals > 0 && options.has(token.slice(0, equals))) {
    return { value: token.slice(equals + 1), consumedNext: false };
  }
  const takeNext = (): { value: string; consumedNext: boolean } | null => {
    const next = argv[index + 1];
    return next === undefined ? null : { value: next, consumedNext: true };
  };
  if (options.has(token)) return takeNext();
  // A clustered short-option group. A long option is never a cluster, so `--`
  // is excluded rather than being read letter by letter.
  if (!token.startsWith("-") || token.startsWith("--")) return null;
  for (let i = 1; i < token.length; i += 1) {
    if (!options.has(`-${token[i]!}`)) continue;
    const attached = token.slice(i + 1);
    return attached.length > 0 ? { value: attached, consumedNext: false } : takeNext();
  }
  return null;
}

/** True when a value carries the `@`-prefixed "contents of this file" sigil. */
function isFileSigilValue(value: string): boolean {
  return value.startsWith("@") && value.length > 1;
}

/**
 * The bodies of every `$(…)` and backtick substitution in `command`, at the top
 * level of quoting. Double-quoted regions are descended into because expansion
 * still happens there; single-quoted ones are not, because it does not.
 */
function extractCommandSubstitutionBodies(command: string): string[] {
  const bodies: string[] = [];
  const n = command.length;
  let i = 0;
  let inDoubleQuote = false;
  while (i < n) {
    const ch = command[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return bodies;
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = !inDoubleQuote;
      i += 1;
      continue;
    }
    if (ch === "`") {
      const close = command.indexOf("`", i + 1);
      if (close === -1) return bodies;
      bodies.push(command.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      const close = matchClosingParen(command, i + 1);
      if (close === -1) return bodies;
      // `$((expr))` is arithmetic, not a command. Its body cannot name a file
      // the shell opens, and reading it as one produced operands out of C-style
      // integer division.
      const body = command.slice(i + 2, close);
      if (!(command[i + 2] === "(" && command[close - 1] === ")")) bodies.push(body);
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return bodies;
}

/** Index of the `)` matching the `(` at `openParen`, or -1 when unbalanced. */
function matchClosingParen(command: string, openParen: number): number {
  let depth = 0;
  for (let i = openParen; i < command.length; i += 1) {
    const ch = command[i]!;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * `value` with every command substitution removed.
 *
 * Used to answer one question only: was this token ever a path, or is it a
 * substitution wearing a `/` from the command inside it? `p=$(command -v cc)`
 * has no path once the substitution is gone; `/tmp/$(basename "$f")` still
 * does, and keeps its substitution text so the dynamic-path rule still refuses
 * it.
 */
function withoutCommandSubstitutions(value: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const ch = value[i]!;
    // An opener with no closer means the rest of the token is substitution text
    // that candidate normalization trimmed (it strips a trailing `)`), so it is
    // dropped rather than kept. The substitution's real body is inspected as a
    // command from the full command string, where the parens still balance.
    if (ch === "`") {
      const close = value.indexOf("`", i + 1);
      if (close === -1) return out;
      i = close + 1;
      continue;
    }
    if (ch === "$" && value[i + 1] === "(") {
      const close = matchClosingParen(value, i + 1);
      if (close === -1) return out;
      i = close + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

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
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
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
    // `&&` and a background `&` are both segment boundaries. Splitting here is
    // what lets `cd /app && awk '{…}'` find `awk` as a head verb — without it
    // the segment's head is `cd` and every rule keyed on the verb reads the
    // wrong command, and `ls & find . -name x` hid `find` the same way.
    //
    // The exclusions are the fd-redirect forms: `2>&1` and `ls &> log` both
    // spell `&` without ending a command, and splitting them tears an operator
    // in half.
    if (ch === "&" && command[i + 1] !== ">" && command[i - 1] !== ">") {
      if (segment.trim()) segments.push(segment);
      segment = "";
      if (command[i + 1] === "&") i += 1;
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

/**
 * Flat path-candidate scan, now segment-aware.
 *
 * Segmenting is what lets this extractor apply the same non-path-operand rule
 * the leaf walk applies: the rule is keyed on a segment's head verb, and before
 * this the scan had no notion of where one command ended and the next began.
 * Leading `NAME=value` assignments are still scanned — an assignment carries a
 * path the later verb dereferences (`D=/usr/local/bin; cp x "$D/f"`), and
 * dropping it would be exactly the hole this scan exists to cover.
 */
function extractPathCandidates(command: string): string[] {
  const candidates: string[] = [];
  for (const segment of splitCommandSegments(command)) {
    const tokens = tokenizeCommand(segment);
    const headIndex = tokens.findIndex((token) => !isAssignmentToken(token));
    const slots = headIndex < 0 ? undefined : classifyOperandSlots(tokens.slice(headIndex));
    const nonPath = slots === undefined
      ? new Set<number>()
      : new Set([...slots.nonPathIndices].map((index) => index + headIndex));
    for (const part of slots?.extraCandidates ?? []) {
      const normalized = normalizeCandidate(part);
      if (normalized && looksLikePath(normalized)) candidates.push(normalized);
    }
    for (let i = 0; i < tokens.length; i += 1) {
      if (nonPath.has(i)) continue;
      for (const part of splitCandidateParts(tokens[i]!)) {
        const normalized = normalizeCandidate(part);
        if (normalized && looksLikePath(normalized)) {
          candidates.push(normalized);
        }
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
  // `@path` — the "contents of this file" sigil. Without splitting it off, the
  // token starts with `@` and so resolves RELATIVE to the cwd, landing inside
  // the boundary while the command opens the absolute path behind the sigil.
  if (isFileSigilValue(token)) {
    parts.push(token.slice(1));
  }
  parts.push(token);
  const eq = token.indexOf("=");
  if (eq > 0 && eq < token.length - 1) {
    const value = token.slice(eq + 1);
    // `NAME=$(cmd)` stores a command's OUTPUT in a variable; it does not open a
    // path. The derived value part is a heuristic split, not an operand the
    // command was given, so a value that is nothing but a substitution is not
    // emitted as a candidate at all — using the variable later (`"$NAME/f"`)
    // produces its own operand, and that one is still a dynamic path.
    if (withoutCommandSubstitutions(value).trim().length > 0) parts.push(value);
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
  // What is left of the token once its command substitutions are removed
  // decides whether it was ever a path.
  //
  //  - nothing left: the token IS the substitution, so what it will name is
  //    unknown until the shell runs it. That is exactly a dynamic path and it
  //    stays one — `cat $(echo /etc/passwd)` must not become reachable by
  //    calling the operand "a command".
  //  - something left, but not path-shaped (`p=`, `total lines: `): the `/`
  //    belonged to the command inside, which the caller's recursive pass
  //    inspects as a command. Not a path operand.
  //  - something path-shaped left (`/tmp/` in `/tmp/$(basename "$f")`): a real
  //    path operand built partly from a substitution — keep the full text so
  //    the dynamic-path rule still refuses it.
  const withoutSubstitutions = withoutCommandSubstitutions(value);
  if (withoutSubstitutions.length === 0 && value.length > 0) return true;
  if (hasPathShape(value) && !hasPathShape(withoutSubstitutions)) return false;
  return hasPathShape(value);
}

function hasPathShape(value: string): boolean {
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
  // A substitution inside a path operand names something no static check can
  // read. The `$` guard below catches `$(…)` but not a backtick, and a backtick
  // operand resolves relative to the cwd — landing inside the boundary while
  // the shell opens whatever the substitution printed.
  if (withoutCommandSubstitutions(value) !== value) {
    throw new Error(`Sandbox: unresolved command substitution in path operand ${value}`);
  }
  const expandedVars = expandShellPathVariables(value, cwd);
  if (expandedVars.includes("$") || expandedVars.includes("%")) {
    throw new Error(`Sandbox: unresolved shell variable in path operand ${value}`);
  }
  // `~user` is the one tilde form nobody expands; `~\x` on POSIX is not that —
  // it is a literal filename `expandLeadingTilde` leaves alone, exactly as the
  // file tools and the permission layer do, so this policy judges the same
  // file they open.
  if (/^~[^/\\]/.test(expandedVars)) {
    throw new Error(`Sandbox: unsupported user-home expansion in path operand ${value}`);
  }
  const expanded = expandLeadingTilde(expandedVars);
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
