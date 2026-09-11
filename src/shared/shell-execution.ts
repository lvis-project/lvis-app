import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, resolve as pathResolve } from "node:path";
import { analyzeShell, literalWord, staticShellWord, type ShellCommand, type ShellStatement, type ShellWord, type ShellWordPart } from "./shell-analysis.js";
import { effectiveShellCommand, stripCommandPath, type EffectiveShellCommand } from "./shell-effective-command.js";
import { SHELL_ANALYSIS_LIMITS } from "./shell-parser.js";
import { resolveShellFilesystemPath } from "./shell-filesystem-path.js";

export interface ShellCommandEvent {
  original: ShellCommand;
  node: ShellCommand;
  effective: EffectiveShellCommand;
  argv: readonly (string | undefined)[];
  cwd: string | null;
  environment: Readonly<Record<string, string | undefined>>;
  builtin: boolean;
  functionCall: boolean;
  recursiveFunction: boolean;
  backquote: boolean;
  pipeline?: readonly ShellStatement[];
  fromPipe: boolean;
  activeFunctions: readonly string[];
  inspectNested(text: string, dialect: "bash" | "posix"): void;
}
export interface ShellExecutionInspector {
  word?(word: ShellWord): void;
  path(path: string, raw: string, cwd: string | null, effect: "read" | "write"): void;
  command(event: ShellCommandEvent): void;
}
export class ShellExecutionError extends Error {
  constructor(message: string, readonly operand?: string) { super(message); }
}
export interface ShellExecutionFacts {
  dialect: "bash";
  environment: Readonly<Record<string, string | undefined>>;
  /** Present only after a fixed probe of the selected interpreter and locale. */
  unicodeEscapes?: boolean;
  prefixAssignmentRhs?: "incoming" | "sequential";
}
interface ShellState {
  cwd: string | null;
  variables: Map<string, string | undefined>;
  arrays: Map<string, readonly (string | undefined)[] | undefined>;
  exported: Set<string>;
  functions: Map<string, ShellStatement>;
  readonlyVariables: Set<string>;
  unsetVariables: Set<string>;
  dialect: "bash" | "posix";
  unicodeEscapes?: boolean;
  prefixAssignmentRhs?: "incoming" | "sequential";
  backquote: boolean;
  pipeline?: readonly ShellStatement[];
  fromPipe: boolean;
  activeFunctions: readonly string[];
}
type ExitStatus = "success" | "failure" | "unknown";
interface StateResult { state: ShellState; status: ExitStatus }
interface WordEvaluation { lastSubstitutionStatus?: ExitStatus; mayFail?: boolean }
const EXECUTION_ALTERING_VARIABLES = new Set(["IFS", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "CDPATH", "PWD"]);
function stateKey(state: ShellState): string {
  return JSON.stringify([state.cwd, state.dialect, state.unicodeEscapes, state.prefixAssignmentRhs, [...state.variables].sort(), [...state.arrays].sort(), [...state.exported].sort(), [...state.readonlyVariables].sort(), [...state.unsetVariables].sort(), [...state.functions].map(([name, body]) => [name, body.source])]);
}
function decline(reason: string, word?: ShellWord): never {
  throw new ShellExecutionError(reason, word?.source.raw);
}
function cloneState(state: ShellState): ShellState {
  return { ...state, variables: new Map(state.variables), arrays: new Map(state.arrays), exported: new Set(state.exported), functions: new Map(state.functions), readonlyVariables: new Set(state.readonlyVariables), unsetVariables: new Set(state.unsetVariables) };
}
function uniqueResults(results: readonly StateResult[]): StateResult[] {
  const unique = new Map<string, StateResult>();
  for (const result of results) {
    const state = result.state;
    const key = JSON.stringify([result.status, stateKey(state)]);
    unique.set(key, result);
    if (unique.size > SHELL_ANALYSIS_LIMITS.states) decline("execution-state limit exceeded");
  }
  return [...unique.values()];
}

