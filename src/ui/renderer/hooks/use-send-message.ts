import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { debugLog, isDebugStreamEnabled } from "../../../lib/debug-stream.js";
import { supportsVision } from "../../../engine/llm/vendor-capabilities.js";
import {
  composeImportedTriggerOutgoing,
  composeOutgoing as composeOutgoingUtil,
} from "../utils/compose.js";
import type { getApi } from "../api-client.js";
import type { useTranslation } from "../../../i18n/react.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import type { Attachment } from "../types/attachments.js";
import type { useChatState } from "./use-chat-state.js";
import type { useSessions } from "./use-sessions.js";
import type { useSettings } from "./use-settings.js";
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
  resetStreamAccumulators: ChatState["resetStreamAccumulators"];
  beginStreamingRequest: ChatState["beginStreamingRequest"];
  finishStreamingRequest: ChatState["finishStreamingRequest"];
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
export type SendMode = "default" | "trigger-import" | "app-message";

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
    appendUserEntry, resetStreamAccumulators, beginStreamingRequest, finishStreamingRequest,
    setErrorWithThought, handleCompactCommand, sessionLoad, applyLoadedSession,
    refreshSessionId, refreshSessions, attachments, setAttachments,
    llmVendor, llmModel, llmReadyWithoutApiKey, onOpenSettings, setQuestion, handleAskRef,
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
      if (mode === "default" && streaming) {
        // Issue #622: interrupt the current turn and start a new one.
        // chatAbort awaits until the active stream turn settles (interrupted),
        // then returns. The in-flight turn's finally block calls
        // finishStreamingRequest; the turnRequestRef increment below makes
        // its requestId stale so the call is a safe no-op. Partial response
        // is committed to history by post-turn-hook-chain with
        // stopReason="interrupted".
        if (debugStreamEnabled) debugLog("handleAsk", "interrupt:abort-and-proceed");
        try { await api.chatAbort(); } catch { /* no-op */ }
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
          const listed = await api.chatSessions();
          const match = listed.sessions.find((session) => session.id.startsWith(requested));
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
      if (!llmReadyWithoutApiKey && !(await checkApiKey())) {
        onOpenSettings("llm");
        return;
      }
      const requestId = ++turnRequestRef.current;
      const streamingRequestId = beginStreamingRequest();
      if (debugStreamEnabled) debugLog("handleAsk", "begin", { requestId, streamingRequestId });
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
      if (hasImageParts && !supportsVision(llmVendor, llmModel)) {
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
          opts?.inputOrigin === "queue-auto"
            ? "queue-auto"
            : mode === "trigger-import"
              ? "plugin-emitted"
              : mode === "app-message"
                ? "app-emitted"
                : "user-keyboard",


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
        setErrorWithThought(t("app.errorGeneric", { message: (err as Error).message }));
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
