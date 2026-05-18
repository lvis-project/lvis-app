import { useEffect } from "react";
import type { LvisApi } from "../../types.js";
import type { PersistentItem } from "./types.js";

interface Options {
  api: LvisApi;
  upsertPersistent: (item: PersistentItem) => void;
}

export function useStatusBarRuntime({ api, upsertPersistent }: Options): void {
  useEffect(() => {
    if (typeof api.getRuntimeCounts !== "function") return;
    let cancelled = false;
    let callToken = 0;
    const refreshCounts = async () => {
      const my = ++callToken;
      try {
        const c = await api.getRuntimeCounts();
        if (cancelled || my !== callToken) return;
        upsertPersistent({
          id: "runtime:tools",
          severity: "info",
          label: "🔧",
          value: String(c.tools),
        });
        upsertPersistent({
          id: "runtime:plugins",
          severity: "info",
          label: "🧩",
          value: String(c.plugins),
        });
        upsertPersistent({
          id: "runtime:mcps",
          severity: "info",
          label: "🔌",
          value: String(c.mcps),
        });
      } catch {
        // Non-fatal — counts are an awareness signal, not load-bearing.
      }
    };
    void refreshCounts();
    const unsubs: Array<() => void> = [];
    if (typeof api.onPluginInstallResult === "function") {
      unsubs.push(api.onPluginInstallResult(() => void refreshCounts()));
    }
    if (typeof api.onPluginUninstallResult === "function") {
      unsubs.push(api.onPluginUninstallResult(() => void refreshCounts()));
    }
    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [api, upsertPersistent]);
}
