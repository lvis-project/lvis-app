/**
 * Headless one-shot CLI modes for the Electron main process.
 *
 * The process boots the ordinary host service graph and performs one action
 * without a window. It quits by default; an explicitly retained turn waits
 * for its caller to release the session before the ordinary shutdown cleanup.
 *
 *   --exec=<prompt>          run one conversation turn and stream its events
 *   --set-secret=<key>       write one secret through the app's own store
 *
 * WHY ITS OWN FILE. `src/main.ts` registers Electron listeners and runs
 * `runEarlyBootEnv()` at module load, so nothing declared there can be imported
 * by a unit test. The parser, the exit-code mapping, and the headless approval
 * policy are exactly the parts that need direct tests, so they live here and
 * `main.ts` keeps only the branch that calls them.
 *
 * WHY THE HEAVY IMPORTS ARE DYNAMIC. `src/lib/logger.ts` imports
 * {@link execModeRequested} at module load — it is the only place that can
 * decide the console destination, because the logger is constructed from
 * `process.argv` when it is first imported. A static import of the turn
 * producer or the secret store here would therefore put the logger inside the
 * engine's own import graph, which is a cycle. The turn producer and the
 * secret-store error types are pulled in at the point of use instead, and this
 * module's static surface stays leaf-shaped.
 */
import { statSync } from "node:fs";
import type { EventEmitter } from "node:events";
import { basename, resolve } from "node:path";
import { errorMessage } from "../shared/error-message.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import type { PermissionManager } from "../permissions/permission-manager.js";
import type { SettingsService } from "../data/settings-store.js";
import type { ConversationLoop, TurnResult } from "../engine/conversation-loop.js";
import type { TurnStopReason } from "../engine/turn/types.js";
import type { PlatformConversationEvent } from "../engine/conversation-platform-protocol.js";
import type { ExecutionMode } from "../shared/permission-mode.js";

/** Exit code for a malformed command line, matching the `EX_USAGE` convention. */
export const EXEC_USAGE_EXIT_CODE = 64;

/**
 * Exit code when another LVIS process already holds the single-instance lock.
 * `EX_TEMPFAIL`: the request was well-formed and may succeed once that process
 * exits, so a runner must not read it as an empty successful turn.
 */
export const EXEC_LOCKED_EXIT_CODE = 75;

/** Exit code for a turn that ended asking the operator a question. */
const EXEC_INPUT_REQUIRED_EXIT_CODE = 2;

/** Exit code for a turn that failed, or a boot that never reached the turn. */
export const EXEC_FAILURE_EXIT_CODE = 1;

/**
 * Stop reasons that mean the turn did not deliver an answer. `round-cap`,
 * `max_tokens` and `interrupted` are deliberately absent: each returns the
 * partial work the run actually produced, which a benchmark reads as a result
 * rather than as a crash.
 */
const FAILED_TURN_STOP_REASONS: ReadonlySet<TurnStopReason> = new Set<TurnStopReason>([
  "context-error",
  "stream-error",
  "blocked",
]);

type ExecOutputFormat = "stream-json" | "json";

/** The `--exec` request: one conversation turn on a machine-readable stream. */
interface ExecTurnRequest {
  /** Inline prompt, or `null` when the prompt is the whole of stdin. */
  readonly prompt: string | null;
  readonly cwd: string;
  /**
   * The permission mode the run asked for. `"default"` leaves the host's own
   * configured policy alone; only `"allow"` is applied, and it still runs every
   * Layer 0 check (sensitive paths, allowed directories) that the interactive
   * app runs.
   */
  readonly approveMode: Extract<ExecutionMode, "default" | "allow">;
  readonly output: ExecOutputFormat;
  readonly maxRounds?: number;
  /** Retain this session after a successful turn until the caller releases it. */
  readonly keepAlive?: boolean;
}

/** The `--set-secret` request. The value never appears here — it is on stdin. */
interface ExecSecretRequest {
  readonly key: string;
}

export interface ExecRequest {
  readonly secret: ExecSecretRequest | null;
  readonly turn: ExecTurnRequest | null;
}

