export interface WorkspaceSessionMetadataStore {
  allowProjectRoot?: (root: string) => unknown;
  detachSessionsFromProject?: (root: string) => unknown;
}

function lifecycleError(code: string): Error & { code: string } {
  return Object.assign(new Error("workspace session metadata lifecycle failed"), { code });
}

/**
 * Detach a removed root from every durable conversation namespace before the
 * permission registry shrinks. A failure rolls back the root-wide guards and
 * is rethrown so the caller retains the workspace setting for a safe retry.
 * Metadata writes are idempotent; a retry finishes any namespace that already
 * detached before another namespace failed.
 */
export async function detachWorkspaceRootSessions(
  root: string,
  candidates: readonly WorkspaceSessionMetadataStore[],
): Promise<number> {
  const managers = [...new Set(candidates)];
  if (managers.length === 0) throw lifecycleError("MEMORY_MANAGER_UNAVAILABLE");

  let detachedTotal = 0;
  try {
    for (const manager of managers) {
      if (typeof manager.detachSessionsFromProject !== "function") {
        throw lifecycleError("MEMORY_DETACH_UNAVAILABLE");
      }
      const detached = await manager.detachSessionsFromProject(root);
      if (!Number.isSafeInteger(detached) || (detached as number) < 0) {
        throw lifecycleError("MEMORY_DETACH_INVALID_RESULT");
      }
      detachedTotal += detached as number;
      if (!Number.isSafeInteger(detachedTotal)) {
        throw lifecycleError("MEMORY_DETACH_INVALID_RESULT");
      }
    }
    return detachedTotal;
  } catch (error: unknown) {
    for (const manager of managers) {
      try {
        manager.allowProjectRoot?.(root);
      } catch {
        // The original durable detach failure remains authoritative.
      }
    }
    throw error;
  }
}
