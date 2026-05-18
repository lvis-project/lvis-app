export const DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS = 15_000;

export type ShutdownCleanupResult =
  | { status: "completed" }
  | { status: "failed"; error: unknown }
  | { status: "timed-out" };

export function resolveShutdownCleanupTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS ?? env.LVIS_SHUTDOWN_TIMEOUT_MS;
  if (!raw) return DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS;
  return Math.floor(parsed);
}

export async function runCleanupWithHardTimeout(
  cleanup: () => Promise<void> | void,
  timeoutMs: number,
): Promise<ShutdownCleanupResult> {
  const normalizedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  let timeout: NodeJS.Timeout | undefined;

  const cleanupPromise: Promise<ShutdownCleanupResult> = Promise.resolve()
    .then(() => cleanup())
    .then(() => ({ status: "completed" as const }))
    .catch((error: unknown) => ({ status: "failed" as const, error }));

  const timeoutPromise = new Promise<ShutdownCleanupResult>((resolve) => {
    timeout = setTimeout(() => resolve({ status: "timed-out" }), normalizedTimeoutMs);
    timeout.unref?.();
  });

  const result = await Promise.race([cleanupPromise, timeoutPromise]);
  if (timeout) clearTimeout(timeout);
  return result;
}