export interface ExecDeps {
  readonly conversationLoop: ConversationLoop;
  readonly permissionManager: PermissionManager | undefined;
  readonly approvalGate: ApprovalGate | undefined;
  readonly settingsService: SettingsService;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly readStdin: () => Promise<string>;
  /**
   * Whether a directory is an authorized workspace project (the default
   * workspace or one of `permissions.additionalDirectories`). The session
   * layer silently re-roots an unauthorized project at the default workspace,
   * which a headless run must refuse instead of quietly working elsewhere.
   */
  readonly isAuthorizedProjectRoot: (projectRoot: string) => boolean;
  /** Required for --exec-keep-alive; the caller owns the session's release. */
  readonly waitForRelease?: () => Promise<void>;
  /** Required before publishing completion for a retained session. */
  readonly flushTelemetry?: () => Promise<void>;
}

/**
 * Whether this launch is a headless one-shot run.
 *
 * Read from raw argv rather than from a parsed request because the logger asks
 * this question at import time, long before boot could hand anything a parsed
 * command line. A malformed headless command line still answers `true`: the
 * process is going to print a usage error and quit, and that diagnostic belongs
 * on stderr for the same reason the rest of the logs do.
 */
export function execModeRequested(argv: readonly string[]): boolean {
  return argv.some(
    (arg) =>
      arg === "--exec"
      || arg.startsWith("--exec=")
      || arg === "--set-secret"
      || arg.startsWith("--set-secret="),
  );
}

/**
 * The narrower question: whether this launch runs a TURN headlessly.
 *
 * `--set-secret` is headless too, which is what {@link execModeRequested}
 * answers and all a log destination needs to know. But it runs no model and
 * builds no prompt, so anything reasoning about what language a model should
 * answer in, or about a conversation existing at all, has to ask this instead —
 * otherwise the secret-writing CLI is treated as a conversation that has none.
 */
export function execTurnRequested(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "--exec" || arg.startsWith("--exec="));
}

function usageError(message: string): { error: string } {
  return { error: `exec: ${message}` };
}

