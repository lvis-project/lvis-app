export interface WorkspaceSessionMetadataStore {
  allowProjectRoot?: (root: string) => unknown;
  detachSessionsFromProject?: (root: string) => unknown;
}

function lifecycleError(code: string): Error & { code: string } {
  return Object.assign(new Error("workspace session metadata lifecycle failed"), { code });
}

/**
 * Detach a removed root from every durable conversation namespace before the
 * permission registry shrinks. The durable removal intent is already committed
 * before this runs, so failure must never call `allowProjectRoot`: keeping every
 * installed root guard is what prevents late metadata writers from reviving the
 * removed binding while a later retry finishes the remaining namespaces.
 */
export async function detachWorkspaceRootSessions(
  root: string,
  candidates: readonly WorkspaceSessionMetadataStore[],
): Promise<number> {
  const managers = [...new Set(candidates)];
  if (managers.length === 0) throw lifecycleError("MEMORY_MANAGER_UNAVAILABLE");

  // Start every namespace before awaiting any one result. Each MemoryManager
  // installs its root tombstone synchronously before its first await, so a
  // failure in one store must not prevent the others from becoming guarded.
  const settled = await Promise.allSettled(managers.map(async (manager) => {
    if (typeof manager.detachSessionsFromProject !== "function") {
      throw lifecycleError("MEMORY_DETACH_UNAVAILABLE");
    }
    const detached = await manager.detachSessionsFromProject(root);
    if (typeof detached !== "number" || !Number.isSafeInteger(detached) || detached < 0) {
      throw lifecycleError("MEMORY_DETACH_INVALID_RESULT");
    }
    return detached;
  }));
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) throw rejected.reason;

  let detachedTotal = 0;
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    detachedTotal += result.value;
    if (!Number.isSafeInteger(detachedTotal)) {
      throw lifecycleError("MEMORY_DETACH_INVALID_RESULT");
    }
  }
  return detachedTotal;
}
