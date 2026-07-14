/**
 * Chat domain IPC handlers.
 * Covers: lvis:chat:*, lvis:memory:*, lvis:starred:*, lvis:feedback:submit,
 *         lvis:ask-user-question:respond
 * Note: routine v2 channels (lvis:routines:v2:*) are handled in misc.ts.
 *
 * C10 (#1409): the PUBLIC chat channels (send / sessions / get-history /
 * session-history) delegate to transport-agnostic pure handlers in
 * `../handlers/chat.ts`; this module keeps only the thin `ipcMain.handle`
 * wrappers (trust boundary + webContents sink construction) and the
 * internal / session-scoped handlers inline. The `lvis:chat:stream` fan-out is
 * published through a {@link ChatStreamSink} so a future in-process api/cli/sdk
 * can subscribe to the exact same frames the renderer receives.
 */
import { ipcMain } from "electron";
import type { WebContents } from "electron";
import { t } from "../../i18n/index.js";
import type { ActiveRolePrompt } from "../../data/role-presets.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import { userContentText } from "../../engine/llm/types.js";
import type { TurnResult } from "../../engine/conversation-loop.js";
import type { ChatUtteranceMode } from "../../shared/chat-utterance.js";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { sendToWebContents } from "../safe-send.js";
import { createLogger } from "../../lib/logger.js";
import { readDiffSidecar, isSafeId } from "../../tools/write-diff-cache.js";
import { isToolResultStubContent } from "../../shared/tool-result-stub.js";
import type { LLMSettings } from "../../data/settings-store.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";
import {
  runStreamedTurn,
  STREAM_TURN_OPTIONS,
  type ChatStreamSink,
} from "../handlers/chat-stream.js";
import {
  handleChatSend,
  handleChatSessions,
  handleChatGetHistory,
  handleChatSessionHistory,
  isSafeSessionId,
  personaPromptIdFromUserMessage,
  resolvePersonaRolePrompt,
  sanitizeOutgoingInput,
  markMainActiveAfterTurn,
  prepareParentMailboxTurn,
  acknowledgeParentMailboxAfterTurn,
  resolveChatNewProjectPayload,
} from "../handlers/chat.js";
import { getDefaultWorkspaceRoot } from "../../main/default-workspace-root.js";
import { resolveAuthorizedWorkspaceProject } from "../../main/project-root-authorization.js";
import { createDlpSafeUuid } from "../../shared/dlp-safe-id.js";
const log = createLogger("chat");
const MAX_MEMORY_PROJECT_ROOT_CHARS = 2_048;
const MAX_MEMORY_PROJECT_NAME_CHARS = 120;
const PROJECT_NOT_ALLOWED = { ok: false, error: "project-not-allowed" } as const;

// ─── Chat import (#1500 / E3) — reverse of chat.export ────────────────────
// Mirrors the export SOT shape (chat.export handler below, JSON branch):
// `{ sessionId, exportedAt, messages: GenericMessage[] }`. Import re-uses
// the same size guard the session-search linear scan used to enforce
// (MAX_SESSION_FILE_BYTES) as a DoS gate on the imported file itself.
const MAX_SESSION_FILE_BYTES = 5_000_000;
// Symmetric ceiling to the byte cap above: a JSON file can stay under 5 MB yet
// still carry an absurd number of tiny messages (e.g. hundreds of thousands of
// `{"role":"user","content":""}`), each of which becomes a persisted session
// line + an FTS index row. Cap the message count so import cost is bounded on
// BOTH axes (total bytes AND element count), not just bytes.
const MAX_IMPORTED_MESSAGES = 100_000;

const USER_CONTENT_PART_KEYS: Record<string, readonly string[]> = {
  text: ["type", "text"],
  image: ["type", "image", "mimeType", "width", "height", "bytes"],
  file: ["type", "data", "mimeType"],
};

function hasOnlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every((k) => allowed.includes(k));
}

function isValidUserContentPart(part: unknown): boolean {
  if (!part || typeof part !== "object" || Array.isArray(part)) return false;
  const p = part as Record<string, unknown>;
  const type = p.type;
  if (typeof type !== "string" || !(type in USER_CONTENT_PART_KEYS)) return false;
  if (!hasOnlyKeys(p, USER_CONTENT_PART_KEYS[type])) return false;
  if (type === "text") return typeof p.text === "string";
  if (type === "image") return typeof p.image === "string";
  if (type === "file") return typeof p.data === "string" && typeof p.mimeType === "string";
  return false;
}

function isValidToolCallBlock(call: unknown): boolean {
  if (!call || typeof call !== "object" || Array.isArray(call)) return false;
  const c = call as Record<string, unknown>;
  if (!hasOnlyKeys(c, ["id", "name", "input"])) return false;
  return (
    typeof c.id === "string" &&
    typeof c.name === "string" &&
    !!c.input &&
    typeof c.input === "object" &&
    !Array.isArray(c.input)
  );
}

/**
 * Strictly validates one imported message against the `GenericMessage`
 * union (src/engine/llm/types.ts). Whitelist-only: any key outside the
 * role's known field set rejects the ENTIRE import (fail-closed — imported
 * JSON is untrusted input that must not smuggle arbitrary fields into a
 * session record). `meta` is deliberately excluded from every role's
 * allowed-key set: it carries engine-internal bookkeeping (turn summaries,
 * checkpoint/compaction state) that has no meaning for a freshly-imported
 * conversation and is dropped rather than round-tripped.
 */
function isValidImportedMessage(raw: unknown): raw is GenericMessage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const m = raw as Record<string, unknown>;
  switch (m.role) {
    case "user": {
      if (!hasOnlyKeys(m, ["role", "content"])) return false;
      if (typeof m.content === "string") return true;
      return Array.isArray(m.content) && m.content.every(isValidUserContentPart);
    }
    case "assistant": {
      if (!hasOnlyKeys(m, ["role", "content", "thought", "toolCalls"])) return false;
      if (typeof m.content !== "string") return false;
      if (m.thought !== undefined && typeof m.thought !== "string") return false;
      if (m.toolCalls !== undefined) {
        if (!Array.isArray(m.toolCalls) || !m.toolCalls.every(isValidToolCallBlock)) return false;
      }
      return true;
    }
    case "tool_result": {
      if (!hasOnlyKeys(m, ["role", "content", "toolName", "toolUseId", "isError"])) return false;
      if (typeof m.content !== "string") return false;
      if (typeof m.toolUseId !== "string") return false;
      if (m.toolName !== undefined && typeof m.toolName !== "string") return false;
      if (m.isError !== undefined && typeof m.isError !== "boolean") return false;
      return true;
    }
    default:
      return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function hasParentSubAgentReference(
  messages: GenericMessage[],
  childSessionId: string,
): boolean {
  const resultByToolUseId = new Map<string, Record<string, unknown> | null>();
  for (const message of messages) {
    if (message.role === "tool_result") {
      resultByToolUseId.set(message.toolUseId, parseJsonRecord(message.content));
    }
  }

  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.toolCalls)) continue;
    for (const toolCall of message.toolCalls) {
      if (toolCall.name !== "agent_spawn") continue;
      const input = asRecord(toolCall.input) ?? {};
      const result = resultByToolUseId.get(toolCall.id) ?? null;
      const linkedIds = [
        typeof input.resumeId === "string" ? input.resumeId : undefined,
        typeof result?.childSessionId === "string" ? result.childSessionId : undefined,
        typeof result?.resumeId === "string" ? result.resumeId : undefined,
      ];
      if (!linkedIds.includes(childSessionId)) continue;
      return true;
    }
  }
  return false;
}

