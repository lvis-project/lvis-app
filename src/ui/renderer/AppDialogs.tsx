import type { Dispatch } from "react";
import type { getApi } from "./api-client.js";
import { ApprovalDialog } from "./dialogs/ApprovalDialog.js";
import { DeferredQueueDialog } from "./dialogs/DeferredQueueDialog.js";
import { MemorySeedDialog } from "./dialogs/MemorySeedDialog.js";
import { SpotlightTour } from "./components/SpotlightTour.js";
import { PostTourFirstTask } from "./onboarding/PostTourFirstTask.js";
import { ScenarioShowcase } from "./onboarding/ScenarioShowcase.js";
import { PersonalizedWelcome } from "./onboarding/PersonalizedWelcome.js";
import { PluginShowcase } from "./onboarding/PluginShowcase.js";
import type {
  OnboardingChainEvent,
  OnboardingChainStage,
} from "./onboarding/onboarding-chain.js";
import { LoginModal } from "./components/LoginModal.js";
import { DevConsoleToggle } from "./components/DevConsoleToggle.js";
import { SnapEdgeHighlight } from "./components/SnapEdgeHighlight.js";

type Api = ReturnType<typeof getApi>;

/**
 * AppDialogs — the App-level modal/overlay cluster.
 *
 * Behavior-preserving extraction of App.tsx's dialog tail: the deferred
 * approval queue + approval dialog, the Z onboarding chain (staged so exactly
 * one chain dialog mounts at a time), the always-mounted SpotlightTour /
 * PostTourFirstTask, the demo-reactivation LoginModal, and the DevConsoleToggle
 * / SnapEdgeHighlight singletons. All state lives in App; this component is a
 * pure function of props (the chain reducer's dispatch is threaded through).
 */
