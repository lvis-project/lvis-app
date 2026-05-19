/**
 * Z onboarding chain — state machine (pure, deterministic).
 *
 * Models the first-boot funnel as an explicit finite-state machine so
 * the App.tsx wiring is just a single `useReducer` plus side-effect
 * effects. Pure because the unit test pins every transition without
 * mounting React.
 *
 * Stages:
 *   idle      — initial state. The async boot probe in App.tsx fires
 *               exactly one of `probe-start` → showcase (fresh boot) or
 *               `probe-skip` → done (returning user). Starting at `idle`
 *               means the showcase Dialog only mounts after the probe
 *               classifies the boot, so a stale `probe-skip` arriving late
 *               can never collapse a freshly-shown showcase.
 *   showcase  — ScenarioShowcase mounted (intro preview cards).
 *   login     — LoginModal mounted (waiting for vendor key / skip).
 *   welcome   — WelcomeQuestion mounted ("시작해볼까요?" card).
 *   memory    — MemorySeedDialog mounted (호칭 + 자기소개).
 *   tour      — SpotlightTour active (7-step first-boot scenario).
 *   plugins   — PluginShowcase mounted (per-plugin descriptions).
 *   done      — chain complete; chat empty-state visible.
 *
 * Chain context (Option A — 2026-05-19):
 *   `selectedScenarioId` carries the ScenarioShowcase card the user
 *   chose to "start with" (e.g. "meeting" / "docs" / "work" /
 *   "multi-agent"). Downstream stages (MemorySeed recommendations,
 *   PluginShowcase ordering, intro placeholder) read it via the
 *   exposed state so the chain is personalised by the user's first
 *   click. `null` means the user skipped the showcase or no card was
 *   clicked.
 *
 * Events:
 *   probe-skip            — boot probe found an existing key (skip whole chain).
 *   probe-start           — boot probe says first-boot; mount Showcase.
 *   showcase-start        — user pressed "이 시나리오로 시작 →" inside the
 *                           showcase. Carries the picked `scenarioId` so
 *                           the chain context records the selection.
 *   showcase-skip         — user pressed "건너뛰기" in Showcase.
 *   login-success         — LoginModal onSuccess fired.
 *   login-skip            — LoginModal closed without success.
 *   welcome-accept        — user pressed "예, 시작할게요".
 *   welcome-skip          — user pressed "나중에 (skip)".
 *   memory-finish         — MemorySeed onDismissed fired (success or skip).
 *   tour-finish           — SpotlightTour completed all steps.
 *   tour-skip             — SpotlightTour dismissed early.
 *   plugins-close         — PluginShowcase closed (or skipped).
 *
 * Skipping at any stage advances to `done` so the user never gets
 * trapped. The reducer never returns to a prior stage — strict forward
 * progress — so a stale onSuccess event from a re-mounted LoginModal
 * cannot reanimate the chain.
 */

export type OnboardingChainStage =
  | "idle"
  | "showcase"
  | "login"
  | "welcome"
  | "memory"
  | "tour"
  | "plugins"
  | "done";

/**
 * Chain state — wraps the FSM stage with carry-along context so the
 * reducer remains a pure `(state, event) => state` function while still
 * threading the picked scenario through every downstream stage.
 */
export interface OnboardingChainState {
  stage: OnboardingChainStage;
  /**
   * Scenario id (ScenarioShowcase card) the user chose to start with.
   * Read by downstream stages to personalise recommendations + tour.
   * `null` when no card was picked (skip path or returning user).
   */
  selectedScenarioId: string | null;
}

export const initialOnboardingChainState: OnboardingChainState = {
  stage: "idle",
  selectedScenarioId: null,
};