function parseMaxRounds(raw: string): number | { error: string } {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    return usageError(`--exec-max-rounds must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * A relative `--exec-cwd` is the caller's, so it resolves against the launch
 * directory — never against wherever the process has been re-anchored to.
 */
function parseCwd(raw: string, launchCwd: string | null): string | { error: string } {
  if (raw.length === 0) return usageError("--exec-cwd must name a directory");
  if (launchCwd === null) return usageError("--exec-cwd needs --exec");
  const path = resolve(launchCwd, raw);
  try {
    if (!statSync(path).isDirectory()) {
      return usageError(`--exec-cwd is not a directory: ${path}`);
    }
  } catch {
    return usageError(`--exec-cwd does not exist: ${path}`);
  }
  return path;
}

/**
 * Parse the headless command line.
 *
 * Returns `null` when this is an ordinary interactive launch, a `{ error }`
 * for a command line the host will not run, and otherwise the request.
 *
 * `launchCwd` is the directory the process was started from, captured by the
 * caller BEFORE the workspace anchor moves the process to `~/.lvis/workspace`
 * (and only for a headless launch — see `execModeRequested`); it is the
 * session root when `--exec-cwd` is absent and the base of a relative one.
 */
export function parseExecFlags(
  argv: readonly string[],
  launchCwd: string | null,
): ExecRequest | { error: string } | null {
  let execRequested = false;
  let prompt: string | null = null;
  let cwd: string | null = null;
  let approveMode: Extract<ExecutionMode, "default" | "allow"> = "default";
  let output: ExecOutputFormat = "stream-json";
  let maxRounds: number | undefined;
  let keepAlive = false;
  let secretKey: string | null = null;

  for (const arg of argv) {
    if (arg === "--exec" || arg === "--exec=-") {
      execRequested = true;
      prompt = null;
      continue;
    }
    if (arg.startsWith("--exec=")) {
      const value = arg.slice("--exec=".length);
      if (value.length === 0) return usageError("--exec was given an empty prompt");
      execRequested = true;
      prompt = value;
      continue;
    }
    if (arg.startsWith("--exec-cwd=")) {
      const parsed = parseCwd(arg.slice("--exec-cwd=".length), launchCwd);
      if (typeof parsed !== "string") return parsed;
      cwd = parsed;
      continue;
    }
    if (arg.startsWith("--exec-approve=")) {
      const value = arg.slice("--exec-approve=".length);
      if (value !== "default" && value !== "allow") {
        return usageError(`--exec-approve must be "default" or "allow", got "${value}"`);
      }
      approveMode = value;
      continue;
    }
    if (arg.startsWith("--exec-output=")) {
      const value = arg.slice("--exec-output=".length);
      if (value !== "stream-json" && value !== "json") {
        return usageError(`--exec-output must be "stream-json" or "json", got "${value}"`);
      }
      output = value;
      continue;
    }
    if (arg.startsWith("--exec-max-rounds=")) {
      const parsed = parseMaxRounds(arg.slice("--exec-max-rounds=".length));
      if (typeof parsed !== "number") return parsed;
      maxRounds = parsed;
      continue;
    }
    if (arg === "--exec-keep-alive") {
      keepAlive = true;
      continue;
    }
    if (arg === "--set-secret") {
      return usageError("--set-secret needs a key, as --set-secret=<key>");
    }
    if (arg.startsWith("--set-secret=")) {
      const value = arg.slice("--set-secret=".length);
      if (value.length === 0) return usageError("--set-secret was given an empty key");
      secretKey = value;
      continue;
    }
    if (arg.startsWith("--exec-")) {
      return usageError(`unknown flag ${arg}`);
    }
  }

  if (keepAlive && (!execRequested || output !== "stream-json")) {
    return usageError("--exec-keep-alive requires --exec with --exec-output=stream-json");
  }
  if (!execRequested && secretKey === null) return null;
  // Both requests read the WHOLE of stdin, so a run that combines them has to
  // give the prompt inline. Refusing here beats consuming stdin for the secret
  // and then running a turn on an empty prompt.
  if (execRequested && prompt === null && secretKey !== null) {
    return usageError("--set-secret consumes stdin, so --exec needs an inline prompt");
  }

  const sessionRoot = cwd ?? launchCwd;
  if (execRequested && sessionRoot === null) {
    return usageError("the launch directory was not captured for this run");
  }

  return {
    secret: secretKey === null ? null : { key: secretKey },
    turn: execRequested && sessionRoot !== null
      ? {
        prompt,
        cwd: sessionRoot,
        approveMode,
        output,
        ...(maxRounds === undefined ? {} : { maxRounds }),
        ...(keepAlive ? { keepAlive: true } : {}),
      }
      : null,
  };
}

/** Read the whole of stdin as UTF-8. A terminal with no piped input reads empty. */
export async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  process.stdin.setEncoding("utf-8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** Drop the single trailing newline a shell heredoc or `echo` adds. */
function stripOneTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

function exitCodeForTurnResult(result: TurnResult): number {
  if (result.inputRequired !== undefined || result.stopReason === "input-required") {
    return EXEC_INPUT_REQUIRED_EXIT_CODE;
  }
  if (result.stopReason !== undefined && FAILED_TURN_STOP_REASONS.has(result.stopReason)) {
    return EXEC_FAILURE_EXIT_CODE;
  }
  return 0;
}

async function applySecret(deps: ExecDeps, request: ExecSecretRequest): Promise<number> {
  const value = stripOneTrailingNewline(await deps.readStdin());
  if (value.length === 0) {
    deps.stderr.write("exec: --set-secret read an empty value from stdin\n");
    return EXEC_USAGE_EXIT_CODE;
  }
  const { SecretDocumentValidationError, SecretEncryptionUnavailableError } =
    await import("../data/secret-document-store.js");
  try {
    await deps.settingsService.setSecret(request.key, value);
    return 0;
  } catch (err) {
    if (err instanceof SecretDocumentValidationError) {
      deps.stderr.write(`exec: --set-secret rejected the key: ${err.message}\n`);
      return EXEC_USAGE_EXIT_CODE;
    }
    if (err instanceof SecretEncryptionUnavailableError) {
      deps.stderr.write(
        "exec: this machine cannot encrypt stored secrets; an OS keyring the app can reach is required\n",
      );
      return EXEC_FAILURE_EXIT_CODE;
    }
    deps.stderr.write(`exec: --set-secret failed: ${errorMessage(err)}\n`);
    return EXEC_FAILURE_EXIT_CODE;
  }
}

async function runTurnRequest(deps: ExecDeps, request: ExecTurnRequest): Promise<number> {
  const { approvalGate, permissionManager } = deps;
  if (!approvalGate || !permissionManager) {
    deps.stderr.write(
      "exec: boot produced no approval gate or permission manager; refusing to run a turn without them\n",
    );
    return EXEC_FAILURE_EXIT_CODE;
  }
  if (!approvalGate.isHeadlessExec) {
    deps.stderr.write("exec: approval gate is not configured for headless execution; refusing to run\n");
    return EXEC_FAILURE_EXIT_CODE;
  }
  const prompt = request.prompt ?? stripOneTrailingNewline(await deps.readStdin());
  if (prompt.trim().length === 0) {
    deps.stderr.write("exec: --exec read an empty prompt\n");
    return EXEC_USAGE_EXIT_CODE;
  }
  if (!deps.isAuthorizedProjectRoot(request.cwd)) {
    deps.stderr.write(
      `exec: ${request.cwd} is not an authorized workspace project; add it to `
      + "permissions.additionalDirectories in ~/.lvis/settings.json or run from the default workspace\n",
    );
    return EXEC_USAGE_EXIT_CODE;
  }
  if (request.approveMode === "allow") permissionManager.setMode("allow");
  try {
    deps.conversationLoop.newConversation("main", {
      projectRoot: request.cwd,
      projectName: basename(request.cwd),
    });
    const { runStreamedTurn, STREAM_TURN_OPTIONS } =
      await import("../ipc/handlers/chat-stream.js");
    const sink = (event: PlatformConversationEvent) => {
      if (request.output === "stream-json") {
        deps.stdout.write(`${JSON.stringify(event)}\n`);
      }
    };
    const result = await runStreamedTurn(deps.conversationLoop, prompt, sink, {
      ...STREAM_TURN_OPTIONS,
      ...(request.maxRounds === undefined ? {} : { maxRounds: request.maxRounds }),
    });
    if (request.output === "json") {
      deps.stdout.write(`${JSON.stringify(result)}\n`);
    }
    return exitCodeForTurnResult(result);
  } catch (err) {
    deps.stderr.write(`exec: turn failed: ${errorMessage(err)}\n`);
    return EXEC_FAILURE_EXIT_CODE;
  }
}

/**
 * Perform the headless request and return the process exit code.
 *
 * A combined run applies the secret first: a container that starts the app once
 * needs the credential in place before the turn asks a provider for anything.
 */
export async function runExecTurn(deps: ExecDeps, request: ExecRequest): Promise<number> {
  if (request.turn?.keepAlive && !deps.waitForRelease) {
    throw new Error("exec: retained session has no release owner");
  }
  if (request.turn?.keepAlive && !deps.flushTelemetry) {
    throw new Error("exec: retained session has no telemetry flush owner");
  }
  if (request.secret) {
    const code = await applySecret(deps, request.secret);
    if (code !== 0) return code;
  }
  const turn = request.turn;
  if (!turn) return 0;
  const code = await runTurnRequest(deps, turn);
  if (code === 0 && turn.keepAlive) {
    try {
      await deps.flushTelemetry!();
    } catch (err) {
      deps.stderr.write(`exec: telemetry flush failed: ${errorMessage(err)}\n`);
      return EXEC_FAILURE_EXIT_CODE;
    }
    // Register release before publishing completion. This is a CLI lifecycle
    // record, not another conversation event or a process-exit notification.
    const released = deps.waitForRelease!();
    deps.stdout.write(`${JSON.stringify({ kind: "exec.completed", exitCode: code })}\n`);
    await released;
  }
  return code;
}

/** Release an explicitly retained session through the ordinary app quit path. */
export function waitForExecRelease(signals: EventEmitter = process): Promise<void> {
  return new Promise((resolveRelease) => {
    const keepAlive = setInterval(() => {}, 60_000);
    const release = () => {
      clearInterval(keepAlive);
      signals.removeListener("SIGTERM", release);
      signals.removeListener("SIGINT", release);
      resolveRelease();
    };
    signals.once("SIGTERM", release);
    signals.once("SIGINT", release);
  });
}
