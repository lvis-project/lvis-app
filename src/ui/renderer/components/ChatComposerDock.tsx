import type React from "react";
import { useEffect, useState, type RefObject } from "react";
import { SessionTodoPanel } from "./SessionTodoPanel.js";
import { MessageQueuePanel } from "./MessageQueuePanel.js";
import { DeferredApprovalChip } from "./DeferredApprovalChip.js";
import { StatusBar, type StatusBarProps } from "./StatusBar.js";
import { Composer, type ComposerHandle } from "./Composer.js";
import { InputActionBar } from "./InputActionBar.js";
import { QuestionOverlay } from "./QuestionOverlay.js";
import { computeComposerPlaceholder } from "../utils/composer-placeholder.js";
import { ATTACH_MAX_COUNT, type Attachment } from "../types/attachments.js";
import { MessageQueueStore, type MessageQueueItem } from "../state/message-queue-store.js";
import type { LvisApi } from "../types.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import type { SuggestedRepliesSnapshot } from "../hooks/use-suggested-replies.js";
import type { QuickAction } from "./CommandPopover.js";
import type { PluginEntry } from "./PluginGridButton.js";
import type { ViewModeState } from "./ViewModeBanner.js";
import type { RolePreset } from "../../../data/role-presets.js";
import type { AppMode } from "../MainToolbar.js";
import type { AskUserQuestionRequest } from "./AskUserQuestionCard.js";
import { ComposerProjectSelector } from "./ComposerProjectSelector.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";

type InputStatusRow = React.ComponentProps<typeof InputActionBar>["statusRow"];

export interface ChatComposerDockProps {
  dockColumnClass: string;
  /** Empty work-mode conversation: visually lift the composer into the first screen. */
  centered?: boolean;
  /** Keep center placement, but reduce lift when the transcript owns an empty-state card. */
  centeredLift?: "default" | "compact";
  workflowApi: LvisApi;
  api: LvisApi;
  currentSessionId: string;
  messageQueueStore: MessageQueueStore;
  onMessageQueueSendNow: (item: MessageQueueItem) => void;
  question: string;
  statusBar?: StatusBarProps;
  composerRef: RefObject<ComposerHandle | null>;
  setQuestion: React.Dispatch<React.SetStateAction<string>>;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  attachmentNCounter: { current: number };
  onComposerSend: (intent: UserKeyboardIntentSnapshot) => void;
  suggestedReplies: SuggestedRepliesSnapshot;
  commandActions: QuickAction[];
  plugins: PluginEntry[];
  onSelectPlugin: (viewKey: string) => void;
  hasApiKey: boolean | null;
  viewMode: ViewModeState | null;
  streaming: boolean;
  onInsertSlashCommand: (cmd: string) => void;
  commandPopoverOpen: boolean;
  onCommandPopoverOpenChange: (open: boolean) => void;
  ringSlot: React.ReactNode;
  onAttach: () => Promise<void> | void;
  rolePresets: RolePreset[];
  activePreset: RolePreset | null;
  activePresetId: string;
  onSelectPreset: (id: string) => void;
  onBottomSend: () => void;
  onCancel: () => void;
  enableThinkingChat: boolean;
  onToggleThinking: (v: boolean) => Promise<void> | void;
  inputStatusRow: InputStatusRow;
  appMode?: AppMode;
  onOpenModelSettings: () => void;
  onOpenPermissions: () => void;
  onOpenApprovalQueue?: () => void;
  askQuestions: AskUserQuestionRequest[];
  onResolveAskQuestion: (id: string) => void;
  /** Active project — drives the empty-state project selector trigger label. */
  activeProject?: ProjectIdentity;
  /** Full known project list — same SOT the sidebar's project group reads from. */
  workspaceProjects?: ProjectIdentity[];
  /** Switch the active project — the same handler wired to the sidebar's project rows. */
  onNewChatForProject?: (project: { projectRoot?: string; projectName?: string }) => void | Promise<void>;
  /** Re-fetch the workspace project list after adding a project folder. */
  onRefreshProjects?: () => void | Promise<void>;
  /** Controlled open state for the project selector dropdown — owned by
   *  ChatView so it can be force-closed when the composer leaves the
   *  centered layout. */
  projectSelectorOpen: boolean;
  onProjectSelectorOpenChange: (open: boolean) => void;
}

