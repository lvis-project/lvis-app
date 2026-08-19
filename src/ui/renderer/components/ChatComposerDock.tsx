import type React from "react";
import { useCallback, useEffect, useState, type RefObject } from "react";
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
import type { ProjectErrorReporter } from "../hooks/use-add-project-folder.js";
import { ComposerApiKeyChip } from "./ComposerApiKeyChip.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";
import type { McpPromptEntry } from "./slash-picker-data.js";

import { subscriptionImageAttachmentLimitViolation, type SubscriptionRuntimeUiPolicy } from "../utils/subscription-runtime-ui-policy.js";
type InputStatusRow = React.ComponentProps<typeof InputActionBar>["statusRow"];

export interface ChatComposerDockProps {
  dockColumnClass: string;
  /** Empty work-mode conversation: visually lift the composer into the first screen. */
  centered?: boolean;
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
  /** Opens the settings window on a tab. Used by the no-key chip. */
  onOpenSettings: (tab?: string) => void;
  viewMode: ViewModeState | null;
  streaming: boolean;
  onInsertSlashCommand: (cmd: string) => void;
  onRunMcpPrompt: (prompt: McpPromptEntry) => void;
  commandPopoverOpen: boolean;
  onCommandPopoverOpenChange: (open: boolean) => void;
  ringSlot: React.ReactNode;
  onAttach: () => Promise<void> | void;
  /** App-owned warning for a verified image-capability refusal only. */
  onImageAttachmentUnavailable?: () => void;
  /** Canonical selected subscription runtime policy; legacy markers are fallback-only. */
  subscriptionRuntimePolicy?: SubscriptionRuntimeUiPolicy;
  /** App-owned warning for a supported image that exceeds the runtime budget. */
  onImageAttachmentLimitExceeded?: () => void;
  /** Selected subscription runtime has not verified original local image input. */
  subscriptionImageAttachmentProvider?: string;
  /** Selected subscription runtime has not verified file-marker attachment support. */
  subscriptionFileAttachmentProvider?: string;
  /** False until the persisted active runtime selection is authoritative. */
  settingsLoaded?: boolean;
  subscriptionUnavailableProvider?: string;
  subscriptionPendingProvider?: string;
  rolePresets: RolePreset[];
  activePreset: RolePreset | null;
  activePresetId: string;
  onSelectPreset: (id: string) => void;
  onBottomSend: () => void;
  onCancel: () => void;
  enableThinkingChat: boolean;
  reasoningAvailable?: boolean;
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
  onProjectError?: ProjectErrorReporter;
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
  onOpenSettings,
  viewMode,
  streaming,
  onInsertSlashCommand,
  onRunMcpPrompt,
  commandPopoverOpen,
  onCommandPopoverOpenChange,
  onImageAttachmentUnavailable,
  onImageAttachmentLimitExceeded,
  ringSlot,
  onAttach,
  subscriptionRuntimePolicy,
  subscriptionImageAttachmentProvider,
  subscriptionFileAttachmentProvider,
  settingsLoaded,
  subscriptionUnavailableProvider,
  subscriptionPendingProvider,
  rolePresets,
  activePreset,
  activePresetId,
  onSelectPreset,
  onBottomSend,
  onCancel,
  enableThinkingChat,
  reasoningAvailable,
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
  onProjectError,
  projectSelectorOpen,
  onProjectSelectorOpenChange,
}: ChatComposerDockProps) {
  // Linger the project-selector slot mounted for one composer-descent cycle
  // after `centered` flips false (first message sent), so ComposerProjectSelector
  // — including its own forceMount + data-state fade/scale-out — has time to
  // finish its close transition instead of being cut off by an instant unmount.
  // Matches the outer dock's layout descent so both animations
  // read as one coordinated motion. Reduced-motion users skip the linger
  // entirely (no transition to wait out).
  const [showProjectSelectorSlot, setShowProjectSelectorSlot] = useState(centered);
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

  // One lift, unconditionally. The `"compact"` variant existed only to leave
  // room for the no-API-key transcript card; that card is gone (its affordance
  // is now the zero-height `ComposerApiKeyChip` in the strip above), so an empty
  // conversation always centers the composer the same way, key or no key.
  const centeredMarginClass = centered ? "mb-[clamp(9rem,32vh,20rem)]" : "mb-0";

  // Stable identity, not an inline arrow. `allocateN` is a dependency of the mention
  // hook's accept callback, which is a dependency of the composer's memoized keydown
  // handler — so a fresh arrow per render rebuilt that handler on every render. The
  // behaviour was correct (a fresh handler is never stale) but it made the handler's
  // dependency array decorative: a missing dependency could not be observed, which is
  // exactly how the mention menu shipped with a dead keyboard. The counter itself is a
  // ref, so there is nothing to close over.
  const allocateN = useCallback(() => ++attachmentNCounter.current, [attachmentNCounter]);
  const runtimeImageAttachmentProvider = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.imageAttachmentProvider
    : subscriptionImageAttachmentProvider;
  const runtimeFileAttachmentProvider = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.fileAttachmentProvider
    : subscriptionFileAttachmentProvider;
  const runtimeUnavailable = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.chatUnavailable
    : subscriptionUnavailableProvider !== undefined;
  const runtimePending = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.chatPending
    : subscriptionPendingProvider !== undefined;
  const attachmentInputsReady = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.attachmentInputsReady
    : settingsLoaded !== false && !runtimePending;
  const imagesEnabled = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.imagesEnabled
    : attachmentInputsReady && runtimeImageAttachmentProvider === undefined;
  const filesEnabled = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.filesEnabled
    : attachmentInputsReady && runtimeFileAttachmentProvider === undefined;
  const composerInputDisabled = viewMode !== null || (hasApiKey === false && (
    runtimeUnavailable
    || runtimePending
    || !question.trimStart().startsWith("/")
  ));
  // A runtime may be switched after a draft has accumulated attachments. Keep
  // the draft editable so the user can remove or preserve markers, but do not
  // leave either visual send path enabled for an attachment type the newly
  // selected runtime has not verified.
  const draftHasUnsupportedAttachment =
    (runtimeImageAttachmentProvider !== undefined
      && attachments.some((attachment) => attachment.kind === "image"))
    || (runtimeFileAttachmentProvider !== undefined
      && attachments.some((attachment) => attachment.kind === "file"))
    || subscriptionImageAttachmentLimitViolation(
      subscriptionRuntimePolicy?.imageAttachmentLimits,
      attachments
        .filter((attachment) => attachment.kind === "image")
        .map((attachment) => ({ bytes: attachment.bytes })),
    ) !== null;
  const composerSendDisabled = !attachmentInputsReady
    || composerInputDisabled
    || draftHasUnsupportedAttachment;
  return (
    <div
      className={[
        "relative z-30 w-full max-w-full min-w-0 overflow-visible transition-[margin,transform] duration-[var(--motion-layout)] ease-[var(--motion-ease-out)] motion-reduce:transition-none",
        centeredMarginClass,
      ].join(" ")}
      data-composer-placement={centered ? "center" : "bottom"}
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
              className="absolute left-0 top-0 z-20 transition-opacity duration-[var(--motion-normal)] ease-[var(--motion-ease-out)] motion-reduce:transition-none"
              data-testid="composer-project-selector-slot"
            >
              <ComposerProjectSelector
                activeProject={activeProject}
                projects={workspaceProjects ?? (activeProject ? [activeProject] : [])}
                onSelectProject={onNewChatForProject}
                onRefreshProjects={onRefreshProjects}
                onProjectError={onProjectError}
                open={projectSelectorOpen && centered}
                onOpenChange={onProjectSelectorOpenChange}
              />
            </div>
          ) : null}
          {/* No-key affordance — mirrored across the same reserved strip the
              project selector occupies. Absolutely positioned + popover-based,
              so it adds no layout height and the centered composer keeps its
              full lift (it replaced a transcript card that did claim height).
              `hasApiKey` here is App's `effectiveLlmReady`, which already ORs in
              `llmReadyWithoutApiKey` — a keyless-ready session never shows it,
              and `null` (probe unresolved) stays silent. */}
          {hasApiKey === false ? (
            <div
              className="absolute right-0 top-0 z-20"
              data-testid="composer-api-key-chip-slot"
            >
              <ComposerApiKeyChip
                onOpenSettings={onOpenSettings}
                subscriptionRuntimePolicy={subscriptionRuntimePolicy}
                subscriptionUnavailableProvider={subscriptionUnavailableProvider}
                subscriptionPendingProvider={subscriptionPendingProvider}
              />
            </div>
          ) : null}
          <div className="lvis-surface-raised relative z-10 overflow-hidden rounded-xl border border-input-bar-border bg-input-bar text-input-bar-foreground transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease-standard)] focus-within:border-input-bar-focus focus-within:ring-1 focus-within:ring-input-bar-focus motion-reduce:transition-none">
        <Composer
          ref={composerRef}
          text={question}
          onTextChange={setQuestion}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          allocateN={allocateN}
          saveClipboardImage={(b64) => window.lvis.attach.saveClipboardImage(b64)}
          discardClipboardImage={(filePath) => window.lvis.attach.discardClipboardImage(filePath)}
          openExternal={(p) => window.lvis.attach.openExternal(p)}
          imagesEnabled={imagesEnabled}
          imageAttachmentLimits={subscriptionRuntimePolicy?.imageAttachmentLimits}
          onSend={onComposerSend}
          suggestedReplies={suggestedReplies}
          commandActions={commandActions}
          inlinePlugins={plugins}
          onSelectPlugin={onSelectPlugin}
          disabled={composerInputDisabled}
          sendDisabled={composerSendDisabled}
          onWarning={(message) => console.warn(message)}
          onImageAttachmentUnavailable={onImageAttachmentUnavailable}
          onImageAttachmentLimitExceeded={onImageAttachmentLimitExceeded}
          placeholder={computeComposerPlaceholder({
            hasApiKey,
            streaming,
            suggestedReplies,
            subscriptionUnavailable: runtimeUnavailable,
            subscriptionPending: runtimePending,
          })}
        />
        <InputActionBar
          plugins={plugins}
          onSelectPlugin={onSelectPlugin}
          onInsertSlashCommand={onInsertSlashCommand}
          onRunMcpPrompt={onRunMcpPrompt}
          commandActions={commandActions}
          commandPopoverOpen={commandPopoverOpen}
          onCommandPopoverOpenChange={onCommandPopoverOpenChange}
          ringSlot={ringSlot}
          attachDisabled={
            attachments.length >= ATTACH_MAX_COUNT ||
            !attachmentInputsReady ||
            hasApiKey === false ||
            (!imagesEnabled && !filesEnabled)
          }
          attachDisabledReason={!attachmentInputsReady
            ? "runtime-pending"
            : (!imagesEnabled && !filesEnabled)
            ? "subscription-unsupported"
            : hasApiKey === false ? "no-api-key" : "limit"}
          attachDisabledSubscriptionProvider={
            runtimeImageAttachmentProvider ?? runtimeFileAttachmentProvider
          }
          onAttach={onAttach}
          rolePresets={rolePresets}
          activePreset={activePreset}
          activePresetId={activePresetId}
          onSelectPreset={onSelectPreset}
          isBusy={streaming}
          hasDraft={question.trim().length > 0 || attachments.length > 0}
          isSendDisabled={
            composerSendDisabled || (question.trim().length === 0 && attachments.length === 0)
          }
          onSend={onBottomSend}
          onCancel={() => {
            // ESC handler 와 동일: 큐를 inject + abort (멈춤 X, 입력으로 inject).
            onCancel();
          }}
          enableThinkingChat={enableThinkingChat}
          reasoningAvailable={reasoningAvailable}
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
