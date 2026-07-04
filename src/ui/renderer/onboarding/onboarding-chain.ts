




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
/**
 * How the chain arrived at the `done` stage. `done` is reached two ways
 * (see {@link nextOnboardingStage}): `plugins-close` after the user walked
 * the full funnel (including the SpotlightTour), or `probe-skip` when the
 * boot probe sent a returning user / demo-relaunched session straight to
 * `done` without ever showing the tour. Downstream UI that should only
 * appear *after a real tour* (e.g. the post-tour first-task proposal) must
 * distinguish the two — `stage === "done"` alone cannot. Absent
 * (`undefined`) until the chain reaches `done`.
 */
export type OnboardingCompletionReason = "chain" | "probe-skip";

export interface OnboardingChainState {
  stage: OnboardingChainStage;
  /**
   * Scenario id (ScenarioShowcase card) the user chose to start with.
   * Read by downstream stages to personalise recommendations + tour.
   * `null` when no card was picked (direct-login CTA or returning user).
   */
  selectedScenarioId: string | null;



  memorySeed: OnboardingMemorySeed;
  /**
   * Why the chain reached `done` — `"chain"` (full funnel incl. tour) vs
   * `"probe-skip"` (returning user / demo relaunch, tour never shown).
   * Absent while still in progress; cleared on `logout-reset`.
   */
  completionReason?: OnboardingCompletionReason;
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



  | { type: "logout-reset" };

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
  if (event.type === "logout-reset") return "idle";
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


  if (event.type === "logout-reset") {
    return {
      stage,
      selectedScenarioId: null,
      memorySeed: { nickname: "", introduction: "" },
    };
  }
  let selectedScenarioId = state.selectedScenarioId;
  let memorySeed = state.memorySeed;
  // Record *why* we reached `done`, ONLY on the actual transition into
  // `done` from a non-`done` stage. Guarding on the transition (not just
  // `stage === "done"`) prevents a late / duplicate `probe-skip` arriving
  // while already in `done` from overwriting a correct `"chain"` reason —
  // which would wrongly hide the post-tour UI for users who finished the
  // full funnel. `plugins-close` = full funnel (tour shown); `probe-skip`
  // = returning user / demo relaunch (tour never shown).
  let completionReason = state.completionReason;
  if (stage === "done" && state.stage !== "done") {
    if (event.type === "plugins-close") completionReason = "chain";
    else if (event.type === "probe-skip") completionReason = "probe-skip";
  }
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
  // Only attach `completionReason` once it has a concrete value. Spreading
  // `{ completionReason: undefined }` for in-progress stages would change the
  // runtime object shape — `toEqual({...})` assertions and `"completionReason"
  // in state` checks treat a present-but-undefined key differently from an
  // absent one — so the key stays absent until the transition into `done`.
  return {
    stage,
    selectedScenarioId,
    memorySeed,
    ...(completionReason !== undefined ? { completionReason } : {}),
  };
}
