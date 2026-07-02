/**
 * cli/commands.ts — #1409 C12 minimal CLI command definitions.
 *
 * A command TABLE plus a pure {@link runCommand}(argv, client) resolver over the
 * typed {@link LvisClient}. It proves the CLI consumes the SAME app contract as
 * the renderer (read + send subset) through the `cli` {@link TrustOrigin}.
 *
 * SCAFFOLD ONLY: this file wires NO real process entrypoint and NO `package.json`
 * bin — argv parsing, exit codes, output formatting, and the loopback network
 * transport are the documented #1409 follow-up. Only read/send commands exist;
 * mutating gesture-gated operations are absent because the `cli` origin can
 * never satisfy the user-keyboard gesture (the dispatcher fails them closed).
 */
import type { LvisClient } from "../sdk/index.js";
import type { ChatSendPayload } from "../shared/chat-origin.js";

/** One CLI command: a name, a one-line summary, and a client-bound runner. */
export interface CliCommand {
  /** Command token matched against `argv[0]`. */
  name: string;
  /** One-line human summary (usage/help text). */
  summary: string;
  /** Execute the command against the SDK client with the remaining args. */
  run(client: LvisClient, args: readonly string[]): Promise<unknown>;
}

/**
 * The command table. Each entry maps to a single {@link LvisClient} read/send
 * method — the CLI holds no logic of its own beyond argument shaping.
 */
export const CLI_COMMANDS: readonly CliCommand[] = [
  {
    name: "session:list",
    summary: "List recent chat sessions (+ active session id)",
    run: (client) => client.listSessions(),
  },
  {
    name: "chat:send",
    summary: "Send a chat message: chat:send <text...>",
    run: (client, args) => {
      // `queue-auto` is the only ChatSendInputOrigin that passes handler
      // validation without a user-keyboard gesture token or a plugin envelope.
      // A dedicated external chat origin is part of the #1409 authenticated-authz
      // follow-up; the scaffold reuses this non-gesture path.
      const payload: ChatSendPayload = { input: args.join(" "), inputOrigin: "queue-auto" };
      return client.sendMessage(payload);
    },
  },
  {
    name: "plugin:list",
    summary: "List installed plugins",
    run: (client) => client.listPlugins(),
  },
  {
    name: "permission:mode",
    summary: "Show the current permission mode (read-only)",
    run: (client) => client.getPermissionMode(),
  },
  {
    name: "marketplace:list",
    summary: "List marketplace plugins",
    run: (client) => client.listMarketplace(),
  },
] as const;

/** Result of {@link runCommand} — a defined envelope (no throws for bad input). */
export type CliRunResult =
  | { ok: true; command: string; data: unknown }
  | { ok: false; error: "unknown-command"; command: string };

/**
 * Resolve `argv` against {@link CLI_COMMANDS} and run the matched command with
 * the given client. `argv[0]` is the command name; the rest are its args.
 */
export async function runCommand(
  argv: readonly string[],
  client: LvisClient,
): Promise<CliRunResult> {
  const [name, ...rest] = argv;
  const command = name ? CLI_COMMANDS.find((c) => c.name === name) : undefined;
  if (!command) return { ok: false, error: "unknown-command", command: name ?? "" };
  const data = await command.run(client, rest);
  return { ok: true, command: command.name, data };
}
