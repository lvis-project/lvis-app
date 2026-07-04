



import { useEffect, useState } from "react";
import type { LvisApi } from "../types.js";
import type { InstallPhase } from "./use-plugin-marketplace.js";

export function useInstallingPlugins(api: LvisApi): ReadonlyMap<string, InstallPhase> {
  const [phases, setPhases] = useState<Map<string, InstallPhase>>(() => new Map());

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    if (typeof api.onPluginInstallProgress === "function") {
      unsubs.push(
        api.onPluginInstallProgress((payload) => {
          setPhases((prev) => {
            if (prev.get(payload.slug) === payload.phase) return prev;
            const next = new Map(prev);
            next.set(payload.slug, payload.phase);
            return next;
          });
        }),
      );
    }

    if (typeof api.onPluginInstallResult === "function") {
      unsubs.push(
        api.onPluginInstallResult((payload) => {
          setPhases((prev) => {
            if (!prev.has(payload.slug)) return prev;
            const next = new Map(prev);
            next.delete(payload.slug);
            return next;
          });
        }),
      );
    }

    return () => {
      for (const u of unsubs) u();
    };
  }, [api]);

  return phases;
}
