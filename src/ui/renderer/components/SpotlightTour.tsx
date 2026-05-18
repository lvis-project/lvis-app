/**
 * Tutorial-C — `SpotlightTour` component.
 *
 * Renders the O-V2 Spotlight onboarding pattern from
 * `/tmp/login-lvis/index.html` §"Onb V2 — Spotlight (toggle B)":
 *   - A full-viewport 78% black overlay darkens the chat surface.
 *   - One anchor element is "spotlit" via a violet ring + glow drawn at
 *     its bounding rect.
 *   - A floating card sits beneath the anchor (or centred when the anchor
 *     is missing) with a `<step> / <total>` badge, title, body, dot
 *     pagination, "건너뛰기" (skip) and "다음 →" (next) actions.
 *
 * Keyboard contract:
 *   - `Esc`        → dismiss (calls `tour.dismiss`).
 *   - `→` / `Enter`→ advance to the next step. Final step "다음" calls
 *                    `tour.markComplete` and closes the tour.
 *   - `←`          → go back one step.
 *   - `1`..`9`     → jump to step N (when N ≤ steps.length). Out-of-range
 *                    keystrokes are ignored.
 *
 * State persistence: the component subscribes to `lvis:tour:start`
 * (`api.tour.onStart`) on mount; the host fans the event out to every
 * window. Completion / dismissal calls `api.tour.markComplete` /
 * `api.tour.dismiss`. The store at `~/.lvis/onboarding/tour-state.json`
 * is the authoritative source — the component never caches state across
 * mounts.
 *
 * Accessibility:
 *   - `role="dialog"` + `aria-modal="true"` on the card.
 *   - `aria-labelledby` points at the title, `aria-describedby` at body.
 *   - `<kbd>` chips emit `aria-label="shortcut: <label>"` so a SR reads
 *     "shortcut: Cmd plus K" rather than the literal glyph.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_TOUR_SCENARIOS,
  getTourScenario,
  type TourScenario,
  type TourStep,
} from "../onboarding/default-tour-scenarios.js";

/**
 * Narrow API surface this component needs. Declared structurally so the
 * tests can hand-roll a minimal mock without faking the entire
 * `window.lvisApi`. Mirrors `LvisApi.tour` in `renderer/types.ts`.
 */
export interface SpotlightTourApi {
  tour: {
    getState: () => Promise<
      | {
          ok: true;
          state: {
            lastSeenScenario: string | null;
            completedScenarios: string[];
            dismissedAt: string | null;
          };
        }
      | { ok: false; error: string; message: string }
    >;
    markComplete: (
      scenarioId: string,
    ) => Promise<unknown>;
    dismiss: (
      scenarioId: string,
    ) => Promise<unknown>;
    onStart: (handler: (payload: { scenarioId: string }) => void) => () => void;
  };
}

export interface SpotlightTourProps {
  api: SpotlightTourApi;
  /**
   * Override the scenario registry — used by tests to inject a fixture
   * without depending on the production default. Defaults to
   * `DEFAULT_TOUR_SCENARIOS`.
   */
  scenarios?: Readonly<Record<string, TourScenario>>;
  /**
   * Open the component immediately for a given scenario instead of
   * waiting for an IPC `tour.onStart` event. Used by tests + Storybook;
   * production renders pass `undefined`.
   */
  initialScenarioId?: string;
}

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function readRect(selector: string): SpotlightRect | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Compute a safe placement for the floating card so it never overflows
 * the viewport. Returns CSS positioning hints in absolute pixels.
 */
function cardPlacement(rect: SpotlightRect | null): React.CSSProperties {
  if (typeof window === "undefined") {
    return { position: "fixed", left: 0, right: 0, bottom: 24 };
  }
  if (!rect) {
    // No anchor — centre in the viewport. Matches the mockup fallback
    // "tour must not block the chat surface" — if a renderer refactor
    // drops the anchor, the user can still see + dismiss the card.
    return {
      position: "fixed",
      left: 24,
      right: 24,
      bottom: Math.max(24, Math.floor(window.innerHeight * 0.18)),
      maxWidth: 480,
      marginLeft: "auto",
      marginRight: "auto",
    };
  }
  // Place the card under the anchor when there's room; otherwise above.
  const padding = 16;
  const cardHeight = 200; // rough estimate — exact height is content-driven
  const spaceBelow = window.innerHeight - (rect.top + rect.height);
  const placeBelow = spaceBelow >= cardHeight + padding;
  const top = placeBelow
    ? rect.top + rect.height + padding
    : Math.max(padding, rect.top - cardHeight - padding);
  return {
    position: "fixed",
    top,
    left: padding,
    right: padding,
    maxWidth: 480,
    marginLeft: "auto",
    marginRight: "auto",
  };
}

