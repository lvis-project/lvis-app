/**
 * ScenarioShowcase (Z onboarding chain step 1) — first-boot intro screen.
 *
 * Renders BEFORE the LoginModal so the user always sees LVIS as
 * *capability surface* first, *credential gate* second. Four passive
 * preview cards illustrate the canonical scenarios (meeting / docs /
 * work / multi-agent); the user advances explicitly via "시작하기 →"
 * or skips with the small "건너뛰기" ghost.
 *
 * Design contract (Z brief):
 *   - Big gradient brand mark + tagline.
 *   - 2×2 scenario card grid sized for the 460×840 narrow LVIS window —
 *     cards are non-interactive previews (no click handler) so the user
 *     understands these are *examples*, not a launcher.
 *   - Two CTAs: large gradient "시작하기 →" (advances to LoginModal),
 *     small ghost "건너뛰기" (advances directly).
 *   - prefers-reduced-motion: drop the animated mount transitions.
 *
 * The component is intentionally minimal — no IPC, no storage. The
 * caller (App.tsx state machine) owns sequencing. Mount/unmount keeps
 * the Showcase out of memory once the user advances.
 *
 * Storage namespace: this view does not persist anything itself.
 * `features.onboardingCompleted` is the canonical flag the parent
 * flips when the entire Z chain ends.
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

export interface ScenarioShowcaseProps {
  open: boolean;
  /** Called when the user clicks "시작하기 →" — advances to LoginModal. */
  onStart: () => void;
  /** Called when the user clicks "건너뛰기" — skips directly past login + tour. */
  onSkip: () => void;
}

interface ScenarioCard {
  id: string;
  icon: string;
  title: string;
  body: string;
}

const SCENARIO_CARDS: readonly ScenarioCard[] = [
  {
    id: "meeting",
    icon: "🎙️",
    title: "회의록 정리",
    body: "회의 녹음 → 자동 STT → 요약과 액션 아이템 추출.",
  },
  {
    id: "docs",
    icon: "📚",
    title: "문서 검색",
    body: "로컬 PDF·Word·마크다운을 인덱싱하고 자연어로 답합니다.",
  },
  {
    id: "work",
    icon: "💼",
    title: "업무 도우미",
    body: "이메일 / 일정에서 할 일을 추출해 적시 알림으로 제안합니다.",
  },
  {
    id: "multi-agent",
    icon: "🤖",
    title: "Multi-agent",
    body: "여러 에이전트가 작업을 분산해 처리하고 결과를 합성합니다.",
  },
];

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

export function ScenarioShowcase({ open, onStart, onSkip }: ScenarioShowcaseProps) {
  const reduceMotion = usePrefersReducedMotion();

  const handleStart = useCallback(() => {
    onStart();
  }, [onStart]);

  const handleSkip = useCallback(() => {
    onSkip();
  }, [onSkip]);

  const cards = useMemo(() => SCENARIO_CARDS, []);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleSkip(); }}>
      <DialogContent
        size="sm"
        data-testid="scenario-showcase"
        data-reduce-motion={reduceMotion ? "true" : "false"}
        className="p-0 overflow-hidden"
      >
        {/* Brand header — gradient ✦ + tagline */}
        <DialogHeader className="px-6 pt-6 pb-3 space-y-0">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="grid h-10 w-10 place-items-center rounded-lg text-base text-primary-foreground"
              style={{
                background:
                  "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(var(--p-blue-500)))",
              }}
            >
              ✦
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-sm font-semibold tracking-tight">
                LVIS Studio
              </DialogTitle>
              <DialogDescription className="text-[11px]">
                업무 흐름 그대로, AI 가 옆에서 함께.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-4">
          {/* Tagline / pitch */}
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            LVIS 가 어떤 일을 도와드릴 수 있는지 먼저 둘러보세요. 시작하기를
            누르면 로그인 후 짧은 소개를 거쳐 바로 채팅으로 들어갑니다.
          </p>

          {/* 2×2 passive preview grid — cards are NOT clickable so the
              user understands these are illustrative samples, not tabs.
              data-testid prefix used by the showcase test to assert
              card count + content order. */}
          <div
            data-testid="scenario-showcase:grid"
            className="grid grid-cols-2 gap-2"
          >
            {cards.map((card) => (
              <div
                key={card.id}
                data-testid={`scenario-showcase:card:${card.id}`}
                className="rounded-lg border border-border/70 bg-[hsl(var(--muted))] px-3 py-3 text-left"
                role="img"
                aria-label={`${card.title} — ${card.body}`}
              >
                <div className="text-lg leading-none" aria-hidden="true">
                  {card.icon}
                </div>
                <div className="mt-2 text-[12px] font-medium">{card.title}</div>
                <div className="mt-1 text-[10.5px] leading-snug text-muted-foreground">
                  {card.body}
                </div>
              </div>
            ))}
          </div>

          {/* Primary CTA — gradient violet→blue mirrors LVIS brand */}
          <Button
            type="button"
            data-testid="scenario-showcase:start"
            onClick={handleStart}
            className="w-full text-primary-foreground"
            style={{
              background:
                "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(var(--p-blue-500)))",
            }}
          >
            시작하기 →
          </Button>
          {/* Skip — small ghost link sized down to match mockup */}
          <Button
            type="button"
            variant="ghost"
            data-testid="scenario-showcase:skip"
            onClick={handleSkip}
            className="w-full text-[11px]"
          >
            건너뛰기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
