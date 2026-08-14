import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { debugLog, isDebugStreamEnabled } from "../../../lib/debug-stream.js";
import { resolveIpcErrorKey } from "../format-ipc-error.js";
import { supportsVision } from "../../../engine/llm/vendor-capabilities.js";
import {
  composeImportedTriggerOutgoing,
  composeOutgoing as composeOutgoingUtil,
} from "../utils/compose.js";
import type { getApi } from "../api-client.js";
import type { useTranslation } from "../../../i18n/react.js";
import type {
  ChatSendInputOrigin,
  UserKeyboardIntentSnapshot,
} from "../../../shared/chat-origin.js";
import type { Attachment } from "../types/attachments.js";
import type { useChatState } from "./use-chat-state.js";
import type { useSessions } from "./use-sessions.js";
import type { useSettings } from "./use-settings.js";
import { subscriptionImageAttachmentLimitViolation } from "../utils/subscription-runtime-ui-policy.js";
import {
  SESSION_ID_PREFIX_LOOKUP_QUERY,
  findSessionByIdPrefix,
} from "../../../shared/session-lookup.js";
import type { HandleAskRefFn } from "./use-routine-overlay.js";

type Api = ReturnType<typeof getApi>;
type TFn = ReturnType<typeof useTranslation>["t"];
type ChatState = ReturnType<typeof useChatState>;
type Sessions = ReturnType<typeof useSessions>;
type Settings = ReturnType<typeof useSettings>;
type ComposeOutgoingFn = (raw: string) => ReturnType<typeof composeOutgoingUtil>;

export interface UseSendMessageDeps {
  api: Api;
  t: TFn;
  streaming: boolean;
  checkApiKey: () => Promise<boolean>;
  composeOutgoing: ComposeOutgoingFn;
  appendUserEntry: ChatState["appendUserEntry"];
  dropUserEntry: ChatState["dropUserEntry"];
  resetStreamAccumulators: ChatState["resetStreamAccumulators"];
  beginStreamingRequest: ChatState["beginStreamingRequest"];
  finishStreamingRequest: ChatState["finishStreamingRequest"];
  markLastAssistantInterrupted?: ChatState["markLastAssistantInterrupted"];
  setErrorWithThought: ChatState["setErrorWithThought"];
  handleCompactCommand: ChatState["handleCompactCommand"];
  sessionLoad: Sessions["handleLoadSession"];
  applyLoadedSession: ChatState["applyLoadedSession"];
  refreshSessionId: Sessions["refreshSessionId"];
  refreshSessions: Sessions["refreshSessions"];
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  llmVendor: Settings["llmVendor"];
  llmModel: Settings["llmModel"];
  llmReadyWithoutApiKey: Settings["llmReadyWithoutApiKey"];
  /** Canonical safe status and raw-image budget for the selected runtime. */
  subscriptionRuntimePolicy: Settings["subscriptionRuntimePolicy"];
  /** False until the active runtime selection has been read from settings. */
  settingsReady?: boolean;
  onOpenSettings: (tab?: string) => void;
  setQuestion: Dispatch<SetStateAction<string>>;
  /**
   * App-owned forward-ref cycle bridge. This hook WRITES it
   * (`handleAskRef.current = handleAsk`) each render so use-routine-overlay's
   * handlePluginPrimaryAction can read the latest handleAsk. Do NOT inline-break
   * the cycle — the ref is the seam.
   */
  handleAskRef: MutableRefObject<HandleAskRefFn>;
}

/**
 * Send modes. `trigger-import` (plugin overlay) and `app-message` (MCP App
 * `ui/message`) are the two STAGED, non-user-authored modes: both carry a provenance
 * envelope, both skip the user bubble, and both classify as a non-`user-keyboard`
 * trust origin in main.
 */
export type SendMode = "default" | "trigger-import" | "app-message" | "mcp-prompt";

/**
 * Send mode → turn-entry origin. A TOTAL map, not a ternary chain: the previous
 * chain fell through to `"user-keyboard"`, so a new staged mode that nobody
 * remembered to branch on would have sent actor-authored text as a fully
 * trusted, user-typed turn. `Record<SendMode, …>` makes omitting a mode a
 * compile error instead.
 */
export const SEND_MODE_ORIGIN: Record<SendMode, ChatSendInputOrigin> = {
  default: "user-keyboard",
  "trigger-import": "plugin-emitted",
  "app-message": "app-emitted",
  "mcp-prompt": "mcp-prompt-emitted",
};

export interface UseSendMessageResult {
  handleAsk: (
    q: string,
    mode?: SendMode,
    userIntent?: UserKeyboardIntentSnapshot,
    opts?: { injectHint?: "queue" | "interrupt"; inputOrigin?: "queue-auto" },
  ) => Promise<void>;
}

