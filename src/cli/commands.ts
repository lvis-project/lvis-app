/**
 * cli/commands.ts — #1409 C12 minimal CLI command definitions.
 *
 * A command TABLE plus a pure {@link runCommand}(argv, client) resolver over the
 * typed {@link LvisClient}. It proves the CLI consumes the SAME app contract as
 * the renderer (read + send subset) through the `cli` {@link TrustOrigin}.
 *
 * The real process entrypoint is `scripts/lvis-cli.ts` (`bun run cli -- <cmd>`,
 * exit codes 0/1/2) over the loopback HTTP transport in `cli/http-client.ts`
 * (#1436). Only read/send commands exist,
 * plus ONE approval-mediated mutation (US-104): `permission:set-mode`, the sole
 * entry in the contract's `EXTERNAL_MUTATION_CHANNELS` allowlist (#1409). Every
 * OTHER mutating gesture-gated operation is absent because the `cli` origin can
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
  /**
   * Validate `args` before dispatch. Returns an error message when `args` are
   * insufficient (e.g. a required positional is missing) — `runCommand` then
   * short-circuits with a `usage-error` result instead of calling `run`.
   */
  validate?(args: readonly string[]): string | undefined;
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
    name: "permission:set-mode",
    summary: "Set the permission mode (approval-gated): permission:set-mode <mode>",
    validate: (args) => (args[0] ? undefined : "permission:set-mode requires a <mode> argument"),
    run: (client, args) => client.setPermissionMode(args[0]),
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
  | { ok: false; error: "unknown-command"; command: string }
  | { ok: false; error: "usage-error"; command: string; message: string };

/**
 * Resolve `argv` against {@link CLI_COMMANDS} and run the matched command with
 * the given client. `argv[0]` is the command name; the rest are its args. A
 * command's optional {@link CliCommand.validate} runs BEFORE dispatch — a
 * missing/malformed positional argument (e.g. `permission:set-mode` with no
 * `<mode>`) short-circuits with `usage-error` instead of reaching the client.
 */
export async function runCommand(
  argv: readonly string[],
  client: LvisClient,
): Promise<CliRunResult> {
  const [name, ...rest] = argv;
  const command = name ? CLI_COMMANDS.find((c) => c.name === name) : undefined;
  if (!command) return { ok: false, error: "unknown-command", command: name ?? "" };
  const usageMessage = command.validate?.(rest);
  if (usageMessage) return { ok: false, error: "usage-error", command: command.name, message: usageMessage };
  const data = await command.run(client, rest);
  return { ok: true, command: command.name, data };
}