export type OnboardingChainEvent =
  | { type: "probe-skip" }
  | { type: "probe-start" }
  | { type: "showcase-start"; scenarioId?: string | null }
  | { type: "showcase-skip" }
  | { type: "login-success" }
  | { type: "login-skip" }
  | { type: "welcome-accept" }
  | { type: "welcome-skip" }
  | { type: "memory-finish" }
  | { type: "tour-finish" }
  | { type: "tour-skip" }
  | { type: "plugins-close" }
  /**
   * Emergency / external "collapse the rest of the chain to done"
   * event. Used when the Live Auto-play demo takes over the screen
   * mid-chain, or when any other surface decides the chain should
   * unconditionally finish. Unlike the per-stage skip events this is
   * always honored regardless of current stage.
   */
  | { type: "force-finish" };

/**
 * Pure stage transition. Unknown / out-of-order events are no-ops —
 * the stage stays at its current value. This protects against
 * duplicate IPC events (e.g. MemorySeed firing both onDismissed and a
 * delayed onSuccess) and keeps the funnel deterministic.
 *
 * Exported so the unit test can pin every transition without
 * constructing a chain state record.
 */
export function nextOnboardingStage(
  stage: OnboardingChainStage,
  event: OnboardingChainEvent,
): OnboardingChainStage {
  if (event.type === "force-finish") return "done";
  switch (stage) {
    case "idle":
      if (event.type === "probe-skip") return "done";
      if (event.type === "probe-start") return "showcase";
      return stage;

    case "showcase":
      if (event.type === "showcase-start") return "login";
      if (event.type === "showcase-skip") return "done";
      // `probe-skip` is intentionally NOT accepted from `showcase`.
      // Initial stage is `idle`; the async boot probe explicitly
      // dispatches either `probe-start` (mount showcase) or
      // `probe-skip` (skip to done) from `idle`, so an in-flight probe
      // can never collapse a freshly-mounted showcase. This eliminates
      // the closet-flash race where a stale probe-skip arriving after
      // showcase mount would dismiss the intro for genuinely
      // fresh-state users (#1014).
      return stage;

    case "login":
      if (event.type === "login-success") return "welcome";
      if (event.type === "login-skip") return "welcome";
      return stage;

    case "welcome":
      if (event.type === "welcome-accept") return "memory";
      if (event.type === "welcome-skip") return "done";
      return stage;

    case "memory":
      if (event.type === "memory-finish") return "tour";
      return stage;

    case "tour":
      if (event.type === "tour-finish") return "plugins";
      if (event.type === "tour-skip") return "plugins";
      return stage;

    case "plugins":
      if (event.type === "plugins-close") return "done";
      return stage;

    case "done":
      return stage;
  }
}

/**
 * Pure reducer for the Z onboarding chain.
 *
 * Threads `selectedScenarioId` through the chain so downstream stages
 * (MemorySeed recommendations, PluginShowcase ordering, etc.) can read
 * what the user clicked in the ScenarioShowcase.
 */
export function onboardingChainReducer(
  state: OnboardingChainState,
  event: OnboardingChainEvent,
): OnboardingChainState {
  const stage = nextOnboardingStage(state.stage, event);
  let selectedScenarioId = state.selectedScenarioId;
  if (event.type === "showcase-start") {
    if (typeof event.scenarioId === "string" && event.scenarioId.length > 0) {
      selectedScenarioId = event.scenarioId;
    }
  }
  return { stage, selectedScenarioId };
}

/**
 * Convenience predicate set — keeps App.tsx JSX free of
 * `state.stage === "..."` litter and makes intent obvious at the call
 * site.
 */
export const onboardingChainHelpers = {
  isShowcase: (s: OnboardingChainStage) => s === "showcase",
  isLogin: (s: OnboardingChainStage) => s === "login",
  isWelcome: (s: OnboardingChainStage) => s === "welcome",
  isMemory: (s: OnboardingChainStage) => s === "memory",
  isTour: (s: OnboardingChainStage) => s === "tour",
  isPlugins: (s: OnboardingChainStage) => s === "plugins",
  isDone: (s: OnboardingChainStage) => s === "done",
} as const;
