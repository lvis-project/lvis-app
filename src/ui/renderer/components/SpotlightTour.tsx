


import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import {
  DEFAULT_TOUR_SCENARIOS,
  getTourScenario,
  type CompletionTrigger,
  type TourScenario,
  type TourStep,
} from "../onboarding/default-tour-scenarios.js";
import { BLOCKING_SURFACE_SELECTOR, TEST_IDS } from "../../../shared/test-ids.js";
import { usePrefersReducedMotion } from "../hooks/use-prefers-reduced-motion.js";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "../../../components/ui/popover.js";

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
   * Fired right after the user reaches the last step of a scenario and the
   * tour closes (NOT on early-dismissal). The host opens its plugin-onboarding
   * proposal gate on this, so the user is offered a real first plugin task
   * instead of a dead-end UX transition.
   */
  onComplete?: (scenarioId: string) => void;



  onDismiss?: (scenarioId: string) => void;
}

/**
 * The mark a step puts on the element it is about. It is the semantic record
 * of which node the step targets — read by tests and by anything asking what
 * the tour is pointing at. It draws nothing: the ring is a portaled layer of
 * its own (see `.lvis-tour-ring` in `styles.css` for why it cannot live on
 * the element).
 */
const TOUR_HIGHLIGHT_ATTR = "data-tour-highlight";

/**
 * How far outside the anchor's own box the ring is drawn. The ring is its own
 * layer, so without this gap it would trace the anchor's edge exactly and read
 * as a border on the control rather than a highlight around it.
 */
const RING_INSET_PX = 3;

/**
 * The element a step's selector means.
 *
 * `data-tour-anchor` is per-surface chrome and the main area holds up to four
 * tiles, so a step selector matches once per open tile — and document order is
 * not screen order, so `querySelector`'s first hit can be a tile the user
 * cannot see. The step is about the one that is on screen.
 *
 * A zero-area rect is the test that carries the weight: it covers
 * `display: none`, a collapsed container, and a detached node alike.
 * `visibility: hidden` keeps its box, so it needs asking about separately.
 * `offsetParent` is deliberately not consulted — it is null for every
 * `position: fixed` element, which would misread the window-level chrome some
 * steps point at as hidden.
 */
function firstVisibleMatch(selector: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (typeof window !== "undefined") {
      if (window.getComputedStyle(el).visibility === "hidden") continue;
    }
    return el;
  }
  return null;
}

/**
 * U6 — Detect whether another modal Dialog / AlertDialog is currently
 * mounted. If true, the SpotlightTour must NOT paint its backdrop on
 * top because the user would see the violet ring float above a still-
 * visible Radix Dialog (the bug from the 2026-05-19 screenshot).
 */
