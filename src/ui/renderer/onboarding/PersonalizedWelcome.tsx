



import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Dialog, DialogContent } from "../../../components/ui/dialog.js";
import { OnboardingHeader } from "./OnboardingCard.js";
import type { AiProviderPingIpcResult } from "../../../shared/ai-provider-ping.js";
import { t } from "../../../i18n/runtime.js";
import { useTranslation } from "../../../i18n/react.js";
import type { BootstrapStatusEvent } from "../hooks/use-bootstrap-status.js";
import {
  FirstRunReadinessPanel,
  normalizeProviderProbe,
  type FirstRunProviderProbe,
} from "./FirstRunReadinessPanel.js";
import type {
  PluginReadinessSummary,
  RuntimeCounts,
  RuntimeEnv,
} from "./first-run-readiness.js";

export interface PersonalizedWelcomeProps {
  open: boolean;

  nickname?: string;

  introduction?: string;
  /**
   * Liveness probe for the configured LLM provider. Passed as a stable
   * function reference (not wrapped in a fresh object literal) so a parent
   * re-render does not re-fire the mount-time ping effect.
   */
  pingAiProvider: () => Promise<AiProviderPingIpcResult>;
  /** Lightweight runtime inventory for the first-run readiness checklist. */
  getRuntimeCounts?: () => Promise<RuntimeCounts>;
  /** Host/platform inventory for Windows-specific repair guidance. */
  getRuntimeEnv?: () => Promise<RuntimeEnv>;
  pluginSummary?: PluginReadinessSummary;
  marketplaceUrlReady?: boolean;
  bootstrapStatus?: BootstrapStatusEvent | null;
  onRetryBootstrap?: () => Promise<void> | void;

  onContinue: () => void;
}

const EMPTY_PLUGIN_SUMMARY: PluginReadinessSummary = {
  installed: 0,
  loaded: 0,
  preparing: 0,
  failed: 0,
  disabled: 0,
  activeTools: 0,
};

function pingFailureMessage(reason: string): string {
  if (reason === "not-configured") {
    return t("personalizedWelcome.pingFailureApiKey");
  }
  if (/public access is disabled|private endpoint|enotfound|fetch failed|eai_again|etimedout|^timeout$/i.test(reason)) {
    return t("personalizedWelcome.pingFailurePrivateEndpoint");
  }
  return t("personalizedWelcome.pingFailureApiKey");
}

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduce(mq.matches);
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);
  return reduce;
}

