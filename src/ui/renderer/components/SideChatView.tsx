/**
 * SideChatView — the side-chat transcript + composer rendered in the
 * workspace-rail `side-chat` tab.
 *
 * Renders through the SHARED `TranscriptRenderer` (the same renderer the main
 * chat uses) so tool calls, thinking, and permission-review status cards appear
 * identically to the main transcript — the "single SOT UI" goal. Capability
 * differences are expressed by OMITTING the optional prop clusters: side chat
 * passes no `edit` / `search` / `spawns` / `actions`, so the shared renderer
 * degrades to a read-only transcript (no pencil / fork / star / retry / feedback,
 * no ghost-text composer). It still passes its OWN `turnSummaryByTurnStart` so
 * the WorkGroup step count + TurnActionBar cost badge reflect the side loop's
 * own token / cost totals.
 *
 * The composer is the SHARED one as well: the same `Composer` the main dock
 * renders (`surface="side"` selects only the narrower growth cap), inside the
 * same `ComposerFrame`, driven by the same `useMessageQueue` — so Enter queues
 * while a turn runs, ⌘⏎ interrupts, Esc injects-or-aborts, paste chips, the
 * inline "/" and "@" menus open, and IME composition is honoured, all by the
 * one implementation. Only the New-session affordance is side-specific chrome.
 * All streaming is driven by `useSideChat`, which subscribes to the DEDICATED
 * side-chat IPC channel so main-chat frames never appear here. Tool APPROVAL
 * requests the side loop raises are drawn by this tab's own `ApprovalDock`:
 * the panel claims its session, so its cards never reach the tile beside it
 * or the window's dock.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { TranscriptRenderer } from "./TranscriptRenderer.js";
import { Composer, ComposerFrame, type ComposerHandle } from "./Composer.js";
import { ComposerApiKeyChip, resolveComposerRuntimeGates } from "./ChatComposerDock.js";
import { AttachButton, ShortcutsButton, TurnControlButton } from "./InputActionBar.js";
import { MessageQueuePanel } from "./MessageQueuePanel.js";
import { useSideChat } from "../hooks/use-side-chat.js";
import { useChatScroll } from "../hooks/use-chat-scroll.js";
import { useMessageQueue } from "../hooks/use-message-queue.js";
import { useAttachmentPicker } from "../hooks/use-attachment-picker.js";
import { computeComposerPlaceholder } from "../utils/composer-placeholder.js";
import { composeOutgoing } from "../utils/compose.js";
import { ATTACH_MAX_COUNT, type Attachment } from "../types/attachments.js";
import type { LvisApi } from "../types.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import { useOptionalChatContext } from "../context/ChatContext.js";
import { useApprovalSurface } from "../hooks/use-approval.js";
import { ApprovalDock } from "./permissions/ApprovalDock.js";
import { sessionOwnedBy } from "./chat-group-session-registry.js";

/** The side transcript has no search band; the scroll hook still wants a stable list. */
const NO_SEARCH_MATCHES: number[] = [];

/**
 * The side loop's stream carries no sub-agent frames, so this panel learns of
 * no child session: the set is empty by construction. It still claims through
 * the tile's own rule (`sessionOwnedBy`) so the two readers cannot drift.
 */
const NO_CHILD_SESSIONS: ReadonlySet<string> = new Set();

/** Stable empty lists: the composer's inline menu memoizes on their identity. */
const NO_COMMAND_ACTIONS: never[] = [];
const NO_INLINE_PLUGINS: never[] = [];
const NOOP_SELECT_PLUGIN = () => {};

export function SideChatView({ api }: { api: LvisApi }) {
  const { t } = useTranslation();
  // If side chat is unavailable (preload without the surface), surface a stable
  // disabled state rather than a broken composer.
  const sideChat = api.sideChat;
  if (!sideChat) {
    return (
      <div
        className="p-4 text-xs text-muted-foreground"
        data-testid="chat-side-panel-side-chat-unavailable"
      >
        {t("chatPreviewRail.sideChat.unavailable")}
      </div>
    );
  }
  return <SideChatSession api={api} sideChat={sideChat} />;
}

