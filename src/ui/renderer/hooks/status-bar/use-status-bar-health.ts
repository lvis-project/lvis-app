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

/**
 * Consecutive LLM ping failures required before flipping a previously-online
 * dot to offline. A single transient failure (network blip, momentary endpoint
 * hiccup) holds the last-known-good state so the status dot stops oscillating
 * online↔offline on every flaky probe. Any non-offline result resets the
 * streak: a successful ping restores online immediately, and a transition to
 * not-configured/unauthorized clears it too — the streak counts *consecutive
 * offline probes* only, and a context switch (e.g. logout) makes a stale
 * failure count meaningless.
 */
const LLM_OFFLINE_HYSTERESIS = 2;

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
    // Consecutive LLM probe failures since the last online result. A single
    // failure does not flip a previously-online dot offline (hysteresis).
    let llmConsecutiveFailures = 0;

    const emit = () => {
      if (cancelled) return;
      upsertPersistent(itemFromHealth(llm, market));
    };

    const refreshLlm = async () => {
      if (!canPingLlm) return;
      const my = ++llmToken;
      if (llm.status === "checking") emit();
      let next: ServiceHealth;
      try {
        const result = await api.pingAiProvider();
        if (cancelled || my !== llmToken) return;
        next = llmHealthFromPing(result);
      } catch {
        if (cancelled || my !== llmToken) return;
        next = { status: "offline", detail: "ping failed" };
      }
      if (next.status === "offline") {
        llmConsecutiveFailures += 1;
        // Hold the last-known-good state until the failure streak crosses the
        // hysteresis threshold. Only a previously *online* dot is held; states
        // like not-configured/unauthorized are deterministic, not transient,
        // so they flip through immediately.
        if (llm.status === "online" && llmConsecutiveFailures < LLM_OFFLINE_HYSTERESIS) {
          return;
        }
        llm = next;
      } else {
        // Any non-offline result (online / not-configured / unauthorized)
        // clears the streak so recovery is immediate.
        llmConsecutiveFailures = 0;
        llm = next;
      }
      emit();
    };

    const refreshMarket = async () => {
      if (!canPingMarket) return;
      const my = ++marketToken;
      if (market.status === "checking") emit();
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
      unsubs.push(api.onSettingsUpdated(() => void refreshAll()));
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