/**
 * The composer send pipeline (`handleAsk`), extracted verbatim from App.tsx.
 *
 * Owns `turnRequestRef` (the interrupt/stale-turn guard — used nowhere else) and
 * the full send flow: debug-stream tracing, mid-stream interrupt, the typed-only
 * slash-command shortcuts (/compact + /load), the api-key gate, the vision
 * confirm gate for text-only models, the user-bubble append (skipped for
 * trigger-import), and the chatSend trust-origin classification (queue-auto /
 * plugin-emitted / user-keyboard).
 *
 * Writes `handleAskRef.current = handleAsk` each render to keep the forward-ref
 * cycle with use-routine-overlay's handlePluginPrimaryAction alive.
 */
export function useSendMessage(deps: UseSendMessageDeps): UseSendMessageResult {
  const {
    api, t, streaming, checkApiKey, composeOutgoing,
    appendUserEntry, dropUserEntry, resetStreamAccumulators, beginStreamingRequest, finishStreamingRequest,
    markLastAssistantInterrupted,
    setErrorWithThought, handleCompactCommand, sessionLoad, applyLoadedSession,
    refreshSessionId, refreshSessions, attachments, setAttachments,
    llmVendor, llmModel, llmReadyWithoutApiKey, subscriptionRuntimePolicy,
    settingsReady = true,
    onOpenSettings, setQuestion, handleAskRef,
  } = deps;

  const turnRequestRef = useRef(0);

  const handleAsk = useCallback(
    async (
      q: string,
      mode: SendMode = "default",
      userIntent?: UserKeyboardIntentSnapshot,
      opts?: { injectHint?: "queue" | "interrupt"; inputOrigin?: "queue-auto" },
    ) => {
      // Cache once per invocation — `window.lvis.env.debugStream` is fixed at
      // preload bootstrap, so reading it again per debugLog call is wasted
      // work. Guarding each call site with the cached flag also skips the
      // payload object allocation when diagnostics are off (#566 item 1).
      const debugStreamEnabled = isDebugStreamEnabled();
      if (debugStreamEnabled) debugLog("handleAsk", "enter", { mode, qLen: q.length, streaming });
      const trimmed = q.trim();
      if (!trimmed) {
        if (debugStreamEnabled) debugLog("handleAsk", "skip:empty");
        return;
      }
      // Do not let a fast legacy-key probe race ahead of the authoritative
      // runtime selection. Until settings resolves we cannot know whether a
      // subscription login, rather than an API-key provider, is selected.
      if (!settingsReady) return;
      // `mcp-prompt` joins `default` here because both are USER-initiated: the
      // picker is live while a turn streams, so without this a click lands on
      // `trackStreamTurn` and surfaces a raw "stream already active" error. The
      // staged modes that are NOT user-initiated stay out — they are queued or
      // injected by the host, and must never abort the turn the user is watching.
      if ((mode === "default" || mode === "mcp-prompt") && streaming) {
        // Issue #622: interrupt the current turn and start a new one.
        // chatAbort awaits until the active stream turn settles (interrupted),
        // then returns. The in-flight turn's finally block calls
        // finishStreamingRequest; the turnRequestRef increment below makes
        // its requestId stale so the call is a safe no-op. Partial response
        // is committed to history by post-turn-hook-chain with
        // stopReason="interrupted".
        if (debugStreamEnabled) debugLog("handleAsk", "interrupt:abort-and-proceed");
        try { await api.chatAbort(); } catch { /* no-op */ }
        // Same contract as the stop button: the initiator marks the settled
        // turn interrupted; the engine no longer streams a literal marker.
        markLastAssistantInterrupted?.();
      }
      // Renderer only performs UX-level shortcuts for typed composer input.
      // Main owns the authoritative trust-origin classification.


      if (mode === "default" && opts?.inputOrigin !== "queue-auto") {
        if (await handleCompactCommand(trimmed)) {
          if (debugStreamEnabled) debugLog("handleAsk", "skip:compact-command-handled");
          setQuestion("");
          return;
        }
        if (trimmed === "/load" || trimmed.startsWith("/load ")) {
          const requested = trimmed.slice("/load".length).trim();
          if (requested.length === 0) {
            setErrorWithThought(t("app.loadCommandUsage"));
            return;
          }
          // Ask the widest query the IPC honours — `/load` is scoped by the id
          // the user typed, not by recency or kind. Passing no options here
          // silently inherited the handler defaults (20 rows, kind "main") and
          // disagreed with the engine dispatcher's lookup.
          const listed = await api.chatSessions({ ...SESSION_ID_PREFIX_LOOKUP_QUERY });
          const match = findSessionByIdPrefix(listed.sessions, requested);
          if (!match) {
            setErrorWithThought(t("app.sessionNotFound", { requested }));
            return;
          }
          await sessionLoad(match.id, false, applyLoadedSession);
          await refreshSessionId();
          await refreshSessions();
          if (debugStreamEnabled) debugLog("handleAsk", "load-session:handled", { sessionId: match.id });
          return;
        }
      }
      // Once a subscription runtime is selected its verified chat capability is
      // the only send gate. A stored API key belongs to the inactive runtime and
      // must never make this path sendable while login/verification is pending.
      if (subscriptionRuntimePolicy.subscriptionSelected && subscriptionRuntimePolicy.chatReady !== true) {
        onOpenSettings("llm");
        return;
      }
      if (!subscriptionRuntimePolicy.subscriptionSelected && !llmReadyWithoutApiKey && !(await checkApiKey())) {
        onOpenSettings("llm");
        return;
      }
      // Preserve the draft if the selected login runtime has not explicitly
      // verified the exact attachment flow in use. Image payloads are native
      // provider input; normal files retain LVIS's governed read-tool flow.
      // Missing/pending capability projections fail closed rather than relying
      // on an inactive API-key vendor setting.
      const interactiveComposerSend = mode === "default" && opts?.inputOrigin !== "queue-auto";
      const hasImageAttachment = interactiveComposerSend
        && attachments.some((attachment) => attachment.kind === "image");
      const hasFileAttachment = interactiveComposerSend
        && attachments.some((attachment) => attachment.kind === "file");
      if (
        subscriptionRuntimePolicy.subscriptionSelected
        && (
          (hasImageAttachment && subscriptionRuntimePolicy.imagesReady !== true)
          || (hasFileAttachment && subscriptionRuntimePolicy.filesReady !== true)
          || (
            hasImageAttachment
            && subscriptionImageAttachmentLimitViolation(
              subscriptionRuntimePolicy.imageAttachmentLimits,
              attachments.filter((attachment) => attachment.kind === "image"),
            ) !== null
          )
        )
      ) {
        setErrorWithThought(t("app.subscriptionAttachmentUnsupported", {
          provider: subscriptionRuntimePolicy.provider ?? "subscription",
        }));
        return;
      }
      const requestId = ++turnRequestRef.current;
      const streamingRequestId = beginStreamingRequest();
      if (debugStreamEnabled) debugLog("handleAsk", "begin", { requestId, streamingRequestId });
      // Snapshot BEFORE clearing. `setQuestion("")` commits, and the composer's
      // marker-sync effect reads that empty body, finds no `[...#N]` markers, and drops
      // every attachment — so by the time an awaited send is refused there is nothing
      // left to put back. Restoring only the text would leave the draft carrying
      // `[Resource #1]` with no attachment behind it: a dangling reference that resends
      // as a marker the model cannot resolve, silently.
      const draftAttachments = attachments;
      setQuestion("");
      // Staged modes send the enveloped text VERBATIM — composeOutgoing's composer
      // affordances (attachment markers, persona prompt) belong to typed input only.
      const composed = mode === "default"
        ? composeOutgoing(trimmed)
        : composeImportedTriggerOutgoing(trimmed);
      const outgoing = composed.text;


      let outgoingAttachments = opts?.inputOrigin === "queue-auto" ? [] : composed.attachments;
      // Vendor vision capability gate. The composer accepts images
      // regardless of the active model so the user can switch models
      // freely; check at send time and confirm before silently dropping
      // image parts on a text-only model.
      const hasImageParts = outgoingAttachments.some((p) => p.type === "image");
      const subscriptionRuntimeOwnsImageCapability = subscriptionRuntimePolicy.subscriptionSelected;
      if (hasImageParts && !subscriptionRuntimeOwnsImageCapability && !supportsVision(llmVendor, llmModel)) {
        const proceed = window.confirm(t("app.visionNotSupportedConfirm", { llmModel }));
        if (!proceed) {
          // Restore the original (untrimmed) draft text so the user can
          // switch models and resend without retyping. We use `q` rather
          // than `t = q.trim()` to preserve any intentional leading /
          // trailing whitespace or newlines the user typed. setQuestion("")
          // was called above before we knew about this guard branch.
          setQuestion(q);
          if (turnRequestRef.current === requestId) finishStreamingRequest(streamingRequestId);
          return;
        }
        outgoingAttachments = outgoingAttachments.filter((p) => p.type !== "image");
      }
      // Staged modes skip only the user-bubble append. The imported_trigger marker
      // already represents the plugin-authored / app-authored prompt visibly, and
      // rendering the wrapped envelope as a user bubble would misattribute authorship.
      if (mode === "default") {
        appendUserEntry(trimmed, opts?.injectHint);
      }
      resetStreamAccumulators();
      try {
        await api.chatSend(
          outgoing,
          outgoingAttachments,
          opts?.inputOrigin === "queue-auto" ? "queue-auto" : SEND_MODE_ORIGIN[mode],


          opts?.inputOrigin === "queue-auto"
            ? undefined
            : mode === "default" ? userIntent : undefined,
          opts?.inputOrigin === "queue-auto"
            ? undefined
            : mode === "default" ? composed.personaPromptId : undefined,
        );
        if (debugStreamEnabled) debugLog("handleAsk", "chatSend:resolved", { requestId });
        // After successful send, clear attachments — the textarea was
        // already cleared by setQuestion(""). N counter persists across
        // turns so re-attached items get fresh numbers.
        if (outgoingAttachments.length > 0 || attachments.length > 0) {
          setAttachments([]);
        }
      } catch (err) {
        if (debugStreamEnabled) {
          debugLog("handleAsk", "chatSend:rejected", {
            requestId,
            err: (err as Error)?.message,
          });
        }
        // A rejected send carries an IPC code as its message — the send gate and the
        // stream chokepoint both THROW their fail-closed code rather than returning
        // an `{ok:false}` frame, so it never passes the code→sentence table. Electron
        // wraps a rejection as `Error invoking remote method '<ch>': Error: <code>`,
        // hence recovering the code from the tail. Anything unmapped keeps the
        // previous localized framing — an unmapped failure must not lose it just
        // because this path learned to map the mapped ones.
        const rawMessage = (err as Error).message;
        const code = rawMessage.match(/(?:^|Error:\s*)([a-z][a-z0-9-]*)\s*$/)?.[1];
        const mappedKey = resolveIpcErrorKey(code);
        setErrorWithThought(
          mappedKey ? t(mappedKey) : t("app.errorGeneric", { message: rawMessage }),
        );
        // Put the turn back the way it was. The bubble was appended optimistically and
        // the composer was cleared before the IPC resolved; a REFUSED send means main
        // recorded nothing, so leaving either would show the user a message that was
        // never sent and lose the text they typed. The vision-capability guard above
        // already restores the draft for its own refusal — this is the same repair for
        // every other one, which until now only the guard had.
        //
        if (mode === "default") {
          dropUserEntry(trimmed);
          // Text AND attachments, together. They are one thing: the composer derives its
          // chips from the markers in the body, so a body restored without its
          // attachments is a draft with dangling references. Restored only when the
          // composer is still empty, so a draft started during the send wins.
          if (draftAttachments.length > 0) {
            setAttachments((current) => (current.length > 0 ? current : draftAttachments));
          }
          // Restored INSIDE the guard. For a staged mode `q` is the provenance
          // ENVELOPE, not anything the user typed (`App.tsx` hands this function
          // `outcome.envelope` for an MCP-server prompt), and putting that in the
          // composer would hand the user server-authored text as their own draft —
          // the laundering shape this whole feature exists to prevent, reintroduced by
          // the repair for a UX complaint. The send gate does reject it
          // (`origin-envelope-mismatch`), so nothing downstream would treat it as
          // staged; it should never be offered in the first place.
          //
          // Functional form so a draft typed WHILE the send was in flight wins over the
          // one being restored — the same race the composer's own `textRef` handles.
          setQuestion((current) => (current.length > 0 ? current : q));
        }
      } finally {
        const turnMatch = turnRequestRef.current === requestId;
        if (debugStreamEnabled) {
          debugLog("handleAsk", "finally", {
            requestId,
            currentTurnRef: turnRequestRef.current,
            turnMatch,
            willCallFinish: turnMatch,
          });
        }
        if (turnMatch) finishStreamingRequest(streamingRequestId);
      }
    },
    [
      api,
      streaming,
      checkApiKey,
      composeOutgoing,
      appendUserEntry,
      dropUserEntry,
      resetStreamAccumulators,
      beginStreamingRequest,
      finishStreamingRequest,
      setErrorWithThought,
      handleCompactCommand,
      sessionLoad,
      applyLoadedSession,
      refreshSessionId,
      refreshSessions,
      // attachments is read directly at the post-send cleanup branch
      // (line ~260) and is also a transitive dep via composeOutgoing,
      // but listing it explicitly avoids stale-closure surprises if
      // composeOutgoing's deps drift. llmVendor/llmModel are read by
      // the supportsVision gate.
      attachments,
      llmVendor,
      llmModel,
      llmReadyWithoutApiKey,
      subscriptionRuntimePolicy,
      settingsReady,
      onOpenSettings,
      setAttachments,
      setQuestion,
      t,
    ],
  );
  // Keep ref in sync so handlePluginPrimaryAction can call handleAsk
  // without a forward-declaration error (ref is populated before first use).
  handleAskRef.current = handleAsk;

  return { handleAsk };
}
