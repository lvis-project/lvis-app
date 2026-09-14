import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, sep } from "node:path";

import { canonicalizePathForMatch, caseFoldForMatch, foldCanonicalPathSeparators, isSensitivePath } from "../permissions/sensitive-paths.js";
import { staticShellWord } from "../shared/shell-analysis.js";
import { stripCommandPath } from "../shared/shell-effective-command.js";
import { inspectShellExecution, type ShellCommandEvent, type ShellExecutionFacts } from "../shared/shell-execution.js";
import { inspectEmbeddedShellPrograms } from "./shell-path-policy.js";

// The event's builtin flag describes lookup context, not builtin membership.
// A bare external command has that flag too; only these names avoid PATH lookup.
const SHELL_BUILTINS = new Set([
  ":", ".", "[", "alias", "bg", "bind", "break", "builtin", "caller", "cd",
  "command", "compgen", "complete", "compopt", "continue", "declare", "dirs",
  "disown", "echo", "enable", "eval", "exec", "exit", "export", "false", "fc",
  "fg", "getopts", "hash", "help", "history", "jobs", "kill", "let", "local",
  "logout", "mapfile", "popd", "printf", "pushd", "pwd", "read", "readarray",
  "readonly", "return", "set", "shift", "shopt", "source", "suspend", "test",
  "times", "trap", "true", "type", "typeset", "ulimit", "umask", "unalias",
  "unset", "wait",
]);
const POSIX_RESERVED_WORDS = new Set([
  "!", "{", "}", "case", "do", "done", "elif", "else", "esac", "fi", "for",
  "if", "in", "then", "until", "while",
]);
const BASH_RESERVED_WORDS = new Set(["[[", "]]", "coproc", "function", "select", "time"]);

interface ExecutablePath {
  lexical: string;
  real: string;
}

function readableExecutable(path: ExecutablePath): boolean {
  // The filesystem transport interprets these bytes as patterns, even when
  // the shell supplied a quoted literal. It cannot express an exact grant.
  if (/[?*\[\]]/.test(path.lexical) || /[?*\[\]]/.test(path.real)) return false;
  // Canonicalizing the lexical name first could hide a sensitive symlink name.
  return !isSensitivePath(caseFoldForMatch(foldCanonicalPathSeparators(path.lexical)))
    && !isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(path.real)));
}

function executablePath(candidate: string): ExecutablePath | undefined {
  try {
    accessSync(candidate, constants.X_OK);
    if (!statSync(candidate).isFile()) return undefined;
    const real = realpathSync.native(candidate);
    if (!statSync(real).isFile()) return undefined;
    accessSync(real, constants.X_OK);
    return { lexical: candidate, real };
  } catch (error) {
    if (error instanceof Error && "code" in error
      && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))) return undefined;
    throw error;
  }
}

function lookupExecutable(name: string, path: string, cwd: string | null, all = false): ExecutablePath[] {
  if (!name || name.includes("/") || (sep === "\\" && name.includes("\\"))) return [];
  const found: ExecutablePath[] = [];
  for (const entry of path.split(delimiter)) {
    if (!isAbsolute(entry) && cwd === null) return [];
    // Preserve link/.. until the filesystem resolves it, just as the shell does.
    const directory = isAbsolute(entry) ? entry : `${cwd}${sep}${entry}`;
    const candidate = directory.endsWith(sep) ? `${directory}${name}` : `${directory}${sep}${name}`;
    const executable = executablePath(candidate);
    if (!executable) continue;
    found.push(executable);
    if (!all) break;
  }
  return found;
}

function resolvedExecutables(name: string, path: string, cwd: string | null, all = false): ExecutablePath[] {
  if (!name.includes("/") && !(sep === "\\" && name.includes("\\"))) {
    return lookupExecutable(name, path, cwd, all).filter(readableExecutable);
  }
  if (!isAbsolute(name)) return [];
  const explicit = executablePath(name);
  if (!explicit || !readableExecutable(explicit)) return [];
  const selected = lookupExecutable(basename(name), path, cwd)[0];
  // An explicit command outside PATH has no ambient executable capability.
  // The caller independently applies its existing absolute-path authority.
  return selected && readableExecutable(selected) && caseFoldForMatch(selected.real) === caseFoldForMatch(explicit.real)
    ? [explicit, selected] : [];
}