function ringStyle(rect: SpotlightRect | null): React.CSSProperties | null {
  if (!rect) return null;
  // The ring is drawn 6px outside the anchor so it doesn't visually
  // crop the underlying element. The matching glow uses a wider
  // box-shadow for the "halo" effect from the mockup.
  const inset = 6;
  return {
    position: "fixed",
    top: rect.top - inset,
    left: rect.left - inset,
    width: rect.width + inset * 2,
    height: rect.height + inset * 2,
    borderRadius: 8,
    pointerEvents: "none",
    boxShadow:
      "0 0 0 4px hsl(262 83% 58% / 0.7), 0 0 30px hsl(262 83% 58% / 0.4)",
    border: "1px solid hsl(262 83% 58% / 0.7)",
  };
}

export function SpotlightTour({
  api,
  scenarios = DEFAULT_TOUR_SCENARIOS,
  initialScenarioId,
}: SpotlightTourProps) {
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(
    initialScenarioId ?? null,
  );
  const [stepIndex, setStepIndex] = useState(0);
  // `tick` forces a re-render when the anchor moves (window resize /
  // layout shift) so the spotlight ring follows the target.
  const [, setTick] = useState(0);
  const dismissedRef = useRef(false);

  // Reset step index whenever a new scenario activates.
  useEffect(() => {
    setStepIndex(0);
    dismissedRef.current = false;
  }, [activeScenarioId]);

  const scenario: TourScenario | null = useMemo(() => {
    if (!activeScenarioId) return null;
    return scenarios[activeScenarioId] ?? getTourScenario(activeScenarioId) ?? null;
  }, [activeScenarioId, scenarios]);

  const currentStep: TourStep | null = scenario?.steps[stepIndex] ?? null;

  // Subscribe to the host broadcast.
  //
  // Test harnesses sometimes mock `window.lvisApi` with a partial shape
  // that omits `tour` — App-level renderer tests like ChatView mount the
  // whole App tree with a hand-rolled api, so a missing `tour.onStart`
  // must not crash the ErrorBoundary. Production preload always exposes
  // the full tour API.
  useEffect(() => {
    const subscribe = api?.tour?.onStart;
    if (typeof subscribe !== "function") return;
    const off = subscribe(({ scenarioId }) => {
      if (typeof scenarioId === "string" && scenarioId.length > 0) {
        setActiveScenarioId(scenarioId);
      }
    });
    return off;
  }, [api]);

  // Refresh the anchor rect on resize so the ring follows the target.
  useEffect(() => {
    if (!scenario) return;
    const onResize = () => setTick((n) => n + 1);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [scenario]);

  const closeAfterCompletion = useCallback(
    (id: string) => {
      const markComplete = api?.tour?.markComplete;
      if (typeof markComplete === "function") {
        void markComplete(id).catch(() => {
          /* persist failure is non-fatal — the tour still closes */
        });
      }
      setActiveScenarioId(null);
    },
    [api],
  );

  const closeAfterDismissal = useCallback(
    (id: string) => {
      if (dismissedRef.current) return;
      dismissedRef.current = true;
      const dismiss = api?.tour?.dismiss;
      if (typeof dismiss === "function") {
        void dismiss(id).catch(() => {
          /* persist failure is non-fatal — the tour still closes */
        });
      }
      setActiveScenarioId(null);
    },
    [api],
  );

  const handleNext = useCallback(() => {
    if (!scenario) return;
    const lastIndex = scenario.steps.length - 1;
    if (stepIndex >= lastIndex) {
      closeAfterCompletion(scenario.id);
    } else {
      setStepIndex((n) => n + 1);
    }
  }, [scenario, stepIndex, closeAfterCompletion]);

  const handlePrev = useCallback(() => {
    setStepIndex((n) => Math.max(0, n - 1));
  }, []);

  // Keyboard wiring — only active while a scenario is mounted.
  useEffect(() => {
    if (!scenario) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeAfterDismissal(scenario.id);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        handleNext();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        handlePrev();
        return;
      }
      // Numeric jump 1..9 — keyboard-only power-user shortcut. Out-of-range
      // keystrokes (e.g. "5" on a 3-step scenario) are ignored rather than
      // clamped so the tour can't desync from the visible dots.
      if (/^[1-9]$/.test(e.key)) {
        const target = Number.parseInt(e.key, 10) - 1;
        if (target >= 0 && target < scenario.steps.length) {
          e.preventDefault();
          setStepIndex(target);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scenario, handleNext, handlePrev, closeAfterDismissal]);

  if (!scenario || !currentStep) return null;

  const total = scenario.steps.length;
  const isLast = stepIndex >= total - 1;
  const rect = readRect(currentStep.anchorSelector);
  const ring = ringStyle(rect);
  const card = cardPlacement(rect);

  const titleId = `lvis-tour-title-${scenario.id}-${stepIndex}`;
  const bodyId = `lvis-tour-body-${scenario.id}-${stepIndex}`;

  return (
    <div data-testid="spotlight-tour" data-scenario-id={scenario.id}>
      {/* Backdrop — clicking it dismisses the tour. The 78% black layer
          matches the mockup; pointer-events stay on so anchor clicks are
          intentionally blocked while the tour is active. */}
      <div
        data-testid="spotlight-tour:backdrop"
        onClick={() => closeAfterDismissal(scenario.id)}
        style={{
          position: "fixed",
          inset: 0,
          background: "hsl(222 47% 4% / 0.78)",
          zIndex: 9000,
        }}
      />
      {ring ? (
        <div
          data-testid="spotlight-tour:ring"
          aria-hidden="true"
          style={{ ...ring, zIndex: 9001 }}
        />
      ) : null}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="spotlight-tour:card"
        data-step-index={stepIndex}
        style={{
          ...card,
          zIndex: 9002,
          background: "hsl(222.2 84% 7%)",
          color: "hsl(210 40% 98%)",
          border: "1px solid hsl(262 83% 58% / 0.5)",
          borderRadius: 12,
          padding: 20,
          boxShadow: "0 20px 50px -10px rgba(0,0,0,0.6)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 11,
            color: "hsl(215 20% 65%)",
          }}
        >
          <span
            data-testid="spotlight-tour:step-badge"
            style={{
              display: "inline-flex",
              width: 18,
              height: 18,
              borderRadius: 9999,
              alignItems: "center",
              justifyContent: "center",
              background: "hsl(262 83% 58%)",
              color: "white",
              fontWeight: 700,
              fontSize: 10,
            }}
          >
            {stepIndex + 1}
          </span>
          <span>
            {stepIndex + 1} / {total} 단계
          </span>
        </div>
        <h3
          id={titleId}
          style={{
            marginTop: 8,
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: "-0.01em",
          }}
        >
          {currentStep.title}
        </h3>
        <p
          id={bodyId}
          style={{
            marginTop: 6,
            fontSize: 12,
            lineHeight: 1.6,
            color: "hsl(215 20% 65%)",
          }}
        >
          {currentStep.body}
        </p>
        {currentStep.keyHint && currentStep.keyHint.length > 0 ? (
          <div
            data-testid="spotlight-tour:key-hints"
            style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}
          >
            {currentStep.keyHint.map((label) => (
              <kbd
                key={label}
                aria-label={`shortcut: ${label}`}
                style={{
                  background: "hsl(217 33% 17%)",
                  border: "1px solid hsl(217 33% 28%)",
                  borderRadius: 4,
                  padding: "1px 6px",
                  fontFamily: '"SF Mono", "JetBrains Mono", Menlo, monospace',
                  fontSize: 11,
                  color: "hsl(210 40% 98%)",
                }}
              >
                {label}
              </kbd>
            ))}
          </div>
        ) : null}
        <div
          style={{
            marginTop: 16,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <div
            data-testid="spotlight-tour:dots"
            style={{ display: "flex", gap: 6 }}
          >
            {scenario.steps.map((_, i) => (
              <span
                key={i}
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: 9999,
                  background:
                    i === stepIndex
                      ? "hsl(262 83% 58%)"
                      : "hsl(217 33% 17%)",
                }}
              />
            ))}
          </div>
          <button
            type="button"
            data-testid="spotlight-tour:skip"
            onClick={() => closeAfterDismissal(scenario.id)}
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: "none",
              color: "hsl(215 20% 65%)",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            건너뛰기
          </button>
          <button
            type="button"
            data-testid="spotlight-tour:next"
            onClick={handleNext}
            style={{
              borderRadius: 6,
              padding: "6px 12px",
              fontSize: 12,
              color: "white",
              background: "hsl(262 83% 58%)",
              border: "none",
              cursor: "pointer",
            }}
          >
            {isLast ? "완료" : "다음 →"}
          </button>
        </div>
      </div>
    </div>
  );
}
