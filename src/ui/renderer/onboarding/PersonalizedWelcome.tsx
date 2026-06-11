/**
 * PersonalizedWelcome (Z onboarding chain — replaces WelcomeQuestion).
 *
 * Mounted AFTER MemorySeed so the card can greet the user by the 호칭
 * they just typed and reference their one-line 자기소개. No skip path —
 * the user must press the confirm button to advance into the tour stage.
 *
 * LLM ping integration (2026-05-20):
 *   On mount the card invokes `api.pingAiProvider()` to surface a *연결
 *   확인 라인* below the personalised greeting. Three render states:
 *     - loading:  spinner + "LLM 연결 확인 중…" (confirm disabled)
 *     - success:  "LVIS 가 <vendor> · <model> 와 <latency>ms 만에 연결됐어요."
 *     - failure:  warning + actionable copy for either missing credentials
 *                  or private endpoint reachability (confirm still enabled).
 *
 *   The ping is a lightweight liveness probe (no full LLM round-trip); we
 *   just want to confirm the configured vendor/model responds before the
 *   user lands on the chat surface. Failure is non-fatal — the user can
 *   still proceed and fix credentials from Settings later.
 *
 * The displayed name comes from chain state (`memorySeed.nickname`); the
 * one-line intro is rendered as a quote so the user recognises their own
 * voice. Blank values gracefully fall back to a neutral greeting.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import type { AiProviderPingIpcResult } from "../../../shared/ai-provider-ping.js";
import { t } from "../../../i18n/runtime.js";
import { useTranslation } from "../../../i18n/react.js";

export interface PersonalizedWelcomeProps {
  open: boolean;
  /** 호칭 the user typed into MemorySeed. Empty = neutral greeting. */
  nickname?: string;
  /** One-line 자기소개 the user typed into MemorySeed. */
  introduction?: string;
  /**
   * Liveness probe for the configured LLM provider. Passed as a stable
   * function reference (not wrapped in a fresh object literal) so a parent
   * re-render does not re-fire the mount-time ping effect.
   */
  pingAiProvider: () => Promise<AiProviderPingIpcResult>;
  /** Fires when the user presses "예, 시작할게요 →". */
  onContinue: () => void;
}

type PingState =
  | { status: "loading" }
  | {
      status: "success";
      vendor: string;
      model: string;
      latencyMs: number;
    }
  | { status: "failure"; reason: string };

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

  const [pingState, setPingState] = useState<PingState>({ status: "loading" });

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
        if ("ok" in result) {
          setPingState({ status: "failure", reason: result.error });
          return;
        }
        if (result.configured && result.online) {
          setPingState({
            status: "success",
            vendor: result.vendor,
            model: result.model,
            latencyMs: result.latencyMs,
          });
          return;
        }
        setPingState({ status: "failure", reason: result.error });
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
        <DialogHeader className="px-6 pt-6 pb-2 space-y-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="grid h-7 w-7 place-items-center rounded-md text-[11px] text-primary-foreground"
              style={{
                background:
                  "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(var(--p-blue-500)))",
              }}
            >
              ✦
            </span>
            <div className="min-w-0">
              <DialogTitle
                className="text-sm font-medium"
                data-testid="personalized-welcome:greeting"
              >
                {greeting}
              </DialogTitle>
              <DialogDescription className="text-[11px]">
                {t("personalizedWelcome.readySubtitle")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

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
              className="rounded-md bg-success/10 px-2.5 py-1.5 text-[11px] text-success"
              role="status"
            >
              {t("personalizedWelcome.pingSuccess", { vendor: pingState.vendor, model: pingState.model, latencyMs: pingState.latencyMs })}
            </div>
          )}
          {pingState.status === "failure" && (
            <div
              data-testid="personalized-welcome:ping-failure"
              className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive"
              role="alert"
            >
              {pingFailureMessage(pingState.reason)}
            </div>
          )}

          <Button
            type="button"
            data-testid="personalized-welcome:continue"
            onClick={handleContinue}
            disabled={pingState.status === "loading"}
            className="w-full text-primary-foreground"
            style={{
              background:
                "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(var(--p-blue-500)))",
            }}
          >
            {t("personalizedWelcome.continueButton")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
