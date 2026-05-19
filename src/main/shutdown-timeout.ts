import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("lvis");
let invalidEnvWarnedOnce = false;
let deprecatedEnvWarnedOnce = false;

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
 * default. `LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS` is the canonical knob; the
 * legacy `LVIS_SHUTDOWN_TIMEOUT_MS` alias is retained for backwards
 * compatibility and scheduled for removal on 2026-08-01 (callers using
 * the legacy alias get a one-shot deprecation warn).
 *
 * Invalid env values (non-numeric, ≤ 0, NaN) emit a one-shot warn so
 * operator misconfiguration is visible in production logs rather than
 * being silently swallowed.
 */
export function resolveShutdownCleanupTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const canonical = env.LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS;
  const legacy = env.LVIS_SHUTDOWN_TIMEOUT_MS;
  const raw = canonical ?? legacy;
  if (!raw) return DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS;

  if (canonical === undefined && legacy !== undefined && !deprecatedEnvWarnedOnce) {
    deprecatedEnvWarnedOnce = true;
    log.warn(
      "shutdown-timeout: LVIS_SHUTDOWN_TIMEOUT_MS is deprecated (scheduled for removal 2026-08-01). " +
        "Use LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS instead.",
    );
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    if (!invalidEnvWarnedOnce) {
      invalidEnvWarnedOnce = true;
      log.warn(
        `shutdown-timeout: env value ${JSON.stringify(raw)} is not a positive number; ` +
          `falling back to default ${DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS}ms.`,
      );
    }
    return DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

/**
 * Test-only: reset the one-shot warn latches so each test gets a clean
 * surface for env-validation assertions. Not exported from the module
 * barrel — direct import only inside `__tests__`.
 */
export function __resetShutdownTimeoutWarnLatchesForTest(): void {
  invalidEnvWarnedOnce = false;
  deprecatedEnvWarnedOnce = false;
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
