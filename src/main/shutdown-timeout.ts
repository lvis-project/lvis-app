import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

/**
 * Default cleanup window for the Electron `before-quit` chain.
 *
 * The single source of truth lives in `tool-timeout-policy.ts` under
 * `shutdownCleanupMs`. We re-export the constant here so existing callers
 * keep working without dragging the policy import into every consumer.
 */
export const DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS =
  TOOL_TIMEOUT_POLICY.shutdownCleanupMs;

export type ShutdownCleanupResult =
  | { status: "completed" }
  | { status: "failed"; error: unknown }
  | { status: "timed-out" };

/**
 * Resolve the cleanup timeout from environment, falling back to the SOT
 * default. `LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS` is the canonical knob;
 * `LVIS_SHUTDOWN_TIMEOUT_MS` is retained as a deprecation alias that
 * callers may warn on.
 */
export function resolveShutdownCleanupTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS ?? env.LVIS_SHUTDOWN_TIMEOUT_MS;
  if (!raw) return DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS;
  return Math.floor(parsed);
}

/**
 * Race the cleanup chain against a hard deadline.
 *
 * The cleanup receives an `AbortSignal` that fires when the deadline
 * elapses (or when cleanup itself rejects). Callers SHOULD honor it so
 * their work actually stops — otherwise the inner promise keeps running
 * invisibly while the caller proceeds to `forceKillManagedChildProcesses`
 * + `app.exit(0)`, racing the kill with any persistAll / plugin-data
 * writes still in flight.
 *
 * This mirrors the `runWithCeiling` pattern from `tools/executor-ceiling`
 * documented in CLAUDE.md `Tool Execution Timeout Policy` ("Promise.race
 * with AbortController" — not Promise.race alone).
 */
export async function runCleanupWithHardTimeout(
  cleanup: (signal: AbortSignal) => Promise<void> | void,
  timeoutMs: number,
): Promise<ShutdownCleanupResult> {
  const normalizedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;

  const cleanupPromise: Promise<ShutdownCleanupResult> = Promise.resolve()
    .then(() => cleanup(controller.signal))
    .then(() => ({ status: "completed" as const }))
    .catch((error: unknown) => ({ status: "failed" as const, error }));

  const timeoutPromise = new Promise<ShutdownCleanupResult>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ status: "timed-out" });
    }, normalizedTimeoutMs);
    timeout.unref?.();
  });

  const result = await Promise.race([cleanupPromise, timeoutPromise]);
  if (timeout) clearTimeout(timeout);
  if (result.status !== "completed") {
    // Abort on failure too so any partially-running sub-tasks tear down
    // before the caller force-kills children.
    controller.abort();
  }
  return result;
}
