let workspaceLifecycleTail: Promise<void> | null = null;

/**
 * Serialize the persisted root mutation and every live/persistent side effect
 * for the workspace registry. Settings file locking alone is not enough: a
 * slow detach could otherwise overtake a later re-add and leave the registry
 * and the live tombstones in opposite states.
 *
 * This queue is intentionally global instead of keyed by an exact root. Parent
 * removal and independently registered child addition overlap semantically even
 * though their canonical strings differ; serializing all rare registry edits
 * closes that snapshot race without affecting normal conversation/tool turns.
 */
export async function withWorkspaceRootLifecycleLock<T>(
  _root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = workspaceLifecycleTail ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  workspaceLifecycleTail = tail;

  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (workspaceLifecycleTail === tail) workspaceLifecycleTail = null;
  }
}
