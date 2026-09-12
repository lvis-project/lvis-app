import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { t } from "../i18n/index.js";
import { displayShellWord, staticShellWord, type ShellWord } from "../shared/shell-analysis.js";
import { commandLeaf, stripCommandPath } from "../shared/shell-effective-command.js";
import { inspectShellExecution, ShellExecutionError, type ShellExecutionFacts, type ShellCommandEvent } from "../shared/shell-execution.js";
import { validateSandboxPath } from "../sandbox/path-validator.js";
import { canonicalizePathForMatch, caseFoldForMatch, isSensitivePath } from "../permissions/sensitive-paths.js";
import { inspectSedScriptFileAccess, isReadOnlyShellLeaf } from "../permissions/reviewer/host-risk-inspector.js";
import { pathEffectIsConfined, type PathEffect } from "../permissions/allowed-directories.js";
import { parseTarListing } from "../shared/shell-tar-listing.js";
import { resolveShellFilesystemPath } from "../shared/shell-filesystem-path.js";
import { classifySqliteArgumentSlots } from "./shell-sqlite-arguments.js";

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
  ["cp", ["-r", "-R", "--recursive", "-a", "--archive"]],
  ["du", ["-a", "--all"]],
  ["egrep", ["-r", "-R", "--recursive", "--dereference-recursive"]],
  ["fgrep", ["-r", "-R", "--recursive", "--dereference-recursive"]],
  ["grep", ["-r", "-R", "--recursive", "--dereference-recursive"]],
  ["ls", ["-R"]],
  ["mv", ["-r", "-R", "--recursive"]],
]);

// These operands address the child shell's standard streams, not host files.
// Do not extend this to arbitrary descriptor paths: they can expose other files.
const SHELL_DEVICE_PATHS: ReadonlySet<string> = new Set([
  "/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr",
]);

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

