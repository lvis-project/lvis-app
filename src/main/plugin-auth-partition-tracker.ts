const PLUGIN_AUTH_PERSIST_PREFIX = "persist:plugin-auth:";
const trackedPluginAuthPartitions = new Map<string, Set<string>>();

/**
 * Injected persistence callbacks — set once at boot by
 * `wirePluginAuthPartitionPersistence()`. Tests can inject their own stubs.
 * Keeping them module-level (rather than a class) preserves the existing
 * function-export API that boot.ts and uninstall-lifecycle depend on.
 */
let _persistWrite: ((map: ReadonlyMap<string, ReadonlySet<string>>) => Promise<void>) | null =
  null;
let _persistDelete: ((pluginId: string) => Promise<void>) | null = null;
let _persistErrorLog: ((msg: string) => void) | null = null;

/**
 * Wire persistence callbacks at boot. Must be called once before the first
 * `openAuthWindow` invocation. Safe to call multiple times (e.g. in tests).
 */
export function wirePluginAuthPartitionPersistence(opts: {
  write: (map: ReadonlyMap<string, ReadonlySet<string>>) => Promise<void>;
  delete: (pluginId: string) => Promise<void>;
  onError: (msg: string) => void;
}): void {
  _persistWrite = opts.write;
  _persistDelete = opts.delete;
  _persistErrorLog = opts.onError;
}

function pluginIdFromPluginAuthPartition(partition: string): string | null {
  if (!partition.startsWith(PLUGIN_AUTH_PERSIST_PREFIX)) return null;
  const rest = partition.slice(PLUGIN_AUTH_PERSIST_PREFIX.length);
  const encodedPluginId = rest.split(":", 1)[0];
  if (!encodedPluginId) return null;
  try {
    return decodeURIComponent(encodedPluginId);
  } catch {
    return null;
  }
}

/**
 * Seed the in-memory tracker from a previously persisted map (at boot).
 * Existing in-memory entries are merged — this is intentionally additive
 * so that a concurrent early-boot `rememberPluginAuthPartition` call cannot
 * lose a just-observed partition.
 */
export function seedPluginAuthPartitions(persisted: Record<string, string[]>): void {
  for (const [pluginId, partitions] of Object.entries(persisted)) {
    const current = trackedPluginAuthPartitions.get(pluginId) ?? new Set<string>();
    for (const p of partitions) {
      current.add(p);
    }
    trackedPluginAuthPartitions.set(pluginId, current);
  }
}

export function rememberPluginAuthPartition(partition: string): void {
  const pluginId = pluginIdFromPluginAuthPartition(partition);
  if (!pluginId) return;
  const current = trackedPluginAuthPartitions.get(pluginId) ?? new Set<string>();
  current.add(partition);
  trackedPluginAuthPartitions.set(pluginId, current);
  // Fire-and-forget persistence — auth windows are interactive, we must not
  // delay them. Errors are routed to the injected error logger (audit log).
  if (_persistWrite) {
    _persistWrite(trackedPluginAuthPartitions).catch((err) => {
      _persistErrorLog?.(
        `plugin-auth-partition-store: write failed after observing ${partition}: ${(err as Error).message}`,
      );
    });
  }
}

export function getTrackedPluginAuthPartitions(pluginId: string): string[] {
  const base = `${PLUGIN_AUTH_PERSIST_PREFIX}${encodeURIComponent(pluginId)}`;
  return [...new Set([base, ...(trackedPluginAuthPartitions.get(pluginId) ?? [])])];
}

export async function forgetTrackedPluginAuthPartitions(
  pluginId: string,
): Promise<void> {
  const previous = trackedPluginAuthPartitions.get(pluginId);
  trackedPluginAuthPartitions.delete(pluginId);
  try {
    await _persistDelete?.(pluginId);
  } catch (error) {
    const concurrentlyObserved = trackedPluginAuthPartitions.get(pluginId);
    if (previous || concurrentlyObserved) {
      trackedPluginAuthPartitions.set(
        pluginId,
        new Set([...(previous ?? []), ...(concurrentlyObserved ?? [])]),
      );
    }
    throw error;
  }
}