function queryNames(event: ShellCommandEvent): { names: string[]; all: boolean } | undefined {
  const [head, ...args] = event.argv;
  if (head === "command" && event.builtin) {
    if (args[0] !== "-v" && args[0] !== "-V") return undefined;
    const names = args.slice(1);
    if (names[0] === "--") names.shift();
    if (names.some((name) => name === undefined || name.startsWith("-"))) return undefined;
    return { names: (names as string[]).filter((name) => !SHELL_BUILTINS.has(name)
      && !POSIX_RESERVED_WORDS.has(name) && !(event.dialect === "bash" && BASH_RESERVED_WORDS.has(name))
      && !event.definedFunctions.includes(name)), all: false };
  }
  if (head === undefined || stripCommandPath(head) !== "which") return undefined;
  let all = false;
  let index = 0;
  for (; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--") { index += 1; break; }
    if (option === "-a" || option === "--all") { all = true; continue; }
    if (option === undefined || option.startsWith("-")) return undefined;
    break;
  }
  const names = args.slice(index);
  if (names.some((name) => name === undefined)) return undefined;
  return { names: names as string[], all };
}

function wrapperNames(event: ShellCommandEvent): string[] {
  const { effective, node } = event;
  // The event carries only the final wrapper state. Earlier states are not
  // recoverable after env/cwd changes, so do not guess an outer PATH lookup.
  if (effective.cwd || effective.resetEnvironment || effective.unsetEnvironment.includes("PATH")
    || effective.environment.some((assignment) => assignment.name === "PATH")
    || node.assignments.some((assignment) => assignment.name === "PATH")) return [];
  const firstInnerWord = effective.words[0];
  const boundary = firstInnerWord ? node.words.indexOf(firstInnerWord) : node.words.length;
  const prefix = node.words.slice(0, Math.max(0, boundary)).map(staticShellWord);
  const names: string[] = [];
  for (const wrapper of new Set(effective.wrappers)) {
    const candidates = prefix.filter((word): word is string => word !== undefined && stripCommandPath(word) === wrapper);
    // Option data may spell a wrapper name. Only an exact count proves that
    // every occurrence is a wrapper head in the canonical flattened view.
    if (candidates.length !== effective.wrappers.filter((name) => name === wrapper).length) continue;
    for (const candidate of candidates) {
      if ((wrapper === "command" || wrapper === "time") && !candidate.includes("/")) continue;
      names.push(candidate);
    }
  }
  return names;
}

/** Exact executable read resources; this does not authorize command execution. */
export function collectShellExecutableReadPaths(
  command: string,
  cwd: string,
  facts: ShellExecutionFacts,
): readonly string[] {
  const paths = new Set<string>();
  const baselinePath = facts.environment.PATH;
  inspectShellExecution(command, cwd, facts, {
    path() {},
    command(event) {
      if (event.functionCall) return;
      const outer = event.node.words[0] && staticShellWord(event.node.words[0]);
      if (outer && !outer.includes("/") && event.definedFunctions.includes(outer)) return;
      const prefix = event.node.words.slice(0, event.node.words.indexOf(event.effective.words[0]!));
      const defaultSearchPath = event.effective.wrappers.includes("command")
        && prefix.some((word) => staticShellWord(word) === "-p");
      const externalWrapper = event.effective.wrappers.some((name) => name !== "command" && name !== "time")
        || prefix.some((word) => {
          const name = staticShellWord(word);
          return name?.includes("/") && ["command", "time"].includes(stripCommandPath(name));
        });
      if (!defaultSearchPath && baselinePath !== undefined && event.environment.PATH === baselinePath) {
        const add = (name: string, all = false): boolean => {
          const executables = resolvedExecutables(name, baselinePath, event.cwd, all);
          for (const executable of executables) {
            paths.add(executable.lexical);
            paths.add(executable.real);
          }
          return executables.length > 0;
        };
        const exportedPathMatches = event.exportedEnvironment.PATH === baselinePath;
        for (const wrapper of wrapperNames(event)) {
          // The outer shell can use an unexported PATH; later external
          // wrappers receive only the exported environment.
          if (exportedPathMatches || wrapper === outer) add(wrapper);
        }
        const head = event.argv[0];
        const headAvailable = !!head && (!externalWrapper || exportedPathMatches)
          && !(event.builtin && !externalWrapper && SHELL_BUILTINS.has(head)) && add(head);
        const query = queryNames(event);
        if (query && (head === "command" && event.builtin && !externalWrapper || headAvailable && exportedPathMatches)) {
          for (const name of query.names) add(name, query.all);
        }
      }
      inspectEmbeddedShellPrograms(event);
    },
  });
  // No results escape when any later statement fails canonical analysis.
  return Object.freeze([...paths]);
}