/** Same original text and prepared child facts are inspected at both gates. */
export function inspectShellExecution(command: string, cwd: string, facts: ShellExecutionFacts, inspector: ShellExecutionInspector): void {
  const analysis = analyzeShell(command);
  if (!analysis.ok) throw new ShellExecutionError(analysis.reason);
  const initial: ShellState = { cwd, dialect: "bash", unicodeEscapes: facts.unicodeEscapes, prefixAssignmentRhs: facts.prefixAssignmentRhs, variables: new Map(Object.entries(facts.environment)), arrays: new Map(), exported: new Set(Object.keys(facts.environment)), functions: new Map(), readonlyVariables: new Set(), unsetVariables: new Set(), backquote: false, fromPipe: false, activeFunctions: [] };
  initial.variables.set("PWD", cwd);
  // Filesystem effects cross process scopes even when variables/cwd do not.
  // Once a possibly executed operation can mutate it, a pre-execution stat
  // cannot decide a later chdir's outcome. This flag belongs to this analysis,
  // not to the clonable shell-variable state or a cross-call cache.
  let filesystemMayChange = false;
  let steps = 0;
  const checkPath = (path: string, raw: string, state: ShellState, effect: "read" | "write"): void => {
    if (!isAbsolute(path) && state.cwd === null) decline("working directory is unresolved");
    inspector.path(path, raw, state.cwd, effect);
  };
  const parameterChoice = (part: Extract<ShellWordPart, { kind: "parameter-choice" }>, state: ShellState): "operand" | "value" | "empty" | "unknown" => {
    const knownUnset = state.unsetVariables.has(part.name);
    const value = knownUnset ? "" : state.variables.get(part.name);
    if (value === undefined) return "unknown";
    const absent = knownUnset || (part.operator.startsWith(":") && value === "");
    return part.operator.endsWith("-") ? absent ? "operand" : "value" : absent ? "empty" : "operand";
  };
  const expandWord = (word: ShellWord, state: ShellState): string | undefined => {
    let output = "";
    for (const part of word.parts) {
      if (part.kind === "literal") output += part.value;
      else if (part.kind === "unicode-escaped") {
        if (state.unicodeEscapes !== true) return undefined;
        output += part.value;
      }
      else if (part.kind === "parameter") {
        if (part.index === "@") return undefined;
        const value = part.index === undefined ? state.unsetVariables.has(part.name) ? "" : state.variables.get(part.name)
          : state.arrays.has(part.name) ? state.arrays.get(part.name)?.[part.index]
          : part.index === 0 ? state.variables.get(part.name) : undefined;
        if (value === undefined) return undefined;
        if (!part.quoted && /[ \t\n*?\[\]]/.test(value)) return undefined;
        output += value;
      } else if (part.kind === "parameter-choice") {
        const choice = parameterChoice(part, state);
        const value = choice === "operand" ? expandWord(part.operand, state) : choice === "value" ? state.variables.get(part.name) : choice === "empty" ? "" : undefined;
        if (value === undefined || (!part.quoted && /[ \t\n*?\[\]]/.test(value))) return undefined;
        output += value;
      } else if (part.kind === "substitution" || part.kind === "arithmetic-data") {
        return undefined;
      } else if (part.kind === "pattern") return undefined;
      else decline(part.reason, word);
    }
    return output;
  };
  const resolveWord = (word: ShellWord, state: ShellState, depth: number, evaluation?: WordEvaluation): string | undefined => {
    inspectSubstitutions(word, state, depth, evaluation);
    return expandWord(word, state);
  };
  const resolveWords = (words: readonly ShellWord[], state: ShellState, depth: number, evaluation?: WordEvaluation): ShellWord[] => words.flatMap((word) => {
    const part = word.parts.length === 1 ? word.parts[0] : undefined;
    if (part?.kind === "parameter" && part.index === "@") {
      inspector.word?.(word);
      const elements = state.arrays.get(part.name);
      if (elements && elements.every((value) => value !== undefined && (part.quoted || !/[ \t\n*?\[\]]/.test(value)))) {
        return elements.map((value) => literalWord(value!, word.source));
      }
      return [word];
    }
    const resolved = resolveWord(word, state, depth, evaluation);
    if (resolved === "" && !word.preservesEmpty) return [];
    return [resolved === undefined ? word : literalWord(resolved, word.source)];
  });
  const setScalar = (state: ShellState, name: string, value: string | undefined): void => {
    if (state.readonlyVariables.has(name)) decline("assignment to a readonly variable");
    state.variables.set(name, value);
    state.unsetVariables.delete(name);
    if (state.arrays.has(name)) {
      const elements = state.arrays.get(name);
      state.arrays.set(name, elements ? [value, ...elements.slice(1)] : undefined);
    }
  };
  const inspectSubstitutions = (word: ShellWord, state: ShellState, depth: number, evaluation?: WordEvaluation): void => {
    inspector.word?.(word);
    for (const part of word.parts) {
      if (part.kind === "substitution") {
        const results = walk(part.body, { ...cloneState(state), backquote: state.backquote || part.backquotes }, depth + 1);
        if (!part.process && evaluation) {
          const statuses = new Set(results.map((result) => result.status));
          evaluation.lastSubstitutionStatus = statuses.size === 1 ? results[0]!.status : "unknown";
        }
      }
      if (part.kind === "parameter-choice") {
        const choice = parameterChoice(part, state);
        if (choice === "operand") inspectSubstitutions(part.operand, state, depth, evaluation);
        else if (choice === "unknown") {
          const optional: WordEvaluation = {};
          inspectSubstitutions(part.operand, state, depth, optional);
          if (evaluation && optional.lastSubstitutionStatus) evaluation.lastSubstitutionStatus = "unknown";
          if (evaluation && optional.mayFail) evaluation.mayFail = true;
        }
      }
      if (part.kind === "arithmetic-data") {
        for (const name of part.variables) {
          const value = state.unsetVariables.has(name) ? "0" : state.variables.get(name);
          if (value === undefined || state.arrays.has(name) || !/^[+-]?[0-9]+$/.test(value)) decline("unresolved arithmetic variable effects", word);
        }
        if (evaluation) evaluation.mayFail = true;
      }
      if (part.kind === "unknown") decline(part.reason, word);
    }
  };
  const applyAssignments = (node: ShellCommand, state: ShellState, incoming: ShellState, depth: number, evaluation: WordEvaluation): void => {
    for (const assignment of node.assignments) {
      const name = assignment.name;
      if (assignment.declarationOnly) {
        if (!state.variables.has(name)) state.variables.set(name, undefined);
        continue;
      }
      if (state.readonlyVariables.has(name)) decline("assignment to a readonly variable", assignment.value);
      if (EXECUTION_ALTERING_VARIABLES.has(name)) decline("execution-altering shell assignment is unsupported", assignment.value);
      if (assignment.elements) {
        const elements = resolveWords(assignment.elements, state, depth, evaluation).map((word) => staticShellWord(word));
        const existing = state.arrays.get(name);
        const result = assignment.append ? existing ? [...existing, ...elements] : state.arrays.has(name) ? undefined : state.variables.has(name) ? [state.variables.get(name), ...elements] : elements : elements;
        state.arrays.set(name, result);
        state.variables.set(name, result?.[0]);
        state.unsetVariables.delete(name);
        continue;
      }
      const expansionState = node.assignmentScope === "command" && state.prefixAssignmentRhs === "incoming" ? incoming : state;
      let value = resolveWord(assignment.value, expansionState, depth, evaluation);
      if (node.assignmentScope === "command" && state.prefixAssignmentRhs === undefined
        && value !== expandWord(assignment.value, incoming)) value = undefined;
      setScalar(state, name, assignment.append
        ? state.variables.get(name) === undefined || value === undefined ? undefined : state.variables.get(name)! + value
        : value);
    }
  };
  const inspectNested = (text: string, state: ShellState, depth: number): void => {
    const nested = analyzeShell(text, state.dialect);
    if (!nested.ok) decline(`nested command cannot be analyzed: ${nested.reason}`);
    walk(nested.program, state, depth + 1);
  };
  const executeCommand = (node: ShellCommand, incoming: ShellState, depth: number): StateResult[] => {
    const state = cloneState(incoming);
    const resolvedWords = resolveWords(node.words, incoming, depth);
    const assigned = cloneState(incoming);
    const assignmentEvaluation: WordEvaluation = {};
    applyAssignments(node, assigned, incoming, depth, assignmentEvaluation);
    if (node.redirects.some((redirect) => redirect.effect === "write" && redirect.target)) {
      filesystemMayChange = true;
    }
    if (node.words.length === 0) {
      for (const redirect of node.redirects) {
        if (redirect.target) {
          const path = resolveWord(redirect.target, assigned, depth);
          if (path === undefined) decline("unresolved redirect target", redirect.target);
          checkPath(path, redirect.target.source.raw, assigned, redirect.effect);
        }
        if (redirect.data) inspectSubstitutions(redirect.data, assigned, depth);
      }
      return [{ state: assigned, status: node.redirects.length || assignmentEvaluation.mayFail ? "unknown" : assignmentEvaluation.lastSubstitutionStatus ?? "success" }];
    }
    const resolvedNode = { ...node, words: resolvedWords };
    const effective = effectiveShellCommand(resolvedNode);
    const argv = effective.words.map((word) => staticShellWord(word));
    const head = argv[0];
    if (head === undefined) {
      if (effective.words.length === 0) return [{ state, status: "unknown" }];
      decline("unresolved executed command", effective.words[0]);
    }
    const verb = stripCommandPath(head);
    const shellBuiltin = !head.includes("/") && effective.wrappers.every((wrapper) => wrapper === "command" || wrapper === "time");
    const commandState = cloneState(assigned);
    if (effective.resetEnvironment) {
      commandState.variables.clear(); commandState.arrays.clear(); commandState.exported.clear(); commandState.unsetVariables.clear();
    }
    for (const name of effective.unsetEnvironment) { commandState.variables.delete(name); commandState.arrays.delete(name); commandState.exported.delete(name); commandState.unsetVariables.add(name); }
    for (const assignment of node.assignments) commandState.exported.add(assignment.name);
    for (const assignment of effective.environment) {
      if (EXECUTION_ALTERING_VARIABLES.has(assignment.name)) decline("execution-altering shell environment is unsupported", assignment.value);
      commandState.variables.set(assignment.name, staticShellWord(assignment.value)); commandState.exported.add(assignment.name);
      commandState.unsetVariables.delete(assignment.name);
    }
    if (effective.cwd) {
      const target = staticShellWord(effective.cwd);
      if (target === undefined) decline("unresolved wrapper working directory", effective.cwd);
      checkPath(target, effective.cwd.source.raw, commandState, "write");
      commandState.cwd = resolveShellFilesystemPath(target, commandState.cwd!);
      commandState.variables.set("PWD", commandState.cwd);
    }
    for (const path of effective.wrapperPaths) {
      const target = staticShellWord(path);
      if (target === undefined) decline("unresolved wrapper path", path);
      checkPath(target, path.source.raw, state, "read");
    }
    for (const redirect of node.redirects) {
      if (redirect.target) {
        const path = resolveWord(redirect.target, incoming, depth);
        if (path === undefined) decline("unresolved redirect target", redirect.target);
        checkPath(path, redirect.target.source.raw, incoming, redirect.effect);
      }
      if (redirect.data) inspectSubstitutions(redirect.data, incoming, depth);
    }
    if (effective.unsupported) decline(effective.unsupported, effective.words[0]);
    const functionBody = effective.wrappers.length === 0 && !head.includes("/") && state.functions.get(head);
    inspector.command({
      original: node, node: resolvedNode, effective, argv, cwd: commandState.cwd,
      environment: Object.freeze(Object.fromEntries(commandState.variables)), builtin: shellBuiltin,
      functionCall: !!functionBody, recursiveFunction: !!functionBody && state.activeFunctions.includes(head), backquote: state.backquote, pipeline: state.pipeline, fromPipe: state.fromPipe, activeFunctions: state.activeFunctions,
      inspectNested(text, dialect) {
        const child = cloneState(commandState);
        child.dialect = dialect;
        child.unicodeEscapes = undefined; child.prefixAssignmentRhs = undefined;
        child.variables = new Map([...child.variables].filter(([name]) => child.exported.has(name) && !child.arrays.has(name)));
        child.arrays.clear(); child.functions.clear(); child.readonlyVariables.clear();
        child.variables.set("PWD", child.cwd ?? undefined);
        inspectNested(text, child, depth);
      },
    });
    if (functionBody) {
      if (state.activeFunctions.includes(head)) decline("recursive function execution cannot establish finite authority", effective.words[0]);
      const local = cloneState(commandState);
      local.activeFunctions = [...state.activeFunctions, head];
      for (const name of local.variables.keys()) if (/^\d+$/.test(name)) local.variables.delete(name);
      argv.slice(1).forEach((argument, index) => local.variables.set(String(index + 1), argument));
      return walk(functionBody, local, depth + 1).map((result) => {
        result.state.activeFunctions = state.activeFunctions;
        for (const name of result.state.variables.keys()) if (/^\d+$/.test(name)) result.state.variables.delete(name);
        for (const [name, value] of state.variables) if (/^\d+$/.test(name)) result.state.variables.set(name, value);
        for (const assignment of node.assignments) {
          if (state.exported.has(assignment.name)) result.state.exported.add(assignment.name);
          else result.state.exported.delete(assignment.name);
          if (state.variables.has(assignment.name)) result.state.variables.set(assignment.name, state.variables.get(assignment.name));
          else result.state.variables.delete(assignment.name);
          if (state.arrays.has(assignment.name)) result.state.arrays.set(assignment.name, state.arrays.get(assignment.name));
          else result.state.arrays.delete(assignment.name);
          if (state.unsetVariables.has(assignment.name)) result.state.unsetVariables.add(assignment.name);
          else result.state.unsetVariables.delete(assignment.name);
        }
        return result;
      });
    }
    if (state.dialect === "posix" && shellBuiltin && [":", "export", "readonly", "set", "unset", "exit"].includes(verb)) {
      // POSIX special builtins retain their prefix assignments. Expansion of
      // their outer argv still used the incoming state above.
      for (const assignment of node.assignments) setScalar(state, assignment.name, assigned.variables.get(assignment.name));
    }
    if (!functionBody && (!shellBuiltin || !["echo", "printf", "tr", "true", "false", ":", "pwd", "cd", "test", "set", "export", "readonly", "unset", "read"].includes(verb))) {
      filesystemMayChange = true;
    }
    const knownArgv = argv.map((argument) => argument ?? "");
    if (["eval", "source", ".", "exec", "builtin", "shopt", "trap", "alias", "unalias", "pushd", "popd", "break", "continue", "return", "shift", "getopts", "mapfile", "readarray", "let", "enable", "hash"].includes(verb)) decline(`unsupported execution-state operation: ${verb}`, effective.words[0]);
    if (shellBuiltin && verb === "set") {
      for (let index = 1; index < argv.length; index += 1) {
        const option = argv[index];
        if (option !== undefined && /^[-+][euxvET]+$/.test(option)) continue;
        if ((option === "-o" || option === "+o") && argv[index + 1] === "pipefail") { index += 1; continue; }
        decline("unsupported shell option state", effective.words[index]);
      }
      return [{ state, status: "success" }];
    }
    if (shellBuiltin && ["export", "readonly"].includes(verb)) {
      for (const assignment of node.assignments) {
        state.variables.set(assignment.name, assigned.variables.get(assignment.name));
        if (!assignment.declarationOnly) state.unsetVariables.delete(assignment.name);
        if (assigned.arrays.has(assignment.name)) state.arrays.set(assignment.name, assigned.arrays.get(assignment.name));
        if (verb === "export") state.exported.add(assignment.name);
        else state.readonlyVariables.add(assignment.name);
      }
      return [{ state, status: "success" }];
    }
    if (shellBuiltin && verb === "unset") {
      let namespace: "variable" | "function" | "either" = "either";
      let options = true;
      for (const name of argv.slice(1)) {
        if (options && name === "--") { options = false; continue; }
        if (options && (name === "-v" || name === "-f")) { namespace = name === "-v" ? "variable" : "function"; continue; }
        options = false;
        if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) decline("unsupported unset operand");
        if (namespace === "function" || (namespace === "either" && !assigned.variables.has(name) && !assigned.arrays.has(name))) {
          state.functions.delete(name);
          continue;
        }
        if (state.readonlyVariables.has(name)) decline("unset of a readonly variable");
        // A command-prefix binding is temporary; unsetting it does not unset
        // the parent binding in the selected Bash contracts.
        if (state.dialect === "posix" || !node.assignments.some((assignment) => assignment.name === name)) {
          state.variables.delete(name); state.unsetVariables.add(name); state.arrays.delete(name); state.exported.delete(name);
        }
      }
      return [{ state, status: "success" }];
    }
    if (shellBuiltin && verb === "printf" && argv[1] === "-v") {
      const name = argv[2];
      if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) decline("unresolved printf variable", effective.words[2]);
      setScalar(state, name, undefined);
    }
    if (shellBuiltin && verb === "read") {
      const names: string[] = [];
      let raw = false;
      let simple = true;
      for (let index = 1; index < argv.length; index += 1) {
        const name = argv[index];
        if (name === "-r") { raw = true; continue; }
        if (name === "--") continue;
        if (name !== undefined && ["-d", "-n", "-N", "-p", "-t", "-u"].includes(name)) { simple = false; index += 1; continue; }
        if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) decline("unsupported read variable", effective.words[index]);
        names.push(name);
      }
      const implicitReply = names.length === 0;
      if (implicitReply) names.push("REPLY");
      const data = node.redirects.length === 1 ? node.redirects[0]?.data : undefined;
      const text = data ? expandWord(data, incoming) : undefined;
      const line = text?.split("\n")[0];
      const value = raw && simple && names.length === 1 && line !== undefined
        ? implicitReply ? line : line.replace(/^[ \t]+|[ \t]+$/g, "") : undefined;
      // Bash 3.2 and 5.x differ when read writes a command-prefix variable.
      // Without a dedicated capability proof neither outcome grants authority.
      for (const name of names) setScalar(state, name,
        node.assignments.some((assignment) => assignment.name === name) ? undefined : value);
      return [{ state, status: "unknown" }];
    }
    if (shellBuiltin && verb === "cd") {
      if (argv.some((argument) => argument === undefined)) decline("unresolved working-directory destination", effective.words[1]);
      const args: string[] = [];
      let options = true;
      let physical = false;
      let targetWord: ShellWord | undefined;
      for (let index = 1; index < knownArgv.length; index += 1) {
        const argument = knownArgv[index]!;
        if (options && argument === "--") { options = false; continue; }
        if (options && /^-[LP]+$/.test(argument)) { physical = argument.endsWith("P"); continue; }
        if (options && argument.startsWith("-") && argument !== "-") return [{ state, status: "failure" }];
        options = false;
        args.push(argument);
        targetWord ??= effective.words[index];
      }
      if (args.length > 1) return [{ state, status: "failure" }];
      const target = args[0] === "-" ? commandState.variables.get("OLDPWD") : args[0] ?? commandState.variables.get("HOME");
      if (target === undefined) decline("unresolved working-directory destination", effective.words[1]);
      const label = targetWord?.source.raw ?? head;
      const next = pathResolve(state.cwd!, target);
      const destination = physical ? resolveShellFilesystemPath(target, state.cwd!) : next;
      // cd -L collapses logical .. before chdir; -P follows actual links.
      checkPath(destination, label, state, "write");
      let observedDirectory = false;
      try {
        // Bash still requires the original components to name a searchable
        // directory: a missing `new/..` is not proven by an existing parent.
        const original = isAbsolute(target) ? target : `${state.cwd!}/${target}`;
        observedDirectory = statSync(original).isDirectory();
        accessSync(original, constants.X_OK);
        accessSync(destination, constants.X_OK);
      } catch { observedDirectory = false; }
      if (!observedDirectory && !filesystemMayChange) return [{ state, status: "failure" }];
      const changed = cloneState(state);
      changed.variables.set("OLDPWD", state.cwd ?? undefined); changed.cwd = destination; changed.variables.set("PWD", destination);
      return filesystemMayChange
        ? [{ state: changed, status: "success" }, { state, status: "failure" }]
        : [{ state: changed, status: "success" }];
    }
    return [{ state, status: shellBuiltin && ["true", ":"].includes(verb) ? "success" : shellBuiltin && verb === "false" ? "failure" : "unknown" }];
  };
  const inspectCommand = (node: ShellCommand, incoming: ShellState, depth: number): StateResult[] => {
    const results = executeCommand(node, incoming, depth);
    // Opening a redirect can fail before a builtin/function changes shell state.
    // Such I/O outcomes are not established by path admission.
    return node.redirects.length
      ? uniqueResults([...results, { state: cloneState(incoming), status: "failure" }])
      : results;
  };
  const walk = (node: ShellStatement, state: ShellState, depth: number): StateResult[] => {
    if (++steps > SHELL_ANALYSIS_LIMITS.nodes) decline("execution-step limit exceeded");
    if (depth > SHELL_ANALYSIS_LIMITS.depth) decline("execution analysis depth exceeded");
    switch (node.kind) {
      case "unsupported": decline(node.reason);
      case "command": return inspectCommand(node, state, depth);
      case "sequence": {
        let results: StateResult[] = [{ state, status: "success" }];
        for (const statement of node.statements) results = uniqueResults(results.flatMap((result) => walk(statement, result.state, depth + 1)));
        return results;
      }
      case "and": case "or": {
        const results: StateResult[] = [];
        for (const left of walk(node.left, state, depth + 1)) {
          const desired = node.kind === "and" ? "success" : "failure";
          if (left.status !== desired) results.push({ state: left.state, status: desired === "success" ? "failure" : "success" });
          if (left.status === desired || left.status === "unknown") results.push(...walk(node.right, left.state, depth + 1));
        }
        return uniqueResults(results);
      }
      case "if": {
        const results: StateResult[] = [];
        for (const condition of walk(node.condition, state, depth + 1)) {
          if (condition.status !== "failure") results.push(...walk(node.consequent, condition.state, depth + 1));
          if (condition.status !== "success") results.push(...walk(node.alternate, condition.state, depth + 1));
        }
        return uniqueResults(results);
      }
      case "subshell": case "background": {
        const result = walk(node.body, cloneState(state), depth + 1);
        return result.map((entry) => ({ state, status: node.kind === "background" ? "success" : entry.status }));
      }
      case "negate": return walk(node.body, state, depth + 1).map((result) => ({ ...result, status: result.status === "success" ? "failure" : result.status === "failure" ? "success" : "unknown" }));
      case "pipeline":
        node.statements.forEach((statement, index) => walk(statement, { ...cloneState(state), pipeline: node.statements, fromPipe: index > 0 }, depth + 1));
        return [{ state, status: "unknown" }];
      case "function": { const next = cloneState(state); next.functions.set(node.name, node.body); return [{ state: next, status: "success" }]; }
      case "for": {
        if (node.values === null) decline("implicit loop values are unresolved");
        const values = resolveWords(node.values, state, depth).map((word) => {
          const value = staticShellWord(word);
          if (value === undefined) decline("unresolved loop value", word);
          return value;
        });
        if (values.length > SHELL_ANALYSIS_LIMITS.states) decline("loop expansion limit exceeded");
        let results: StateResult[] = [{ state, status: "success" }];
        for (const value of values) results = uniqueResults(results.flatMap((result) => {
          const next = cloneState(result.state); setScalar(next, node.name, value); return walk(node.body, next, depth + 1);
        }));
        return results;
      }
      case "while": {
        const results: StateResult[] = [];
        const pending: ShellState[] = [state];
        const seen = new Set<string>();
        const terminal = node.until ? "success" : "failure";
        while (pending.length) {
          const current = pending.shift()!;
          const key = stateKey(current);
          if (seen.has(key)) continue;
          seen.add(key);
          if (seen.size > SHELL_ANALYSIS_LIMITS.states) decline("loop authority state does not converge within the execution-state limit");
          for (const condition of walk(node.condition, current, depth + 1)) {
            // The condition runs even when the body runs zero times.
            if (condition.status === terminal || condition.status === "unknown") results.push({ state: condition.state, status: "unknown" });
            if (condition.status !== terminal) {
              for (const body of walk(node.body, condition.state, depth + 1)) pending.push(body.state);
            }
          }
        }
        return uniqueResults(results);
      }
    }
  };
  walk(analysis.program, initial, 0);
}
