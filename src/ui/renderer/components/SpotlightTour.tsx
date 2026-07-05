



import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import {
  DEFAULT_TOUR_SCENARIOS,
  getTourScenario,
  type CompletionTrigger,
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
  /**
   * Tutorial-X5 — fired right after the user reaches the last step of a
   * scenario and the tour closes (NOT on early-dismissal). The host's
   * `PostTourFirstTask` listens for this so it can offer the user a
   * real first plugin task without a dead-end UX transition.
   */
  onComplete?: (scenarioId: string) => void;



  onDismiss?: (scenarioId: string) => void;
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
  // U3 — viewport visibility check. An anchor whose bounding rect lands
  // fully off-screen (e.g. hidden behind a still-mounted Radix Dialog
  // portal that ate the layout, or scrolled out of view) would cause
  // the spotlight ring to draw at coordinates the user cannot see.
  // Returning null lets the caller fall back to the centred card.
  if (typeof window !== "undefined") {
    const offScreen =
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= window.innerHeight ||
      rect.left >= window.innerWidth;
    if (offScreen) return null;
  }
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * U6 — Detect whether another modal Dialog / AlertDialog is currently
 * mounted. If true, the SpotlightTour must NOT paint its backdrop on
 * top because the user would see the violet ring float above a still-
 * visible Radix Dialog (the bug from the 2026-05-19 screenshot).
 */
function anyModalDialogOpen(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    ),
  );
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

function ringStyle(
  rect: SpotlightRect | null,
  reduceMotion: boolean,
): React.CSSProperties | null {
  if (!rect) return null;
  // The ring is drawn 6px outside the anchor so it doesn't visually
  // crop the underlying element. The matching glow uses a wider
  // box-shadow for the "halo" effect from the mockup.
  //
  // F5 — when `prefers-reduced-motion: reduce`, drop the glowing
  // box-shadow halo (which animates in via the dialog mount). The
  // 1px violet border still marks the anchor unambiguously without
  // the visually-animated glow that a vestibular user would notice.
  const inset = 6;
  return {
    position: "fixed",
    top: rect.top - inset,
    left: rect.left - inset,
    width: rect.width + inset * 2,
    height: rect.height + inset * 2,
    borderRadius: "var(--radius-md)",
    pointerEvents: "none",
    // Halo composed from the active bundle's --primary + named opacity scale
    // via --shadow-spotlight (see styles.css). Reduced-motion drops the wide
    // bloom for the tighter ring so a vestibular user still sees the anchor.
    boxShadow: reduceMotion
      ? "var(--shadow-spotlight-reduced)"
      : "var(--shadow-spotlight)",
    border: "1px solid hsl(var(--primary) / var(--opacity-stronger))",
  };
}

/**
 * Subscribe to `prefers-reduced-motion: reduce` so the component re-renders
 * when the OS toggle flips. Returns the current preference; defaults to
 * `false` in non-DOM test environments.
 */
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
    // Safari < 14 only supports `addListener` / `removeListener`.
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);
  return reduce;
}

