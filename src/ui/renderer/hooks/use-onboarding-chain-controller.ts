import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { getApi } from "../api-client.js";
import {
  initialOnboardingChainState,
  onboardingChainReducer,
  type OnboardingChainEvent,
  type OnboardingChainStage,
} from "../onboarding/onboarding-chain.js";
import { shouldOpenDemoReactivationOnBoot } from "../onboarding/demo-reactivation-gate.js";
import { hasSeenFirstBootTour } from "../onboarding/first-boot-tour-gate.js";
import { LLM_VENDORS } from "../../../shared/llm-vendor-defaults.js";

type Api = ReturnType<typeof getApi>;

export interface UseOnboardingChainControllerResult {
  chainStage: OnboardingChainStage;
  dispatchChain: Dispatch<OnboardingChainEvent>;
  selectedScenarioId: string | null;
  memorySeedNickname: string;
  memorySeedIntroduction: string;
  tourCompleted: boolean;
  /** Probes + persists `hasApiKey`; also returns the concrete boolean. */
  checkApiKey: () => Promise<boolean>;
  /**
   * `hasApiKey` masked by chain progress. Only a concrete boolean once the Z
   * chain has finished AND the boot probe resolved `hasApiKey` — otherwise null
   * so downstream empty-state branches stay in their loading shape (#1014).
   */
  effectiveHasApiKey: boolean | null;
  reactivationOpen: boolean;
  setReactivationOpen: Dispatch<SetStateAction<boolean>>;
}

/**
 * The Z onboarding chain controller, extracted verbatim from App.tsx.
 *
 * Owns the chain reducer, `hasApiKey`, the demo-reactivation flag, and the
 * boot-probe generation counter, plus the four onboarding effects: the first-
 * boot probe (classifies the boot exactly once per generation), the completion
 * + tour-broadcast side-effects (StrictMode-guarded via refs), the logout /
 * reactivate broadcast listeners, and the ⌘/Ctrl+Shift+/ tour shortcut.
 *
 * Only depends on `api`; every transition after the probe is driven by user
 * actions on the chain dialogs (dispatchChain) so the funnel stays deterministic.
 */
