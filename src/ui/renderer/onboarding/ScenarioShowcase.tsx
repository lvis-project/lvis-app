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
 *      mode for that scenario. A primary "로그인하여 LVIS 시작하기"
 *      button advances directly to LoginModal with no selected scenario.
 *      There is still no skip path; closing the dialog is a no-op via
 *      Radix until the user either previews a scenario or starts login.
 *
 *   2. Inline demo (activeScenarioId set) — the picked card's scripted
 *      turn plays inside the same dialog via the shared
 *      `ScriptedTurnEngine`. Header shows "← 다른 시나리오" + a pulsing
 *      "● DEMO" indicator; footer offers two CTAs:
 *        - "로그인하여 LVIS 시작하기" — dispatches `showcase-start` with
 *           the picked scenarioId so the onboarding chain advances to
 *           LoginModal carrying the user's choice.
 *        - "뒤로가기" — resets the active scenario, returning to the
 *           grid (replaces the older "다른 시나리오" copy).
 *
 * Trust boundary: the inline scripted-turn engine NEVER calls
 * `ConversationLoop` or any real tool; each tool result is a hard-coded
 * string in `scripts/*.json`. See
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
import { useTranslation } from "../../../i18n/react.js";

export interface ScenarioShowcaseProps {
  open: boolean;
  /**
   * Called when the user clicks "로그인하여 LVIS 시작하기". Carries the
   * picked scenarioId when started from an inline preview, or `null` when
   * the user starts login directly from the grid CTA. Downstream stages
   * use the non-null id to personalise MemorySeed recommendations,
   * PluginShowcase ordering, and the intro placeholder.
   */
  onStart: (scenarioId: string | null) => void;
}

interface ScenarioCard {
  id: string;
  icon: string;
  /** i18n key resolved via t() at render time */
  titleKey: string;
  /** i18n key resolved via t() at render time */
  bodyKey: string;
}

const SCENARIO_CARDS: readonly ScenarioCard[] = [
  {
    id: "meeting",
    icon: "🎙️",
    titleKey: "scenarioShowcase.meetingTitle",
    bodyKey: "scenarioShowcase.meetingBody",
  },
  {
    id: "docs",
    icon: "📚",
    titleKey: "scenarioShowcase.docsTitle",
    bodyKey: "scenarioShowcase.docsBody",
  },
  {
    id: "work",
    icon: "💼",
    titleKey: "scenarioShowcase.workTitle",
    bodyKey: "scenarioShowcase.workBody",
  },
  {
    id: "multi-agent",
    icon: "🤖",
    titleKey: "scenarioShowcase.multiAgentTitle",
    bodyKey: "scenarioShowcase.multiAgentBody",
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

export function ScenarioShowcase({ open, onStart }: ScenarioShowcaseProps) {
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
    // Forced choice — closing via outside-click / Esc is a no-op until
    // the user picks a card and confirms.
    <Dialog open={open} onOpenChange={() => { /* forced choice */ }}>
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
            cardTitleKey={activeCard.titleKey}
            onBack={handleResetToGrid}
            onStart={handleStart}
          />
        ) : (
          <ScenarioShowcaseGrid
            cards={cards}
            onCardClick={handleCardClick}
            onStart={handleStart}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Grid view — passive-illustration layout updated to the Option A
 * mockup. Cards are now *buttons* (the entire surface is clickable);
 * the "▶ 시나리오 구경하기" affordance under each label communicates
 * that the click leads to a live preview rather than a hidden tab switch.
 *
 * 2026-05-20: the skip path stays removed. The user can preview one of
 * the 4 cards or continue directly to login through the primary CTA.
 */
function ScenarioShowcaseGrid({
  cards,
  onCardClick,
  onStart,
}: {
  cards: readonly ScenarioCard[];
  onCardClick: (scenarioId: string) => void;
  onStart: () => void;
}) {
  const { t } = useTranslation();
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
              {t("scenarioShowcase.gridDescription")}
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
              aria-label={`${t(card.titleKey)} — ${t(card.bodyKey)}. ${t("scenarioShowcase.cardAriaClickHint")}`}
            >
              <div className="text-lg leading-none" aria-hidden="true">
                {card.icon}
              </div>
              <div className="mt-2 text-[12px] font-medium">{t(card.titleKey)}</div>
              <div className="mt-1 text-[10.5px] leading-snug text-muted-foreground">
                {t(card.bodyKey)}
              </div>
              <div
                className="mt-2 text-[10px] font-medium"
                style={{ color: "hsl(var(--p-purple-500))" }}
              >
                {t("scenarioShowcase.cardPreviewAffordance")}
              </div>
            </button>
          ))}
        </div>

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
          {t("scenarioShowcase.startButton")}
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
  cardTitleKey,
  onBack,
  onStart,
}: {
  script: ScriptedTurn;
  cardTitleKey: string;
  onBack: () => void;
  onStart: () => void;
}) {
  const { t } = useTranslation();
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
          {t("scenarioShowcase.backButton")}
        </button>
        <span
          className="ml-2 text-[11px] font-medium text-foreground"
          data-testid="scenario-showcase:inline-demo:title"
        >
          {t(cardTitleKey)}
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
              {t("scenarioShowcase.startButton")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid="scenario-showcase:inline-demo:back-cta"
              onClick={onBack}
            >
              {t("scenarioShowcase.backButtonShort")}
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
  const { t } = useTranslation();
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
              {entry.status === "running" ? ` · ${t("scenarioShowcase.toolRunning")}` : ""}
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
          {t("scenarioShowcase.toolResultPrefix")}{entry.text}
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
