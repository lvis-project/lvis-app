/**
 * Z onboarding chain — state machine (pure, deterministic).
 *
 * Models the first-boot funnel as an explicit finite-state machine so
 * the App.tsx wiring is just a single `useReducer` plus side-effect
 * effects. Pure because the unit test pins every transition without
 * mounting React.
 *
 * Stages (2026-05-20 redesign — `welcome` stage removed; MemorySeed
 * now precedes a personalized welcome card that reads the seeded
 * 호칭/자기소개):
 *   idle                — initial state. The async boot probe in App.tsx
 *                         fires exactly one of `probe-start` → showcase
 *                         (fresh boot) or `probe-skip` → done (returning
 *                         user). Starting at `idle` means the showcase
 *                         Dialog only mounts after the probe classifies
 *                         the boot, so a stale `probe-skip` arriving late
 *                         can never collapse a freshly-shown showcase.
 *   showcase            — ScenarioShowcase mounted (intro preview cards).
 *   login               — LoginModal mounted (waiting for vendor key / skip).
 *   memory              — MemorySeedDialog mounted (호칭 + 자기소개).
 *                         Now FIRST after login so the personalized
 *                         welcome card downstream can address the user
 *                         by their chosen 호칭.
 *   personalized_welcome — PersonalizedWelcome card mounted. Greets the
 *                         user by the 호칭 they just typed and confirms
 *                         the next phase (tour).
 *   tour                — SpotlightTour active (8-step first-boot scenario).
 *   plugins             — PluginShowcase mounted (per-plugin descriptions).
 *   done                — chain complete; chat empty-state visible.
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
 *   `memorySeed` carries the 호칭 + 자기소개 the user typed into the
 *   MemorySeedDialog so the downstream `personalized_welcome` stage
 *   can address the user by name without re-reading the DOM.
 *
 * Events:
 *   probe-skip                  — boot probe found an existing key (skip whole chain).
 *   probe-start                 — boot probe says first-boot; mount Showcase.
 *   showcase-start              — user pressed "로그인하에 LVIS 시작하기" inside
 *                                 the showcase. Carries the picked `scenarioId`
 *                                 so the chain context records the selection.
 *   login-success               — LoginModal onSuccess fired.
 *   login-skip                  — LoginModal closed without success.
 *   memory-finish               — MemorySeed onDismissed fired (success or skip).
 *                                 Optionally carries the typed 호칭 / 자기소개
 *                                 so the personalized welcome card can read it.
 *   personalized-welcome-accept — user pressed "예, 시작할게요 →" in the
 *                                 PersonalizedWelcome card.
 *   tour-finish                 — SpotlightTour completed all steps.
 *   tour-skip                   — SpotlightTour dismissed early.
 *   plugins-close               — PluginShowcase closed (or skipped).
 *
 * `showcase-skip` was removed 2026-05-20 — the showcase no longer offers a
 * skip path; the user MUST pick one of the 4 cards before advancing.
 *
 * The reducer never returns to a prior stage — strict forward
 * progress — so a stale onSuccess event from a re-mounted LoginModal
 * cannot reanimate the chain.
 */

export type OnboardingChainStage =
  | "idle"
  | "showcase"
  | "login"
  | "memory"
  | "personalized_welcome"
  | "tour"
  | "plugins"
  | "done";

/**
 * MemorySeed inputs threaded forward into the PersonalizedWelcome card.
 * Both fields default to the empty string so the welcome card always
 * renders even when the user skipped or partially filled the wizard.
 */
export interface OnboardingMemorySeed {
  nickname: string;
  introduction: string;
}

/**
 * Chain state — wraps the FSM stage with carry-along context so the
 * reducer remains a pure `(state, event) => state` function while still
 * threading the picked scenario + memory seed through every downstream
 * stage.
 */
export interface OnboardingChainState {
  stage: OnboardingChainStage;
  /**
   * Scenario id (ScenarioShowcase card) the user chose to start with.
   * Read by downstream stages to personalise recommendations + tour.
   * `null` when no card was picked (skip path or returning user).
   */
  selectedScenarioId: string | null;
  /**
   * 호칭 + 자기소개 captured by the MemorySeed wizard. Threaded into
   * the PersonalizedWelcome card so it can address the user by name.
   */
  memorySeed: OnboardingMemorySeed;
}

export const initialOnboardingChainState: OnboardingChainState = {
  stage: "idle",
  selectedScenarioId: null,
  memorySeed: { nickname: "", introduction: "" },
};

export type OnboardingChainEvent =
  | { type: "probe-skip" }
  | { type: "probe-start" }
  | { type: "showcase-start"; scenarioId?: string | null }
  | { type: "login-success" }
  | { type: "login-skip" }
  | {
      type: "memory-finish";
      nickname?: string;
      introduction?: string;
    }
  | { type: "personalized-welcome-accept" }
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
      if (event.type === "login-success") return "memory";
      if (event.type === "login-skip") return "memory";
      return stage;

    case "memory":
      if (event.type === "memory-finish") return "personalized_welcome";
      return stage;

    case "personalized_welcome":
      if (event.type === "personalized-welcome-accept") return "tour";
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
 * Threads `selectedScenarioId` + `memorySeed` through the chain so
 * downstream stages (MemorySeed recommendations, PluginShowcase
 * ordering, PersonalizedWelcome greeting) can read what the user
 * selected / typed earlier in the flow.
 */
export function onboardingChainReducer(
  state: OnboardingChainState,
  event: OnboardingChainEvent,
): OnboardingChainState {
  const stage = nextOnboardingStage(state.stage, event);
  let selectedScenarioId = state.selectedScenarioId;
  let memorySeed = state.memorySeed;
  if (event.type === "showcase-start") {
    if (typeof event.scenarioId === "string" && event.scenarioId.length > 0) {
      selectedScenarioId = event.scenarioId;
    }
  }
  if (event.type === "memory-finish") {
    const nickname =
      typeof event.nickname === "string" ? event.nickname.trim() : "";
    const introduction =
      typeof event.introduction === "string" ? event.introduction.trim() : "";
    memorySeed = {
      nickname: nickname.length > 0 ? nickname : memorySeed.nickname,
      introduction:
        introduction.length > 0 ? introduction : memorySeed.introduction,
    };
  }
  return { stage, selectedScenarioId, memorySeed };
}

/**
 * Convenience predicate set — keeps App.tsx JSX free of
 * `state.stage === "..."` litter and makes intent obvious at the call
 * site.
 */
export const onboardingChainHelpers = {
  isShowcase: (s: OnboardingChainStage) => s === "showcase",
  isLogin: (s: OnboardingChainStage) => s === "login",
  isMemory: (s: OnboardingChainStage) => s === "memory",
  isPersonalizedWelcome: (s: OnboardingChainStage) =>
    s === "personalized_welcome",
  isTour: (s: OnboardingChainStage) => s === "tour",
  isPlugins: (s: OnboardingChainStage) => s === "plugins",
  isDone: (s: OnboardingChainStage) => s === "done",
} as const;