interface ImportValidationResult {
  ok: boolean;
  messages: GenericMessage[];
  error?: string;
}

/**
 * Validates the top-level shape `{ sessionId, exportedAt, messages }` and
 * every message inside `messages`. Rejects the whole file on the first
 * invalid message (no partial-import — a rejected batch either imports in
 * full or not at all, preventing session-content corruption).
 */
function validateImportedSessionJson(raw: unknown): ImportValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, messages: [], error: "invalid-file-shape" };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || typeof r.exportedAt !== "string" || !Array.isArray(r.messages)) {
    return { ok: false, messages: [], error: "invalid-file-shape" };
  }
  if (r.messages.length === 0) {
    return { ok: false, messages: [], error: "empty-messages" };
  }
  // Element-count ceiling symmetric with the byte cap the handler enforces on
  // the file itself — bounds import cost on the message-count axis too.
  if (r.messages.length > MAX_IMPORTED_MESSAGES) {
    return { ok: false, messages: [], error: "too-many-messages" };
  }
  for (const candidate of r.messages) {
    if (!isValidImportedMessage(candidate)) {
      return { ok: false, messages: [], error: "invalid-message-shape" };
    }
  }
  // Re-derive plain objects containing ONLY the whitelisted keys per role —
  // never persist the caller's original object references (defense in depth
  // even though isValidImportedMessage already rejected unknown keys).
  const messages = (r.messages as GenericMessage[]).map((m): GenericMessage => {
    switch (m.role) {
      case "user":
        return { role: "user", content: m.content };
      case "assistant":
        return {
          role: "assistant",
          content: m.content,
          ...(m.thought !== undefined ? { thought: m.thought } : {}),
          ...(m.toolCalls !== undefined ? { toolCalls: m.toolCalls } : {}),
        };
      case "tool_result":
        return {
          role: "tool_result",
          toolUseId: m.toolUseId,
          content: m.content,
          ...(m.toolName !== undefined ? { toolName: m.toolName } : {}),
          ...(m.isError !== undefined ? { isError: m.isError } : {}),
        };
    }
  });
  return { ok: true, messages };
}

interface MemoryProjectOptions {
  projectRoot?: string;
  projectName?: string;
  includeUnscoped?: boolean;
}

type MemoryProjectOptionsResolution =
  | { ok: true; options: MemoryProjectOptions }
  | { ok: false; error: "project-not-allowed" };

function normalizeMemoryProjectString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxChars) : undefined;
}

function parseMemoryProjectOptions(raw: unknown): MemoryProjectOptionsResolution {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: true, options: {} };
  }
  const record = raw as Record<string, unknown>;
  const projectRoot = normalizeMemoryProjectString(record.projectRoot, MAX_MEMORY_PROJECT_ROOT_CHARS);
  const projectName = normalizeMemoryProjectString(record.projectName, MAX_MEMORY_PROJECT_NAME_CHARS);
  const resolved = resolveAuthorizedWorkspaceProject(projectRoot, projectName);
  if (!resolved.authorized || !resolved.project) return PROJECT_NOT_ALLOWED;
  return {
    ok: true,
    options: {
      projectRoot: resolved.project.projectRoot,
      projectName: resolved.project.projectName,
      ...(resolved.project.isDefault === true ? { includeUnscoped: true } : {}),
      ...(record.includeUnscoped === true && resolved.project.isDefault === true ? { includeUnscoped: true } : {}),
    },
  };
}

/**
 * Stable signature of EVERY vendor block's configured `baseUrl` (order-stable
 * by vendor id). Mirrors the helper in settings.ts; kept local to avoid a
 * cross-domain import dependency. Used to guard ASRT sandbox live-refresh calls
 * so the refresh fires only when an endpoint actually changed.
 */
function vendorBaseUrlSignature(llm: LLMSettings): string {
  const vendors = llm.vendors ?? {};
  return Object.keys(vendors)
    .sort()
    .map((id) => `${id}=${vendors[id as keyof typeof vendors]?.baseUrl ?? ""}`)
    .join("|");
}

export type { SerializedHistoryMessage } from "../../shared/chat-history.js";

function removeOrphanToolUse(messages: GenericMessage[]): GenericMessage[] {
  const result = [...messages];
  const resolvedIds = new Set<string>();
  for (const m of result) {
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const block of m.content as Array<Record<string, unknown>>) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          resolvedIds.add(block.tool_use_id);
        }
      }
    }
  }
  for (let i = result.length - 1; i >= 0; i--) {
    const m = result[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) break;
    const blocks = m.content as Array<Record<string, unknown>>;
    const hasOrphan = blocks.some(
      (b) => b.type === "tool_use" && typeof b.id === "string" && !resolvedIds.has(b.id),
    );
    if (!hasOrphan) break;
    result.splice(i, 1);
  }
  return result;
}

function entryOrdinalToHistoryIndex(history: GenericMessage[], ordinal: number): number {
  if (ordinal < 0) return -1;
  let count = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === "user" || history[i].role === "assistant") {
      if (count === ordinal) return i;
      count += 1;
    }
  }
  return -1;
}