/**
 * Presentational composer dock: the todo/queue panels, the deferred-approval
 * chip, the composer toast surface, the unified input box (Composer +
 * InputActionBar), and the ask-user question overlay. Moved verbatim from
 * ChatView so every data-testid + i18n key + gating expression is unchanged;
 * all stateful logic stays in ChatView's hooks and is threaded in via props.
 */
export function ChatComposerDock({
  dockColumnClass,
  centered = false,
  centeredLift = "default",
  workflowApi,
  api,
  currentSessionId,
  messageQueueStore,
  onMessageQueueSendNow,
  question,
  statusBar,
  composerRef,
  setQuestion,
  attachments,
  setAttachments,
  attachmentNCounter,
  onComposerSend,
  suggestedReplies,
  commandActions,
  plugins,
  onSelectPlugin,
  hasApiKey,
  viewMode,
  streaming,
  onInsertSlashCommand,
  commandPopoverOpen,
  onCommandPopoverOpenChange,
  ringSlot,
  onAttach,
  rolePresets,
  activePreset,
  activePresetId,
  onSelectPreset,
  onBottomSend,
  onCancel,
  enableThinkingChat,
  onToggleThinking,
  inputStatusRow,
  appMode,
  onOpenModelSettings,
  onOpenPermissions,
  onOpenApprovalQueue,
  askQuestions,
  onResolveAskQuestion,
  activeProject,
  workspaceProjects,
  onNewChatForProject,
  onRefreshProjects,
  projectSelectorOpen,
  onProjectSelectorOpenChange,
}: ChatComposerDockProps) {
  // Linger the project-selector slot mounted for one composer-descent cycle
  // after `centered` flips false (first message sent), so ComposerProjectSelector
  // — including its own forceMount + data-state fade/scale-out — has time to
  // finish its close transition instead of being cut off by an instant unmount.
  // Matches the outer dock's own `duration-300` descent so both animations
  // read as one coordinated motion. Reduced-motion users skip the linger
  // entirely (no transition to wait out).
  const [showProjectSelectorSlot, setShowProjectSelectorSlot] = useState(centered);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerHeight,
  );
  useEffect(() => {
    if (centered) {
      setShowProjectSelectorSlot(true);
      return;
    }
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (prefersReducedMotion) {
      setShowProjectSelectorSlot(false);
      return;
    }
    const timer = window.setTimeout(() => setShowProjectSelectorSlot(false), 300);
    return () => window.clearTimeout(timer);
  }, [centered]);
  useEffect(() => {
    const updateViewportHeight = () => setViewportHeight(window.innerHeight);
    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);
    return () => window.removeEventListener("resize", updateViewportHeight);
  }, []);

  const compactCenteredMarginClass =
    viewportHeight >= 720
      ? "mb-48"
      : viewportHeight >= 560
        ? "mb-32"
        : "mb-[clamp(1rem,5vh,4rem)]";

  const centeredMarginClass = centered
    ? centeredLift === "compact"
      ? compactCenteredMarginClass
      : "mb-[clamp(9rem,32vh,20rem)]"
    : "mb-0";

  return (
    <div
      className={[
        "relative z-30 w-full max-w-full min-w-0 overflow-visible transition-[margin,transform] duration-300 ease-out motion-reduce:transition-none",
        centeredMarginClass,
      ].join(" ")}
      data-composer-placement={centered ? "center" : "bottom"}
      data-composer-centered-lift={centered ? centeredLift : undefined}
    >
      <div className={dockColumnClass} data-testid="session-todo-dock">
        <SessionTodoPanel api={workflowApi} sessionId={currentSessionId} />
        <MessageQueuePanel
          store={messageQueueStore}
          onSendNow={onMessageQueueSendNow}
        />
      </div>
      <div className={`${dockColumnClass} overflow-x-hidden pb-1`}>
        {/* §8 agent-approval surface — interactive natural-language approval
            chip. Renders directly above the composer (the position its own
            contract describes); self-hides unless the draft expresses an
            approve/reject intent AND exactly one queue entry is pending. */}
        <DeferredApprovalChip draftText={question} />
        {/* ONE unified input box: textarea + the single InputActionBar
            (action row + status sub-row). The window StatusBar is
            notifications-only; the model / permission / active / context%
            cells live in the bar's status sub-row.
            `lvis-surface-raised` paints the edge as an inset hairline so
            the dock's overflow handling cannot clip the composer edge. */}
        <div className="relative mx-3 mb-2 pt-9">
          {statusBar && (statusBar.visibleToast !== null || statusBar.persistent.length > 0) ? (
            <div
              className="absolute inset-x-3 top-0 z-0 min-w-0"
              data-testid="composer-toast-dock"
            >
              <StatusBar {...statusBar} />
            </div>
          ) : null}
          {/* Empty-state project selector — attached directly above the
              composer card, in the same reserved toast-zone the StatusBar
              uses. Rendered for the centered (empty-conversation) layout AND
              for one descent cycle after it ends (`showProjectSelectorSlot`
              lingers per the effect above), so the dropdown's own
              forceMount+data-state close transition (see
              ComposerProjectSelector) has time to play instead of being cut
              off by an instant unmount when the composer drops to the
              bottom-docked position. `open` is gated on `centered` directly
              (not the lingering slot) so the dropdown starts closing the
              INSTANT the transition begins, in lockstep with the composer's
              own descent — the slot then unmounts once both animations
              finish. */}
          {showProjectSelectorSlot && onNewChatForProject ? (
            <div
              className="absolute left-0 top-0 z-20 transition-opacity duration-200 ease-out motion-reduce:transition-none"
              data-testid="composer-project-selector-slot"
            >
              <ComposerProjectSelector
                activeProject={activeProject}
                projects={workspaceProjects ?? (activeProject ? [activeProject] : [])}
                onSelectProject={onNewChatForProject}
                onRefreshProjects={onRefreshProjects}
                open={projectSelectorOpen && centered}
                onOpenChange={onProjectSelectorOpenChange}
              />
            </div>
          ) : null}
          <div className="lvis-surface-raised relative z-10 rounded-xl bg-input-bar overflow-hidden">
        <Composer
          ref={composerRef}
          text={question}
          onTextChange={setQuestion}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          allocateN={() => ++attachmentNCounter.current}
          saveClipboardImage={(b64) => window.lvis.attach.saveClipboardImage(b64)}
          openExternal={(p) => window.lvis.attach.openExternal(p)}
          onSend={onComposerSend}
          suggestedReplies={suggestedReplies}
          commandActions={commandActions}
          inlinePlugins={plugins}
          onSelectPlugin={onSelectPlugin}
          disabled={
            // Context/TPM red zones stay sendable: main preflight runs
            // compact before the LLM call. Slash commands still bypass
            // API/view UI gates where they are the recovery path.
            (hasApiKey === false || viewMode !== null) &&
            !question.trimStart().startsWith("/")
          }
          onWarning={(msg) => console.warn(msg)}
          placeholder={computeComposerPlaceholder({ hasApiKey, streaming, suggestedReplies })}
        />
        <InputActionBar
          plugins={plugins}
          onSelectPlugin={onSelectPlugin}
          onInsertSlashCommand={onInsertSlashCommand}
          commandActions={commandActions}
          commandPopoverOpen={commandPopoverOpen}
          onCommandPopoverOpenChange={onCommandPopoverOpenChange}
          ringSlot={ringSlot}
          attachDisabled={
            attachments.length >= ATTACH_MAX_COUNT ||
            hasApiKey === false
          }
          attachDisabledReason={hasApiKey === false ? "no-api-key" : "limit"}
          onAttach={onAttach}
          rolePresets={rolePresets}
          activePreset={activePreset}
          activePresetId={activePresetId}
          onSelectPreset={onSelectPreset}
          isBusy={streaming}
          isSendDisabled={
            (hasApiKey === false || viewMode !== null) &&
            !question.trimStart().startsWith("/")
              ? true
              : question.trim().length === 0 && attachments.length === 0
          }
          onSend={onBottomSend}
          onCancel={() => {
            // ESC handler 와 동일: 큐를 inject + abort (멈춤 X, 입력으로 inject).
            onCancel();
          }}
          enableThinkingChat={enableThinkingChat}
          onToggleThinking={onToggleThinking}
          statusRow={inputStatusRow}
          appMode={appMode}
          onOpenModelSettings={onOpenModelSettings}
          onOpenPermissions={onOpenPermissions}
          onOpenApprovalQueue={onOpenApprovalQueue}
        />
          </div>
        </div>
      </div>
      <QuestionOverlay
        api={api}
        requests={askQuestions}
        onResolved={onResolveAskQuestion}
      />
    </div>
  );
}
