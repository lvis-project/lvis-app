import { useEffect } from "react";
import type { AiProviderPingResult } from "../../../../shared/ai-provider-ping.js";
import type { LvisApi } from "../../types.js";
import type { PersistentItem } from "./types.js";

interface Options {
  api: LvisApi;
  upsertPersistent: (item: PersistentItem) => void;
}

const ITEM_ID = "provider:llm-ping";

export function useStatusBarProviderPing({ api, upsertPersistent }: Options): void {
  useEffect(() => {
    if (typeof api.pingAiProvider !== "function") return;
    let cancelled = false;
    let pingToken = 0;

    const setChecking = () => {
      upsertPersistent({
        id: ITEM_ID,
        severity: "info",
        dot: true,
        a11yLabel: "AI provider: Checking",
        tooltip: "AI provider: Checking",
      });
    };

    const refreshProviderPing = async () => {
      const my = ++pingToken;
      setChecking();
      try {
        const result = await api.pingAiProvider();
        if (cancelled || my !== pingToken) return;
        upsertPersistent(itemFromPingResult(result));
      } catch {
        if (cancelled || my !== pingToken) return;
        upsertPersistent({
          id: ITEM_ID,
          severity: "error",
          dot: true,
          a11yLabel: "AI provider: Ping failed",
          tooltip: "AI provider: Ping failed",
        });
      }
    };

    void refreshProviderPing();
    const unsubs: Array<() => void> = [];
    if (typeof api.onSettingsUpdated === "function") {
      unsubs.push(api.onSettingsUpdated(() => void refreshProviderPing()));
    }
    const onFocus = () => {
      void refreshProviderPing();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      for (const u of unsubs) u();
    };
  }, [api, upsertPersistent]);
}

function itemFromPingResult(result: AiProviderPingResult): PersistentItem {
  if (!result.configured) {
    return {
      id: ITEM_ID,
      severity: "warning",
      dot: true,
      a11yLabel: "AI provider: Not configured",
      tooltip: "AI provider: Not configured",
    };
  }
  const label = formatProviderLabel(result.vendor, result.model);
  if (result.online) {
    return {
      id: ITEM_ID,
      severity: "success",
      dot: true,
      a11yLabel: `AI provider: Connected (${label})`,
      tooltip: `AI provider: Connected (${label}, ${result.latencyMs} ms)`,
    };
  }
  return {
    id: ITEM_ID,
    severity: "error",
    dot: true,
    a11yLabel: `AI provider: Offline (${label})`,
    tooltip: `AI provider: Offline (${label})`,
  };
}

function formatProviderLabel(vendor: string, model: string): string {
  return model ? `${vendor} · ${model}` : vendor;
}