export function registerChatHandlers(deps: IpcDeps): void {
  const {
    conversationLoop,
    settingsService,
    memoryManager,
    starredStore,
    feedbackStore,
    auditLogger,
    askUserQuestionGate,
    preferenceRefreshService,
    personaPromptStore,
    getMainWindow,
  } = deps;

  // Build a ChatStreamSink bound to a specific webContents. The IPC sink is a
  // byte-identical wrapper over the pre-C10 `sendToWebContents` fan-out; a
  // future api/cli surface supplies its own sink over the same frames.
  const buildSink = (wc: WebContents | undefined): ChatStreamSink =>
    (channel, payload) => sendToWebContents(wc, channel, payload, log);

  // read-only, sender guard optional
  ipcMain.handle(CHANNELS.chat.hasProvider, () => conversationLoop.hasProvider());
  ipcMain.handle(CHANNELS.llm.ping, async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.llm.ping, e);
      return UNAUTHORIZED_FRAME;
    }
    return conversationLoop.pingProvider();
  });

  const STREAMING_ACTIVE = "streaming-active" as const;
  let activeStreamTurn: Promise<TurnResult> | null = null;
  let activeSessionMutation: Promise<unknown> | null = null;
  let nextStreamId = 0;
  const trackStreamTurn = (factory: () => Promise<TurnResult>) => {
    if (activeStreamTurn !== null || activeSessionMutation !== null) {
      return Promise.reject(new Error(STREAMING_ACTIVE));
    }
    // Publish the lease before factory code can run. Promise.resolve().then()
    // defers even a synchronously-entering factory (for example mailbox peek),
    // closing the re-entrant new/resume/fork TOCTOU window.
    const turnPromise = Promise.resolve().then(factory).finally(() => {
      if (activeStreamTurn === turnPromise) activeStreamTurn = null;
    });
    activeStreamTurn = turnPromise;
    return turnPromise;
  };
  const trackSessionMutation = <T>(factory: () => Promise<T>): Promise<T> | null => {
    if (activeStreamTurn !== null || activeSessionMutation !== null) return null;
    // Acquire synchronously and execute after the lease is visible. The lease
    // spans every await in fork/checkpoint persistence.
    const mutationPromise = Promise.resolve().then(factory).finally(() => {
      if (activeSessionMutation === mutationPromise) activeSessionMutation = null;
    });
    activeSessionMutation = mutationPromise;
    return mutationPromise;
  };
  const allocateStreamId = () => ++nextStreamId;
  const streamTurn = async (
    input: string,
    attachments?: import("../../engine/llm/types.js").UserContentPart[],
    rolePrompt?: ActiveRolePrompt,
  ) => {
    const win = getMainWindow();
    const sink = buildSink(win?.webContents);
    const streamId = allocateStreamId();
    return trackStreamTurn(async () => {
      const result = await runStreamedTurn(
        conversationLoop,
        input,
        sink,
        streamId,
        {
          ...STREAM_TURN_OPTIONS,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          ...(rolePrompt ? { rolePrompt } : {}),
        },
      );
      await markMainActiveAfterTurn(deps, input);
      return result;
    });
  };

  // D3 opt-in wake is registered once the parent stream coordinator exists.
  // It never changes the active session: a race with user navigation or a
  // manual turn leaves the durable mailbox untouched for a later user turn.
  type WakeAwareRunner = {
    setParentWakeHandler?: (handler: (parentSessionId: string) => Promise<void>) => void;
  };
  const wakeAwareRunner = deps.getSubAgentRunner?.() as WakeAwareRunner | undefined;
  if (typeof wakeAwareRunner?.setParentWakeHandler === "function") {
    wakeAwareRunner.setParentWakeHandler(async (parentSessionId) => {
      // A child result can arrive after the last round boundary but before the
      // stream or session lease releases. Capture that one lease and await it
      // once. The bus invokes this handler from a detached side promise, so a
      // synchronous onDropped callback never waits on its own active turn.
      // There is deliberately no timer, polling, or parking loop.
      const leaseAtRequest = activeStreamTurn ?? activeSessionMutation;
      if (leaseAtRequest !== null) {
        try {
          await leaseAtRequest;
        } catch {
          // Failed/interrupted work still releases its lease. The durable
          // mailbox remains eligible for the same one-time revalidation.
        }
      }

      if (
        conversationLoop.getSessionKind() !== "main"
        || conversationLoop.getSessionId() !== parentSessionId
        || activeStreamTurn !== null
        || activeSessionMutation !== null
        || conversationLoop.hasActiveTurn()
      ) {
        return;
      }

      const win = getMainWindow();
      const sink = buildSink(win?.webContents);
      const streamId = allocateStreamId();
      await trackStreamTurn(async () => {
        // Snapshot only after the turn lease is visible. A concurrent manual
        // send or session mutation then fails closed before it can switch the
        // loop or consume the same durable mailbox entries.
        const mailboxTurn = await prepareParentMailboxTurn(deps);
        if (
          !mailboxTurn
          || mailboxTurn.parentSessionId !== parentSessionId
          || conversationLoop.getSessionId() !== parentSessionId
          || conversationLoop.hasActiveTurn()
        ) {
          return { text: "", toolCalls: [], route: "default", stopReason: "blocked" };
        }
        const result = await runStreamedTurn(
          conversationLoop,
          mailboxTurn.initialGuidance,
          sink,
          streamId,
          {
            ...STREAM_TURN_OPTIONS,
            inputOrigin: "agent-message",
            approvalReasonPrefix: mailboxTurn.approvalReasonPrefix,
          },
        );
        if (conversationLoop.getSessionId() !== parentSessionId) return result;
        await acknowledgeParentMailboxAfterTurn(deps, mailboxTurn, result);
        await markMainActiveAfterTurn(deps, mailboxTurn.initialGuidance);
        return result;
      });
    });
  }
  // PUBLIC lvis:chat:send — thin wrapper: trust boundary + sink construction,
  // logic in handlers/chat.ts. The stream/redact/fallback frames the renderer
  // receives are byte-identical to the pre-C10 fan-out.
  ipcMain.handle(CHANNELS.chat.send, async (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.send, e); return UNAUTHORIZED_FRAME; }
    if (activeStreamTurn !== null || activeSessionMutation !== null) {
      return { error: STREAMING_ACTIVE };
    }
    const win = getMainWindow();
    const sink = buildSink(win?.webContents);
    try {
      return await handleChatSend(deps, payload, { sink, allocateStreamId, trackStreamTurn });
    } catch (error) {
      if (error instanceof Error && error.message === STREAMING_ACTIVE) {
        return { error: STREAMING_ACTIVE };
      }
      throw error;
    }
  });

  // "guide" — non-interrupting mid-stream direction adjustment. Queues
  // the user's text so the engine consumes it at the next assistant-round
  // boundary (between tool execution and the next LLM stream). The
  // in-flight LLM call and its tool round are NOT aborted.
  //
  // Contract diverges from the pre-#623 handler (which aborted + restarted
  // with a guidance prompt template) — see `src/shared/chat-utterance.ts`
  // for the full 4-mode taxonomy.
  //
  // Atomicity: the `currentAbortController` check is folded INTO
  // `queueGuidance` so the renderer can never lose a guide to a turn that
  // ended between the active-turn check and the enqueue (critic MAJOR #2 /
  // code-reviewer MAJOR #3). The IPC return value drives the renderer's
  // "keep typed text vs. clear" decision.
  ipcMain.handle(CHANNELS.chat.guide, async (e, input: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.chat.guide, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof input !== "string" || input.trim().length === 0) {
      return { ok: false, error: "empty-text" };
    }
    // PII redaction applies to guide input too — same trust origin
    // (user-keyboard) and same downstream LLM consumption as chatSend.
    // The `redact_notice` stream event uses the active turn's streamId
    // implicitly (sanitizeOutgoingInput sends to the host webContents
    // directly — renderer surfaces under the current streaming context).
    const win = getMainWindow();
    const effective = sanitizeOutgoingInput(settingsService, buildSink(win?.webContents), input);
    const queueResult = conversationLoop.queueGuidance(effective);
    if (queueResult === "queued") {
      // Audit successful guide as a mutating state transition (parity with
      // `lvis:feedback:submit` and other mutating IPC calls — security
      // reviewer M2). Log metadata only; the text already passed
      // `sanitizeOutgoingInput` but logging it widens the disclosure
      // surface unnecessarily. `mode` tag uses the shared utterance
      // taxonomy so audit consumers can correlate guide/start/stop/abort
      // calls across handlers.
      const mode: ChatUtteranceMode = "guide";
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: conversationLoop.getSessionId(),
        type: "info",
        input: `chat:utterance:${mode}:queued:len=${effective.length}`,
      });
      return { ok: true };
    }
    return { ok: false, error: queueResult };
  });

  ipcMain.handle(CHANNELS.chat.abort, async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.abort, e); return UNAUTHORIZED_FRAME; }
    conversationLoop.abortCurrentTurn();
    if (activeStreamTurn) {
      try {
        await activeStreamTurn;
      } catch {
        // expected: interrupted turns may reject
      }
    }
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.chat.new, async (e, rawProject?: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.new, e); return UNAUTHORIZED_FRAME; }
    const mutation = trackSessionMutation(async () => {
      const parsed = resolveChatNewProjectPayload(rawProject, getDefaultWorkspaceRoot());
      const resolved = resolveAuthorizedWorkspaceProject(parsed.projectRoot, parsed.projectName);
      if (!resolved.authorized || !resolved.project) return PROJECT_NOT_ALLOWED;
      const { project } = resolved;
      conversationLoop.newConversation("main", project);
      // Persist the resolved project identity to the new session's metadata at
      // creation — mirroring startRoutineConversation — but ONLY when the user
      // explicitly selected a real (non-default) project. A session created
      // with no explicit project (the common case: plain "New Chat") runs
      // against the default/base-directory binding internally (unaffected —
      // conversationLoop.newConversation above already applied it for tool
      // access) but must NOT be tagged with it in metadata: "no project" (null
      // fields) is the normal persisted state, so the sidebar renders it as a
      // plain ungrouped conversation and Insights buckets it under "No
      // project" rather than a synthetic "default"/"Current Project" label
      // (2026-07 "remove Current Project labeling" refinement). Full-overwrite
      // is safe: the session is brand new.
      if (!project.isDefault && (project.projectRoot || project.projectName)) {
        await memoryManager.saveSessionMetadata(conversationLoop.getSessionId(), {
          sessionKind: "main",
          ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
          ...(project.projectName ? { projectName: project.projectName } : {}),
        });
      }
      await memoryManager.markMainActiveFresh();
      return { ok: true as const };
    });
    return mutation ?? { ok: false as const, error: STREAMING_ACTIVE };
  });
  // PUBLIC lvis:chat:sessions — read-only; sender guard optional. On rejection
  // returns the same shape (active id + empty list) as before; logic delegated.
  ipcMain.handle(CHANNELS.chat.sessions, (e, opts?: { limit?: unknown; before?: unknown; beforeId?: unknown; after?: unknown; kind?: unknown; routineId?: unknown; projectRoot?: unknown }) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.chat.sessions, e);
      return { current: conversationLoop.getSessionId(), sessions: [] };
    }
    return handleChatSessions(deps, opts);
  });

  ipcMain.handle(CHANNELS.chat.compact, (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.compact, e); return UNAUTHORIZED_FRAME; }
    // Wire onCompactStarted/onCompactOccurred so slash-/compact also shows
    // the "자동 압축 중..." StatusBar indicator (parity with token preflight
    // path which gets it via runStreamedTurn callbacks). streamId is omitted
    // because manualCompact runs outside the per-turn stream.
    return conversationLoop.manualCompact({
      onCompactStarted: ({ triggerSource, estimatedBefore, preflight }) =>
        sendToWebContents(e.sender, CHANNELS.chat.stream, { type: "compact_started", triggerSource, estimatedBefore, preflight }, log),
      onCompactOccurred: ({ removedMessages, freedTokens, estimatedAfter, trigger, summary, compactNum, compactStatus, truncatedDir }) =>
        sendToWebContents(e.sender, CHANNELS.chat.stream, {
          type: "compact_notice",
          removedMessages,
          freedTokens,
          estimatedAfter,
          ...(trigger !== undefined ? { trigger } : {}),
          ...(summary !== undefined ? { summary } : {}),
          ...(compactNum !== undefined ? { compactNum } : {}),
          ...(compactStatus !== undefined ? { compactStatus } : {}),
          ...(truncatedDir !== undefined ? { truncatedDir } : {}),
        }, log),
    });
  });

  ipcMain.handle(CHANNELS.chat.sessionResume, async (e, sessionId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.sessionResume, e); return UNAUTHORIZED_FRAME; }
    if (!isSafeSessionId(sessionId)) {
      return { ok: false, compacted: false, compactedAt: null, removedMessageCount: 0 };
    }
    const mutation = trackSessionMutation(async () => {
      const result = conversationLoop.resetAndResume(sessionId);
      if (result.ok && conversationLoop.getSessionKind() === "main") {
        await memoryManager.markMainActiveResume(sessionId).catch((err: unknown) => {
          log.warn("session-resume markMainActiveResume failed: %s", (err as Error).message);
        });
      }
      return result;
    });
    return mutation ?? {
      ok: false,
      compacted: false,
      compactedAt: null,
      removedMessageCount: 0,
      error: STREAMING_ACTIVE,
    };
  });
  // PUBLIC lvis:chat:get-history — read-only, sender guard optional. Returns the
  // active session's serialized history; logic delegated.
  ipcMain.handle(CHANNELS.chat.getHistory, () => handleChatGetHistory(deps));

  ipcMain.handle(CHANNELS.chat.mainActiveState, (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.chat.mainActiveState, e);
      return null;
    }
    return memoryManager.loadMainActiveSessionState();
  });

  // PUBLIC lvis:chat:session-history — read-only: load messages for any session
  // by id (does NOT change active session). Delegated; the unauthorized frame
  // keeps the success-path shape so callers always read `result.ok`/`.messages`.
  ipcMain.handle(CHANNELS.chat.sessionHistory, (e, sessionId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.chat.sessionHistory, e);
      // Keep the shape consistent with the success path — renderer always
      // reads `result.messages` and `result.ok`. Returning the bare
      // UNAUTHORIZED_FRAME (which omits `messages`) would force every caller
      // to widen the type and check before reading.
      return { ok: false, messages: [], error: "unauthorized-frame" as const };
    }
    return handleChatSessionHistory(deps, sessionId);
  });

  ipcMain.handle(CHANNELS.chat.editResend, async (e, messageIndex: number, newText: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.editResend, e); return UNAUTHORIZED_FRAME; }
    if (typeof messageIndex !== "number" || messageIndex < 0) return { ok: false, error: "invalid-index" };
    if (typeof newText !== "string" || newText.trim().length === 0) return { ok: false, error: "empty-text" };
    const history = conversationLoop.getHistory().getMessages() as GenericMessage[];
    const historyIndex = entryOrdinalToHistoryIndex(history, messageIndex);
    if (historyIndex < 0) return { ok: false, error: "index-out-of-range" };
    const personaPromptId = personaPromptIdFromUserMessage(history[historyIndex]);
    if (!personaPromptId.ok) return { ok: false, error: personaPromptId.error };
    const personaPrompt = await resolvePersonaRolePrompt(personaPromptStore, personaPromptId.personaPromptId);
    if (!personaPrompt.ok) return { ok: false, error: personaPrompt.error };
    conversationLoop.getHistory().truncate(historyIndex);
    const result = await streamTurn(newText, undefined, personaPrompt.rolePrompt);
    return { ok: true, result };
  });

  ipcMain.handle(CHANNELS.chat.fork, async (e, messageIndex: number) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.fork, e); return UNAUTHORIZED_FRAME; }
    const mutation = trackSessionMutation(async () => {
      const current = conversationLoop.getHistory().getMessages() as GenericMessage[];
      let upto = current.length;
      if (typeof messageIndex === "number" && messageIndex >= 0) {
        const historyIndex = entryOrdinalToHistoryIndex(current, messageIndex);
        if (historyIndex >= 0) upto = Math.min(historyIndex + 1, current.length);
      }
      let slice = current.slice(0, upto);
      slice = removeOrphanToolUse(slice);
      if (current.length > 0) {
        await memoryManager.saveSession(conversationLoop.getSessionId(), current);
      }
      const newId = createDlpSafeUuid();
      const sourceSessionId = conversationLoop.getSessionId();
      const forkSlice = memoryManager.rehydrateToolResultArtifacts(sourceSessionId, slice) as GenericMessage[];
      await memoryManager.saveSession(newId, forkSlice);
      const currentMeta = memoryManager.loadSessionMetadata(sourceSessionId);
      await memoryManager.saveSessionMetadata(newId, {
        sessionKind: currentMeta?.sessionKind ?? conversationLoop.getSessionKind(),
        ...(currentMeta?.routineId ? { routineId: currentMeta.routineId } : {}),
        ...(currentMeta?.routineTitle ? { routineTitle: currentMeta.routineTitle } : {}),
        ...(currentMeta?.routineFiredAt ? { routineFiredAt: currentMeta.routineFiredAt } : {}),
        ...(currentMeta?.projectRoot ? { projectRoot: currentMeta.projectRoot } : {}),
        ...(currentMeta?.projectName ? { projectName: currentMeta.projectName } : {}),
        ...(currentMeta?.summaryPreamble ? { summaryPreamble: currentMeta.summaryPreamble } : {}),
      });
      const loaded = conversationLoop.loadSession(newId);
      if (loaded && conversationLoop.getSessionKind() === "main") {
        await memoryManager.markMainActiveResume(newId).catch((err: unknown) => {
          log.warn("chat:fork markMainActiveResume failed: %s", (err as Error).message);
        });
      }
      return { ok: loaded, sessionId: loaded ? newId : null };
    });
    return mutation ?? { ok: false, sessionId: null, error: STREAMING_ACTIVE };
  });
  const continueFromLastUserTurn = async (opts: {
    requireTerminalUser: boolean;
    restoreOnFailure: boolean;
  }) => {
    const messages = [...(conversationLoop.getHistory().getMessages() as GenericMessage[])];
    if (messages.length === 0) return { ok: false, error: "no-user-message" };
    let lastUserIdx = messages.length - 1;
    if (opts.requireTerminalUser) {
      if (messages[lastUserIdx]?.role !== "user") {
        return { ok: false, error: "last-message-not-user" };
      }
    } else {
      lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") { lastUserIdx = i; break; }
      }
    }
    if (lastUserIdx < 0) return { ok: false, error: "no-user-message" };
    const lastUser = messages[lastUserIdx] as Extract<GenericMessage, { role: "user" }>;
    // Disjoint split: text parts → prompt body, non-text parts → attachments.
    // `userContentText()` is wrong here — its `[image:...]` placeholder would
    // re-send each attachment twice once paired with `lastUserAttachments`.
    const lastUserText = Array.isArray(lastUser.content)
      ? lastUser.content
          .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("\n")
      : lastUser.content;
    const lastUserAttachments = Array.isArray(lastUser.content)
      ? lastUser.content.filter((p) => p.type !== "text")
      : undefined;
    const personaPromptId = personaPromptIdFromUserMessage(lastUser);
    if (!personaPromptId.ok) return { ok: false, error: personaPromptId.error };
    const personaPrompt = await resolvePersonaRolePrompt(personaPromptStore, personaPromptId.personaPromptId);
    if (!personaPrompt.ok) return { ok: false, error: personaPrompt.error };
    conversationLoop.getHistory().truncate(lastUserIdx);
    try {
      const result = await streamTurn(lastUserText, lastUserAttachments, personaPrompt.rolePrompt);
      return { ok: true, result };
    } catch (err) {
      if (opts.restoreOnFailure) {
        conversationLoop.getHistory().restore(messages);
      }
      throw err;
    }
  };

  ipcMain.handle(CHANNELS.chat.continueLastUser, async (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.continueLastUser, e); return UNAUTHORIZED_FRAME; }
    const p = payload as { sessionId?: unknown };
    if (typeof p?.sessionId !== "string") return { ok: false, error: "invalid-args" };
    if (p.sessionId !== conversationLoop.getSessionId()) return { ok: false, error: "session-mismatch" };
    return continueFromLastUserTurn({ requireTerminalUser: true, restoreOnFailure: true });
  });

  ipcMain.handle(CHANNELS.chat.retryEffort, async (
    e,
    opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean },
  ) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.retryEffort, e); return UNAUTHORIZED_FRAME; }
    const prevLlm = settingsService.get("llm");
    const provider = prevLlm.provider;
    const prevBlock = getLlmVendorSettings(prevLlm.vendors, provider);
    const prevVendorBaseUrlSig = vendorBaseUrlSignature(prevLlm);
    await settingsService.patch({
      llm: {
        vendors: {
          [provider]: {
            ...prevBlock,
            enableThinking: opts?.enableThinking ?? true,
            thinkingBudgetTokens: opts?.thinkingBudgetTokens ?? 20000,
          },
        },
      },
    });
    // ASRT choke-point: the spread includes prevBlock.baseUrl if set, so if
    // a baseUrl was present it remains unchanged and the guard is a no-op.
    // Included for completeness in case future patches extend this handler.
    if (vendorBaseUrlSignature(settingsService.get("llm")) !== prevVendorBaseUrlSig) {
      deps.refreshSandboxNetworkConfig?.();
    }
    conversationLoop.refreshProvider();
    try {
      return await continueFromLastUserTurn({ requireTerminalUser: false, restoreOnFailure: false });
    } finally {
      await settingsService.patch({
        llm: { vendors: { [provider]: prevBlock } },
      });
      // Restore path: if the forward patch triggered a sandbox refresh but
      // the restore brings baseUrl back to the same value, the guard here is
      // also a no-op (prevBlock was the original, sig matches original).
      if (vendorBaseUrlSignature(settingsService.get("llm")) !== prevVendorBaseUrlSig) {
        deps.refreshSandboxNetworkConfig?.();
      }
      conversationLoop.refreshProvider();
    }
  });

  ipcMain.handle(CHANNELS.chat.export, async (e, format: "markdown" | "json") => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.export, e); return UNAUTHORIZED_FRAME; }
    const { dialog } = await import("electron");
    const { writeFile } = await import("node:fs/promises");
    const win = getMainWindow();
    if (format !== "markdown" && format !== "json") return { ok: false, error: "invalid-format" };
    const messages = conversationLoop.getHistory().getMessages() as GenericMessage[];
    if (messages.length === 0) return { ok: false, error: "empty" };

    const sessionId = conversationLoop.getSessionId();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const defaultName = `lvis-chat-${sessionId.slice(0, 8)}-${stamp}.${format === "markdown" ? "md" : "json"}`;
    const dialogOptions = {
      title: t("mainDialog.exportConversationTitle"),
      defaultPath: defaultName,
      filters: format === "markdown"
        ? [{ name: "Markdown", extensions: ["md"] }]
        : [{ name: "JSON", extensions: ["json"] }],
    };
    const res = win
      ? await dialog.showSaveDialog(win, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };

    let body: string;
    if (format === "json") {
      body = JSON.stringify({ sessionId, exportedAt: new Date().toISOString(), messages }, null, 2);
    } else {
      const exportedAt = new Date().toISOString();
      const lines: string[] = [t("be_chatDomain.exportHeading"), ``, t("be_chatDomain.exportSessionLine", { sessionId }), t("be_chatDomain.exportTimeLine", { exportedAt }), ``];
      for (const m of messages) {
        if (m.role === "user") {
          lines.push(`## User`, ``, userContentText(m.content), ``);
        } else if (m.role === "assistant") {
          lines.push(`## Assistant`, ``);
          if (m.thought) lines.push(`> _reasoning:_ ${m.thought.replace(/\n/g, " ")}`, ``);
          lines.push(m.content, ``);
          if (m.toolCalls && m.toolCalls.length > 0) {
            for (const tc of m.toolCalls) {
              lines.push(`### Tool call: \`${tc.name}\``, ``, "```json", JSON.stringify(tc.input, null, 2), "```", ``);
            }
          }
        } else if (m.role === "tool_result") {
          lines.push(`### Tool result${m.toolName ? `: \`${m.toolName}\`` : ""}${m.isError ? " (error)" : ""}`, ``, "```", m.content, "```", ``);
        }
      }
      body = lines.join("\n");
    }
    await writeFile(res.filePath, body, "utf-8");
    return { ok: true, filePath: res.filePath };
  });

  // #1500 (E3) — reverse of chat.export. INTERNAL (mutating; not in
  // PUBLIC_CHANNELS — same classification as chat.new/chat.fork above).
  // ALWAYS creates a brand-new DLP-safe UUID session — importing
  // NEVER overwrites an existing session, matching chat.fork's pattern.
  ipcMain.handle(CHANNELS.chat.import, async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.import, e); return UNAUTHORIZED_FRAME; }
    const { dialog } = await import("electron");
    const { open } = await import("node:fs/promises");
    const win = getMainWindow();
    const dialogOptions = {
      title: t("mainDialog.importConversationTitle"),
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"] as Array<"openFile">,
    };
    const res = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true };
    const filePath = res.filePaths[0];

    // TOCTOU-safe read (CodeQL js/file-system-race): open ONE fd, size-guard
    // via fstat(fd), then read from that SAME fd. A separate stat()+readFile()
    // pair races — the path could be swapped between the size check and the
    // read (e.g. small→huge, or file→symlink to a device) so the cap is
    // enforced against a different inode than the one read. Anchoring both the
    // check and the read to a single fd closes that window.
    let text: string;
    let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fileHandle = await open(filePath, "r");
      const stats = await fileHandle.stat();
      // DoS guard — reject oversized files before ever reading/parsing them
      // (same MAX_SESSION_FILE_BYTES cap memory-manager enforces on-disk).
      if (stats.size > MAX_SESSION_FILE_BYTES) {
        return { ok: false, error: "file-too-large" };
      }
      text = await fileHandle.readFile("utf-8");
    } catch {
      return { ok: false, error: "file-not-found" };
    } finally {
      await fileHandle?.close().catch(() => {});
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, error: "invalid-json" };
    }

    const validated = validateImportedSessionJson(raw);
    if (!validated.ok) {
      return { ok: false, error: validated.error ?? "invalid-file-shape" };
    }

    const newSessionId = createDlpSafeUuid();
    await memoryManager.saveImportedSession(newSessionId, validated.messages);
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: newSessionId,
      type: "info",
      input: `chat:import:sessionId=${newSessionId}:messageCount=${validated.messages.length}`,
    });
    return { ok: true, sessionId: newSessionId, messageCount: validated.messages.length };
  });

  // ─── Checkpoint View + Branch ─────────────────────────

  ipcMain.handle(CHANNELS.chat.enterCheckpointView, (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.enterCheckpointView, e); return UNAUTHORIZED_FRAME; }
    const p = payload as { sessionId?: unknown; compactNum?: unknown };
    if (typeof p?.sessionId !== "string" || !Number.isSafeInteger(p?.compactNum) || (p.compactNum as number) < 0) {
      return { error: "invalid-args" };
    }
    if (p.sessionId !== conversationLoop.getSessionId()) {
      return { error: "session-mismatch" };
    }
    const result = conversationLoop.enterViewMode(p.compactNum as number);
    if (!result) return { error: "checkpoint-not-found" };
    return result;
  });

  ipcMain.handle(CHANNELS.chat.exitCheckpointView, (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.exitCheckpointView, e); return UNAUTHORIZED_FRAME; }
    conversationLoop.exitViewMode();
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.chat.branchFromCheckpoint, async (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.branchFromCheckpoint, e); return UNAUTHORIZED_FRAME; }
    const p = payload as { sessionId?: unknown; compactNum?: unknown };
    if (typeof p?.sessionId !== "string" || !Number.isSafeInteger(p?.compactNum) || (p.compactNum as number) < 0) {
      return { error: "invalid-args" };
    }
    if (p.sessionId !== conversationLoop.getSessionId()) {
      return { error: "session-mismatch" };
    }
    const mutation = trackSessionMutation(async () =>
      conversationLoop.branchFromCheckpoint(p.compactNum as number));
    if (!mutation) return { error: STREAMING_ACTIVE };
    try {
      return await mutation;
    } catch (err) {
      return { error: (err as Error).message };
    }
  });
  // ─── Memory ─────────────────────────────────────
  ipcMain.handle(CHANNELS.memory.entriesList, (e, opts?: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.entriesList, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return [];
    return memoryManager.listMemoryEntries(project.options);
  });
  ipcMain.handle(CHANNELS.memory.entriesSave, async (e, title: string, content: string, opts?: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.entriesSave, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return PROJECT_NOT_ALLOWED;
    return memoryManager.saveMemory(title, content, project.options);
  });
  ipcMain.handle(CHANNELS.memory.entriesDelete, async (e, filename: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.entriesDelete, e); return UNAUTHORIZED_FRAME; }
    await memoryManager.deleteMemory(filename);
    return undefined;
  });
  ipcMain.handle(CHANNELS.memory.entriesSearch, (e, query: string, opts?: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.entriesSearch, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return [];
    return memoryManager.searchMemoryEntries(query, project.options).map((note) => ({
      filename: note.filename,
      title: note.title,
      content: note.content,
      excerpt: note.content.replace(/^#\s+.+(?:\r?\n)+/, "").trim(),
      updatedAt: note.updatedAt ?? new Date().toISOString(),
      ...(note.projectRoot ? { projectRoot: note.projectRoot } : {}),
      ...(note.projectName ? { projectName: note.projectName } : {}),
    }));
  });
  ipcMain.handle(CHANNELS.memory.indexGet, (e, opts?: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.indexGet, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return "";
    return memoryManager.getMemoryIndex(project.options);
  });
  ipcMain.handle(CHANNELS.memory.indexUpdateIfUnchanged, async (e, expectedContent: string, nextContent: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.indexUpdateIfUnchanged, e); return UNAUTHORIZED_FRAME; }
    return memoryManager.updateMemoryIndexIfUnchanged(expectedContent, nextContent);
  });
  ipcMain.handle(CHANNELS.memory.indexSectionsUpdate, async (e, sections: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.indexSectionsUpdate, e); return UNAUTHORIZED_FRAME; }
    if (!sections || typeof sections !== "object" || Array.isArray(sections)) {
      return { ok: false, error: "invalid-memory-sections" };
    }
    const candidate = sections as { urgentMemory?: unknown; references?: unknown };
    if (
      (candidate.urgentMemory !== undefined && typeof candidate.urgentMemory !== "string") ||
      (candidate.references !== undefined && typeof candidate.references !== "string")
    ) {
      return { ok: false, error: "invalid-memory-sections" };
    }
    await memoryManager.updateMemoryIndexSections({
      ...(candidate.urgentMemory !== undefined ? { urgentMemory: candidate.urgentMemory } : {}),
      ...(candidate.references !== undefined ? { references: candidate.references } : {}),
    });
    return { ok: true };
  });
  ipcMain.handle(CHANNELS.memory.sessionsList, (e, opts?: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.sessionsList, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return [];
    return memoryManager.listSessionEntries(50, project.options);
  });
  ipcMain.handle(CHANNELS.memory.sessionsSearch, (e, query: string, opts?: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.sessionsSearch, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return [];
    return memoryManager.searchSessions(query, project.options);
  });
  ipcMain.handle(CHANNELS.memory.agentsMdGet, (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.agentsMdGet, e); return UNAUTHORIZED_FRAME; }
    return memoryManager.getAgentsMd();
  });
  ipcMain.handle(CHANNELS.memory.agentsMdUpdate, async (e, content: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.agentsMdUpdate, e); return UNAUTHORIZED_FRAME; }
    return memoryManager.updateAgentsMd(content);
  });
  ipcMain.handle(CHANNELS.memory.userPrefsGet, (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.userPrefsGet, e); return UNAUTHORIZED_FRAME; }
    return memoryManager.getUserPreferences();
  });
  ipcMain.handle(CHANNELS.memory.userPrefsUpdate, async (e, content: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.userPrefsUpdate, e); return UNAUTHORIZED_FRAME; }
    return memoryManager.updateUserPreferences(content);
  });
  ipcMain.handle(CHANNELS.memory.userPrefsRefresh, async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.userPrefsRefresh, e); return UNAUTHORIZED_FRAME; }
    if (!preferenceRefreshService) {
      return { ok: false, error: "preference-refresh-service-unavailable" };
    }
    try {
      const result = await preferenceRefreshService.refresh({ reason: "manual" });
      return {
        ok: true,
        content: result.content,
        refreshedAt: result.refreshedAt,
        sources: result.sources,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ─── Starred messages ────────────────────────────────────
  // read-only, sender guard optional
  ipcMain.handle(CHANNELS.starred.list, () => {
    if (!starredStore) return [];
    return starredStore.list();
  });
  ipcMain.handle(CHANNELS.starred.add, (e, entry: { sessionId?: string; messageIndex: number; role: string; text: string }) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.starred.add, e); return UNAUTHORIZED_FRAME; }
    if (!starredStore) return { ok: false, error: "no-starred-store" };
    if (typeof entry?.messageIndex !== "number" || entry.messageIndex < -1) return { ok: false, error: "invalid-index" };
    if (typeof entry?.text !== "string") return { ok: false, error: "invalid-text" };
    const sessionId = entry.sessionId ?? conversationLoop.getSessionId();
    const record = starredStore.add({ sessionId, messageIndex: entry.messageIndex, role: entry.role, text: entry.text });
    return { ok: true, entry: record };
  });
  ipcMain.handle(CHANNELS.starred.remove, (e, opts: { id?: string; sessionId?: string; messageIndex?: number }) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.starred.remove, e); return UNAUTHORIZED_FRAME; }
    if (!starredStore) return { ok: false, error: "no-starred-store" };
    if (opts?.id) return { ok: starredStore.remove(opts.id) };
    if (opts?.sessionId && typeof opts.messageIndex === "number") {
      return { ok: starredStore.removeBySessionAndIndex(opts.sessionId, opts.messageIndex) };
    }
    return { ok: false, error: "invalid-args" };
  });

  // ─── Message feedback ────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.feedback.submit, async (e, payload: { sessionId: string; messageIndex: number; rating: "up" | "down"; reason?: string }) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.feedback.submit, e); return UNAUTHORIZED_FRAME; }
    const { sessionId, messageIndex, rating, reason } = payload ?? {};
    if (
      typeof sessionId !== "string" ||
      typeof messageIndex !== "number" ||
      messageIndex < 0 ||
      (rating !== "up" && rating !== "down")
    ) {
      return { ok: false, error: "invalid-args" };
    }
    if (feedbackStore) {
      feedbackStore.add({ sessionId, messageIndex, rating, ...(reason !== undefined ? { reason } : {}) });
    }
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId,
      type: "warn",
      input: `feedback:${rating}:${sessionId}:${messageIndex}`,
    });
    if (rating === "up" && starredStore) {
      const existing = starredStore.list().find(
        (s) => s.sessionId === sessionId && s.messageIndex === messageIndex,
      );
      if (!existing) {
        starredStore.add({ sessionId, messageIndex, role: "assistant", text: "" });
      }
    }
    return { ok: true };
  });

  // ─── Verbatim tool_result lazy-load ────────────────────────────────────
  // Returns the in-memory verbatim content for a compacted or size-capped tool_result.
  // Only works for the currently-active session; when the active history has
  // a disk stub, the host attempts to rehydrate it from the file-backed artifact.
  // Returns null when:
  //   - sessionId does not match the active session
  //   - toolUseId not found in history
  //   - message has NOT been compacted or size-capped — callers should only
  //     request verbatim for stubbed tool results
  //   - message is a disk stub and no matching artifact is available
  // lineCount is computed here so the renderer never has to split on "\n".
  ipcMain.handle(
    CHANNELS.chat.getVerbatimToolResult,
    (e, { sessionId, toolUseId }: { sessionId: string; toolUseId: string }) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.chat.getVerbatimToolResult, e);
        return null;
      }
      if (sessionId !== conversationLoop.getSessionId()) return null;
      const messages = conversationLoop.getHistory().getMessages() as GenericMessage[];
      const msg = messages.find(
        (m): m is Extract<GenericMessage, { role: "tool_result" }> =>
          m.role === "tool_result" && m.toolUseId === toolUseId,
      );
      if (!msg) return null;
      // content is always string on tool_result messages
      const content = msg.content;
      if (typeof content !== "string") return null;
      const artifact = isToolResultStubContent(content) && !msg.meta?.artifactUnavailable
        ? memoryManager.loadToolResultArtifact(sessionId, toolUseId)
        : null;
      if (!artifact && msg.meta?.compactedAt === undefined && msg.meta?.truncated === undefined) return null;
      if (msg.meta?.serializedStub === true && isToolResultStubContent(content) && !artifact) return null;
      const verbatim = artifact?.content ?? content;
      // zero-allocation line count
      let lineCount = 1;
      for (let i = 0; i < verbatim.length; i++) {
        if (verbatim.charCodeAt(i) === 10) lineCount++;
      }
      return { content: verbatim, lineCount };
    },
  );

  // ─── Sub-agent transcript lazy-load ───────────────────────────────────
  // Parent `agent_spawn` results may be stored as a small handle/stub, while
  // the full child loop transcript lives in the isolated ~/.lvis/subagent/
  // namespace. This read-only handler re-joins them for the right-side
  // sub-agent viewer without exposing sub-agent sessions in the main session
  // list.
  ipcMain.handle(
    CHANNELS.chat.getSubAgentTranscript,
    (e, payload: unknown) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.chat.getSubAgentTranscript, e);
        return { ok: false, error: "unauthorized-frame" };
      }
      const p = (payload ?? {}) as Record<string, unknown>;
      const originSessionId = typeof p.originSessionId === "string" && isSafeSessionId(p.originSessionId)
        ? p.originSessionId
        : "";
      if (!originSessionId) return { ok: false, error: "invalid-origin-session-id" };
      if (originSessionId !== conversationLoop.getSessionId()) {
        return { ok: false, error: "origin-session-not-active" };
      }
      const runner = deps.getSubAgentRunner?.();
      if (!runner) return { ok: false, error: "sub-agent runner not configured" };
      const childSessionId = typeof p.childSessionId === "string" && isSafeSessionId(p.childSessionId)
        ? p.childSessionId
        : undefined;
      if (!childSessionId) return { ok: false, error: "invalid-child-session-id" };
      const messages = memoryManager.rehydrateToolResultArtifacts(
        originSessionId,
        conversationLoop.getHistory().getMessages(),
      ) as GenericMessage[];
      if (!hasParentSubAgentReference(messages, childSessionId)) {
        return { ok: false, error: "sub-agent-reference-not-found" };
      }
      return runner.getPersistedTranscript({
        originSessionId,
        childSessionId,
      });
    },
  );

  // ─── Issue #749: write-file diff sidecar lazy-load ──────────────────────
  // Returns { before, after } for a write_file tool call when content exceeded
  // WRITE_DIFF_PREVIEW_LIMIT on either side. The sidecar is written by
  // WriteFileTool.executeTyped into ~/.lvis/diff-cache/<sessionId>/<toolUseId>.json.
  // Returns null when:
  //   - sessionId / toolUseId fail safe-id validation (no path separators)
  //   - sidecar file not found or unreadable
  ipcMain.handle(
    CHANNELS.chat.getWriteDiff,
    async (e, payload: unknown): Promise<{ before: string; after: string } | null> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.chat.getWriteDiff, e);
        return null;
      }
      const p = (payload ?? {}) as Record<string, unknown>;
      const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
      const toolUseId = typeof p.toolUseId === "string" ? p.toolUseId : "";
      if (!sessionId || !toolUseId || !isSafeId(sessionId) || !isSafeId(toolUseId)) {
        return null;
      }
      return readDiffSidecar(sessionId, toolUseId);
    },
  );

  // ─── ask_user_question response ─────────────────────────────────────────
  ipcMain.handle(CHANNELS.askUserQuestion.respond, (e, response: unknown) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.askUserQuestion.respond, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!askUserQuestionGate) {
      return { ok: false, error: "ask-user-question gate not configured" };
    }
    const r = (response ?? {}) as Record<string, unknown>;
    const requestId = typeof r.requestId === "string" ? r.requestId : "";
    if (!requestId) return { ok: false, error: "invalid-request-id" };
    const rawAnswers = Array.isArray(r.answers) ? (r.answers as unknown[]) : null;
    const answers = rawAnswers
      ? rawAnswers.map((entry) => {
          const a = (entry ?? {}) as Record<string, unknown>;
          const multiRaw = Array.isArray(a.choices) ? (a.choices as unknown[]) : null;
          const choices = multiRaw
            ? multiRaw.filter((c): c is string => typeof c === "string" && c.length > 0)
            : undefined;
          return {
            choice: typeof a.choice === "string" ? a.choice : undefined,
            choices: choices && choices.length > 0 ? choices : undefined,
            freeText: typeof a.freeText === "string" ? a.freeText : undefined,
          };
        })
      : undefined;
    askUserQuestionGate.resolve({
      requestId,
      answers,
      dismissed: r.dismissed === true,
    });
    return { ok: true };
  });
}