function anyBlockingSurfaceOpen(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector(
      BLOCKING_SURFACE_SELECTOR,
    ),
  );
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
      if (anyBlockingSurfaceOpen()) {
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
  //
  // It also carries the anchor's liveness: the ring and the card are portaled
  // layers positioned against the anchor node, so a node that leaves the DOM
  // would leave both painting where nothing is any more. Bumping the epoch
  // re-runs the resolution effect below, which re-anchors to whatever the
  // selector means now — the replacement node after a re-render, or nothing,
  // in which case the card falls back to centring itself.
  const anchorElRef = useRef<HTMLElement | null>(null);
  const [anchorEpoch, setAnchorEpoch] = useState(0);
  useEffect(() => {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") {
      return;
    }
    const observer = new MutationObserver(() => {
      const anchored = anchorElRef.current;
      if (anchored && !anchored.isConnected) {
        anchorElRef.current = null;
        setAnchorEpoch((n) => n + 1);
      }
      if (pendingScenarioRef.current && !anyBlockingSurfaceOpen()) {
        const next = pendingScenarioRef.current;
        pendingScenarioRef.current = null;
        // Same-scenario guard — see the onStart subscriber comment above.
        if (activeScenarioIdRef.current === next) return;
        setActiveScenarioId(next);
      }
    });
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["data-state"],
    });
    return () => observer.disconnect();
  }, []);

  // Resolve the element this step is about, and mark it. Everything visual
  // then hangs off that element: both the ring and the card are Radix popovers
  // anchored to it. Because the anchor is a live node rather than a copied
  // rect, an in-app layout shift — a notice strip opening, the composer
  // growing, a list re-rendering — moves the ring and the card with it, with
  // nothing to re-measure.
  //
  // The cleanup unmarks the node this effect actually marked rather than
  // whatever the selector resolves to later, so a step that swaps the target
  // cannot leave the previous element ringed. A node that leaves the DOM
  // mid-step takes its own mark with it.
  const anchorSelector = currentStep?.anchorSelector ?? null;
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    const el = anchorSelector ? firstVisibleMatch(anchorSelector) : null;
    anchorElRef.current = el;
    setAnchorEl(el);
    if (!el) return;
    el.setAttribute(TOUR_HIGHLIGHT_ATTR, "true");
    return () => el.removeAttribute(TOUR_HIGHLIGHT_ATTR);
  }, [anchorSelector, stepIndex, scenario, anchorEpoch]);

  // The ring is drawn on a layer of its own, so it needs the anchor's size —
  // and only its size. Where the layer goes stays the popper's job against the
  // live node, so nothing here holds a coordinate that could go stale; a
  // control that grows (the composer gaining a line) re-sizes the ring through
  // the observer while the popper re-places it.
  const [anchorSize, setAnchorSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    if (!anchorEl) {
      setAnchorSize(null);
      return;
    }
    const measure = () => {
      const rect = anchorEl.getBoundingClientRect();
      setAnchorSize((prev) =>
        prev && prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const ResizeObserverCtor =
      typeof window === "undefined" ? undefined : window.ResizeObserver;
    if (typeof ResizeObserverCtor !== "function") return;
    const observer = new ResizeObserverCtor(measure);
    observer.observe(anchorEl);
    return () => observer.disconnect();
  }, [anchorEl]);

  const closeAfterCompletion = useCallback(
    (id: string) => {
      const markComplete = api?.tour?.markComplete;
      if (typeof markComplete === "function") {
        void markComplete(id).catch(() => {
          /* persist failure is non-fatal — the tour still closes */
        });
      }
      setActiveScenarioId(null);
      // Notify the host the scenario completed so the onboarding proposal
      // gate can open. Wrapped in try/catch
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
      // Z onboarding chain — notify the host so dismissing the tour
      // can still complete the first-run flow.

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
      // Same resolver as the anchor: a trigger selector and an anchor selector
      // name the same control, so two resolvers disagreeing about which tile
      // it lives in would ring one composer and wait on another.
      const selector = triggerForStep.selector;
      const target = firstVisibleMatch(selector);
      if (!target) return;
      const onInput = () => handleNext();
      target.addEventListener("input", onInput);
      cleanup = () => target.removeEventListener("input", onInput);
    } else if (triggerForStep.kind === "click") {
      const selector = triggerForStep.selector;
      const target = firstVisibleMatch(selector);
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

  const titleId = `lvis-tour-title-${scenario.id}-${stepIndex}`;
  const bodyId = `lvis-tour-body-${scenario.id}-${stepIndex}`;

  const cardChrome: React.CSSProperties = {
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
  };

  const cardAria = {
    role: "dialog" as const,
    "aria-modal": true,
    "aria-labelledby": titleId,
    "aria-describedby": bodyId,
    "data-testid": TEST_IDS.spotlightTourCard,
    "data-step-index": stepIndex,
  };

  const cardBody = (
    <>
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
        className="mt-1.5 min-h-0 overflow-y-auto text-[12px] leading-relaxed"
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
    </>
  );

  return (
    <div
      data-testid="spotlight-tour"
      data-scenario-id={scenario.id}
      data-reduce-motion={reduceMotion ? "true" : "false"}
    >
      {/* Backdrop — clicking it dismisses the tour. The dimmed layer matches
          the mockup; the ring and the card are portaled onto the body, above
          this band, so the anchor reads at full strength through it.

          The layers sit in the shared `z-50` floating band, ordered by
          mount order like every other overlay there: the tour mounts after the
          whole shell, so it covers the shell, and a dialog portal that opens
          during the tour mounts after the tour and stays reachable above it. */}
      <div
        data-testid="spotlight-tour:backdrop"
        onClick={() => closeAfterDismissal(scenario.id)}
        className="z-50"
        style={{
          position: "fixed",
          inset: 0,
          // Matches the shared Dialog overlay ladder (bundle --overlay tone).
          background: "hsl(var(--overlay) / var(--opacity-emphatic))",
        }}
      />
      {anchorEl && anchorSize ? (
        /* The ring. It is its own portaled layer rather than a box-shadow on
           the anchor because the anchor cannot carry one: every ancestor from
           the composer's input bar out to the route canvas is `overflow:
           hidden`, which clips a shadow drawn outside the border box, and the
           route canvas is `isolation: isolate`, which traps any z-index put on
           the anchor below this tour's own backdrop.

           Placed by the same popper as the card, against the same live node,
           so it tracks the anchor without anything re-measuring coordinates —
           only the anchor's size crosses over, and a ResizeObserver keeps that
           fresh. `side="bottom"` with a negative side offset lands the layer's
           top edge on the anchor's, `align="start"` its left edge, and
           collisions stay off so nothing nudges the ring off its target. */
        <Popover open>
          <PopoverAnchor virtualRef={{ current: anchorEl }} />
          <PopoverContent
            data-testid="spotlight-tour:ring"
            // Decorative: it is the mark made visible, and the marked element
            // is already in the accessibility tree in its own right. `dialog`
            // is what Radix would give it, which would put a phantom blocking
            // surface on screen for the whole tour.
            role="presentation"
            aria-hidden
            key={`ring-${scenario.id}-${stepIndex}`}
            className="lvis-tour-ring w-auto border-0 bg-transparent p-0"
            side="bottom"
            align="start"
            avoidCollisions={false}
            sideOffset={-(anchorSize.height + RING_INSET_PX)}
            alignOffset={-RING_INSET_PX}
            style={{
              width: anchorSize.width + RING_INSET_PX * 2,
              height: anchorSize.height + RING_INSET_PX * 2,
            }}
            // A decorative layer takes no focus and dismisses nothing: Escape
            // and outside clicks belong to the tour's own handlers and to the
            // backdrop, so this layer declines all four rather than competing
            // for them.
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onEscapeKeyDown={(e) => e.preventDefault()}
            onPointerDownOutside={(e) => e.preventDefault()}
            onFocusOutside={(e) => e.preventDefault()}
            onInteractOutside={(e) => e.preventDefault()}
          />
        </Popover>
      ) : null}
      {anchorEl ? (
        <Popover open>
          {/* The anchor is the live element, handed to Radix as a measurable.
              Radix owns side flipping and collision padding from here, so a
              step whose translated copy makes the card taller than the room
              below the anchor flips above it instead of covering it. */}
          <PopoverAnchor virtualRef={{ current: anchorEl }} />
          <PopoverContent
            {...cardAria}
            // Y2 — slide-up + fade entrance keyframe smooths the hand-off
            // into the SpotlightTour so the
            // tour card doesn't pop into place. The shared `lvis-anim-slide-up`
            // utility collapses to opacity-only fade under
            // prefers-reduced-motion (styles.css §290).
            className="lvis-anim-slide-up w-auto max-w-[480px]"
            // Step transitions inside the same scenario also benefit from a
            // light re-mount fade — keying the card on the step index gives
            // React a unique key so the animation re-runs on advance.
            key={`${scenario.id}-${stepIndex}`}
            side="bottom"
            align="center"
            sideOffset={12}
            collisionPadding={16}
            // The tour drives its own focus story: a step may ask the user to
            // type into the anchor, so the card must neither take focus when
            // it mounts nor throw focus somewhere on step change.
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            style={{
              ...cardChrome,
              // Copy long enough to outgrow the room beside the anchor scrolls
              // inside the body instead of running the card off the window
              // edge and taking Skip / Next with it. Radix publishes the room
              // it had to place the card in; the column keeps the step counter
              // and the footer pinned while only the body gives way.
              display: "flex",
              flexDirection: "column",
              maxHeight: "var(--radix-popover-content-available-height)",
              overflow: "hidden",
            }}
          >
            {cardBody}
          </PopoverContent>
        </Popover>
      ) : (
        // No anchor — the selector matched nothing, or the element it names is
        // not rendered in this build. The card centres itself so the narrative
        // stays legible and the tour is never stuck.
        <div
          {...cardAria}
          className="lvis-anim-slide-up z-50"
          key={`${scenario.id}-${stepIndex}`}
          style={{
            position: "fixed",
            left: 24,
            right: 24,
            bottom:
              typeof window === "undefined"
                ? 24
                : Math.max(24, Math.floor(window.innerHeight * 0.18)),
            maxWidth: 480,
            marginLeft: "auto",
            marginRight: "auto",
            ...cardChrome,
          }}
        >
          {cardBody}
        </div>
      )}
    </div>
  );
}