function SideChatSession({
  api,
  sideChat,
}: {
  api: LvisApi;
  sideChat: NonNullable<LvisApi["sideChat"]>;
}) {
  const { t } = useTranslation();
  // Called BEFORE `useMessageQueue` below, so the transcript's stream listener
  // is registered first and judges each frame first. That ordering is no longer
  // load-bearing — the shared verdict is a pure read and the queue's drain is
  // deferred out of the dispatch — and `use-message-queue.test.ts` pins the
  // reversed order to keep it that way.
  const {
    entries,
    turnSummaryByTurnStart,
    isStreaming,
    sessionId,
    send,
    newSession,
    abort,
    isCurrentTurnEvent,
  } = useSideChat(api);
  const chatContext = useOptionalChatContext();
  // A side chat runs its own session; its approval cards belong in this panel,
  // not in the tile beside it and not in the window. The panel claims the
  // session once the loop has one, and draws the card over its own composer.
  const approvals = useApprovalSurface();
  // ...unless the tile holding this panel is hidden. The panel is then inside a
  // `display:none` subtree, so the card it claims is a card nobody can answer;
  // the window's dock takes it back until the tile is drawn again.
  const tileHidden = chatContext?.hidden === true;
  useEffect(() => {
    if (sessionId === null || tileHidden) return undefined;
    return approvals.claims.claim(
      `side-chat:${sessionId}`,
      (id) => sessionOwnedBy(sessionId, NO_CHILD_SESSIONS, id),
    );
  }, [approvals.claims, sessionId, tileHidden]);
  const pendingApprovals = useMemo(
    () => (sessionId === null
      ? []
      : approvals.queue.filter((req) =>
        req.sessionId !== undefined && sessionOwnedBy(sessionId, NO_CHILD_SESSIONS, req.sessionId))),
    [approvals.queue, sessionId],
  );
  const approvalHead = pendingApprovals[0] ?? null;
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentNCounter = useRef(0);
  const composerRef = useRef<ComposerHandle | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Side chat is a second ConversationLoop, not a second credential policy.
  // Read the app-level readiness contract so it cannot bypass a selected
  // subscription login that is still checking, signed out, or unsupported.
  const hasApiKey = chatContext?.hasApiKey ?? null;
  const subscriptionRuntimePolicy = chatContext?.subscriptionRuntimePolicy;
  const {
    runtimeImageAttachmentProvider,
    runtimeFileAttachmentProvider,
    runtimeUnavailable,
    runtimePending,
    attachmentInputsReady,
    imagesEnabled,
    filesEnabled,
    draftHasUnsupportedAttachment,
  } = resolveComposerRuntimeGates({
    subscriptionRuntimePolicy,
    subscriptionImageAttachmentProvider: chatContext?.subscriptionImageAttachmentProvider,
    subscriptionFileAttachmentProvider: chatContext?.subscriptionFileAttachmentProvider,
    settingsLoaded: chatContext?.settingsLoaded,
    subscriptionUnavailableProvider: chatContext?.subscriptionUnavailableProvider,
    subscriptionPendingProvider: chatContext?.subscriptionPendingProvider,
    attachments,
  });
  // The side loop runs no local slash commands, so a missing credential blocks
  // the field outright — there is no keyless "/" path to keep open.
  const composerInputDisabled = !attachmentInputsReady || runtimeUnavailable || hasApiKey === false;
  const composerSendDisabled = composerInputDisabled || draftHasUnsupportedAttachment;
  const hasDraft = draft.trim().length > 0 || attachments.length > 0;

  // The main transcript's scroll model: follow the stream only while pinned
  // near the bottom, and offer a jump back once the reader has scrolled away.
  const { scrollViewportRef, showJumpToBottom, scrollChatToBottom } = useChatScroll({
    entries,
    currentSessionId: sessionId ?? "",
    chatEndRef,
    viewMode: null,
    searchOpen: false,
    searchMatches: NO_SEARCH_MATCHES,
    searchIdx: 0,
    hidden: tileHidden,
  });

  const allocateN = useCallback(() => ++attachmentNCounter.current, []);

  // The queue hands a send here in three shapes: the idle Enter (the draft as
  // typed), ⌘⏎ / Esc / a row's "send now" (an interrupt), and the end-of-turn
  // drain (`queue-auto`). A user send composes the draft's attachments into
  // content parts and clears the field, as the main composer does; the drain
  // carries text only, because queued rows never held attachments.
  const handleAsk = useCallback(
    (
      text: string,
      _intent?: UserKeyboardIntentSnapshot,
      opts?: { injectHint?: "queue" | "interrupt"; inputOrigin?: "queue-auto" },
    ) => {
      if (opts?.inputOrigin === "queue-auto") {
        return send(text, { injectHint: opts.injectHint, inputOrigin: "queue-auto" });
      }
      const composed = composeOutgoing({ raw: text, activePreset: null, attachments });
      setDraft("");
      setAttachments([]);
      return send(composed.text, {
        attachments: composed.attachments,
        ...(opts?.injectHint ? { injectHint: opts.injectHint } : {}),
      });
    },
    [send, attachments],
  );

  const {
    messageQueueStore,
    handleComposerSend,
    handleMessageQueueSendNow,
    flushQueueAsUserMessage,
  } = useMessageQueue({
    surface: "side",
    subscribeStream: sideChat.onStream,
    composerRef,
    currentSessionId: sessionId ?? "",
    question: draft,
    attachments,
    streaming: isStreaming,
    setQuestion: setDraft,
    setAttachments,
    onAsk: handleAsk,
    onAbort: abort,
    // Same verdict the transcript uses. An interrupted turn's trailing `done`
    // reaches this channel after the replacement turn has started; without the
    // shared guard the queue would read it as "the turn ended" and drain a row
    // onto the live turn.
    isCurrentTurnEvent,
  });

  const handleBottomSend = useCallback(() => {
    handleComposerSend({ inputOrigin: "user-keyboard", token: "" });
  }, [handleComposerSend]);

  const { handleAttach } = useAttachmentPicker({
    attachmentNCounter,
    setAttachments,
    setQuestion: setDraft,
    composerRef,
    imagesEnabled,
    filesEnabled,
    imageAttachmentLimits: subscriptionRuntimePolicy?.imageAttachmentLimits,
  });

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="side-chat-view" data-approval-scope>
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("chatPreviewRail.sideChat.title")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px]"
          onClick={() => void newSession()}
          // Disabled mid-stream: starting a new session mutates the shared side
          // loop; the main handler aborts the in-flight turn first, but blocking
          // the affordance avoids the surprising "New drops my streaming reply".
          disabled={isStreaming}
          data-testid="side-chat-new"
          aria-label={t("chatPreviewRail.sideChat.newSession")}
        >
          <Plus className="h-3 w-3" />
          {t("chatPreviewRail.sideChat.newSession")}
        </Button>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollViewportRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2"
        data-testid="side-chat-transcript"
      >
        {entries.length === 0 ? (
          <div className="pt-6 text-center text-xs text-muted-foreground">
            {t("chatPreviewRail.sideChat.empty")}
          </div>
        ) : (
          <TranscriptRenderer
            entries={entries}
            streaming={isStreaming}
            currentSessionId={sessionId ?? "side-chat"}
            turnSummaryByTurnStart={turnSummaryByTurnStart}
            showTokenCostBadge={chatContext?.usageAvailable !== false}
          />
        )}
        <div ref={chatEndRef} />
      </div>
      {showJumpToBottom && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="lvis-surface-raised absolute bottom-3 right-3 z-20 h-7 rounded-full bg-card/(--opacity-solid) px-2.5 text-[11px] backdrop-blur"
          onClick={() => scrollChatToBottom("smooth")}
          data-testid="side-chat-jump-to-bottom"
        >
          <ChevronDown className="mr-1 h-3.5 w-3.5" />
          {t("chatView.jumpToBottom")}
        </Button>
      )}
      </div>

      {/* `data-composer-surface` marks the whole dock subtree, matching the
          main dock: the queue panel, the field, and the action row below all
          carry test ids the main dock also renders. */}
      <div
        className="shrink-0 border-t px-2 pb-2 pt-1.5"
        data-testid="side-chat-composer-dock"
        data-composer-surface="side"
      >
        <MessageQueuePanel
          store={messageQueueStore}
          onSendNow={handleMessageQueueSendNow}
          heldByApproval={approvalHead !== null}
        />
        {/* The same no-credential affordance the main dock shows, in the strip
            above the input box. `hasApiKey` is the app's readiness verdict, so a
            keyless-ready session never shows it and `null` (probe unresolved)
            stays silent. */}
        {hasApiKey === false && chatContext ? (
          <div className="mb-1.5 flex justify-end" data-testid="side-chat-api-key-chip-slot">
            <ComposerApiKeyChip
              onOpenSettings={chatContext.onOpenSettings}
              subscriptionRuntimePolicy={subscriptionRuntimePolicy}
              subscriptionUnavailableProvider={chatContext.subscriptionUnavailableProvider}
              subscriptionPendingProvider={chatContext.subscriptionPendingProvider}
            />
          </div>
        ) : null}
        <ComposerFrame>
          <Composer
            ref={composerRef}
            surface="side"
            text={draft}
            onTextChange={setDraft}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            allocateN={allocateN}
            saveClipboardImage={(b64) => window.lvis.attach.saveClipboardImage(b64)}
            discardClipboardImage={(filePath) => window.lvis.attach.discardClipboardImage(filePath)}
            openExternal={(p) => window.lvis.attach.openExternal(p)}
            imagesEnabled={imagesEnabled}
            imageAttachmentLimits={subscriptionRuntimePolicy?.imageAttachmentLimits}
            onSend={handleComposerSend}
            commandActions={NO_COMMAND_ACTIONS}
            inlinePlugins={NO_INLINE_PLUGINS}
            onSelectPlugin={NOOP_SELECT_PLUGIN}
            disabled={composerInputDisabled}
            sendDisabled={composerSendDisabled}
            onWarning={(message) => console.warn(message)}
            placeholder={computeComposerPlaceholder({
              hasApiKey,
              streaming: isStreaming,
              subscriptionUnavailable: runtimeUnavailable,
              subscriptionPending: runtimePending,
            })}
          />
          {/* Compact action row: the shared attach + shortcuts + turn control,
              without the main dock's slash picker, persona, and status sub-row —
              those act on the main loop (its commands, its persona, its context
              budget), which the side loop does not share. */}
          <div
            className="flex min-w-0 flex-nowrap items-center gap-1.5 px-3 pb-2 pt-1"
            data-testid="side-chat-action-row"
          >
            <AttachButton
              onAttach={handleAttach}
              disabled={
                attachments.length >= ATTACH_MAX_COUNT ||
                !attachmentInputsReady ||
                hasApiKey === false ||
                (!imagesEnabled && !filesEnabled)
              }
              disabledReason={!attachmentInputsReady
                ? "runtime-pending"
                : (!imagesEnabled && !filesEnabled)
                ? "subscription-unsupported"
                : hasApiKey === false ? "no-api-key" : "limit"}
              disabledSubscriptionProvider={
                runtimeImageAttachmentProvider ?? runtimeFileAttachmentProvider
              }
            />
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <ShortcutsButton />
              <TurnControlButton
                isBusy={isStreaming}
                hasDraft={hasDraft}
                isSendDisabled={composerSendDisabled || !hasDraft}
                onSend={handleBottomSend}
                onCancel={flushQueueAsUserMessage}
              />
            </div>
          </div>
        </ComposerFrame>
      </div>
      <ApprovalDock
        queue={pendingApprovals}
        conversationLabel={t("chatPreviewRail.sideChat.title")}
        onDecide={(choice, pattern, extras) => {
          if (approvalHead === null) return;
          void approvals.decide(approvalHead.id, choice, pattern, extras);
        }}
        onOpenPermanentDeny={approvals.openPermanentDeny}
        interactionLocked={approvalHead !== null && approvals.lockedRequestId === approvalHead.id}
      />
    </div>
  );
}