export function PersonalizedWelcome({
  open,
  nickname,
  introduction,
  pingAiProvider,
  getRuntimeCounts,
  getRuntimeEnv,
  pluginSummary = EMPTY_PLUGIN_SUMMARY,
  marketplaceUrlReady = false,
  bootstrapStatus = null,
  onRetryBootstrap,
  onContinue,
}: PersonalizedWelcomeProps) {
  const { t } = useTranslation();
  const reduceMotion = usePrefersReducedMotion();
  const greeting = useMemo(() => {
    const trimmed = (nickname ?? "").trim();
    if (trimmed.length === 0) return t("personalizedWelcome.greetingAnonymous");
    return t("personalizedWelcome.greetingNamed", { name: trimmed });
  }, [nickname, t]);

  const introLine = useMemo(() => {
    const trimmed = (introduction ?? "").trim();
    if (trimmed.length === 0) {
      return t("personalizedWelcome.introNoIntroduction");
    }
    return t("personalizedWelcome.introWithIntroduction", { introduction: trimmed });
  }, [introduction, t]);

  const [pingState, setPingState] = useState<FirstRunProviderProbe>({ status: "loading" });
  const [runtimeCounts, setRuntimeCounts] = useState<RuntimeCounts | null>(null);
  const [runtimeCountsError, setRuntimeCountsError] = useState<string | null>(null);
  const [runtimeEnv, setRuntimeEnv] = useState<RuntimeEnv | null>(null);

  // Ping is fire-and-forget but we cancel the state setter on unmount so
  // a slow IPC response doesn't update an unmounted component. We only
  // fire while `open` is true so re-open after an early dismiss runs a
  // fresh probe.
  const cancelledRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    cancelledRef.current = false;
    setPingState({ status: "loading" });
    (async () => {
      try {
        const result = await pingAiProvider();
        if (cancelledRef.current) return;
        // Discriminated union narrowing — IpcResult is either the
        // unauthorized-frame envelope `{ok: false, error}` or the
        // AiProviderPingResult union (configured + online | configured +
        // offline | not-configured).
        setPingState(normalizeProviderProbe(result));
      } catch (err) {
        if (cancelledRef.current) return;
        setPingState({ status: "failure", reason: "ipc-failed" });
        // eslint-disable-next-line no-console
        console.error("pingAiProvider IPC failed", err);
      }
    })();
    return () => {
      cancelledRef.current = true;
    };
  }, [open, pingAiProvider]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRuntimeCounts(null);
    setRuntimeCountsError(null);
    if (getRuntimeCounts) {
      void getRuntimeCounts()
        .then((counts) => {
          if (!cancelled) setRuntimeCounts(counts);
        })
        .catch((err) => {
          if (!cancelled) setRuntimeCountsError((err as Error).message || "runtime-counts-failed");
        });
    }
    if (getRuntimeEnv) {
      void getRuntimeEnv()
        .then((env) => {
          if (!cancelled) setRuntimeEnv(env);
        })
        .catch(() => {
          if (!cancelled) setRuntimeEnv(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [getRuntimeCounts, getRuntimeEnv, open]);

  const handleContinue = useCallback(() => {
    if (pingState.status === "loading") return;
    onContinue();
  }, [onContinue, pingState.status]);

  return (
    <Dialog open={open} onOpenChange={() => { /* no skip — forced choice */ }}>
      <DialogContent
        size="sm"
        data-testid="personalized-welcome"
        data-reduce-motion={reduceMotion ? "true" : "false"}
        data-ping-status={pingState.status}
        className="p-0 overflow-hidden"
      >
        <OnboardingHeader
          className="pb-2"
          title={greeting}
          titleTestId="personalized-welcome:greeting"
          description={t("personalizedWelcome.readySubtitle")}
        />

        <div className="px-6 pb-6 space-y-3">
          <p
            data-testid="personalized-welcome:intro"
            className="text-[12.5px] leading-relaxed text-muted-foreground"
          >
            {introLine}
          </p>

          {/* LLM ping status — surfaces connection state inline so the
              user sees a confirmation before reaching the chat surface. */}
          {pingState.status === "loading" && (
            <div
              data-testid="personalized-welcome:ping-loading"
              className="flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-[11px] text-muted-foreground"
              role="status"
            >
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary"
              />
              {t("personalizedWelcome.pingLoading")}
            </div>
          )}
          {pingState.status === "success" && (
            <div
              data-testid="personalized-welcome:ping-success"
              className="rounded-md bg-success/(--opacity-subtle) px-2.5 py-1.5 text-[11px] text-success"
              role="status"
            >
              {t("personalizedWelcome.pingSuccess", { vendor: pingState.vendor, model: pingState.model, latencyMs: pingState.latencyMs })}
            </div>
          )}
          {pingState.status === "failure" && (
            <div
              data-testid="personalized-welcome:ping-failure"
              className="rounded-md bg-destructive/(--opacity-subtle) px-2.5 py-1.5 text-[11px] text-destructive"
              role="alert"
            >
              {pingFailureMessage(pingState.reason)}
            </div>
          )}

          <FirstRunReadinessPanel
            providerProbe={pingState}
            runtimeCounts={runtimeCounts}
            runtimeCountsError={runtimeCountsError}
            runtimeEnv={runtimeEnv}
            pluginSummary={pluginSummary}
            marketplaceUrlReady={marketplaceUrlReady}
            bootstrapStatus={bootstrapStatus}
            onRetryBootstrap={onRetryBootstrap}
          />

          <Button
            type="button"
            data-testid="personalized-welcome:continue"
            onClick={handleContinue}
            disabled={pingState.status === "loading"}
            className="w-full text-primary-foreground"
            style={{ background: "var(--gradient-brand)" }}
          >
            {t("personalizedWelcome.continueButton")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
