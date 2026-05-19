/**
 * ScenarioShowcase (Z onboarding chain step 1) — first-boot intro screen.
 *
 * Option A — Interactive demo launcher (2026-05-19).
 * Mockup SOT: `/tmp/auth-account-discussion/v3-autoplay-integration.html` A1/A2/A3.
 *
 * Two render modes:
 *
 *   1. Default grid (no active scenario) — 4 clickable cards
 *      illustrate the canonical LVIS scenarios (meeting / docs / work /
 *      multi-agent). Clicking a card switches the dialog into demo
 *      mode for that scenario. A small "건너뛰기 →" ghost link below
 *      the grid lets the user skip the whole intro.
 *
 *   2. Inline demo (activeScenarioId set) — the picked card's scripted
 *      turn plays inside the same dialog via the shared
 *      `ScriptedTurnEngine`. Header shows "← 다른 시나리오" + a pulsing
 *      "● DEMO" indicator; footer offers two CTAs:
 *        - "이 시나리오로 시작 →" — dispatches `showcase-start` with
 *           the picked scenarioId so the onboarding chain advances to
 *           LoginModal carrying the user's choice.
 *        - "다른 시나리오" — resets the active scenario, returning to
 *           the grid.
 *
 * Trust boundary stays identical to the standalone DemoAutoplayView:
 * the inline engine NEVER calls `ConversationLoop` or any real tool;
 * each tool result is a hard-coded string in `scripts/*.json`. See
 * `engine/demo-autoplay/scripted-turn-engine.ts`.
 *
 * Storage namespace: this view does not persist anything itself.
 * `features.onboardingCompleted` is the canonical flag the parent
 * flips when the entire Z chain ends.
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
import { ScriptedTurnEngine } from "../../../engine/demo-autoplay/scripted-turn-engine.js";
import type {
  ScriptedAbortReason,
  ScriptedSink,
  ScriptedTurn,
} from "../../../engine/demo-autoplay/types.js";
import { getScriptByScenarioId } from "../../../engine/demo-autoplay/scripts-registry.js";

export interface ScenarioShowcaseProps {
  open: boolean;
  /**
   * Called when the user clicks "이 시나리오로 시작 →". Carries the
   * picked scenarioId so the onboarding chain can personalise the
   * downstream stages (MemorySeed recommendations, PluginShowcase
   * ordering, intro placeholder).
   */
  onStart: (scenarioId: string | null) => void;
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
  /**
   * Currently-previewed scenario id. `null` means the default 2×2
   * grid is shown. Reset whenever the dialog closes so a re-open
   * always returns to the grid view.
   */
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setActiveScenarioId(null);
  }, [open]);

  const handleStart = useCallback(() => {
    onStart(activeScenarioId);
  }, [activeScenarioId, onStart]);

  const handleSkip = useCallback(() => {
    onSkip();
  }, [onSkip]);

  const handleCardClick = useCallback((scenarioId: string) => {
    setActiveScenarioId(scenarioId);
  }, []);

  const handleResetToGrid = useCallback(() => {
    setActiveScenarioId(null);
  }, []);

  const cards = useMemo(() => SCENARIO_CARDS, []);
  const activeScript = useMemo(
    () => getScriptByScenarioId(activeScenarioId),
    [activeScenarioId],
  );
  const activeCard = useMemo(
    () => cards.find((c) => c.id === activeScenarioId) ?? null,
    [activeScenarioId, cards],
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleSkip(); }}>
      <DialogContent
        size="sm"
        data-testid="scenario-showcase"
        data-reduce-motion={reduceMotion ? "true" : "false"}
        data-active-scenario={activeScenarioId ?? ""}
        className="p-0 overflow-hidden"
      >
        {activeScript && activeCard ? (
          <ScenarioShowcaseInlineDemo
            script={activeScript}
            cardTitle={activeCard.title}
            onBack={handleResetToGrid}
            onStart={handleStart}
          />
        ) : (
          <ScenarioShowcaseGrid
            cards={cards}
            onCardClick={handleCardClick}
            onStart={handleStart}
            onSkip={handleSkip}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Grid view — passive-illustration layout updated to the Option A
 * mockup. Cards are now *buttons* (the entire surface is clickable);
 * the "▶ demo 시연" affordance under each label communicates that the
 * click leads to a live preview rather than a hidden tab switch.
 */
function ScenarioShowcaseGrid({
  cards,
  onCardClick,
  onStart,
  onSkip,
}: {
  cards: readonly ScenarioCard[];
  onCardClick: (scenarioId: string) => void;
  onStart: () => void;
  onSkip: () => void;
}) {
  return (
    <>
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
              어떤 작업이 가장 자주이세요? 카드를 누르면 즉시 시연합니다.
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="px-6 pb-6 space-y-4">
        <div
          data-testid="scenario-showcase:grid"
          className="grid grid-cols-2 gap-2"
        >
          {cards.map((card) => (
            <button
              key={card.id}
              type="button"
              data-testid={`scenario-showcase:card:${card.id}`}
              onClick={() => onCardClick(card.id)}
              className="rounded-lg border border-border/70 bg-[hsl(var(--muted))] px-3 py-3 text-left transition hover:border-[hsl(var(--p-purple-500)/0.6)] hover:bg-[hsl(var(--muted))]/80 focus:outline-none focus:ring-2 focus:ring-[hsl(var(--p-purple-500))]"
              aria-label={`${card.title} — ${card.body}. 클릭하면 데모가 시연됩니다.`}
            >
              <div className="text-lg leading-none" aria-hidden="true">
                {card.icon}
              </div>
              <div className="mt-2 text-[12px] font-medium">{card.title}</div>
              <div className="mt-1 text-[10.5px] leading-snug text-muted-foreground">
                {card.body}
              </div>
              <div
                className="mt-2 text-[10px] font-medium"
                style={{ color: "hsl(var(--p-purple-500))" }}
              >
                ▶ demo 시연
              </div>
            </button>
          ))}
        </div>

        {/* Primary CTA — proceeds without picking a scenario (chain
            still records null selection so downstream uses default
            ordering). */}
        <Button
          type="button"
          data-testid="scenario-showcase:start"
          onClick={onStart}
          className="w-full text-primary-foreground"
          style={{
            background:
              "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(var(--p-blue-500)))",
          }}
        >
          시작하기 →
        </Button>
        <Button
          type="button"
          variant="ghost"
          data-testid="scenario-showcase:skip"
          onClick={onSkip}
          className="w-full text-[11px]"
        >
          건너뛰기
        </Button>
      </div>
    </>
  );
}

/**
 * Inline demo view — replaces the grid surface inside the same
 * Dialog. Renders header navigation, the scripted-turn transcript,
 * and the two-CTA footer per A2 of the mockup.
 */
function ScenarioShowcaseInlineDemo({
  script,
  cardTitle,
  onBack,
  onStart,
}: {
  script: ScriptedTurn;
  cardTitle: string;
  onBack: () => void;
  onStart: () => void;
}) {
  return (
    <div data-testid="scenario-showcase:inline-demo" className="flex flex-col">
      <div
        className="flex items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "hsl(var(--border))" }}
      >
        <button
          type="button"
          data-testid="scenario-showcase:inline-demo:back"
          onClick={onBack}
          className="text-[10.5px] text-muted-foreground transition hover:text-foreground"
        >
          ← 다른 시나리오
        </button>
        <span
          className="ml-2 text-[11px] font-medium text-foreground"
          data-testid="scenario-showcase:inline-demo:title"
        >
          {cardTitle}
        </span>
        <span
          data-testid="scenario-showcase:inline-demo:rec"
          className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
          style={{
            background: "hsl(0 78% 58% / 0.15)",
            color: "hsl(0 78% 70%)",
          }}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full demo-autoplay-rec-dot"
            style={{ background: "hsl(0 78% 58%)" }}
          />
          DEMO
        </span>
      </div>

      <ScenarioShowcaseDemoTranscript script={script} />

      <div
        className="border-t p-3"
        style={{
          borderColor: "hsl(var(--border))",
          background:
            "linear-gradient(180deg, transparent, hsl(var(--p-purple-500) / 0.08))",
        }}
      >
        <div
          className="rounded-md p-3 text-center"
          style={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--p-purple-500) / 0.5)",
          }}
        >
          <div className="mb-2.5 text-[12px]">
            이런 식으로 동작해요. 이 시나리오로 시작해볼까요?
          </div>
          <div className="flex justify-center gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="scenario-showcase:inline-demo:start"
              onClick={onStart}
              className="text-primary-foreground"
              style={{
                background:
                  "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(var(--p-blue-500)))",
              }}
            >
              이 시나리오로 시작 →
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid="scenario-showcase:inline-demo:other"
              onClick={onBack}
            >
              다른 시나리오
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface DemoEntry {
  id: string;
  kind: "user" | "tool-call" | "tool-result" | "assistant";
  text: string;
  status?: "running" | "done";
  toolName?: string;
  labelKo?: string;
  isFinal?: boolean;
}

/**
 * Self-contained scripted-turn transcript. A *fresh* `ScriptedTurnEngine`
 * is spun up for each (script) the user picks, so switching cards mid-flight
 * cleanly aborts the previous run via the cleanup effect.
 *
 * The transcript does NOT reach `ChatHistory` or `ConversationLoop` —
 * every entry stays in local view state, matching the trust boundary
 * documented in `docs/architecture/proposals/live-autoplay.md` §5 R4.
 */
function ScenarioShowcaseDemoTranscript({ script }: { script: ScriptedTurn }) {
  const [entries, setEntries] = useState<DemoEntry[]>([]);
  const engineRef = useRef<ScriptedTurnEngine | null>(null);

  const upsertEntry = useCallback((next: DemoEntry) => {
    setEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === next.id);
      if (idx < 0) return [...prev, next];
      const copy = prev.slice();
      copy[idx] = next;
      return copy;
    });
  }, []);

  const sink = useMemo<ScriptedSink>(
    () => ({
      emitUserMessage(text, isFinal) {
        upsertEntry({ id: "user-1", kind: "user", text, isFinal });
      },
      emitToolCall(call, status) {
        upsertEntry({
          id: `tool-call:${call.toolName}`,
          kind: "tool-call",
          text: call.labelKo,
          toolName: call.toolName,
          labelKo: call.labelKo,
          status,
        });
      },
      emitToolResult(call, resultKo) {
        upsertEntry({
          id: `tool-result:${call.toolName}`,
          kind: "tool-result",
          text: resultKo,
          toolName: call.toolName,
          labelKo: call.labelKo,
        });
      },
      emitAssistantDelta(text, isFinal) {
        upsertEntry({ id: "assistant-1", kind: "assistant", text, isFinal });
      },
      onAborted(_reason: ScriptedAbortReason) {
        // Inline demo intentionally has no audit emitter — the showcase
        // surface is pre-credentials, so the audit log is not yet
        // accessible. The host audits the picked scenario when chain
        // advances via `showcase-start`.
      },
    }),
    [upsertEntry],
  );

  useEffect(() => {
    // Reset transcript when script switches so partial entries from a
    // previous demo don't bleed into the next one.
    setEntries([]);
    const engine = new ScriptedTurnEngine();
    engineRef.current = engine;
    void engine.start(script, sink).catch(() => {
      // start() throws only on re-entry — the cleanup below aborts the
      // previous engine before this effect re-runs, so we should never
      // hit this in practice. Swallow to avoid an unhandled rejection
      // when the dialog unmounts mid-flight.
    });
    return () => {
      engine.abort("external");
    };
  }, [script, sink]);

  return (
    <div
      data-testid="scenario-showcase:inline-demo:transcript"
      className="flex-1 max-h-[340px] space-y-2 overflow-y-auto px-3 py-3 text-[11.5px]"
    >
      {entries.map((entry) => (
        <ScenarioShowcaseDemoEntry key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function ScenarioShowcaseDemoEntry({ entry }: { entry: DemoEntry }) {
  if (entry.kind === "user") {
    return (
      <div
        className="flex justify-end gap-2"
        data-testid="scenario-showcase:inline-demo:entry:user"
      >
        <div
          className="max-w-[80%] rounded-lg rounded-tr-sm px-3 py-2"
          style={{ background: "hsl(217 91% 60%)", color: "white" }}
        >
          {entry.text}
          {entry.isFinal === false && <CursorBlink />}
        </div>
      </div>
    );
  }
  if (entry.kind === "tool-call") {
    return (
      <div
        className="flex gap-2"
        data-testid="scenario-showcase:inline-demo:entry:tool-call"
      >
        <BotAvatar />
        <div
          className="flex-1 rounded-lg rounded-tl-sm px-3 py-2"
          style={{ background: "hsl(var(--card))" }}
        >
          <div className="flex items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[10.5px]"
              style={{ background: "hsl(217 33% 17%)", color: "hsl(217 91% 75%)" }}
            >
              {entry.toolName}
            </span>
            <span className="text-[10.5px] text-muted-foreground">
              {entry.labelKo}
              {entry.status === "running" ? " · 실행 중" : ""}
            </span>
          </div>
        </div>
      </div>
    );
  }
  if (entry.kind === "tool-result") {
    return (
      <div
        className="flex gap-2"
        data-testid="scenario-showcase:inline-demo:entry:tool-result"
      >
        <BotAvatar invisible />
        <div
          className="flex-1 rounded-lg rounded-tl-sm px-3 py-2 font-mono text-[10.5px] text-muted-foreground"
          style={{ background: "hsl(var(--card))" }}
        >
          📄 데모: {entry.text}
        </div>
      </div>
    );
  }
  return (
    <div
      className="flex gap-2"
      data-testid="scenario-showcase:inline-demo:entry:assistant"
    >
      <BotAvatar invisible />
      <div
        className="flex-1 whitespace-pre-wrap rounded-lg rounded-tl-sm px-3 py-2 leading-relaxed"
        style={{ background: "hsl(var(--card))" }}
      >
        {entry.text}
        {entry.isFinal === false && <CursorBlink />}
      </div>
    </div>
  );
}

function BotAvatar({ invisible = false }: { invisible?: boolean }) {
  return (
    <div
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[11px] text-primary-foreground"
      style={{
        background: invisible
          ? "transparent"
          : "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(217 91% 60%))",
        visibility: invisible ? "hidden" : "visible",
      }}
      aria-hidden="true"
    >
      ✦
    </div>
  );
}

function CursorBlink() {
  return (
    <span
      aria-hidden="true"
      className="demo-autoplay-cursor ml-0.5 inline-block h-3 w-1 align-middle"
      style={{ background: "currentColor" }}
    />
  );
}
