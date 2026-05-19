/**
 * WelcomeQuestion (Z onboarding chain step 3) — post-login welcome card.
 *
 * Fires immediately after LoginModal resolves (success OR explicit skip)
 * so the user always sees an *opt-in confirmation* before the
 * MemorySeed wizard appears. Removing the implicit auto-trigger keeps
 * the first-boot funnel under the user's control end-to-end.
 *
 * Two paths:
 *   1. "예, 시작할게요 →" → triggers MemorySeed dialog (host's previous
 *      auto-trigger path is now gated behind this button).
 *   2. "나중에 (skip)" → bypasses MemorySeed + tour entirely;
 *      `onboardingCompleted` is flipped true and the user lands on
 *      the chat empty state.
 *
 * The displayed name comes from the host (best-effort settings probe);
 * if no name is known the card uses a neutral greeting.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";

export interface WelcomeQuestionProps {
  open: boolean;
  /**
   * Display name for the greeting. Empty/undefined falls back to a
   * neutral "환영합니다" so the card never shows the literal token
   * "{name}" or an empty bracket.
   */
  displayName?: string;
  /** Called when the user picks "예" — advances to MemorySeed. */
  onAccept: () => void;
  /** Called when the user picks "나중에" — skips memory + tour, flips completion. */
  onSkip: () => void;
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

export function WelcomeQuestion({
  open,
  displayName,
  onAccept,
  onSkip,
}: WelcomeQuestionProps) {
  const reduceMotion = usePrefersReducedMotion();
  const greeting = useMemo(() => {
    const trimmed = (displayName ?? "").trim();
    if (trimmed.length === 0) return "안녕하세요 👋";
    return `안녕하세요, ${trimmed}님 👋`;
  }, [displayName]);

  const handleAccept = useCallback(() => {
    onAccept();
  }, [onAccept]);

  const handleSkip = useCallback(() => {
    onSkip();
  }, [onSkip]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleSkip(); }}>
      <DialogContent
        size="sm"
        data-testid="welcome-question"
        data-reduce-motion={reduceMotion ? "true" : "false"}
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
              <DialogTitle className="text-sm font-medium">
                {greeting}
              </DialogTitle>
              <DialogDescription className="text-[11px]">
                LVIS 사용 준비를 시작해볼까요?
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-3">
          <p
            data-testid="welcome-question:body"
            className="text-[12.5px] leading-relaxed text-muted-foreground"
          >
            짧은 자기소개를 적으면 LVIS 가 호칭과 맥락을 기억해 첫 대화부터
            맞춤형으로 도와드립니다. 1분이면 충분해요.
          </p>

          <Button
            type="button"
            data-testid="welcome-question:accept"
            onClick={handleAccept}
            className="w-full text-primary-foreground"
            style={{
              background:
                "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(var(--p-blue-500)))",
            }}
          >
            예, 시작할게요 →
          </Button>
          <Button
            type="button"
            variant="ghost"
            data-testid="welcome-question:skip"
            onClick={handleSkip}
            className="w-full text-[11px]"
          >
            나중에 (skip)
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