export function findResolvedShellPathViolation(
  absolute: string,
  label: string,
  sandboxRoot: string,
  extraAllowedDirectories: readonly string[],
  effect: PathEffect,
  blockReadsOutsideWorkingDirectories: boolean,
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
  if (!pathEffectIsConfined(effect, blockReadsOutsideWorkingDirectories)) return null;
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
 * A recursive-operation refusal names an available builtin, scopes a partial
 * alternative, or states the missing capability. An unrelated operation is not an
 * equivalent, and no refusal should silently narrow the requested scope.
 * Keys belong to RECURSIVE_TRAVERSAL_COMMANDS or RECURSIVE_FLAG_COMMANDS.
 */
const SHELL_TRAVERSAL_GUIDANCE: Readonly<Record<string, {
  kind: "builtin" | "conditional" | "unavailable";
  messageKey: string;
}>> = {
  find: { kind: "builtin", messageKey: "be_shellPathPolicy.altFind" },
  fd: { kind: "builtin", messageKey: "be_shellPathPolicy.altFd" },
  fdfind: { kind: "builtin", messageKey: "be_shellPathPolicy.altFdfind" },
  rg: { kind: "builtin", messageKey: "be_shellPathPolicy.altRg" },
  tree: { kind: "builtin", messageKey: "be_shellPathPolicy.altTree" },
  tar: { kind: "conditional", messageKey: "be_shellPathPolicy.altTar" },
  unzip: { kind: "unavailable", messageKey: "be_shellPathPolicy.altUnzip" },
  zip: { kind: "unavailable", messageKey: "be_shellPathPolicy.altZip" },
  grep: { kind: "builtin", messageKey: "be_shellPathPolicy.altGrep" },
  egrep: { kind: "builtin", messageKey: "be_shellPathPolicy.altEgrep" },
  fgrep: { kind: "builtin", messageKey: "be_shellPathPolicy.altFgrep" },
  cp: { kind: "builtin", messageKey: "be_shellPathPolicy.altCp" },
  mv: { kind: "unavailable", messageKey: "be_shellPathPolicy.altMv" },
};

/** Program interfaces own data/path roles after exact shell expansion.
 * Unknown positionals remain exact file operands. Only explicit option/slot
 * contracts can select a value inside an argument; spelling alone never strips
 * a leading @ or turns a filename containing = into another filename.
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
  /** Possible value-option abbreviations consume their operand without exempting it. */
  abbreviatedValueOptions?: true;
  /** Forwarding options; possible abbreviations conservatively end option roles. */
  forwardingOptions?: ReadonlySet<string>;
  /** Cluster form of a code-carrying option, e.g. perl's `-ne` / `-lpe`. */
  clusteredCodeOption?: RegExp;
  /** True when the first non-option operand is the program/pattern. */
  firstPositionalIsProgram?: true;
  /** Options that supply the program elsewhere, freeing the first positional to be a path again. */
  programSuppliedBy?: ReadonlySet<string>;
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
const OPENSSL_PASSPHRASE_OPTIONS = new Set(["-passin", "-passout", "-pass"]);
const DEBUGGER_CODE_OPTIONS = new Set([
  "-ex", "-eval-command", "--eval-command",
  "-iex", "-init-eval-command", "--init-eval-command",
  "-eiex", "-early-init-eval-command", "--early-init-eval-command",
]);
const DEBUGGER_PATH_OPTIONS = new Set([
  "-x", "-command", "--command",
  "-ix", "-init-command", "--init-command",
  "-eix", "-early-init-command", "--early-init-command",
  "-e", "-exec", "--exec", "-s", "-symbols", "--symbols", "-se", "--se",
  "-c", "-core", "--core", "-d", "-directory", "--directory",
  "-cd", "--cd", "-data-directory", "--data-directory",
  "-t", "-tty", "--tty",
]);

const NON_PATH_OPERAND_SPECS: ReadonlyMap<string, NonPathOperandSpec> = new Map<string, NonPathOperandSpec>([
  ["gdb", {
    valueOptions: DEBUGGER_CODE_OPTIONS,
    pathValueOptions: DEBUGGER_PATH_OPTIONS,
    abbreviatedValueOptions: true,
    forwardingOptions: new Set(["--args", "--no-escape-args"]),
  }],
  // Shell family: `-c` carries a command LINE, so its value is re-entered as a
  // command rather than merely exempted — see `nestedCommandOption`.
  ...(["sh", "bash", "zsh", "dash", "ksh"] as const).map((verb) => [verb, {
    valueOptions: SHELL_CODE_OPTIONS,
    nestedCommandOptions: SHELL_CODE_OPTIONS,
  }] as [string, NonPathOperandSpec]),
  ...(["python", "python2", "python3"] as const).map((verb) => [verb, {
    valueOptions: PYTHON_CODE_OPTIONS,
  }] as [string, NonPathOperandSpec]),
  ["node", { valueOptions: NODE_CODE_OPTIONS, }],
  ...(["deno", "bun"] as const).map((verb) => [verb, {
    valueOptions: DENO_CODE_OPTIONS,
  }] as [string, NonPathOperandSpec]),
  ["php", { valueOptions: PHP_CODE_OPTIONS, }],
  ...(["rscript", "r", "lua", "osascript"] as const).map((verb) => [verb, {
    valueOptions: EXPRESSION_CODE_OPTIONS,
  }] as [string, NonPathOperandSpec]),
  ...(["perl", "ruby"] as const).map((verb) => [verb, {
    valueOptions: PERL_CODE_OPTIONS,
    clusteredCodeOption: PERL_CLUSTERED_CODE_OPTION,
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
  ...(["rg", "ag", "ack"] as const).map((verb) => [verb, {
    valueOptions: new Set([
      "-e", "--regexp", "-g", "--glob",
      "--include", "--exclude", "--include-dir", "--exclude-dir",
    ]),
    firstPositionalIsProgram: true,
    programSuppliedBy: new Set(["-e", "--regexp", "-f", "--file"]),
  }] as [string, NonPathOperandSpec]),
  ["curl", { valueOptions: new Set(["-w", "--write-out", "-H", "--header", "-d", "--data", "--data-ascii", "--data-binary", "--json"]) }],
  // Passphrase option values are data except their documented file: source.
  ["openssl", { valueOptions: new Set(["-subj", ...OPENSSL_PASSPHRASE_OPTIONS]) }],
  // Data-only builtins are handled by the execution role. Their executed
  // substitutions and downstream execution consumers remain independently checked.
  ["printf", { firstPositionalIsProgram: true, }],
  // Format-string options. A format carries `%` placeholders and `\n` escapes,
  // and the `\` is enough to make the token look like a Windows path.
  ["stat", { valueOptions: new Set(["-c", "--format", "--printf"]) }],
  ["dpkg-query", { valueOptions: new Set(["-f", "--showformat"]) }],
  ...(["identify", "convert", "magick"] as const).map((verb) => [verb, {
    valueOptions: new Set(["-format"]),
  }] as [string, NonPathOperandSpec]),
]);

/**
 * The result of reading a leaf's argument vector for path-operand purposes.
 */
interface OperandSlotClassification {
  /** Indices in `argv` that hold code, a pattern or a format rather than a path. */
  nonPathIndices: ReadonlySet<number>;
  /** Program roles that require exact expansion even when they contain no literal file effect. */
  programIndices?: ReadonlySet<number>;
  /**
   * Paths recovered from INSIDE an operand that is otherwise not one. A sed
   * script is a single token, so the filename in `1r /etc/shadow` is reachable
   * no other way.
   */
  extraCandidates: readonly { value: string; index: number }[];
  /**
   * Command lines carried INSIDE an operand that is otherwise program text —
   * today `sed`'s `e COMMAND`. They are re-entered through the whole policy the
   * same way a `sh -c` payload is.
   */
  nestedCommands: readonly { value: string; index: number }[];
  /**
   * Set when an operand executes text that cannot be read before running, so
   * there is nothing to inspect and the call has to be refused instead.
   */
  dynamicExecution: string | null;
}

const COMPILER_COMMANDS = new Set(["cc", "c++", "gcc", "g++", "clang", "clang++"]);
// Named options precede any shorter option prefix that could claim their value.
const COMPILER_PATH_OPTIONS = [
  "-include-pch", "-idirafter", "-isysroot", "-isystem", "-iquote", "-include", "-imacros",
  "-MF", "-I", "-L", "-B", "-o",
];

function classifyCompilerOperandSlots(argv: readonly string[], verbIndex: number): OperandSlotClassification {
  const nonPathIndices = new Set<number>();
  const extraCandidates: { value: string; index: number }[] = [];
  for (let i = verbIndex + 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--") break;
    const option = COMPILER_PATH_OPTIONS.find((prefix) => token.startsWith(prefix));
    if (!option) continue;
    const value = token === option ? argv[++i] : token.slice(option.length);
    // Sysroot-relative values require additional interpretation; keep the
    // conservative scan for those instead of treating '=' as a directory name.
    if (!value || value.startsWith("=")) continue;
    nonPathIndices.add(i);
    extraCandidates.push({ value, index: i });
  }
  return { nonPathIndices, extraCandidates, nestedCommands: [], dynamicExecution: null };
}

const GREP_LITERAL_OPTIONS = new Set([
  "-e", "--regexp", "-A", "--after-context", "-B", "--before-context",
  "-C", "--context", "-m", "--max-count", "-d", "--directories",
  "-D", "--devices", "--binary-files", "--label", "--include", "--exclude",
  "--exclude-dir", "--group-separator",
]);
const GREP_FILE_OPTIONS = new Set(["-f", "--file", "--exclude-from"]);
const GREP_SWITCHES = new Set([
  ..."abcEFGHIhiLlnoPqRrsUuVvwxyZz".split("").map((flag) => `-${flag}`),
  "--basic-regexp", "--extended-regexp", "--fixed-strings", "--perl-regexp",
  "--ignore-case", "--no-ignore-case", "--invert-match", "--word-regexp",
  "--line-regexp", "--count", "--files-without-match", "--files-with-matches",
  "--only-matching", "--quiet", "--silent", "--no-messages", "--byte-offset",
  "--with-filename", "--no-filename", "--line-number", "--initial-tab",
  "--null", "--recursive", "--dereference-recursive", "--text", "--binary",
  "--unix-byte-offsets", "--null-data", "--no-group-separator", "--help", "--version",
]);

const PROCESS_PATTERN_FILE_OPTIONS = new Set(["-F", "--pidfile"]);
const PROCESS_PATTERN_LITERAL_OPTIONS = new Set([
  "-d", "--delimiter", "-g", "--pgroup", "-G", "--group", "-O", "--older",
  "-p", "--pid", "-P", "--parent", "-s", "--session", "--signal", "-t", "--terminal",
  "-u", "--euid", "-U", "--uid", "-r", "--runstates", "--cgroup", "--ns", "--nslist", "--env",
]);
const PROCESS_PATTERN_SWITCHES = new Set([
  "-a", "--list-full", "-l", "--list-name", "--quiet", "-v", "--inverse",
  "-w", "--lightweight", "-c", "--count", "-f", "--full", "-i", "--ignore-case",
  "-n", "--newest", "-o", "--oldest", "-x", "--exact", "-L", "--logpidfile",
  "-A", "--ignore-ancestors", "-Q", "--shell-quote", "-h", "--help", "-V", "--version",
]);

/** Process selection patterns are text; pidfile options still open files. */
function classifyProcessPatternOperandSlots(argv: readonly string[], verbIndex: number): OperandSlotClassification {
  const nonPathIndices = new Set<number>();
  const extraCandidates: { value: string; index: number }[] = [];
  const positionals: number[] = [];
  const unclassified: OperandSlotClassification = {
    nonPathIndices: new Set(), extraCandidates: [], nestedCommands: [], dynamicExecution: null,
  };
  let optionsEnded = false;
  for (let i = verbIndex + 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || !token.startsWith("-") || token === "-") {
      positionals.push(i);
      continue;
    }
    const long = token.startsWith("--");
    const equals = token.indexOf("=");
    const options = long
      ? [equals < 0 ? token : token.slice(0, equals)]
      : token.slice(1).split("").map((flag) => `-${flag}`);
    for (let j = 0; j < options.length; j += 1) {
      const option = options[j]!;
      const fileValue = PROCESS_PATTERN_FILE_OPTIONS.has(option);
      if (!fileValue && !PROCESS_PATTERN_LITERAL_OPTIONS.has(option)) {
        if (!PROCESS_PATTERN_SWITCHES.has(option) || (long && equals >= 0)) return unclassified;
        continue;
      }
      const attached = long ? equals >= 0 : j + 2 < token.length;
      const value = attached ? token.slice(long ? equals + 1 : j + 2) : argv[i + 1];
      if (value === undefined) return unclassified;
      nonPathIndices.add(i);
      if (!attached) nonPathIndices.add(++i);
      if (fileValue) extraCandidates.push({ value, index: i });
      break;
    }
  }
  // An unknown option or extra positional can change which word is the
  // pattern. Grant no text exemption unless the complete argv is understood.
  if (positionals.length > 1) return unclassified;
  if (positionals[0] !== undefined) nonPathIndices.add(positionals[0]);
  return { nonPathIndices, extraCandidates, nestedCommands: [], dynamicExecution: null };
}

/** Pattern text never opens a file; -f and later positionals do. */
function classifyGrepOperandSlots(argv: readonly string[], verbIndex: number): OperandSlotClassification {
  const nonPathIndices = new Set<number>();
  const extraCandidates: { value: string; index: number }[] = [];
  const positionals: number[] = [];
  const unclassified: OperandSlotClassification = {
    nonPathIndices: new Set(), extraCandidates: [], nestedCommands: [], dynamicExecution: null,
  };
  let suppliedPattern = false;
  let optionsEnded = false;
  for (let i = verbIndex + 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || !token.startsWith("-") || token === "-") {
      positionals.push(i);
      continue;
    }
    if (/^-\d+$/.test(token)) continue;
    const long = token.startsWith("--");
    const equals = token.indexOf("=");
    const options = long
      ? [equals < 0 ? token : token.slice(0, equals)]
      : token.slice(1).split("").map((flag) => `-${flag}`);
    for (let j = 0; j < options.length; j += 1) {
      const option = options[j]!;
      if (option === "--color" || option === "--colour") {
        nonPathIndices.add(i);
        continue;
      }
      const fileValue = GREP_FILE_OPTIONS.has(option);
      if (!fileValue && !GREP_LITERAL_OPTIONS.has(option)) {
        // Unknown options may consume a following word. Do not guess its role.
        if (!GREP_SWITCHES.has(option) || (long && equals >= 0)) return unclassified;
        continue;
      }
      const attached = long ? equals >= 0 : j + 2 < token.length;
      const value = attached ? token.slice(long ? equals + 1 : j + 2) : argv[i + 1];
      if (value === undefined) return unclassified;
      nonPathIndices.add(i);
      if (!attached) nonPathIndices.add(++i);
      if (fileValue) extraCandidates.push({ value, index: i });
      if (["-e", "--regexp", "-f", "--file"].includes(option)) suppliedPattern = true;
      // A short option's attached remainder is its value, never more flags.
      break;
    }
  }
  if (!suppliedPattern && positionals[0] !== undefined) nonPathIndices.add(positionals[0]);
  return { nonPathIndices, extraCandidates, nestedCommands: [], dynamicExecution: null };
}

type FindOperandRole = "literal" | "path";

/** Arity and operand roles of find expression primaries, not shell options.
 * A predicate's value can itself look like another primary, so each is
 * consumed before looking for the next primary. Unlisted syntax stays checked.
 */
const FIND_PRIMARY_OPERANDS: ReadonlyMap<string, readonly FindOperandRole[]> = new Map([
  ...[
    "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename",
    "-lname", "-ilname", "-regex", "-iregex", "-printf", "-context",
    "-amin", "-atime", "-cmin", "-ctime", "-mmin", "-mtime", "-used",
    "-inum", "-links", "-size", "-uid", "-gid", "-user", "-group",
    "-perm", "-type", "-xtype", "-fstype", "-maxdepth", "-mindepth", "-regextype",
  ].map((primary): [string, readonly FindOperandRole[]] => [primary, ["literal"]]),
  ...[
    "-newer", "-anewer", "-cnewer", "-samefile", "-fprint", "-fprint0",
    "-fls", "-files0-from",
  ].map((primary): [string, readonly FindOperandRole[]] => [primary, ["path"]]),
  ["-fprintf", ["path", "literal"]],
  ...[
    "-true", "-false", "-empty", "-readable", "-writable", "-executable",
    "-nouser", "-nogroup", "-print", "-print0", "-ls", "-quit", "-prune",
    "-delete", "-depth", "-daystart", "-follow", "-mount", "-xdev", "-noleaf",
    "-ignore_readdir_race", "-noignore_readdir_race", "-warn", "-nowarn",
    "!", "-not", "-a", "-and", "-o", "-or", ",",
  ].map((primary): [string, readonly FindOperandRole[]] => [primary, []]),
]);

function classifyFindOperandSlots(argv: readonly string[], verbIndex: number): OperandSlotClassification {
  const nonPathIndices = new Set<number>();
  const unclassified: OperandSlotClassification = {
    nonPathIndices: new Set(), extraCandidates: [], nestedCommands: [], dynamicExecution: null,
  };
  let i = verbIndex + 1;
  // Global execution options precede the starting points; they do not consume
  // path operands. Debugging categories are a separate literal argument.
  while (i < argv.length) {
    const token = argv[i]!;
    if (["-H", "-L", "-P", "--"].includes(token) || /^-O[0-3]$/.test(token)) { i += 1; continue; }
    if (token !== "-D") break;
    if (argv[i + 1] === undefined) return unclassified;
    nonPathIndices.add(i + 1);
    i += 2;
  }
  // Starting points end at the first expression primary/operator. Every
  // starting point stays a path, including multiple roots and relative roots.
  while (i < argv.length && !argv[i]!.startsWith("-")
    && !["!", "(", "\\(", ")", "\\)", ","].includes(argv[i]!)) i += 1;
  let groups = 0;
  for (; i < argv.length; i += 1) {
    const primary = argv[i]!;
    if (primary === "(" || primary === "\\(") { groups += 1; continue; }
    if (primary === ")" || primary === "\\)") {
      if (--groups < 0) return unclassified;
      continue;
    }
    // The last letter determines whether -newerXY compares a reference FILE
    // or parses a literal timestamp (Y=t).
    const roles = /^-newer[acmB][acmBt]$/.test(primary)
      ? [primary.endsWith("t") ? "literal" : "path"] as const
      : FIND_PRIMARY_OPERANDS.get(primary);
    // In particular, -exec/-execdir/-ok carry command argv of variable length.
    // Never read their arguments as find primaries or invent exemptions.
    if (roles === undefined || i + roles.length >= argv.length) return unclassified;
    for (const role of roles) {
      i += 1;
      if (role === "literal") nonPathIndices.add(i);
    }
  }
  if (groups !== 0) return unclassified;
  return { nonPathIndices, extraCandidates: [], nestedCommands: [], dynamicExecution: null };
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
  const extraCandidates: { value: string; index: number }[] = [];
  const nestedCommands: { value: string; index: number }[] = [];
  let dynamicExecution: string | null = null;
  const empty = { nonPathIndices: skip, extraCandidates, nestedCommands, dynamicExecution };
  const verbIndex = 0;
  const head = argv[verbIndex];
  if (head === undefined) return empty;
  const verb = stripCommandPath(head).toLowerCase();
  if (verb === "sqlite3") return classifySqliteArgumentSlots(argv);
  if (verb === "find") return classifyFindOperandSlots(argv, verbIndex);
  if (["grep", "egrep", "fgrep"].includes(verb)) return classifyGrepOperandSlots(argv, verbIndex);
  if (verb === "pgrep") return classifyProcessPatternOperandSlots(argv, verbIndex);
  if (verb === "kill") {
    // These are signals and process identifiers, never file operands. Shell
    // substitutions are inspected recursively, and redirects remain separate.
    for (let i = verbIndex + 1; i < argv.length; i += 1) skip.add(i);
    return empty;
  }
  if (COMPILER_COMMANDS.has(verb)) return classifyCompilerOperandSlots(argv, verbIndex);
  if (verb === "tar") {
    const listing = parseTarListing(argv.slice(verbIndex));
    if (listing) {
      for (let i = verbIndex + 1; i < argv.length; i += 1) skip.add(i);
      extraCandidates.push(...listing.archivePaths.map((value, index) => ({ value, index: listing.archiveArgIndices[index]! })));
    }
    return empty;
  }
  const spec = NON_PATH_OPERAND_SPECS.get(verb);
  if (!spec) return empty;
  const isSed = verb === "sed";

  /**
   * Decide one candidate exemption. Returns false — meaning "keep checking this
   * as a path" — for a value the command would open or execute even though the
   * slot usually holds code.
   */
  const exempts = (value: string, index: number, option?: string): boolean => {
    // Only these documented curl payload slots interpret @ as file contents.
    if (verb === "curl" && isFileSigilValue(value)) {
      if (value !== "@-") extraCandidates.push({ value: value.slice(1), index });
      return true;
    }
    if (verb === "openssl" && option && OPENSSL_PASSPHRASE_OPTIONS.has(option) && value.startsWith("file:")) {
      extraCandidates.push({ value: value.slice(5), index });
      return true;
    }
    // A sed script with a file-access command letter (`r R w W`, `s///w`)
    // reads or writes a file, and `e` / `s///e` executes. Both the letters and
    // the operand come from the host's own sed scanner rather than a second
    // copy of its grammar. The scanner returns the operand SPAN — sed takes the
    // filename from just after the command letter to end of line, so `w/tmp/x`
    // and `w /tmp/x` name the same file and splitting on whitespace would have
    // yielded the token `w/tmp/x`, which resolves cwd-relative and stays inside
    // any boundary.
    if (isSed) {
      const sedAccess = inspectSedScriptFileAccess(value);
      // `e COMMAND` runs a command line this policy can read, so it is
      // re-entered rather than exempted — the same treatment `sh -c` gets.
      nestedCommands.push(...sedAccess.execCommands.map((value) => ({ value, index })));
      if (sedAccess.hasDynamicExec && dynamicExecution === null) {
        dynamicExecution =
          `Dynamic path: \`sed\` script \`${value}\` executes text that only exists while sed runs ` +
          "(`s///e`, or `e` with no command, run the pattern space), so the paths it uses cannot be " +
          "checked beforehand. Put the command in the shell call itself instead.";
      }
      if (sedAccess.hasWriteOrExec) {
        extraCandidates.push(...sedAccess.fileOperands.map((value) => ({ value, index })));
        return true;
      }
    }
    return true;
  };

  let programTaken = spec.firstPositionalIsProgram !== true;
  let optionsEnded = false;
  for (let i = verbIndex + 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    // A potential forwarding abbreviation must not grant debugger roles to
    // arguments the child might receive. Normalize only the option prefix.
    const optionName = token.replace(/^--?/, "--");
    const mayForward = token.startsWith("-") && optionName.length > 2
      && spec.forwardingOptions !== undefined
      && [...spec.forwardingOptions].some((option) => option.startsWith(optionName));
    if (!optionsEnded && (token === "--" || mayForward)) {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("-") && token.length > 1) {
      if (verb === "curl" && spec.valueOptions) {
        // The same option arity applies to separate, equals and short attached
        // values. A glued @file must retain its original operand span.
        const carried = readOptionValue(argv, i, spec.valueOptions);
        if (carried) {
          const index = carried.consumedNext ? i + 1 : i;
          if (exempts(carried.value, index)) skip.add(index);
          if (carried.consumedNext) i += 1;
          continue;
        }
      }
      const equals = token.indexOf("=");
      const name = equals > 0 ? token.slice(0, equals) : token;
      if (spec.programSuppliedBy?.has(name)) programTaken = true;
      const normalizedName = name.replace(/^--?/, "--");
      const mayConsumeValue = spec.abbreviatedValueOptions === true
        && spec.valueOptions?.has(name) !== true
        && [...spec.pathValueOptions ?? [], ...spec.valueOptions ?? []]
          .some((option) => option.replace(/^--?/, "--").startsWith(normalizedName));
      if (spec.pathValueOptions?.has(name) === true || mayConsumeValue) {
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
        if (exempts(token.slice(equals + 1), i, name)) skip.add(i);
        continue;
      }
      if (i + 1 < argv.length) {
        if (exempts(argv[i + 1]!, i + 1, name)) skip.add(i + 1);
        i += 1;
      }
      continue;
    }
    if (!programTaken) {
      if (exempts(token, i)) skip.add(i);
      programTaken = true;
    }
  }
  return { nonPathIndices: skip, extraCandidates, nestedCommands, dynamicExecution };
}

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

function buildRecursiveBlockMessage(
  commandToken: string,
  commandName: string,
  flag?: string,
): string {
  const head = flag
    ? `Sandbox: recursive shell filesystem traversal is not allowed: ${commandToken} ${flag}`
    : `Sandbox: recursive shell filesystem traversal is not allowed: ${commandToken}`;
  const capability = SHELL_TRAVERSAL_GUIDANCE[commandName];
  if (!capability) return `${head} ${t("be_shellPathPolicy.guidanceNoAlt")}`;
  const guidanceKey = capability.kind === "builtin"
    ? "be_shellPathPolicy.guidanceWithAlt"
    : capability.kind === "conditional"
      ? "be_shellPathPolicy.guidanceConditional"
      : "be_shellPathPolicy.guidanceUnavailable";
  return `${head} ${t(guidanceKey, { alt: t(capability.messageKey) })}`;
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

export type { ShellExecutionFacts } from "../shared/shell-execution.js";
class PathPolicyError extends Error {
  constructor(readonly violation: ShellPathPolicyViolation) { super(violation.reason); }
}
function decline(reason: string, word?: ShellWord): never {
  throw new ShellExecutionError(reason, word?.source.raw);
}

export function findShellPathPolicyViolation(
  command: string, cwd: string, sandboxRoot: string, extraAllowedDirectories: readonly string[],
  blockReadsOutsideWorkingDirectories: boolean,
  facts: ShellExecutionFacts = { dialect: "bash", environment: {} },
): ShellPathPolicyViolation | null {
  const cwdError = validateShellWorkingDirectory(cwd, sandboxRoot, extraAllowedDirectories);
  if (cwdError) return { kind: cwdError.startsWith("Sensitive") ? "sensitive-path" : "sandbox-boundary", reason: cwdError, path: cwd };
  const checkPath = (path: string, label: string, cwd: string | null, effect: PathEffect): void => {
    // These exact public standard-stream operands name the child descriptors;
    // resolving them in the host process would inspect different descriptors.
    if (SHELL_DEVICE_PATHS.has(path)) return;
    if (!isAbsolute(path) && cwd === null) decline("working directory is unresolved");
    let absolute: string;
    try { absolute = resolveShellFilesystemPath(path, cwd ?? sandboxRoot); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error)) throw error;
      throw new PathPolicyError({ kind: "invalid-path", reason: "Shell path policy: cannot resolve command operand", candidate: label });
    }
    const violation = findResolvedShellPathViolation(absolute, label, sandboxRoot, extraAllowedDirectories, effect, blockReadsOutsideWorkingDirectories);
    if (violation) throw new PathPolicyError(violation);
  };
  try {
    inspectShellExecution(command, cwd, facts, { path: checkPath, command(event) {
      const {node, effective, argv, cwd: commandCwd, environment} = event;
      const head = argv[0]!;
      const verb = stripCommandPath(head);
      if (event.functionCall) return;
      // The state owner checks cd's destination using its -L/-P semantics.
      // Builtin exit consumes status data, including an unknown status value.
      // Expansion effects and redirects were inspected separately. External
      // executables and functions named exit keep their own operand checks.
      // No numeric result is inferred; the conservative statement scan remains.
      const dataOnly = ["echo", "printf", "tr", "true", "false", ":", "pwd", "export", "readonly", "unset", "read", "cd"].includes(verb)
        || (event.builtin && verb === "exit");
      const knownArgv = argv.map((argument,index) => argument ?? displayShellWord(effective.words[index]!));
      const leaf = commandLeaf(node, effective);
      const effect: PathEffect = verb === "cd" ? "write" : isReadOnlyShellLeaf(leaf, {ignoreRedirects:true}) ? "read" : "write";
      if (pathEffectIsConfined(effect, blockReadsOutsideWorkingDirectories)) {
        if (RECURSIVE_TRAVERSAL_COMMANDS.has(verb) && !(verb === "tar" && parseTarListing(knownArgv) && !environment.TAR_OPTIONS)) {
          throw new PathPolicyError({kind:"recursive-traversal",reason:buildRecursiveBlockMessage(head,verb),candidate:head});
        }
        const flags=RECURSIVE_FLAG_COMMANDS.get(verb);
        const selected=knownArgv[1] === "--" ? undefined : knownArgv.slice(1).find((argument)=>flags?.some((flag)=>hasShellFlag(argument,flag)));
        if(selected) throw new PathPolicyError({kind:"recursive-traversal",reason:buildRecursiveBlockMessage(head,verb,selected),candidate:selected});
      }
      const slots=classifyOperandSlots(knownArgv);
      if(slots.dynamicExecution) decline(slots.dynamicExecution);
      const unknown = argv.findIndex((argument, index) => argument === undefined && !dataOnly
        && !(["curl", "wget"].includes(verb) && isQuotedRemoteUrl(effective.words[index]!))
        && (verb === "curl" || slots.programIndices?.has(index) || !slots.nonPathIndices.has(index) || slots.extraCandidates.some((path) => path.index === index)));
      if (unknown >= 0) decline("unresolved command operand", effective.words[unknown]);
      // Command-path operands carry the same proven effect as the command.
      // An unknown executable has no read-only proof merely because its bytes
      // could be read from outside the working directories.
      if(head.includes("/")) checkPath(head,effective.words[0]!.source.raw,commandCwd,effect);
      if(!dataOnly){
        let optionsEnded=false;
        for(let index=1;index<knownArgv.length;index++){
          const argument=knownArgv[index]!;
          if(!optionsEnded && argument === "--"){optionsEnded=true;continue;}
          if(slots.nonPathIndices.has(index))continue;
          for(const path of operandPaths(argument,!optionsEnded,verb))checkPath(path,effective.words[index]!.source.raw,commandCwd,effect);
        }
        for(const path of slots.extraCandidates)checkPath(path.value,effective.words[path.index]!.source.raw,commandCwd,effect);
      }
      inspectEmbeddedShellPrograms(event,slots);
    }});
    return null;
  }catch(error){
    if(error instanceof PathPolicyError)return error.violation;
    if(error instanceof ShellExecutionError)return {kind:"dynamic-path",reason:"Shell path policy: "+error.message,...(error.operand?{candidate:error.operand}:{})};
    throw error;
  }
}

function operandPaths(value: string, option: boolean, verb: string): string[] {
  if (["curl", "wget"].includes(verb) && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (value.toLowerCase().startsWith("file:")) {
      try { return [fileURLToPath(value)]; } catch { decline("unresolved file URL"); }
    }
    return [];
  }
  if (value === "-" && ["cat", "sed", "awk", "head", "tail", "sort", "diff", "tee"].includes(verb)) return [];
  if (option && value.startsWith("-") && value.length > 1) {
    const equals = value.indexOf("=");
    if (equals > 0) return [value.slice(equals + 1)];
    const glued = /^-[A-Za-z]+?([/~.].*)$/.exec(value);
    return glued ? [glued[1]!] : [];
  }
  if (["awk", "gawk", "mawk", "nawk"].includes(verb)) {
    const equals = value.indexOf("=");
    if (equals > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.slice(0, equals))) return [value.slice(equals + 1)];
  }
  if (verb === "dd" && (value.startsWith("if=") || value.startsWith("of="))) return [value.slice(3)];
  return [value];
}

