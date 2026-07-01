import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import type { ReactNode } from "react";
import type { AiProviderPingIpcResult } from "../../../shared/ai-provider-ping.js";
import type { BootstrapStatusEvent } from "../hooks/use-bootstrap-status.js";
import {
  hasWindowsFileLockSignal,
  isWindowsRuntime,
  summarizeBootstrapReadiness,
  type FirstRunReadinessLevel,
  type PluginReadinessSummary,
  type RuntimeCounts,
  type RuntimeEnv,
} from "./first-run-readiness.js";

export type FirstRunProviderProbe =
  | { status: "loading" }
  | { status: "success"; vendor: string; model: string; latencyMs: number }
  | { status: "failure"; reason: string };

interface Props {
  providerProbe: FirstRunProviderProbe;
  runtimeCounts: RuntimeCounts | null;
  runtimeCountsError: string | null;
  runtimeEnv: RuntimeEnv | null;
  pluginSummary: PluginReadinessSummary;
  marketplaceUrlReady: boolean;
  bootstrapStatus: BootstrapStatusEvent | null;
  onRetryBootstrap?: () => Promise<void> | void;
}

function levelClass(level: FirstRunReadinessLevel): string {
  if (level === "ready") return "bg-success";
  if (level === "checking") return "bg-primary animate-pulse";
  if (level === "repair") return "bg-destructive";
  return "bg-warning";
}

function providerLevel(providerProbe: FirstRunProviderProbe): FirstRunReadinessLevel {
  if (providerProbe.status === "loading") return "checking";
  if (providerProbe.status === "success") return "ready";
  return "attention";
}

function providerDetail(providerProbe: FirstRunProviderProbe, t: ReturnType<typeof useTranslation>["t"]): string {
  if (providerProbe.status === "loading") return t("personalizedWelcome.readinessProviderChecking");
  if (providerProbe.status === "success") {
    return t("personalizedWelcome.readinessProviderReady", {
      vendor: providerProbe.vendor,
      model: providerProbe.model,
      latencyMs: providerProbe.latencyMs,
    });
  }
  if (providerProbe.reason === "not-configured") {
    return t("personalizedWelcome.readinessProviderMissingKey");
  }
  return t("personalizedWelcome.readinessProviderNeedsReview");
}

function runtimeLevel(runtimeCounts: RuntimeCounts | null, runtimeCountsError: string | null): FirstRunReadinessLevel {
  if (runtimeCountsError) return "attention";
  if (runtimeCounts === null) return "checking";
  return runtimeCounts.tools > 0 || runtimeCounts.plugins > 0 || runtimeCounts.mcps > 0 ? "ready" : "attention";
}

function runtimeDetail(
  runtimeCounts: RuntimeCounts | null,
  runtimeCountsError: string | null,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (runtimeCountsError) return t("personalizedWelcome.readinessRuntimeFailed", { error: runtimeCountsError });
  if (runtimeCounts === null) return t("personalizedWelcome.readinessRuntimeChecking");
  return t("personalizedWelcome.readinessRuntimeReady", {
    tools: runtimeCounts.tools,
    plugins: runtimeCounts.plugins,
    mcps: runtimeCounts.mcps,
  });
}

function pluginLevel(summary: PluginReadinessSummary): FirstRunReadinessLevel {
  if (summary.failed > 0) return "repair";
  if (summary.preparing > 0) return "checking";
  if (summary.installed === 0 || summary.activeTools === 0) return "attention";
  return "ready";
}

function pluginDetail(summary: PluginReadinessSummary, t: ReturnType<typeof useTranslation>["t"]): string {
  if (summary.failed > 0) {
    return t("personalizedWelcome.readinessPluginsFailed", { count: summary.failed });
  }
  if (summary.preparing > 0) {
    return t("personalizedWelcome.readinessPluginsPreparing", { count: summary.preparing });
  }
  if (summary.installed === 0) return t("personalizedWelcome.readinessPluginsEmpty");
  if (summary.activeTools === 0) {
    return t("personalizedWelcome.readinessPluginsNoTools", {
      installed: summary.installed,
      disabled: summary.disabled,
    });
  }
  return t("personalizedWelcome.readinessPluginsReady", {
    installed: summary.installed,
    tools: summary.activeTools,
  });
}

