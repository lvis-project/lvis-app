import { useEffect } from "react";
import { t } from "../../../../i18n/runtime.js";
import { STATUS_BAR_RUNTIME_EMOJIS } from "../../../../shared/status-bar-emojis.js";
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
      const upsertIfCurrent = (item: PersistentItem): boolean => {
        if (cancelled || my !== callToken) return false;
        upsertPersistent(item);
        return true;
      };
      try {
        const c = await api.getRuntimeCounts();
        if (!upsertIfCurrent({
          id: "runtime:tools",
          severity: "info",
          label: STATUS_BAR_RUNTIME_EMOJIS.tools,
          value: String(c.tools),
          a11yLabel: t("useStatusBarRuntime.toolsA11y"),
        })) return;
        if (!upsertIfCurrent({
          id: "runtime:plugins",
          severity: "info",
          label: STATUS_BAR_RUNTIME_EMOJIS.plugins,
          value: String(c.plugins),
          a11yLabel: t("useStatusBarRuntime.pluginsA11y"),
        })) return;
        if (!upsertIfCurrent({
          id: "runtime:mcps",
          severity: "info",
          label: STATUS_BAR_RUNTIME_EMOJIS.mcps,
          value: String(c.mcps),
          a11yLabel: t("useStatusBarRuntime.mcpsA11y"),
        })) return;
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
