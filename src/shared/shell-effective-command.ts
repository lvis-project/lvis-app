import { displayShellWord, literalWord, staticShellWord, type ShellAssignment, type ShellCommand, type ShellWord, type ShellWordPart } from "./shell-analysis.js";

export interface EffectiveShellCommand {
  words: readonly ShellWord[];
  assignments: readonly ShellAssignment[];
  environment: readonly ShellAssignment[];
  unsetEnvironment: readonly string[];
  resetEnvironment: boolean;
  cwd?: ShellWord;
  wrappers: readonly string[];
  wrapperPaths: readonly ShellWord[];
  unsupported?: string;
}
export function stripCommandPath(word: string): string { return word.slice(word.lastIndexOf("/") + 1); }

/** Wrapper option arity belongs to the same command view all consumers use. */
export function effectiveShellCommand(command: ShellCommand): EffectiveShellCommand {
  let words = [...command.words];
  const wrappers: string[] = [];
  const environment: ShellAssignment[] = [];
  const unsetEnvironment: string[] = [];
  const wrapperPaths: ShellWord[] = [];
  let resetEnvironment = false;
  let cwd: ShellWord | undefined;
  const result = (unsupported?: string): EffectiveShellCommand => ({ words, assignments: command.assignments,
    environment, unsetEnvironment, resetEnvironment, wrappers, wrapperPaths, ...(cwd ? { cwd } : {}), ...(unsupported ? { unsupported } : {}) });
  for (;;) {
    const head = words[0] && staticShellWord(words[0]);
    if (head === undefined) return result(words.length ? "Unresolved executed command" : undefined);
    const verb = stripCommandPath(head);
    if (!["command", "env", "timeout", "nice", "ionice", "nohup", "stdbuf", "time", "watch", "xargs"].includes(verb)) return result();
    if (verb === "xargs" || verb === "watch") return result(`Unsupported stream or string execution wrapper: ${verb}`);
    if (head.includes("/")) wrapperPaths.push(words[0]!);
    wrappers.push(verb);
    let index = 1;
    let needsDuration = verb === "timeout";
    while (index < words.length) {
      const word = words[index]!;
      const value = staticShellWord(word);
      if (value === undefined) return result(`Unresolved ${verb} wrapper operand`);
      if (value === "--") {
        index += 1;
        if (needsDuration) {
          if (!words[index] || staticShellWord(words[index]!) === undefined) return result("Missing timeout duration");
          index += 1;
          needsDuration = false;
        }
        break;
      }
      if (verb === "env") {
        if (value === "-i" || value === "--ignore-environment" || value === "-") { resetEnvironment = true; index += 1; continue; }
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(value);
        if (assignment) {
          environment.push({ name: assignment[1]!, value: literalWord(value.slice(assignment[0].length), word.source), append: false, source: word.source });
          index += 1; continue;
        }
        const option = value.split("=", 1)[0]!;
        if (["-u", "--unset", "-C", "--chdir"].includes(option)) {
          const equals = value.indexOf("=");
          const argument = equals >= 0 ? literalWord(value.slice(equals + 1), word.source) : words[index + 1];
          if (!argument || staticShellWord(argument) === undefined) return result("Unresolved environment wrapper option");
          if (option === "-u" || option === "--unset") unsetEnvironment.push(staticShellWord(argument)!);
          else { cwd = argument; wrapperPaths.push(argument); }
          index += equals >= 0 ? 1 : 2; continue;
        }
      }
      if (value.startsWith("-")) {
        const option = value.split("=", 1)[0]!;
        const flags: Readonly<Record<string, readonly string[]>> = {
          command: ["-p"], timeout: ["--preserve-status", "--foreground", "--verbose"],
          nice: [], ionice: ["-t", "--ignore"], nohup: [], stdbuf: [], time: ["-p"], env: [],
        };
        const values: Readonly<Record<string, readonly string[]>> = {
          command: [], timeout: ["-k", "--kill-after", "-s", "--signal"], nice: ["-n", "--adjustment"],
          ionice: ["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"],
          nohup: [], stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"], time: [], env: [],
        };
        if (flags[verb]?.includes(value)) { index += 1; continue; }
        const attachedShort = values[verb]?.find((candidate) => candidate.length === 2 && value.startsWith(candidate) && value.length > 2);
        if (values[verb]?.includes(option) || attachedShort) {
          if (value.includes("=") || attachedShort) { index += 1; continue; }
          if (!words[index + 1] || staticShellWord(words[index + 1]!) === undefined) return result(`Missing ${verb} wrapper option value`);
          index += 2; continue;
        }
        // Querying a command or a wrapper never executes the remaining argv.
        if (verb === "command" && ["-v", "-V"].includes(value)) return result();
        return result(`Unsupported ${verb} wrapper option: ${value}`);
      }
      if (needsDuration) { needsDuration = false; index += 1; }
      break;
    }
    if (needsDuration) return result("Missing timeout wrapper duration");
    words = words.slice(index);
    if (words.length === 0) return result();
  }
}

export interface ShellLeaf {
  argv: string[];
  redirectTargets: string[];
  inputRedirectTargets: string[];
  hasOutputRedirect: boolean;
  hasInputRedirect: boolean;
  hasCommandSubstitution: boolean;
  hasProcessSubstitution: boolean;
  argvHasExpandableDollar: boolean[];
  strippedWrappers: string[];
  assignments: string[];
  raw: string;
}
function wordParts(word: ShellWord): ShellWordPart[] {
  return word.parts.flatMap((part) => part.kind === "parameter-choice" ? [part, ...wordParts(part.operand)] : [part]);
}
export function commandLeaf(command: ShellCommand, effective = effectiveShellCommand(command)): ShellLeaf {
  const allWords = [...command.words, ...command.assignments.flatMap((assignment) => [assignment.value, ...(assignment.elements ?? [])]),
    ...command.redirects.flatMap((redirect) => [...(redirect.target ? [redirect.target] : []), ...(redirect.data ? [redirect.data] : [])])];
  return {
    argv: effective.words.map(displayShellWord),
    redirectTargets: command.redirects.filter((redirect) => redirect.effect === "write" && redirect.target).map((redirect) => displayShellWord(redirect.target!)),
    inputRedirectTargets: command.redirects.filter((redirect) => redirect.effect === "read" && redirect.target).map((redirect) => displayShellWord(redirect.target!)),
    hasOutputRedirect: command.redirects.some((redirect) => redirect.effect === "write"),
    hasInputRedirect: command.redirects.some((redirect) => redirect.effect === "read"),
    hasCommandSubstitution: allWords.some((word) => wordParts(word).some((part) => part.kind === "substitution" && !part.process)),
    hasProcessSubstitution: allWords.some((word) => wordParts(word).some((part) => part.kind === "substitution" && part.process)),
    argvHasExpandableDollar: effective.words.map((word) => word.parts.some((part) => part.kind !== "literal")),
    strippedWrappers: [...effective.wrappers],
    assignments: [...command.assignments, ...effective.environment].map((assignment) => `${assignment.name}=${displayShellWord(assignment.value)}`),
    raw: command.source.raw,
  };
}
