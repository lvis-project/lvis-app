import type {
  PluginUpdateCheckResult,
  UpdateInfo,
} from "../../plugins/update-detector.js";

export interface UpdateCheckRunnerInput {
  check: () => Promise<PluginUpdateCheckResult>;
  filter: (updates: UpdateInfo[]) => UpdateInfo[];
  broadcast: (updates: UpdateInfo[]) => void;
  onNoChange?: (count: number) => void;
  onCatalogUnavailable?: () => void;
  onError?: (error: unknown) => void;
}

/** One catalog request at a time, with state advanced only by successful snapshots. */
export function createUpdateCheckRunner(input: UpdateCheckRunnerInput): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let lastBroadcastKey = "";

  return (): Promise<void> => {
    if (inFlight) return inFlight;
    const run = (async () => {
      try {
        const result = await input.check();
        if (result.status === "catalog-unavailable") {
          input.onCatalogUnavailable?.();
          return;
        }
        const updates = input.filter(result.updates);
        const key = updates
          .map((update) =>
            `${update.pluginId}@${update.installedVersion}->${update.latestVersion}`,
          )
          .sort()
          .join("|");
        if (key === lastBroadcastKey) {
          input.onNoChange?.(updates.length);
          return;
        }
        lastBroadcastKey = key;
        input.broadcast(updates);
      } catch (error) {
        input.onError?.(error);
      }
    })();
    const settled = run.finally(() => {
      if (inFlight === settled) inFlight = null;
    });
    inFlight = settled;
    return settled;
  };
}
