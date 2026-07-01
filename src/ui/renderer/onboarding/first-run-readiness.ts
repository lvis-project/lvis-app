import type { BootstrapStatusEvent } from "../hooks/use-bootstrap-status.js";
import type { PluginCardSummary } from "../types.js";

export type FirstRunReadinessLevel = "ready" | "checking" | "attention" | "repair";

export interface RuntimeCounts {
  tools: number;
  plugins: number;
  mcps: number;
}

export interface RuntimeEnv {
  platform: string;
  hostname: string;
  user: string;
}

export interface PluginReadinessSummary {
  installed: number;
  loaded: number;
  preparing: number;
  failed: number;
  disabled: number;
  activeTools: number;
}

export interface BootstrapReadinessSummary {
  level: FirstRunReadinessLevel;
  retryable: boolean;
  failedCount: number;
  skippedReason?: string;
  message?: string;
}

export function summarizePluginReadiness(
  cards: PluginCardSummary[],
  fallbackActiveTools = 0,
): PluginReadinessSummary {
  return cards.reduce<PluginReadinessSummary>(
    (summary, card) => {
      summary.installed += 1;
      if (card.loadStatus === "preparing") summary.preparing += 1;
      else if (card.loadStatus === "failed") summary.failed += 1;
      else if (card.loadStatus === "disabled") summary.disabled += 1;
      else summary.loaded += 1;

      if (card.active !== false && card.loadStatus !== "disabled" && card.loadStatus !== "failed") {
        summary.activeTools += Array.isArray(card.tools) ? card.tools.length : 0;
      }
      return summary;
    },
    {
      installed: 0,
      loaded: 0,
      preparing: 0,
      failed: 0,
      disabled: 0,
      activeTools: fallbackActiveTools,
    },
  );
}

export function summarizeBootstrapReadiness(
  status: BootstrapStatusEvent | null,
): BootstrapReadinessSummary {
  if (status === null) {
    return { level: "ready", retryable: false, failedCount: 0 };
  }
  if (status.phase === "start") {
    return { level: "checking", retryable: false, failedCount: 0 };
  }
  if (status.phase === "error") {
    return {
      level: "repair",
      retryable: true,
      failedCount: 1,
      message: status.message,
    };
  }
  if (status.failed.length > 0) {
    return {
      level: "repair",
      retryable: true,
      failedCount: status.failed.length,
      message: status.failed.map((item) => item.error).join("\n"),
    };
  }
  if (status.skippedReason) {
    return {
      level: "attention",
      retryable: false,
      failedCount: 0,
      skippedReason: status.skippedReason,
    };
  }
  return { level: "ready", retryable: false, failedCount: 0 };
}

export function isWindowsRuntime(env: RuntimeEnv | null): boolean {
  return env?.platform === "win32";
}

export function hasWindowsFileLockSignal(input: string | undefined): boolean {
  if (!input) return false;
  return /eperm|ebusy|enotempty|access is denied|permission denied|file lock|locked|antivirus|virus/i.test(input);
}
