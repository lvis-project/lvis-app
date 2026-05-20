import { useEffect } from "react";
import type {
  AiProviderPingIpcResult,
  AiProviderPingResult,
} from "../../../../shared/ai-provider-ping.js";
import type { LvisApi } from "../../types.js";
import type { PersistentItem, StatusBarSeverity } from "./types.js";

interface Options {
  api: LvisApi;
  upsertPersistent: (item: PersistentItem) => void;
  removePersistent: (id: string) => void;
}

const ITEM_ID = "health:services";

type ServiceHealth =
  | { status: "checking" }
  | { status: "online"; detail?: string; latencyMs?: number }
  | { status: "offline"; detail?: string }
  | { status: "not-configured" }
  | { status: "unavailable" }
  | { status: "unauthorized" };

export function useStatusBarHealth({ api, upsertPersistent, removePersistent }: Options): void {
  useEffect(() => {
    const canPingLlm = typeof api.pingAiProvider === "function";
    const canPingMarket = typeof api.pingMarketplace === "function";
    if (!canPingLlm && !canPingMarket) return;

    let cancelled = false;
    let llmToken = 0;
    let marketToken = 0;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let llm: ServiceHealth = canPingLlm ? { status: "checking" } : { status: "unavailable" };
    let market: ServiceHealth = canPingMarket ? { status: "checking" } : { status: "unavailable" };

    const emit = () => {
      if (cancelled) return;
      upsertPersistent(itemFromHealth(llm, market));
    };

    const refreshLlm = async () => {
      if (!canPingLlm) return;
      const my = ++llmToken;
      llm = { status: "checking" };
      emit();
      try {
        const result = await api.pingAiProvider();
        if (cancelled || my !== llmToken) return;
        llm = llmHealthFromPing(result);
      } catch {
        if (cancelled || my !== llmToken) return;
        llm = { status: "offline", detail: "ping failed" };
      }
      emit();
    };

    const refreshMarket = async () => {
      if (!canPingMarket) return;
      const my = ++marketToken;
      market = { status: "checking" };
      emit();
      try {
        const result = await api.pingMarketplace();
        if (cancelled || my !== marketToken) return;
        if (!result.configured) market = { status: "not-configured" };
        else market = result.online ? { status: "online" } : { status: "offline" };
      } catch {
        if (cancelled || my !== marketToken) return;
        market = { status: "offline" };
      }
      emit();
    };

    const refreshAll = () => {
      void refreshLlm();
      void refreshMarket();
    };

    const start = () => {
      if (intervalId !== null) return;
      refreshAll();
      intervalId = setInterval(refreshAll, 30_000);
    };
    const stop = () => {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    };

    start();
    const onFocus = () => start();
    const onBlur = () => stop();
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);

    const unsubs: Array<() => void> = [];
    if (typeof api.onSettingsUpdated === "function") {
      unsubs.push(api.onSettingsUpdated(() => void refreshLlm()));
    }

    return () => {
      cancelled = true;
      stop();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      for (const u of unsubs) u();
      removePersistent(ITEM_ID);
    };
  }, [api, upsertPersistent, removePersistent]);
}

function itemFromHealth(llm: ServiceHealth, market: ServiceHealth): PersistentItem {
  const tooltip = `LLM: ${formatHealth(llm)}\nMarket: ${formatHealth(market)}`;
  return {
    id: ITEM_ID,
    severity: combinedSeverity(llm, market),
    dot: true,
    a11yLabel: tooltip.replace(/\n/g, ", "),
    tooltip,
  };
}

function combinedSeverity(...services: ServiceHealth[]): StatusBarSeverity {
  if (services.some((s) => s.status === "offline" || s.status === "unauthorized")) return "error";
  if (services.some((s) => s.status === "not-configured" || s.status === "unavailable")) return "warning";
  if (services.some((s) => s.status === "checking")) return "info";
  return "success";
}

function llmHealthFromPing(result: AiProviderPingIpcResult): ServiceHealth {
  if (isUnauthorizedPingResult(result)) return { status: "unauthorized" };
  const ping = result as AiProviderPingResult;
  if (!ping.configured) return { status: "not-configured" };
  const detail = formatProviderLabel(ping.vendor, ping.model);
  if (ping.online) {
    return { status: "online", detail, latencyMs: ping.latencyMs };
  }
  return { status: "offline", detail: ping.error ? `${detail}; ${ping.error}` : detail };
}

function formatHealth(health: ServiceHealth): string {
  switch (health.status) {
    case "checking":
      return "checking";
    case "online": {
      const latency = health.latencyMs !== undefined ? `, ${health.latencyMs} ms` : "";
      return health.detail ? `online (${health.detail}${latency})` : "online";
    }
    case "offline":
      return health.detail ? `offline (${health.detail})` : "offline";
    case "not-configured":
      return "not configured";
    case "unavailable":
      return "unavailable";
    case "unauthorized":
      return "unauthorized";
  }
}

function formatProviderLabel(vendor: string, model: string): string {
  return model ? `${vendor} · ${model}` : vendor;
}

function isUnauthorizedPingResult(
  result: AiProviderPingIpcResult,
): result is { ok: false; error: "unauthorized-frame" } {
  return "ok" in result && result.ok === false;
}
