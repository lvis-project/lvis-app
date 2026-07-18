import type { Dispatch } from "react";
import type { getApi } from "./api-client.js";
import { ApprovalDialog } from "./dialogs/ApprovalDialog.js";
import { DeferredQueueDialog } from "./dialogs/DeferredQueueDialog.js";
import { MemorySeedDialog } from "./dialogs/MemorySeedDialog.js";
import { SpotlightTour } from "./components/SpotlightTour.js";
import { PostTourFirstTask } from "./onboarding/PostTourFirstTask.js";
import { ScenarioShowcase } from "./onboarding/ScenarioShowcase.js";
import { PersonalizedWelcome } from "./onboarding/PersonalizedWelcome.js";
import type {
  OnboardingChainEvent,
  OnboardingChainStage,
} from "./onboarding/onboarding-chain.js";
import { DevConsoleToggle } from "./components/DevConsoleToggle.js";
import { SnapEdgeHighlight } from "./components/SnapEdgeHighlight.js";

type Api = ReturnType<typeof getApi>;

/**
 * AppDialogs — the App-level modal/overlay cluster.
 *
 * Behavior-preserving extraction of App.tsx's dialog tail: the deferred
 * approval queue + approval dialog, the Z onboarding chain (staged so exactly
 * one chain dialog mounts at a time), the always-mounted SpotlightTour /
 * PostTourFirstTask, and the DevConsoleToggle / SnapEdgeHighlight singletons.
 * pure function of props (the chain reducer's dispatch is threaded through).
 */
export function AppDialogs({
  api,
  deferredQueueOpen,
  onDeferredQueueOpenChange,
  approvalQueue,
  onApprovalDecide,
  onboardingDialogsSuspended,
  chainStage,
  dispatchChain,
  selectedScenarioId,
  memorySeedNickname,
  memorySeedIntroduction,
  tourCompleted,
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
  /** Keep the next onboarding dialog offscreen while inline Settings is active. */
  onboardingDialogsSuspended: boolean;
  chainStage: OnboardingChainStage;
  dispatchChain: Dispatch<OnboardingChainEvent>;
  selectedScenarioId: string | null;
  memorySeedNickname: string;
  memorySeedIntroduction: string;
  tourCompleted: boolean;
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






      <MemorySeedDialog
        open={chainStage === "memory" && !onboardingDialogsSuspended}
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
          nickname they just typed and references their self-introduction.
          Forced choice — there is no skip; pressing the start button is
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
          dispatches `tour-finish` and completes onboarding. Installed
          plugins remain discoverable from their persistent management UI. */}
      <SpotlightTour
        api={api}
        onComplete={() => {
          if (chainStage === "tour") dispatchChain({ type: "tour-finish" });
        }}
        onDismiss={() => {
          if (chainStage === "tour") dispatchChain({ type: "tour-skip" });
        }}
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
      {/* v6: ApprovalQueueStatus floating chip removed. The natural-language
          approval chip (DeferredApprovalChip) renders just above ChatView's
          composer. See the removal section in
          docs/blueprints/composer-redesign-message-queue.md. */}
      <DevConsoleToggle />
      {/* Snap edge highlight — shown when a detached child window enters the snap zone */}
      <SnapEdgeHighlight />
    </>
  );
}