export function useOnboardingChainController(api: Api): UseOnboardingChainControllerResult {
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  // Z onboarding chain (2026-05-19) — replaces the previous pair of
  // `onboardingOpen` + `appLoginOpen` flags with an explicit reducer
  // that drives every stage of the first-boot funnel:
  //   idle → showcase → login → welcome → memory → tour → plugins → done
  // The reducer keeps the JSX render branches small (each dialog
  // mounts only when its stage matches) and prevents the race where
  // multiple Radix Dialogs were mounted at once (#982/#990/#997).
  //
  // Initial state is `idle`. The boot probe (below) classifies the
  // boot exactly once and dispatches either `probe-start` → showcase
  // (fresh install, no key, onboarding incomplete) or `probe-skip` →
  // done (returning user). Starting at `idle` instead of `showcase`
  // eliminates the closet-flash race where a true fresh-state boot
  // briefly shows the intro Dialog and then collapses (#1014).
  const [chainState, dispatchChain] = useReducer(
    onboardingChainReducer,
    initialOnboardingChainState,
  );
  const chainStage: OnboardingChainStage = chainState.stage;
  /**
   * ScenarioShowcase carry — which card the user clicked in the first
   * step. Threaded into MemorySeed recommendations and PluginShowcase
   * ordering so the chain is personalised by the user's first choice.
   * `null` means the user reached the chain via skip / returning-user
   * paths and downstream stages should use their default ordering.
   */
  const selectedScenarioId: string | null = chainState.selectedScenarioId;
  // 2026-05-20: PersonalizedWelcome reads its display name + intro
  // straight from the chain's memorySeed context, which `memory-finish`
  // populates from the MemorySeed wizard inputs. No separate state.
  const memorySeedNickname = chainState.memorySeed.nickname;
  const memorySeedIntroduction = chainState.memorySeed.introduction;
  // 2026-05-20 — Settings → "데모 자격증명 재입력" 클릭 시 main window 가
  // LoginModal 을 forceActivation=true 로 mount 하도록 하는 flag.
  // `lvis:auth:reactivate-demo` broadcast 가 도착하면 true 로 flip 되고,
  // LoginModal 이 close 되면 false 로 reset.
  const [reactivationOpen, setReactivationOpen] = useState(false);
  // Z chain — `tourCompleted` gates the PostTourFirstTask proposal. It is
  // true ONLY once the user finished the full funnel (PluginShowcase closed
  // → `done` via `plugins-close`, recorded as completionReason "chain").
  // Two cases that previously leaked the card are now excluded:
  //   - `plugins` stage — PluginShowcase's own Dialog is still open, so a
  //     z-9000 card would overlay it.
  //   - `done` reached via `probe-skip` (returning user / demo relaunch) —
  //     the tour was never shown, so a "post-tour" proposal is wrong.
  const tourCompleted =
    chainStage === "done" && chainState.completionReason === "chain";

  const checkApiKey = useCallback(async () => { const h = await api.hasApiKey(); setHasApiKey(h); return h; }, [api]);

  // Z onboarding chain — first-boot probe.
  //
  // Runs once on mount: when the user already has a vendor key or the
  // onboardingCompleted flag is set, the chain stays at `idle` and
  // resolves directly to `done`. Otherwise the reducer advances to
  // `showcase` which mounts the ScenarioShowcase intro screen. All
  // subsequent transitions are driven by user actions on the in-chain
  // dialogs (NOT by additional IPC probes), so the funnel is fully
  // deterministic and easy to reason about.
  // `bootProbeGen` is the explicit re-run gate. Initial mount fires the
  // probe once at gen=0; the logout broadcast bumps the generation so the
  // same effect re-evaluates `onboardingCompleted` / vendor keys on top of
  // the freshly-cleared state. Without this the original `firstBootProbedRef`
  // boolean gate (now removed) prevented logout from re-entering the
  // ScenarioShowcase.
  const [bootProbeGen, setBootProbeGen] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Populate `hasApiKey` state up-front so the downstream
        // `effectiveHasApiKey` mask can resolve to a concrete boolean
        // the moment the chain advances to `done`. Without this the
        // boot probe only dispatched chain events; `hasApiKey` stayed
        // `null` until the user opened+saved Settings, producing the
        // "로그인된 척" race (#1014 tracer Stage B).
        void checkApiKey();
        const settings = await api.getSettings();
        if (cancelled) return;
        const demoStatus = await api.demo.status().catch(() => null);
        if (cancelled) return;
        if (shouldOpenDemoReactivationOnBoot(settings, demoStatus)) {
          dispatchChain({ type: "probe-skip" });
          setReactivationOpen(true);
          return;
        }
        if (settings.features?.onboardingCompleted === true) {
          dispatchChain({ type: "probe-skip" });
          return;
        }
        // Returning user who already saw the first-boot SpotlightTour — skip
        // the chain even if `onboardingCompleted` was never persisted. That
        // flag only flips at the `done` stage (after PluginShowcase closes,
        // two stages past the tour), so a user who finished the tour but quit
        // before closing PluginShowcase left it `false` and the spotlight
        // re-appeared on every launch. The tour-state store is the source of
        // truth for "has seen the tour"; the boot probe previously ignored it.
        const tourState = await api.tour.getState().catch(() => null);
        if (cancelled) return;
        if (hasSeenFirstBootTour(tourState)) {
          dispatchChain({ type: "probe-skip" });
          return;
        }
        const anyKey = await Promise.all(
          LLM_VENDORS.map((v) => api.hasApiKey(v).catch(() => false)),
        );
        if (cancelled) return;
        if (anyKey.some(Boolean)) {
          // Existing-install flow — skip the whole Z chain so returning
          // users are never prompted to re-seed identity.
          dispatchChain({ type: "probe-skip" });
          return;
        }
        dispatchChain({ type: "probe-start" });
      } catch {
        // Probe failure is non-fatal — chat still works once a key exists.
        dispatchChain({ type: "probe-skip" });
      }
    })();
    return () => { cancelled = true; };
  }, [api, checkApiKey, bootProbeGen]);

  const markOnboardingCompleted = useCallback(async () => {
    try {
      await api.updateSettings({ features: { onboardingCompleted: true } });
    } catch {
      // Persist failure is non-fatal; the dialog still dismisses for the
      // current session even if the disk write fails.
    }
  }, [api]);

  // Z onboarding chain — persist completion + auto-trigger SpotlightTour.
  // Side-effects driven by the reducer state:
  //   - tour stage:    fan the host's tour broadcast so SpotlightTour
  //                    mounts the first-boot scenario without depending
  //                    on MemorySeedDialog firing the trigger itself.
  //   - done stage:    flip `features.onboardingCompleted=true` once so
  //                    the next boot skips the entire chain (idempotent
  //                    via the markOnboardingCompleted helper above).
  //
  // Both side-effects are guarded by a per-run ref so React 18 StrictMode's
  // double-invoked dev-mode effects (mount → cleanup → mount) cannot
  // broadcast `tour.start` twice — without the guard the second mount
  // re-fires the IPC, which re-enters the SpotlightTour subscriber and
  // visibly resets the scenario to step 0 ("스팟하이라이트 시퀀스가 2번 노출"
  // — user report 2026-05-19). The ref also protects against incidental
  // re-renders that change `api` / `markOnboardingCompleted` while
  // `chainStage === "tour"` stays pinned.
  const chainCompletionPersistedRef = useRef(false);
  const chainTourBroadcastRef = useRef(false);
  useEffect(() => {
    if (chainStage === "tour") {
      if (chainTourBroadcastRef.current) return;
      chainTourBroadcastRef.current = true;
      try {
        void api.tour.start("first-boot-essentials");
      } catch {
        // tour.start failure is non-fatal — user can still reach the
        // PluginShowcase via the SpotlightTour onComplete callback path
        // by pressing 다음 from within the tour.
      }
      return;
    }
    if (chainStage === "done" && !chainCompletionPersistedRef.current) {
      chainCompletionPersistedRef.current = true;
      void markOnboardingCompleted();
    }
  }, [api, chainStage, markOnboardingCompleted]);

  // 2026-05-20 — Settings 의 로그아웃 / 데모 자격증명 재입력 broadcast 수신.
  //
  // 로그아웃 cue:
  //   1. chain reducer 에 `logout-reset` dispatch → 모든 stage 가 `idle` 로 collapse
  //   2. boot-probe ref 를 리셋해 onboardingCompleted=false 가 다시 평가됨
  //   3. side-effect ref (`chainTourBroadcastRef`, `chainCompletionPersistedRef`)
  //      도 reset 해서 재진입 chain 의 tour broadcast / completion persist 가
  //      한 번씩 다시 동작 가능하게 됨
  //   4. `hasApiKey` 를 다시 평가
  //
  // 재입력 cue:
  //   LoginModal 을 `forceActivation=true` 로 mount.
  useEffect(() => {
    // 일부 test fixture 가 `api.auth` 의 broadcast 메서드를 mock 하지 않으므로
    // optional chaining 으로 graceful degradation. production preload 는 항상
    // 두 메서드를 정의하고, undefined 일 때는 listener 만 비활성 (전체 effect 가
    // throw 하지 않는다).
    const unsubLogout = api.auth?.onLogoutReset?.(() => {
      dispatchChain({ type: "logout-reset" });
      chainTourBroadcastRef.current = false;
      chainCompletionPersistedRef.current = false;
      // Bump the boot-probe generation so the existing probe effect re-runs
      // against the now-cleared settings (`onboardingCompleted=false`) and
      // wipes-clear vendor keys. Without this the chain would stay at `idle`
      // forever because `dispatchChain({logout-reset})` collapses to idle
      // but no follow-up `probe-start` ever fires.
      setBootProbeGen((g) => g + 1);
      void checkApiKey();
    });
    const unsubReactivate = api.auth?.onReactivateDemo?.(() => {
      setReactivationOpen(true);
    });
    return () => {
      unsubLogout?.();
      unsubReactivate?.();
    };
  }, [api, checkApiKey]);

  // Tutorial-C SpotlightTour trigger (PR #983 follow-up). ⌘+Shift+/ ("⌘?")
  // is the canonical "help" shortcut on macOS; on Windows/Linux Ctrl+Shift+/
  // serves the same role. The handler fires `api.tour.start` which fans the
  // `lvis:tour:start` IPC broadcast out to every open window — including
  // detached panes — so the SpotlightTour component (always mounted in
  // App.tsx) flips on. Guarded against open dialogs so the shortcut never
  // races a modal interaction.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "?" && e.key !== "/") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (!e.shiftKey) return;
      if (e.isComposing) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        return;
      }
      e.preventDefault();
      void api.tour.start("first-boot-essentials");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [api]);

  // Mask `hasApiKey === false` while the onboarding chain is still in
  // progress so the "Claude API 키 설정 필요" empty state never paints
  // underneath the Z chain dialogs. The chain itself is the canonical
  // first-boot CTA; surfacing a competing empty state below it leaks
  // through the Radix Dialog backdrop and confuses the user (the bug
  // this fix resolves). Returning users with `chainStage === "done"`
  // (probe-skip or chain completion) still see the empty state when
  // they remove their key from Settings, so the safety-net behaviour
  // for that path is preserved.
  // Tracer Stage B race fix (#1014): only surface the boolean when BOTH
  // (a) the Z chain has finished AND (b) the boot probe has resolved
  // `hasApiKey` to a concrete boolean. Any other state — chain still
  // running, or probe still pending — returns `null` so downstream
  // empty-state branches stay in their loading shape. This prevents the
  // "로그인된 척" race where chain advanced to `done` but `hasApiKey`
  // hadn't been populated yet, letting `hasApiKey !== false` falsely
  // paint the ready-state empty prompt.
  const effectiveHasApiKey: boolean | null =
    chainStage === "done" && hasApiKey !== null ? hasApiKey : null;

  return {
    chainStage,
    dispatchChain,
    selectedScenarioId,
    memorySeedNickname,
    memorySeedIntroduction,
    tourCompleted,
    checkApiKey,
    effectiveHasApiKey,
    reactivationOpen,
    setReactivationOpen,
  };
}