function marketplaceLevel(marketplaceUrlReady: boolean): FirstRunReadinessLevel {
  return marketplaceUrlReady ? "ready" : "attention";
}

function bootstrapDetail(
  status: BootstrapStatusEvent | null,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const summary = summarizeBootstrapReadiness(status);
  if (summary.level === "checking") return t("personalizedWelcome.readinessBootstrapChecking");
  if (summary.level === "repair") {
    return summary.failedCount > 1
      ? t("personalizedWelcome.readinessBootstrapMultipleFailed", { count: summary.failedCount })
      : t("personalizedWelcome.readinessBootstrapFailed");
  }
  if (summary.skippedReason) {
    return t("personalizedWelcome.readinessBootstrapSkipped", { reason: summary.skippedReason });
  }
  return t("personalizedWelcome.readinessBootstrapReady");
}

function ReadinessRow({
  level,
  title,
  detail,
  children,
}: {
  level: FirstRunReadinessLevel;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[0.65rem_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2">
      <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${levelClass(level)}`} />
      <div className="min-w-0">
        <div className="text-[11px] font-medium text-foreground">{title}</div>
        <div className="text-[10.5px] leading-snug text-muted-foreground">{detail}</div>
      </div>
      {children}
    </div>
  );
}

export function normalizeProviderProbe(result: AiProviderPingIpcResult): FirstRunProviderProbe {
  if ("ok" in result) return { status: "failure", reason: result.error };
  if (result.configured && result.online) {
    return {
      status: "success",
      vendor: result.vendor,
      model: result.model,
      latencyMs: result.latencyMs,
    };
  }
  return { status: "failure", reason: result.error };
}

export function FirstRunReadinessPanel({
  providerProbe,
  runtimeCounts,
  runtimeCountsError,
  runtimeEnv,
  pluginSummary,
  marketplaceUrlReady,
  bootstrapStatus,
  onRetryBootstrap,
}: Props) {
  const { t } = useTranslation();
  const bootstrapSummary = summarizeBootstrapReadiness(bootstrapStatus);
  const windowsFileLock = isWindowsRuntime(runtimeEnv) && hasWindowsFileLockSignal(bootstrapSummary.message);

  return (
    <div
      data-testid="first-run-readiness"
      className="overflow-hidden rounded-md border border-border bg-muted/(--opacity-subtle) divide-y divide-border"
    >
      <ReadinessRow
        level={providerLevel(providerProbe)}
        title={t("personalizedWelcome.readinessProviderTitle")}
        detail={providerDetail(providerProbe, t)}
      />
      <ReadinessRow
        level={runtimeLevel(runtimeCounts, runtimeCountsError)}
        title={t("personalizedWelcome.readinessRuntimeTitle")}
        detail={runtimeDetail(runtimeCounts, runtimeCountsError, t)}
      />
      <ReadinessRow
        level={pluginLevel(pluginSummary)}
        title={t("personalizedWelcome.readinessPluginsTitle")}
        detail={pluginDetail(pluginSummary, t)}
      />
      <ReadinessRow
        level={marketplaceLevel(marketplaceUrlReady)}
        title={t("personalizedWelcome.readinessMarketplaceTitle")}
        detail={marketplaceUrlReady
          ? t("personalizedWelcome.readinessMarketplaceReady")
          : t("personalizedWelcome.readinessMarketplaceMissing")}
      />
      <ReadinessRow
        level={windowsFileLock ? "repair" : bootstrapSummary.level}
        title={t("personalizedWelcome.readinessBootstrapTitle")}
        detail={windowsFileLock ? t("personalizedWelcome.readinessWindowsFileLock") : bootstrapDetail(bootstrapStatus, t)}
      >
        {bootstrapSummary.retryable && onRetryBootstrap ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[10.5px]"
            data-testid="first-run-readiness:retry-bootstrap"
            onClick={() => void onRetryBootstrap()}
          >
            {t("personalizedWelcome.readinessRetry")}
          </Button>
        ) : null}
      </ReadinessRow>
      {isWindowsRuntime(runtimeEnv) && (
        <ReadinessRow
          level="attention"
          title={t("personalizedWelcome.readinessWindowsTitle")}
          detail={t("personalizedWelcome.readinessWindowsHint")}
        />
      )}
    </div>
  );
}