export function AppDialogs({
  api,
  deferredQueueOpen,
  onDeferredQueueOpenChange,
  approvalQueue,
  onApprovalDecide,
  chainStage,
  dispatchChain,
  selectedScenarioId,
  memorySeedNickname,
  memorySeedIntroduction,
  tourCompleted,
  checkApiKey,
  reactivationOpen,
  onReactivationOpenChange,
  firstRunPluginSummary,
  marketplaceUrlReady,
  bootstrapStatus,
  onRetryBootstrap,
  installedPluginIds,
  onComposerSeedText,
}: {
  api: Api;
  deferredQueueOpen: boolean;
  onDeferredQueueOpenChange: (open: boolean) => void;
  approvalQueue: Parameters<typeof ApprovalDialog>[0]["queue"];
  onApprovalDecide: Parameters<typeof ApprovalDialog>[0]["onDecide"];
  chainStage: OnboardingChainStage;
  dispatchChain: Dispatch<OnboardingChainEvent>;
  selectedScenarioId: string | null;
  memorySeedNickname: string;
  memorySeedIntroduction: string;
  tourCompleted: boolean;
  checkApiKey: () => Promise<boolean>;
  reactivationOpen: boolean;
  onReactivationOpenChange: (open: boolean) => void;
  firstRunPluginSummary: Parameters<typeof PersonalizedWelcome>[0]["pluginSummary"];
  marketplaceUrlReady: boolean;
  bootstrapStatus: Parameters<typeof PersonalizedWelcome>[0]["bootstrapStatus"];
  onRetryBootstrap: Parameters<typeof PersonalizedWelcome>[0]["onRetryBootstrap"];
  installedPluginIds: string[];
  onComposerSeedText: (text: string) => void;
}) {
  return (
    <>
      {/* ask_user_question cards now render inline inside ChatView
          (immediately after the active turn's entries),
          so the previous App-level FloatingQuestionPanel mount is gone.
          See <AskUserQuestionCard> + ChatView ask-question slot. */}
      <DeferredQueueDialog open={deferredQueueOpen} onOpenChange={onDeferredQueueOpenChange} />
      <ApprovalDialog queue={approvalQueue} onDecide={onApprovalDecide} />
      {/* Z onboarding chain — staged sequence of dialogs.
          The chain reducer guarantees only one of these dialogs is
          ever mounted at a time, so the historical multi-Dialog
          race (#982/#990/#997) cannot recur. */}
      <ScenarioShowcase
        open={chainStage === "showcase"}
        onStart={(scenarioId) =>
          dispatchChain({ type: "showcase-start", scenarioId })
        }
      />
      <LoginModal
        api={api}
        open={chainStage === "login"}
        onOpenChange={(next) => {
          if (chainStage !== "login") return;
          if (!next) {
            // Radix closed the dialog — treat any close that didn't
            // already advance the chain as a user-initiated skip.
            dispatchChain({ type: "login-skip" });
          }
        }}
        onSuccess={() => {
          void checkApiKey();
          dispatchChain({ type: "login-success" });
        }}
      />
      {/* 2026-05-20 — Settings 의 "데모 자격증명 재입력" entry. onboarding
          chain 과는 독립된 modal — 사용자가 이미 onboarding 을 끝낸
          returning user 의 *자발적 재입력 path*. LoginModal 의 forceActivation
          prop 으로 chip 1/2/3 surface 를 우회하고 곧장 activation 입력
          page 를 mount 한다. */}
      <LoginModal
        api={api}
        open={reactivationOpen}
        forceActivation
        onOpenChange={(next) => {
          if (!next) onReactivationOpenChange(false);
        }}
        onSuccess={() => {
          void checkApiKey();
          onReactivationOpenChange(false);
        }}
      />
      {/* Tutorial-B (O-X2) — Memory Seed Onboarding Wizard. 2026-05-20:
          MemorySeed now mounts BEFORE the welcome card so the typed
          호칭/자기소개 can personalize the welcome greeting that follows.
          The chain reducer drives `open` from stage "memory" only;
          `onDismissed` advances the chain to "personalized_welcome".

          The wrapper below intentionally swallows MemorySeed's own
          `startTour()` IPC so the chain-effect on stage="tour" remains
          the single canonical broadcaster (preserves the #1029 fix). */}
      <MemorySeedDialog
        open={chainStage === "memory"}
        selectedScenarioId={selectedScenarioId}
        onOpenChange={(next) => {
          if (chainStage !== "memory") return;
          if (!next) {
            // Radix-side close. The MemorySeed's own onDismissed
            // already fires for Submit / Skip; this branch covers the
            // Esc / outside-click paths.
            dispatchChain({ type: "memory-finish" });
          }
        }}
        api={{
          ...api,
          tour: {
            ...api.tour,
            // Swallow the MemorySeed's internal tour.start fire — the
            // Z chain effect on stage="tour" already broadcasts the
            // canonical scenario. Double-broadcast would reset the
            // SpotlightTour to step 0 visibly.
            start: async () => ({ ok: true as const, scenarioId: "first-boot-essentials" }),
          },
        } as typeof api}
        onDismissed={() => {
          // Read the typed 호칭/자기소개 from the DOM at the dismissal
          // frame and feed them into the chain reducer so the
          // PersonalizedWelcome card can address the user by name.
          // The MemorySeed wizard's own write to MEMORY.md is unaffected
          // (it runs inside the wizard before this callback fires).
          let nickname = "";
          let introduction = "";
          if (typeof document !== "undefined") {
            const nameEl = document.querySelector<HTMLInputElement>(
              '[data-testid="memory-seed-dialog:name"]',
            );
            const introEl = document.querySelector<HTMLTextAreaElement>(
              '[data-testid="memory-seed-dialog:intro"]',
            );
            nickname = nameEl?.value?.trim() ?? "";
            introduction = introEl?.value?.trim() ?? "";
          }
          dispatchChain({
            type: "memory-finish",
            nickname,
            introduction,
          });
        }}
      />
      {/* PersonalizedWelcome (2026-05-20) — replaces WelcomeQuestion.
          Mounted after MemorySeed so the card greets the user by the
          호칭 they just typed and references their 자기소개. Forced
          choice — there is no skip; pressing "예, 시작할게요 →" is
          the only path forward. The card also pings the LLM provider
          on mount and surfaces vendor/model/latency inline as a
          connection-confirmation cue. */}
      <PersonalizedWelcome
        open={chainStage === "personalized_welcome"}
        nickname={memorySeedNickname}
        introduction={memorySeedIntroduction}
        pingAiProvider={api.pingAiProvider}
        getRuntimeCounts={api.getRuntimeCounts}
        getRuntimeEnv={api.getRuntimeEnv}
        pluginSummary={firstRunPluginSummary}
        marketplaceUrlReady={marketplaceUrlReady}
        bootstrapStatus={bootstrapStatus}
        onRetryBootstrap={onRetryBootstrap}
        onContinue={() =>
          dispatchChain({ type: "personalized-welcome-accept" })
        }
      />
      {/* Tutorial-C — SpotlightTour mounts always; it stays invisible until
          a `lvis:tour:start` broadcast flips it on. Production trigger:
          ⌘+Shift+/ (macOS "⌘?" help shortcut) / Ctrl+Shift+/ — see the
          useEffect above. State lives in `~/.lvis/onboarding/`. The
          `onComplete` callback fires only when the user reaches the
          final tour step (not on early-dismissal); the Z chain
          dispatches `tour-finish` so PluginShowcase mounts next. */}
      <SpotlightTour
        api={api}
        onComplete={() => {
          if (chainStage === "tour") dispatchChain({ type: "tour-finish" });
        }}
        onDismiss={() => {
          if (chainStage === "tour") dispatchChain({ type: "tour-skip" });
        }}
      />
      {/* Z onboarding chain — PluginShowcase. Mounted only at stage
          "plugins"; carries the host's installed pluginCards so each
          card reflects what the user actually has. Closing the
          showcase finishes the chain (state → done) and the
          markOnboardingCompleted side-effect persists the flag. */}
      <PluginShowcase
        open={chainStage === "plugins"}
        installedPluginIds={installedPluginIds}
        api={api}
        onClose={() => dispatchChain({ type: "plugins-close" })}
        prioritizedScenarioId={selectedScenarioId}
      />
      {/* Tutorial-X5 — Post-tour first-task proposal. Mounts always,
          stays invisible until the user finishes a tour AND at least one
          installed plugin has a registered proposal in first-task-proposals.
          The composerSeedText callback writes directly to the chat
          composer state setter so the user is one click away from a real
          plugin invocation — no hidden IPC. */}
      <PostTourFirstTask
        api={{
          composerSeedText: (text: string) => {
            onComposerSeedText(text);
          },
        }}
        installedPluginIds={installedPluginIds}
        tourCompleted={tourCompleted}
      />
      {/* v6: ApprovalQueueStatus floating chip 제거. 자연어 승인 칩
          (DeferredApprovalChip) 은 ChatView 의 컴포저 바로 위에서 렌더된다.
          Spec docs/blueprints/composer-redesign-message-queue.md "제거" 섹션. */}
      <DevConsoleToggle />
      {/* Snap edge highlight — shown when a detached child window enters the snap zone */}
      <SnapEdgeHighlight />
    </>
  );
}
