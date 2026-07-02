/**
 * lvis-cli.ts — #1436 THIN process entrypoint for the LVIS CLI (#1409 follow-up).
 *
 * The runnable edge over the loopback local API server. It is deliberately thin:
 * parse argv → discover the server → build the typed client → run the matched
 * command → print + exit. ALL command logic lives in the pure, client-bound
 * `runCommand` (`src/cli/commands.ts`); the transport lives in
 * `src/cli/http-client.ts`; the typed client comes from the SDK facade
 * (`createLvisClient`). This file holds ZERO agent/command logic of its own.
 *
 * Invocation (tsx, matching the `scripts/plugins-cli.ts` precedent — the package
 * is private/unpublished, so there is no `bin`; the documented invocation is the
 * npm script): `bun run cli -- <command> [args...]`.
 *
 * Exit codes:
 *   0 — usage printed (no args / help), or a command succeeded.
 *   2 — server not running, an unknown command, or a command usage error (e.g.
 *       `permission:set-mode` with no `<mode>`) — usage text → stderr.
 *   1 — a dispatch was rejected (LvisClientError) — including a server that went
 *       away mid-flight (surfaces as the `server-unavailable` transport code),
 *       or an approval-mediated mutation the user declined (surfaces as the
 *       `external-mutation-denied` code, e.g. `permission:set-mode`).
 *
 * The entry is NOT exercised as a subprocess in tests (slow/flaky) — it stays
 * thin enough that the transport + command-table tests cover the real logic.
 */
import { CLI_COMMANDS, runCommand } from "../src/cli/commands.js";
import { createHttpLocalApi, readLocalApiConnection } from "../src/cli/http-client.js";
import { createLvisClient, LvisClientError } from "../src/sdk/index.js";

/** English usage text: command list + summaries + how to enable the server. */
function usageText(): string {
  const commands = CLI_COMMANDS.map((c) => `  ${c.name.padEnd(20)} ${c.summary}`).join("\n");
  return [
    "LVIS CLI — talk to a running LVIS instance over its loopback local API.",
    "",
    "Usage:",
    "  bun run cli -- <command> [args...]",
    "",
    "Commands:",
    commands,
    "",
    "The local API server is OFF by default. Enable it, then restart LVIS:",
    "  - Settings → System → localApiServer (settings.system.localApiServer = true), or",
    "  - set the environment variable LVIS_LOCAL_API=1",
  ].join("\n");
}

/** One line pointing the user at how to turn the server on. */
const SERVER_NOT_RUNNING =
  "local API server is not running (enable settings.system.localApiServer or LVIS_LOCAL_API=1 and restart LVIS)";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  // No args or an explicit help request → usage on stdout, success.
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    console.log(usageText());
    return 0;
  }

  // Discover the running server via the shared discovery file.
  const conn = await readLocalApiConnection();
  if (conn === null) {
    console.error(SERVER_NOT_RUNNING);
    return 2;
  }

  // Build the typed client over the HTTP transport (reuses the SDK facade so the
  // CLI consumes the SAME contract as the renderer, via the `cli` origin).
  const httpApi = createHttpLocalApi(conn);
  const client = createLvisClient(httpApi, "cli");

  try {
    const result = await runCommand(argv, client);
    if (!result.ok) {
      // Unknown command → usage to stderr so stdout stays clean for pipes.
      console.error(usageText());
      return 2;
    }
    console.log(JSON.stringify(result.data, null, 2));
    return 0;
  } catch (err) {
    if (err instanceof LvisClientError) {
      // Dispatch rejection (fail-closed code, or server-unavailable mid-flight).
      console.error(`error: ${err.code} (channel: ${err.channel})`);
      return 1;
    }
    // Any other unexpected throw — surface the message, generic failure.
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