function isQuotedRemoteUrl(word: ShellWord): boolean {
  const first = word.parts[0];
  return first?.kind === "literal" && /^https?:\/\//i.test(first.value)
    && word.parts.every((part) => part.kind === "literal" || (part.kind === "parameter" && part.quoted));
}
export function validateShellCommandPathPolicy(
  command: string, cwd: string, sandboxRoot: string, extraAllowedDirectories: readonly string[],
  blockReadsOutsideWorkingDirectories: boolean, facts?: ShellExecutionFacts,
): string | null {
  return findShellPathPolicyViolation(command, cwd, sandboxRoot, extraAllowedDirectories, blockReadsOutsideWorkingDirectories, facts)?.reason ?? null;
}

/** Program roles and recursive admission are shared by structural and path checks. */
export function inspectEmbeddedShellPrograms(event: ShellCommandEvent, suppliedSlots?: OperandSlotClassification): void {
  const { node, effective } = event;
  const verb=stripCommandPath(event.argv[0]!);
  if (event.argv.some((argument)=>argument === undefined) && verb !== "sqlite3") {
    if(NON_PATH_OPERAND_SPECS.get(verb)?.nestedCommandOptions || verb === "sed") {
      const index=event.argv.findIndex((argument)=>argument === undefined);
      decline("unresolved embedded program",effective.words[index]);
    }
    return;
  }
  const knownArgv=event.argv.map((argument,index) => argument ?? displayShellWord(effective.words[index]!));
  const slots=suppliedSlots ?? classifyOperandSlots(knownArgv);
  if(slots.dynamicExecution)decline(slots.dynamicExecution);
  const unknownProgram = event.argv.findIndex((argument, index) => argument === undefined && slots.programIndices?.has(index));
  if (unknownProgram >= 0) decline("unresolved embedded program", effective.words[unknownProgram]);
      for(const program of slots.nestedCommands)event.inspectNested(program.value,"posix");
      const shellOptions=NON_PATH_OPERAND_SPECS.get(verb)?.nestedCommandOptions;
      if(shellOptions){
        if (!["sh", "dash", "bash"].includes(verb)) decline("nested shell dialect is not supported", effective.words[0]);
        const dialect = verb === "bash" ? "bash" : "posix";
        let carriesCommand=false;
        for(let index=1;index<knownArgv.length;index++){
          const carried=readOptionValue(knownArgv,index,shellOptions);
          if(carried){event.inspectNested(carried.value,dialect);carriesCommand=true;if(carried.consumedNext)index++;}
        }
        if(!carriesCommand)for(const redirect of node.redirects)if(redirect.data){
          const program=staticShellWord(redirect.data);
          if(program === undefined)decline("unresolved shell input program",redirect.data);
          event.inspectNested(program,dialect);
        }
        if(!carriesCommand && event.fromPipe)decline("unresolved shell program from a pipe",effective.words[0]);
      }
}
