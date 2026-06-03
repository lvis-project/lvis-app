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
  /**
   * Z onboarding chain — fires when the user dismisses the tour
   * BEFORE reaching the last step (Esc, backdrop click, "건너뛰기").
   * The chain reducer uses this to still advance to the
   * PluginShowcase stage so an early-skip user is not stranded on
   * a half-finished chain.
   */
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
    borderRadius: 8,
    pointerEvents: "none",
    boxShadow: reduceMotion
      ? "0 0 0 2px hsl(262 83% 58% / 0.7)"
      : "0 0 0 4px hsl(262 83% 58% / 0.7), 0 0 30px hsl(262 83% 58% / 0.4)",
    border: "1px solid hsl(262 83% 58% / 0.7)",
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
  // F4 — demo↔tour mutex: if the Live Auto-play demo is mid-flight,
  // `document.body[data-demo-active]` is set by `App.tsx`. We ignore
  // tour.start broadcasts in that case so the Spotlight backdrop can't
  // paint over the demo overlay.
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
  // same id visibly re-mounts the tour at step 0 — the "스팟하이라이트
  // 시퀀스가 2번 노출" symptom. The chain side-effect in App.tsx already
  // carries an idempotency ref; this is defense-in-depth so external
  // callers (⌘+Shift+/ help shortcut, PluginShowcase 둘러보기) also can't
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
      if (
        typeof document !== "undefined" &&
        document.body?.getAttribute("data-demo-active") === "true"
      ) {
        return;
      }
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
      // dismissed the tour early (Esc / backdrop / "건너뛰기").
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
  // the tour "쫓아다닌다" (follow the user) — typing in the composer or
  // pressing ⌘+K advances the tour without the user clicking "다음".
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
          background: "hsl(222.2 84% 7%)",
          color: "hsl(210 40% 98%)",
          border: "1px solid hsl(262 83% 58% / 0.5)",
          borderRadius: 12,
          padding: 20,
          // F5 — under `prefers-reduced-motion: reduce`, drop the soft
          // animated drop-shadow that the mockup uses to "float" the
          // card; a vestibular-sensitive user still sees the card via
          // the violet border + filled backdrop.
          boxShadow: reduceMotion ? "none" : "0 20px 50px -10px rgba(0,0,0,0.6)",
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
            {stepIndex + 1} / {total} {t("spotlightTour.stepUnit")}
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
            {t("spotlightTour.skip")}
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
            {isLast ? t("spotlightTour.complete") : t("spotlightTour.next")}
          </button>
        </div>
      </div>
    </div>
  );
}