export function SpotlightTour({
  api,
  scenarios = DEFAULT_TOUR_SCENARIOS,
  initialScenarioId,
  onComplete,
  onDismiss,
}: SpotlightTourProps) {
  const { t } = useTranslation();
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
  //
  // U6 — modal precondition: if any Radix Dialog / AlertDialog is open
  // when the tour.start broadcast arrives, queue the scenario and wait
  // for the dialog to close before mounting. Without this guard the
  // SpotlightTour would paint its backdrop + ring on top of the still-
  // open dialog, leaving the violet ring floating over an unrelated
  // anchor that the user can't see (the 2026-05-19 screenshot bug).
  //
  // Double-broadcast guard (2026-05-19): if the SAME scenario is already
  // mounted, ignore the incoming broadcast instead of calling
  // `setActiveScenarioId` again. The downstream `useEffect [activeScenarioId]`
  // resets `stepIndex` to 0 and clears `dismissedRef`, so re-setting the


  // carries an idempotency ref; this is defense-in-depth so external

  // re-mount the active tour.
  const activeScenarioIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeScenarioIdRef.current = activeScenarioId;
  }, [activeScenarioId]);
  const pendingScenarioRef = useRef<string | null>(null);
  useEffect(() => {
    const subscribe = api?.tour?.onStart;
    if (typeof subscribe !== "function") return;
    const off = subscribe(({ scenarioId }) => {
      if (typeof scenarioId !== "string" || scenarioId.length === 0) return;
      if (activeScenarioIdRef.current === scenarioId) {
        // Same scenario already running — ignore the re-broadcast.
        return;
      }
      if (anyModalDialogOpen()) {
        // Queue the scenario; the MutationObserver below will pick it up
        // when the offending dialog unmounts.
        pendingScenarioRef.current = scenarioId;
        return;
      }
      setActiveScenarioId(scenarioId);
    });
    return off;
  }, [api]);

  // U6 — observer that flushes the queued scenario when every modal
  // dialog has closed. We watch `document.body` for the data-state
  // attribute mutations Radix emits on close.
  useEffect(() => {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") {
      return;
    }
    const observer = new MutationObserver(() => {
      if (pendingScenarioRef.current && !anyModalDialogOpen()) {
        const next = pendingScenarioRef.current;
        pendingScenarioRef.current = null;
        // Same-scenario guard — see the onStart subscriber comment above.
        if (activeScenarioIdRef.current === next) return;
        setActiveScenarioId(next);
      }
    });
    observer.observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-state"],
    });
    return () => observer.disconnect();
  }, []);

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
      // Tutorial-X5 — notify the host the scenario completed so a
      // post-tour first-task offer can render. Wrapped in try/catch
      // because consumer code lives outside this component's
      // reliability envelope; a thrown callback must not block tour
      // close-out.
      try {
        onComplete?.(id);
      } catch {
        /* host callback failure stays local */
      }
    },
    [api, onComplete],
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
      // Z onboarding chain — notify the host so the chain reducer
      // can still advance to PluginShowcase even when the user

      try {
        onDismiss?.(id);
      } catch {
        /* host callback failure stays local */
      }
    },
    [api, onDismiss],
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

  // U8 — Interactive auto-advance. When the current step declares a
  // `completionTrigger`, attach a listener that fires `handleNext` the
  // moment the user performs the matching action. This is what makes


  const triggerForStep: CompletionTrigger | undefined =
    scenario?.steps[stepIndex]?.completionTrigger;
  useEffect(() => {
    if (!scenario) return;
    if (!triggerForStep || triggerForStep.kind === "manual") return;

    let cleanup: (() => void) | null = null;

    if (triggerForStep.kind === "keypress") {
      const combo = triggerForStep.combo;
      const onKey = (e: KeyboardEvent) => {
        if (e.isComposing) return;
        const meta = e.metaKey || e.ctrlKey;
        if (!meta) return;
        if (combo === "⌘+K" && e.key.toLowerCase() === "k") {
          handleNext();
        } else if (
          combo === "⌘+?" &&
          e.shiftKey &&
          (e.key === "?" || e.key === "/")
        ) {
          handleNext();
        } else if (combo === "⌘+Enter" && e.key === "Enter") {
          handleNext();
        }
      };
      window.addEventListener("keydown", onKey);
      cleanup = () => window.removeEventListener("keydown", onKey);
    } else if (triggerForStep.kind === "input") {
      const selector = triggerForStep.selector;
      const target = document.querySelector<HTMLElement>(selector);
      if (!target) return;
      const onInput = () => handleNext();
      target.addEventListener("input", onInput);
      cleanup = () => target.removeEventListener("input", onInput);
    } else if (triggerForStep.kind === "click") {
      const selector = triggerForStep.selector;
      const target = document.querySelector<HTMLElement>(selector);
      if (!target) return;
      const onClick = () => handleNext();
      target.addEventListener("click", onClick);
      cleanup = () => target.removeEventListener("click", onClick);
    }

    return () => {
      if (cleanup) cleanup();
    };
  }, [scenario, stepIndex, triggerForStep, handleNext]);

  const reduceMotion = usePrefersReducedMotion();
  if (!scenario || !currentStep) return null;

  const total = scenario.steps.length;
  const isLast = stepIndex >= total - 1;
  const rect = readRect(currentStep.anchorSelector);
  const ring = ringStyle(rect, reduceMotion);
  const card = cardPlacement(rect);

  const titleId = `lvis-tour-title-${scenario.id}-${stepIndex}`;
  const bodyId = `lvis-tour-body-${scenario.id}-${stepIndex}`;

  return (
    <div
      data-testid="spotlight-tour"
      data-scenario-id={scenario.id}
      data-reduce-motion={reduceMotion ? "true" : "false"}
    >
      {/* Backdrop — clicking it dismisses the tour. The 78% black layer
          matches the mockup; pointer-events stay on so anchor clicks are
          intentionally blocked while the tour is active. */}
      <div
        data-testid="spotlight-tour:backdrop"
        onClick={() => closeAfterDismissal(scenario.id)}
        style={{
          position: "fixed",
          inset: 0,
          // Matches the shared Dialog overlay ladder (bundle --overlay tone).
          background: "hsl(var(--overlay) / var(--opacity-emphatic))",
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
        // Y2 — slide-up + fade entrance keyframe smooths the hand-off
        // from MemorySeedDialog → SpotlightTour so the
        // tour card doesn't pop into place. The shared `lvis-anim-slide-up`
        // utility collapses to opacity-only fade under
        // prefers-reduced-motion (styles.css §290).
        className="lvis-anim-slide-up"
        // Step transitions inside the same scenario also benefit from a
        // light re-mount fade — keying the card on the step index gives
        // React a unique key so the animation re-runs on advance.
        key={`${scenario.id}-${stepIndex}`}
        style={{
          ...card,
          zIndex: 9002,
          background: "hsl(var(--popover))",
          color: "hsl(var(--popover-foreground))",
          border: "1px solid hsl(var(--primary) / var(--opacity-half))",
          borderRadius: "var(--radius-lg)",
          padding: 20,
          // F5 — under `prefers-reduced-motion: reduce`, drop the soft
          // drop-shadow that "floats" the card; a vestibular-sensitive user
          // still sees the card via the primary border + filled backdrop.
          // Elevation now rides the bundle depth ladder (--shadow-e4) instead
          // of a theme-blind `rgba(0,0,0,.6)` so it re-tints per bundle.
          boxShadow: reduceMotion ? "none" : "var(--shadow-e4)",
        }}
      >
        <div
          className="text-[11px]"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "hsl(var(--muted-foreground))",
          }}
        >
          <span
            data-testid="spotlight-tour:step-badge"
            className="text-[10px] font-bold"
            style={{
              display: "inline-flex",
              width: 18,
              height: 18,
              borderRadius: "9999px",
              alignItems: "center",
              justifyContent: "center",
              background: "hsl(var(--primary))",
              color: "hsl(var(--primary-foreground))",
            }}
          >
            {stepIndex + 1}
          </span>
          <span>
            {stepIndex + 1} / {total} {t("spotlightTour.stepUnit")}
          </span>
        </div>
        <h3
          id={titleId}
          className="mt-2 text-[14px] font-semibold"
          style={{
            letterSpacing: "-0.01em",
          }}
        >
          {currentStep.title}
        </h3>
        <p
          id={bodyId}
          className="mt-1.5 text-[12px] leading-relaxed"
          style={{
            color: "hsl(var(--muted-foreground))",
          }}
        >
          {currentStep.body}
        </p>
        {currentStep.keyHint && currentStep.keyHint.length > 0 ? (
          <div
            data-testid="spotlight-tour:key-hints"
            className="mt-2"
            style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
          >
            {currentStep.keyHint.map((label) => (
              <kbd
                key={label}
                aria-label={t("spotlightTour.shortcutAriaLabel", { label })}
                className="font-mono text-[11px]"
                style={{
                  background: "hsl(var(--kbd-bg))",
                  border: "1px solid hsl(var(--kbd-border))",
                  borderRadius: "var(--radius-sm)",
                  padding: "1px 6px",
                  color: "hsl(var(--popover-foreground))",
                }}
              >
                {label}
              </kbd>
            ))}
          </div>
        ) : null}
        <div
          className="mt-4"
          style={{
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
                  borderRadius: "9999px",
                  background:
                    i === stepIndex
                      ? "hsl(var(--primary))"
                      : "hsl(var(--muted))",
                }}
              />
            ))}
          </div>
          <button
            type="button"
            data-testid="spotlight-tour:skip"
            onClick={() => closeAfterDismissal(scenario.id)}
            className="ml-auto text-[11px]"
            style={{
              background: "transparent",
              border: "none",
              color: "hsl(var(--muted-foreground))",
              cursor: "pointer",
            }}
          >
            {t("spotlightTour.skip")}
          </button>
          <button
            type="button"
            data-testid="spotlight-tour:next"
            onClick={handleNext}
            className="text-[12px]"
            style={{
              borderRadius: "var(--radius-md)",
              padding: "6px 12px",
              color: "hsl(var(--primary-foreground))",
              background: "hsl(var(--primary))",
              border: "none",
              cursor: "pointer",
            }}
          >
            {isLast ? t("spotlightTour.complete") : t("spotlightTour.next")}
          </button>
        </div>
      </div>
    </div>
  );
}
