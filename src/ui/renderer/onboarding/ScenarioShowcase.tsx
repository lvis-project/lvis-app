/**
 * ScenarioShowcase (Z onboarding chain step 1) — first-boot intro screen.
 *
 * The grid illustrates the canonical LVIS scenarios (meeting / docs /
 * work / multi-agent) as passive cards, then a primary
 * "로그인하여 LVIS 시작하기" button advances the onboarding chain to the
 * LoginModal. There is no skip path; closing the dialog is a no-op via
 * Radix until the user starts login.
 *
 * Storage namespace: this view does not persist anything itself.
 * `features.onboardingCompleted` is the canonical flag the parent
 * flips when the entire Z chain ends.
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
} from "../../../components/ui/dialog.js";
import { OnboardingHeader } from "./OnboardingCard.js";
import { useTranslation } from "../../../i18n/react.js";

export interface ScenarioShowcaseProps {
  open: boolean;
  /**
   * Called when the user clicks "로그인하여 LVIS 시작하기" to advance the
   * onboarding chain to the LoginModal. The argument is reserved for the
   * downstream personalization carry and is always `null` from this grid.
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
  const cards = useMemo(() => SCENARIO_CARDS, []);

  return (
    // Forced choice — closing via outside-click / Esc is a no-op until
    // the user starts login.
    <Dialog open={open} onOpenChange={() => { /* forced choice */ }}>
      <DialogContent
        size="sm"
        data-testid="scenario-showcase"
        data-reduce-motion={reduceMotion ? "true" : "false"}
        className="p-0 overflow-hidden"
      >
        <ScenarioShowcaseGrid cards={cards} onStart={() => onStart(null)} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Grid view — passive illustration of the canonical scenarios. The
 * single primary CTA advances the onboarding chain to login.
 */
function ScenarioShowcaseGrid({
  cards,
  onStart,
}: {
  cards: readonly ScenarioCard[];
  onStart: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <OnboardingHeader
        size="lg"
        title="LVIS Studio"
        description={t("scenarioShowcase.gridDescription")}
      />

      <div className="px-6 pb-6 space-y-4">
        <div
          data-testid="scenario-showcase:grid"
          className="grid grid-cols-2 gap-2"
        >
          {cards.map((card) => (
            <div
              key={card.id}
              data-testid={`scenario-showcase:card:${card.id}`}
              className="rounded-lg border border-border/(--opacity-stronger) bg-[hsl(var(--muted))] px-3 py-3 text-left"
            >
              <div className="text-lg leading-none" aria-hidden="true">
                {card.icon}
              </div>
              <div className="mt-2 text-[12px] font-medium">{t(card.titleKey)}</div>
              <div className="mt-1 text-[10.5px] leading-snug text-muted-foreground">
                {t(card.bodyKey)}
              </div>
            </div>
          ))}
        </div>

        <Button
          type="button"
          data-testid="scenario-showcase:start"
          onClick={onStart}
          className="w-full text-primary-foreground"
          style={{ background: "var(--gradient-brand)" }}
        >
          {t("scenarioShowcase.startButton")}
        </Button>
      </div>
    </>
  );
}
