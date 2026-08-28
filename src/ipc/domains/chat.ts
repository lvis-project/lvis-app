/**
 * Chat domain IPC handlers.
 * Covers: lvis:chat:*, lvis:llm:*, lvis:memory:*, lvis:starred:*,
 *         lvis:feedback:submit, lvis:ask-user-question:respond
 * Note: routine channels (lvis:routines:*) are handled in routines.ts.
 *
 * The PUBLIC chat channels (send / sessions / get-history /
 * session-history) delegate to transport-agnostic pure handlers in
 * `../handlers/chat.ts`; this module keeps only the thin `ipcMain.handle`
 * wrappers (trust boundary + semantic-event sink construction) and the
 * internal / session-scoped handlers inline. The common platform timeline is
 * canonical; this Electron adapter performs the one-way `lvis:chat:stream`
 * compatibility projection at the display edge.
 */
import { ipcMain } from "electron";
import { t } from "../../i18n/index.js";
import type { ActiveRolePrompt } from "../../data/role-presets.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import { userContentText } from "../../engine/llm/types.js";
import { normalizeToolPairInvariant } from "../../engine/conversation-history.js";
import {
  MAX_LOCAL_USER_CONTENT_PARTS,
  MAX_LOCAL_USER_CONTENT_TEXT_CHARS,
  MAX_LOCAL_USER_CONTENT_TEXT_PARTS,
  normalizeLocalUserContentParts,
} from "../../main/subscription-attachment-input.js";
import type { ChatUtteranceMode } from "../../shared/chat-utterance.js";
import { parseStagedEnvelope, isMissingStagedEnvelopeErrorMessage } from "../../shared/staged-origins.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { isValidSessionId } from "../../memory/memory-manager.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { sendToWebContents } from "../safe-send.js";
import {
  createPlatformConversationLegacyStreamAdapter,
  createPlatformTurnId,
} from "../../api/platform-conversation-legacy-adapter.js";
import { createPlatformConversationEventSink } from "../../engine/conversation-platform-protocol.js";
import {
  createConversationCommandPort,
  DESKTOP_CONVERSATION_ACTOR,
} from "../../main/conversation-command-port.js";
import { createLogger } from "../../lib/logger.js";
import { readDiffSidecar, isSafeId } from "../../tools/write-diff-cache.js";
import { isToolResultStubContent } from "../../shared/tool-result-stub.js";
import type { LLMSettings } from "../../data/settings-store.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";
import {
  runStreamedTurn,
  STREAM_TURN_OPTIONS,
  type ConversationStreamEventSink,
} from "../handlers/chat-stream.js";
import {
  handleChatSessions,
  handleChatGetHistory,
  handleChatSessionHistory,
  isSafeSessionId,
  personaPromptIdFromUserMessage,
  resolvePersonaRolePrompt,
  sanitizeOutgoingTurnContent,
  sanitizeOutgoingInput,
  markMainActiveAfterTurn,
  prepareParentMailboxTurn,
  acknowledgeParentMailboxAfterTurn,
  resolveChatNewProjectPayload,
  parseChatSendPayload,
} from "../handlers/chat.js";
import { getDefaultWorkspaceRoot } from "../../main/default-workspace-root.js";
import { resolveAuthorizedWorkspaceProject } from "../../main/project-root-authorization.js";
import { createDlpSafeUuid } from "../../shared/dlp-safe-id.js";
import { createConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import type { ConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import type { ConversationCommandPort } from "../../main/conversation-command-port.js";
import { MAIN_CHAT_GROUP_ID } from "../../contract/app-contract.js";
import type { ConversationLoop } from "../../engine/conversation-loop.js";
const log = createLogger("chat");
const MAX_MEMORY_PROJECT_ROOT_CHARS = 2_048;
const MAX_MEMORY_PROJECT_NAME_CHARS = 120;
const PROJECT_NOT_ALLOWED = { ok: false, error: "project-not-allowed" } as const;

function isMissingStagedEnvelopeError(error: unknown): boolean {
  return error instanceof Error
    && isMissingStagedEnvelopeErrorMessage(error.message);
}

// ─── Chat import — reverse of chat.export ─────────────────────────────────
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

const UNREADABLE_FIELD = Symbol("unreadable-field");

function hasOnlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  try {
    const keys = Object.keys(obj);
    for (let index = 0; index < keys.length; index += 1) {
      if (!allowed.includes(keys[index])) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function ownField(obj: Record<string, unknown>, key: string): unknown {
  try {
    return Object.hasOwn(obj, key) ? obj[key] : undefined;
  } catch {
    return UNREADABLE_FIELD;
  }
}

function isOptionalNonNegativeSafeInteger(value: unknown): boolean {
  return value === undefined
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isValidUserContentPart(part: unknown): boolean {
  if (!part || typeof part !== "object" || Array.isArray(part)) return false;
  const p = part as Record<string, unknown>;
  const type = ownField(p, "type");
  if (typeof type !== "string" || !Object.hasOwn(USER_CONTENT_PART_KEYS, type)) return false;
  if (!hasOnlyKeys(p, USER_CONTENT_PART_KEYS[type])) return false;

  if (type === "text") return typeof ownField(p, "text") === "string";

  if (type === "image") {
    const image = ownField(p, "image");
    const mimeType = ownField(p, "mimeType");
    const width = ownField(p, "width");
    const height = ownField(p, "height");
    const bytes = ownField(p, "bytes");
    return typeof image === "string"
      && (mimeType === undefined || typeof mimeType === "string")
      && isOptionalNonNegativeSafeInteger(width)
      && isOptionalNonNegativeSafeInteger(height)
      && isOptionalNonNegativeSafeInteger(bytes);
  }

  if (type === "file") {
    return typeof ownField(p, "data") === "string" && typeof ownField(p, "mimeType") === "string";
  }
  return false;
}

/**
 * Imported multipart records use the same bounded composition as live IPC.
 * Iterate by owned index instead of caller-provided iteration helpers:
 * holes, unreadable properties, and overridden iteration helpers fail closed.
 */
function hasValidUserContentPartComposition(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;

  let length: number;
  try {
    length = raw.length;
  } catch {
    return false;
  }
  if (
    !Number.isSafeInteger(length)
    || length < 0
    || length > MAX_LOCAL_USER_CONTENT_PARTS
  ) {
    return false;
  }

  let textPartCount = 0;
  let textChars = 0;
  for (let index = 0; index < length; index += 1) {
    let part: unknown;
    try {
      if (!Object.hasOwn(raw, index)) return false;
      part = raw[index];
    } catch {
      return false;
    }
    if (!isValidUserContentPart(part)) return false;

    const record = part as Record<string, unknown>;
    if (ownField(record, "type") !== "text") continue;
    const text = ownField(record, "text");
    if (typeof text !== "string") return false;
    if (textPartCount >= MAX_LOCAL_USER_CONTENT_TEXT_PARTS) return false;
    if (text.length > MAX_LOCAL_USER_CONTENT_TEXT_CHARS - textChars) return false;
    textPartCount += 1;
    textChars += text.length;
  }
  return true;
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
      const content = ownField(m, "content");
      if (content === UNREADABLE_FIELD) return false;
      if (typeof content === "string") return true;
      return hasValidUserContentPartComposition(content);
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

/**
 * Rebuild imported records instead of retaining parsed object references.
 * User multipart content is normalized through the same bounded local-data URL
 * contract used by live IPC and the provider mapper, so imports cannot persist
 * a remote URL that the AI SDK would later fetch.
 */
function normalizeImportedMessage(message: GenericMessage): GenericMessage | null {
  switch (message.role) {
    case "user": {
      if (typeof message.content === "string") {
        return { role: "user", content: message.content };
      }
      const content = normalizeLocalUserContentParts(message.content);
      return content && content.length === message.content.length ? { role: "user", content } : null;
    }
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.thought !== undefined ? { thought: message.thought } : {}),
        ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
      };
    case "tool_result":
      return {
        role: "tool_result",
        toolUseId: message.toolUseId,
        content: message.content,
        ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
        ...(message.isError !== undefined ? { isError: message.isError } : {}),
      };
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
  const messages: GenericMessage[] = [];
  for (const candidate of r.messages) {
    if (!isValidImportedMessage(candidate)) {
      return { ok: false, messages: [], error: "invalid-message-shape" };
    }
    const normalized = normalizeImportedMessage(candidate);
    if (!normalized) {
      return { ok: false, messages: [], error: "invalid-message-shape" };
    }
    messages.push(normalized);
  }
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

type MemoryCandidateActionPayload =
  | { ok: true; id: string; options: unknown }
  | { ok: false };

/**
 * Candidate approval/rejection is an internal user action. Keep the payload
 * deliberately narrow so a renderer cannot smuggle arbitrary manager options
 * through the lifecycle boundary.
 */
function parseMemoryCandidateActionPayload(raw: unknown): MemoryCandidateActionPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const record = raw as Record<string, unknown>;
  if (!hasOnlyKeys(record, ["id", "opts"])) return { ok: false };
  if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 128) {
    return { ok: false };
  }
  if (record.opts !== undefined) {
    if (!record.opts || typeof record.opts !== "object" || Array.isArray(record.opts)) {
      return { ok: false };
    }
    if (!hasOnlyKeys(record.opts as Record<string, unknown>, ["projectRoot", "projectName", "includeUnscoped"])) {
      return { ok: false };
    }
  }
  return { ok: true, id: record.id, options: record.opts };
}

function candidateMemoryActionFailure(error: unknown): { ok: false; error: "invalid-input" | "not-found" | "write-failed" } {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("invalid memory id")) return { ok: false, error: "invalid-input" };
  // Scope misses intentionally share this result with absent candidates, so a
  // caller cannot probe whether another project's candidate exists.
  if (message.includes("candidate not found")) return { ok: false, error: "not-found" };
  return { ok: false, error: "write-failed" };
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
    memoryCaptureService,
    starredStore,
    feedbackStore,
    auditLogger,
    askUserQuestionGate,
    preferenceRefreshService,
    memoryConsolidationService,
    personaPromptStore,
    getMainWindow,
  } = deps;

  // This single host-owned runtime outlives individual transports. Direct
  // registrar tests deliberately receive a private instance, while production
  // main-process composition injects the same one into Local API and IPC.
  // ─── Tiled chat groups ────────────────────────────────────────────────
  //
  // A conversation IS a ConversationLoop: it holds the live history and runs
  // exactly one turn at a time. Several tiles that can each be streaming
  // therefore means several loops, and everything built ON one loop — its
  // surface runtime, its command port, its legacy stream adapter — has to be
  // per-group too. Two tiles sharing one timeline would interleave frames.
  //
  // See docs/design/tiled-chat-groups.md.
  const STREAMING_ACTIVE = "streaming-active" as const;
  type StreamTurnTransport = {
    readonly sink: ConversationStreamEventSink;
  };
  /**
   * The turn machinery of ONE group: its leases, its stream ids and sinks,
   * and the replay paths (edit/resend, continue, retry) built over them.
   *
   * These were one closure family over the primary loop. A handler that read
   * a group's history and then replayed it through closures bound to the
   * primary ran that tile's turn in the primary conversation — so each group
   * builds its own, and a handler reaches them only through the group it
   * resolved.
   */
  const createGroupTurns = (
    loop: ConversationLoop,
    surfaceRuntime: ConversationSurfaceRuntime,
    buildSink: (streamId?: number) => ConversationStreamEventSink,
    groupDeps: IpcDeps,
  ) => {
    const trackStreamTurn = <T>(factory: () => Promise<T>): Promise<T> =>
      surfaceRuntime.activity.trackTurn(factory);
    const tryTrackStreamTurn = <T>(factory: () => Promise<T>): Promise<T> | null =>
      surfaceRuntime.activity.tryTrackTurn(factory);
    const trackSessionMutation = <T>(factory: () => Promise<T>): Promise<T> | null =>
      surfaceRuntime.activity.trackMutation(factory);
    const allocateStreamId = () => surfaceRuntime.activity.allocateStreamId();
    const createStreamTurnTransport = (): StreamTurnTransport => {
      const streamId = allocateStreamId();
      return { sink: buildSink(streamId) };
    };
    const runStreamTurn = async (
      { sink }: StreamTurnTransport,
      input: string,
      attachments?: import("../../engine/llm/types.js").UserContentPart[],
      rolePrompt?: ActiveRolePrompt,
      displayText?: string,
    ) => {
      // Edit/resend and history replay reach the provider through this separate
      // main-chat path. Keep their input (including folded text attachments)
      // under the same DLP boundary as a normal `chat:send` turn while
      // preserving non-text attachments.
      //
      // Keep only the fixed staged-origin enum before DLP can rewrite a source
      // header into a non-parseable placeholder. Passing that enum as the
      // claim below lets runStreamedTurn fail closed rather than downgrade a
      // replayed staged turn to user-keyboard; the raw source never crosses
      // this boundary.
      const replayStagedInputOrigin = parseStagedEnvelope(input)?.kind.inputOrigin;
      const sanitized = sanitizeOutgoingTurnContent(settingsService, sink, input, attachments);
      const result = await runStreamedTurn(
        loop,
        sanitized.input,
        sink,
        {
          ...STREAM_TURN_OPTIONS,
          ...(replayStagedInputOrigin ? { inputOrigin: replayStagedInputOrigin } : {}),
          ...(sanitized.attachments && sanitized.attachments.length > 0
            ? { attachments: sanitized.attachments }
            : {}),
          ...(rolePrompt ? { rolePrompt } : {}),
          ...(displayText !== undefined ? { displayText } : {}),
        },
      );
      await markMainActiveAfterTurn(groupDeps, sanitized.input);
      return result;
    };
    const tryStreamTurn = <T>(
      factory: (transport: StreamTurnTransport) => Promise<T>,
    ): Promise<T> | null => {
      const transport = createStreamTurnTransport();
      return tryTrackStreamTurn(() => factory(transport));
    };

    const continueFromLastUserTurnWithinLease = async (
      opts: { requireTerminalUser: boolean; restoreOnFailure: boolean },
      transport: StreamTurnTransport,
    ) => {
      const messages = [...(loop.getHistory().getMessages() as GenericMessage[])];
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
      // Carried forward for the same reason `personaPromptId` is: the replayed row has to
      // look like the row it replaces. Without it a resource turn's fenced body — folded
      // into `lastUserText` by the split above — renders inside the user's own bubble on
      // reload, which is exactly what the seam in `run-turn.ts` exists to prevent, undone
      // one click after it worked.
      //
      // DISPLAY only. The fold still puts the fence in the replayed turn's text, so the
      // per-turn bound (which counts content PARTS) does not see it — unchanged by this
      // and accepted by the resources policy §6. What the fold must NOT also lose is the
      // turn's TAINT, and that is fixed where taint is derived: `initialToolTrustOrigin`
      // recognizes the fence in body text, the same way it already recognizes an inlined
      // paste.
      const priorDisplayText = (lastUser.meta as { displayText?: unknown } | undefined)?.displayText;
      loop.getHistory().truncate(lastUserIdx);
      try {
        const result = await runStreamTurn(
          transport,
          lastUserText,
          lastUserAttachments,
          personaPrompt.rolePrompt,
          typeof priorDisplayText === "string" ? priorDisplayText : undefined,
        );
        return { ok: true, result };
      } catch (err) {
        // Retry intentionally keeps its legacy behavior for ordinary stream
        // failures, but a DLP-induced staged-header rejection happens before
        // provider work and must never turn the pre-send truncate into data loss.
        if (opts.restoreOnFailure || isMissingStagedEnvelopeError(err)) {
          loop.getHistory().restore(messages);
        }
        throw err;
      }
    };
    const continueFromLastUserTurn = async (
      opts: { requireTerminalUser: boolean; restoreOnFailure: boolean },
      expectedSessionId?: string,
    ) => {
      const turn = tryStreamTurn(async (transport) => {
        if (expectedSessionId !== undefined && expectedSessionId !== loop.getSessionId()) {
          return { ok: false, error: "session-mismatch" };
        }
        return continueFromLastUserTurnWithinLease(opts, transport);
      });
      return turn ?? { ok: false, error: STREAMING_ACTIVE };
    };
    return {
      trackStreamTurn,
      trackSessionMutation,
      allocateStreamId,
      runStreamTurn,
      tryStreamTurn,
      continueFromLastUserTurnWithinLease,
      continueFromLastUserTurn,
    };
  };
  type GroupTurns = ReturnType<typeof createGroupTurns>;

  interface ChatGroupContext {
    loop: ConversationLoop;
    deps: IpcDeps;
    surfaceRuntime: ConversationSurfaceRuntime;
    commandPort: ConversationCommandPort;
    buildSink: (streamId?: number) => ConversationStreamEventSink;
    turns: GroupTurns;
    /** Detaches this group's frames from the window — part of releasing it. */
    unsubscribeStream: () => void;
  }
  const groupContexts = new Map<string, ChatGroupContext>();
  const chatGroupContext = (chatGroupId: string): ChatGroupContext => {
    const cached = groupContexts.get(chatGroupId);
    if (cached) return cached;
    const isMain = chatGroupId === MAIN_CHAT_GROUP_ID;
    // No silent fall back to the primary loop: a request naming a group this
    // process cannot build must fail, because the alternative is another
    // tile's turn landing in this one.
    if (!isMain && (!deps.resolveChatGroupLoop || !deps.releaseChatGroupLoop)) {
      throw new Error("chat-groups-unavailable");
    }
    const loop = isMain ? conversationLoop : deps.resolveChatGroupLoop!(chatGroupId);
    const groupDeps: IpcDeps = isMain ? deps : { ...deps, conversationLoop: loop, chatGroupId };
    if (!isMain) watchRendererLifetime();
    // Injected runtimes belong to the PRIMARY group. Production composition
    // shares one with the Local API, and registrar tests inject a private one;
    // a second tile must not be handed either.
    const surfaceRuntime = isMain
      ? deps.conversationSurfaceRuntime ?? createConversationSurfaceRuntime()
      : createConversationSurfaceRuntime();
    const commandPort = isMain
      ? deps.conversationCommandPort ?? createConversationCommandPort(groupDeps, surfaceRuntime)
      : createConversationCommandPort(groupDeps, surfaceRuntime);
    const legacyStreamAdapter = createPlatformConversationLegacyStreamAdapter(
      surfaceRuntime.timeline,
    );
    // Electron is the first owner-surface adapter. It receives a compatibility
    // projection only; the semantic timeline remains the producer source.
    //
    // The group is stamped HERE rather than inside the adapter: the adapter is
    // group-agnostic by design, and labelling at the one subscriber that owns
    // these frames means no frame can leave unlabelled. `chatGroupId`, not
    // `groupId` — the stream protocol already uses that name for a tool-call
    // group, and reusing it would misroute a frame only when a turn happened
    // to contain grouped tool calls.
    const unsubscribeStream = legacyStreamAdapter.subscribe((channel, payload) => {
      const labelled = payload && typeof payload === "object"
        ? { ...(payload as Record<string, unknown>), chatGroupId }
        : payload;
      sendToWebContents(getMainWindow()?.webContents, channel, labelled, log);
    });
    const buildGroupSink = (streamId?: number): ConversationStreamEventSink =>
      createPlatformConversationEventSink(surfaceRuntime.timeline, {
        conversationId: loop.getSessionId(),
        ...(streamId === undefined ? {} : { turnId: createPlatformTurnId(streamId) }),
      });
    const context: ChatGroupContext = {
      loop,
      deps: groupDeps,
      surfaceRuntime,
      commandPort,
      buildSink: buildGroupSink,
      turns: createGroupTurns(loop, surfaceRuntime, buildGroupSink, groupDeps),
      unsubscribeStream,
    };
    groupContexts.set(chatGroupId, context);
    return context;
  };

  // The primary group is built eagerly so its injected runtimes are wired
  // before any channel is called, exactly as they were before groups existed.
  const mainGroup = chatGroupContext(MAIN_CHAT_GROUP_ID);
  const conversationSurfaceRuntime = mainGroup.surfaceRuntime;
  const buildSink = mainGroup.buildSink;

  /**
   * The group a per-conversation channel names, from its trailing argument.
   *
   * Required, not defaulted. Both ends of these channels ship in one binary
   * and the preload stamps the id on every call, so an absent id is a caller
   * that forgot which tile it meant — and the symptom of defaulting that (a
   * turn landing in the wrong tile) is worse than a rejected call.
   */
  const groupOf = (chatGroupId: unknown): ChatGroupContext => {
    if (typeof chatGroupId !== "string" || !chatGroupId.trim()) {
      throw new Error("chat-group-required");
    }
    return chatGroupContext(chatGroupId.trim());
  };

  const releaseGroup = async (id: string): Promise<boolean> => {
    const context = groupContexts.get(id);
    if (!context) return false;
    context.loop.abortCurrentTurn();
    const active = context.surfaceRuntime.activity.activeTurn()
      ?? context.surfaceRuntime.activity.activeMutation();
    if (active) {
      try {
        await active;
      } catch {
        // expected: interrupted turns may reject
      }
    }
    context.unsubscribeStream();
    groupContexts.delete(id);
    deps.releaseChatGroupLoop?.(id);
    return true;
  };

  /**
   * A renderer that navigates or dies takes its tiles with it, and the one
   * that comes back numbers its tiles from the start again. Every group but
   * the primary is let go of at that moment, so a reloaded window's second
   * tile can never be handed a conversation the previous window left behind.
   * Installed once, on the window whose tiles these are, the first time it
   * asks for a second tile — that is the first moment there is anything to
   * lose.
   */
  const watchedRenderers = new WeakSet<object>();
  const watchRendererLifetime = (): void => {
    const contents = getMainWindow()?.webContents;
    if (!contents || watchedRenderers.has(contents)) return;
    watchedRenderers.add(contents);
    const releaseAll = () => {
      for (const id of [...groupContexts.keys()]) {
        if (id !== MAIN_CHAT_GROUP_ID) void releaseGroup(id);
      }
    };
    contents.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) releaseAll();
    });
    contents.on("render-process-gone", releaseAll);
  };

  /**
   * Let go of a tile's conversation when the tile closes.
   *
   * The loop is what makes a group cost something — live history and the
   * ability to run a turn — and ids are never reused, so a closed tile that
   * kept its loop would count against the ceiling for the rest of the
   * session. Any turn still running is stopped first: a tile that is gone
   * has nowhere to show it.
   */
  ipcMain.handle(CHANNELS.chat.groupRelease, async (e, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.groupRelease, e); return UNAUTHORIZED_FRAME; }
    if (typeof chatGroupId !== "string" || !chatGroupId.trim()) return { ok: false, error: "chat-group-required" };
    const id = chatGroupId.trim();
    if (id === MAIN_CHAT_GROUP_ID) return { ok: false, error: "invalid-args" };
    return { ok: true, released: await releaseGroup(id) };
  });

  // read-only, sender guard optional
  ipcMain.handle(CHANNELS.chat.hasProvider, (_e, chatGroupId?: unknown) =>
    groupOf(chatGroupId).loop.hasProvider());
  ipcMain.handle(CHANNELS.llm.ping, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.llm.ping, e);
      return UNAUTHORIZED_FRAME;
    }
    return conversationLoop.pingProvider();
  });

  const mainTurns = mainGroup.turns;

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
      const leaseAtRequest = conversationSurfaceRuntime.activity.activeTurn()
        ?? conversationSurfaceRuntime.activity.activeMutation();
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
        || conversationSurfaceRuntime.activity.isBusy()
        || conversationLoop.hasActiveTurn()
      ) {
        return;
      }

      const streamId = mainTurns.allocateStreamId();
      const sink = buildSink(streamId);
      await mainTurns.trackStreamTurn(async () => {
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
          {
            ...STREAM_TURN_OPTIONS,
            inputOrigin: "agent-message",
            approvalReasonPrefix: mailboxTurn.approvalReasonPrefix,
            // The wake turn's INPUT is the child report, so the report box has
            // to come off the turn-input row on reload.
            subAgentReport: mailboxTurn.childTitle === undefined
              ? {}
              : { title: mailboxTurn.childTitle },
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
  // logic in handlers/chat.ts. The common semantic timeline is canonical; the
  // renderer receives its existing frame shape only through the owner adapter.
  // Stops the group's running turn and waits for it to settle, so the next
  // command finds the lease free. Shared by `chat:abort` and an interrupt send.
  const interruptActiveTurn = async (group: ChatGroupContext): Promise<void> => {
    group.loop.abortCurrentTurn();
    const activeStreamTurn = group.surfaceRuntime.activity.activeTurn();
    if (activeStreamTurn) {
      try {
        await activeStreamTurn;
      } catch {
        // expected: interrupted turns may reject
      }
    }
  };
  // A refusal that came back after the running turn was already stopped: the
  // renderer must not read it as "nothing happened" and take the interrupted
  // badge off an answer that really was cut short.
  const flagInterruptedRefusal = (result: unknown): unknown => {
    if (result === null || typeof result !== "object") return result;
    const { ok, error } = result as { ok?: unknown; error?: unknown };
    if (ok === true || typeof error !== "string") return result;
    return { ...result, interrupted: true };
  };
  const isInterruptSend = (payload: unknown): boolean =>
    typeof payload === "object" && payload !== null
    && (payload as { interrupt?: unknown }).interrupt === true;

  ipcMain.handle(CHANNELS.chat.send, async (e, payload: unknown, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.send, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(chatGroupId);
    // An interrupt send is the user's Enter while a turn is running. The abort
    // happens inside this call rather than as a separate round trip the
    // renderer awaits first: that wait outlived the five-second keyboard
    // intent, and the send that followed was refused as not user-initiated.
    let interrupted = false;
    if (isInterruptSend(payload)) {
      // Only a send the host would accept from the keyboard may stop the
      // running turn: a refused payload must leave the answer the user was
      // watching alone.
      const admitted = parseChatSendPayload(payload);
      if (admitted.ok && admitted.payload.inputOrigin === "user-keyboard") {
        await interruptActiveTurn(group);
        interrupted = true;
      }
    }
    try {
      const result = await group.commandPort.execute(DESKTOP_CONVERSATION_ACTOR, {
        kind: "message.send",
        payload,
      });
      return interrupted ? flagInterruptedRefusal(result) : result;
    } catch (error) {
      if (error instanceof Error && error.message === STREAMING_ACTIVE) {
        return { error: STREAMING_ACTIVE, ...(interrupted ? { interrupted: true } : {}) };
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
  // ended between the active-turn check and the enqueue. The IPC return value
  // drives the renderer's "keep typed text vs. clear" decision.
  ipcMain.handle(CHANNELS.chat.guide, async (e, input: string, chatGroupId?: unknown) => {
    const group = groupOf(chatGroupId);
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.chat.guide, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof input !== "string" || input.trim().length === 0) {
      return { ok: false, error: "empty-text" };
    }
    // PII redaction applies to guide input too — same trust origin
    // (user-keyboard) and same downstream LLM consumption as chatSend.
    // The `redact_notice` stream event uses the active turn's streamId
    // implicitly and travels through the shared surface adapter so every
    // attached display sees the same current streaming context.
    const effective = sanitizeOutgoingInput(settingsService, group.buildSink(), input);
    const queueResult = group.loop.queueGuidance(effective);
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
        sessionId: group.loop.getSessionId(),
        type: "info",
        input: `chat:utterance:${mode}:queued:len=${effective.length}`,
      });
      return { ok: true };
    }
    return { ok: false, error: queueResult };
  });

  ipcMain.handle(CHANNELS.chat.abort, async (e, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.abort, e); return UNAUTHORIZED_FRAME; }
    await interruptActiveTurn(groupOf(chatGroupId));
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.chat.new, async (e, rawProject?: unknown, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.new, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(chatGroupId);
    const conversationLoop = group.loop;
    const mutation = group.turns.trackSessionMutation(async () => {
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
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.chat.sessions, e);
      return { current: conversationLoop.getSessionId(), sessions: [] };
    }
    return handleChatSessions(deps, opts);
  });

  ipcMain.handle(CHANNELS.chat.compact, (e, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.compact, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(chatGroupId);
    // Wire onCompactStarted/onCompactOccurred so slash-/compact also shows
    // the "자동 압축 중..." StatusBar indicator (parity with token preflight
    // path which gets it via runStreamedTurn callbacks). streamId is omitted
    // because manualCompact runs outside the per-turn stream.
    const mutation = group.turns.trackSessionMutation(async () => {
      const sink = group.buildSink();
      return group.loop.manualCompact({
        onCompactStarted: ({ triggerSource, estimatedBefore, preflight }) =>
          sink({
            kind: "compaction.started",
            triggerSource,
            estimatedBefore,
            preflight,
          }),
        onCompactOccurred: ({ removedMessages, freedTokens, estimatedAfter, trigger, summary, compactNum, compactStatus, truncatedDir }) =>
          sink({
            kind: "compaction.completed",
            removedMessages,
            freedTokens,
            estimatedAfter,
            ...(trigger !== undefined ? { trigger } : {}),
            ...(compactNum !== undefined ? { compactNum } : {}),
            ...(compactStatus !== undefined ? { compactStatus } : {}),
            ownerDetail: {
              ...(summary === undefined ? {} : { summary }),
              ...(truncatedDir === undefined ? {} : { truncatedDir }),
            },
          }),
      });
    });
    return mutation ?? { error: STREAMING_ACTIVE };
  });

  ipcMain.handle(CHANNELS.chat.sessionResume, async (e, sessionId: string, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.sessionResume, e); return UNAUTHORIZED_FRAME; }
    if (!isSafeSessionId(sessionId)) {
      return { ok: false, compacted: false, compactedAt: null, removedMessageCount: 0 };
    }
    const group = groupOf(chatGroupId);
    const conversationLoop = group.loop;
    const mutation = group.turns.trackSessionMutation(async () => {
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
  ipcMain.handle(CHANNELS.chat.getHistory, (_e, chatGroupId?: unknown) =>
    handleChatGetHistory(groupOf(chatGroupId).deps));

  ipcMain.handle(CHANNELS.chat.mainActiveState, (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.chat.mainActiveState, e);
      return null;
    }
    return memoryManager.loadMainActiveSessionState();
  });

  // PUBLIC lvis:chat:session-history — read-only: load messages for any session
  // by id (does NOT change active session). Delegated; the unauthorized frame
  // keeps the success-path shape so callers always read `result.ok`/`.messages`.
  ipcMain.handle(CHANNELS.chat.sessionHistory, (e, sessionId: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.chat.sessionHistory, e);
      // Keep the shape consistent with the success path — renderer always
      // reads `result.messages` and `result.ok`. Returning the bare
      // UNAUTHORIZED_FRAME (which omits `messages`) would force every caller
      // to widen the type and check before reading.
      return { ok: false, messages: [], error: "unauthorized-frame" as const };
    }
    return handleChatSessionHistory(deps, sessionId);
  });

  ipcMain.handle(CHANNELS.chat.editResend, async (e, messageIndex: number, newText: string, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.editResend, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(chatGroupId);
    const conversationLoop = group.loop;
    if (typeof messageIndex !== "number" || messageIndex < 0) return { ok: false, error: "invalid-index" };
    if (typeof newText !== "string" || newText.trim().length === 0) return { ok: false, error: "empty-text" };
    const turn = group.turns.tryStreamTurn(async (transport) => {
      // Read, persona-resolve, and truncate only after the exclusive lease is
      // visible. A Local API/CLI turn cannot leave this replay with a partial
      // history when it wins the race.
      const history = conversationLoop.getHistory().getMessages() as GenericMessage[];
      const historyIndex = entryOrdinalToHistoryIndex(history, messageIndex);
      if (historyIndex < 0) return { ok: false, error: "index-out-of-range" };
      const personaPromptId = personaPromptIdFromUserMessage(history[historyIndex]);
      if (!personaPromptId.ok) return { ok: false, error: personaPromptId.error };
      const personaPrompt = await resolvePersonaRolePrompt(personaPromptStore, personaPromptId.personaPromptId);
      if (!personaPrompt.ok) return { ok: false, error: personaPrompt.error };
      const messages = [...history];
      conversationLoop.getHistory().truncate(historyIndex);
      try {
        const result = await group.turns.runStreamTurn(transport, newText, undefined, personaPrompt.rolePrompt);
        return { ok: true, result };
      } catch (err) {
        // A provider-bound replay can fail closed before runTurn (for example
        // when DLP redacts a staged provenance header). Keep the original
        // conversation intact instead of turning a safe rejection into data loss.
        if (isMissingStagedEnvelopeError(err)) {
          conversationLoop.getHistory().restore(messages);
        }
        throw err;
      }
    });
    return turn ?? { ok: false, error: STREAMING_ACTIVE };
  });

  ipcMain.handle(CHANNELS.chat.fork, async (e, messageIndex: number, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.fork, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(chatGroupId);
    const conversationLoop = group.loop;
    const mutation = group.turns.trackSessionMutation(async () => {
      const current = conversationLoop.getHistory().getMessages() as GenericMessage[];
      let upto = current.length;
      if (typeof messageIndex === "number" && messageIndex >= 0) {
        const historyIndex = entryOrdinalToHistoryIndex(current, messageIndex);
        if (historyIndex >= 0) upto = Math.min(historyIndex + 1, current.length);
      }
      const sliced = current.slice(0, upto);
      // Repair tool-pair invariant before the slice is written to a NEW session
      // file — the same authority `branchFromCheckpoint` uses on the identical
      // slice→repair→rehydrate→saveSession sequence (engine/turn/session.ts).
      const { messages: slice, removedMessages, removedToolCalls } = normalizeToolPairInvariant(sliced);
      if (removedMessages > 0 || removedToolCalls > 0) {
        log.warn(
          `chat:fork repaired ${removedMessages} messages + ${removedToolCalls} tool calls from the forked slice`,
        );
      }
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
  ipcMain.handle(CHANNELS.chat.continueLastUser, async (e, payload: unknown, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.continueLastUser, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(chatGroupId);
    const p = payload as { sessionId?: unknown };
    if (typeof p?.sessionId !== "string") return { ok: false, error: "invalid-args" };
    if (p.sessionId !== group.loop.getSessionId()) return { ok: false, error: "session-mismatch" };
    return group.turns.continueFromLastUserTurn({ requireTerminalUser: true, restoreOnFailure: true }, p.sessionId);
  });

  ipcMain.handle(CHANNELS.chat.retryEffort, async (
    e,
    opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean },
    chatGroupId?: unknown,
  ) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.retryEffort, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(chatGroupId);
    const turn = group.turns.tryStreamTurn(async (transport) => {
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
        void deps.refreshSandboxNetworkConfig?.();
      }
      group.loop.refreshProvider();
      try {
        return await group.turns.continueFromLastUserTurnWithinLease(
          { requireTerminalUser: false, restoreOnFailure: false },
          transport,
        );
      } finally {
        await settingsService.patch({
          llm: { vendors: { [provider]: prevBlock } },
        });
        // Restore path: if the forward patch triggered a sandbox refresh but
        // the restore brings baseUrl back to the same value, the guard here is
        // also a no-op (prevBlock was the original, sig matches original).
        if (vendorBaseUrlSignature(settingsService.get("llm")) !== prevVendorBaseUrlSig) {
          void deps.refreshSandboxNetworkConfig?.();
        }
        group.loop.refreshProvider();
      }
    });
    return turn ?? { ok: false, error: STREAMING_ACTIVE };
  });

  // `targetSessionId` lets a sidebar row export ITSELF. Without it "share this
  // conversation" on a row silently exported whichever conversation happened to
  // be loaded — the same click meaning two different things.
  ipcMain.handle(CHANNELS.chat.export, async (
    e,
    format: "markdown" | "json",
    targetSessionId?: unknown,
  ) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.export, e); return UNAUTHORIZED_FRAME; }
    const { dialog } = await import("electron");
    const { writeFile } = await import("node:fs/promises");
    const win = getMainWindow();
    if (format !== "markdown" && format !== "json") return { ok: false, error: "invalid-format" };
    const loadedSessionId = conversationLoop.getSessionId();
    let sessionId = loadedSessionId;
    let messages: GenericMessage[];
    if (typeof targetSessionId === "string" && targetSessionId !== loadedSessionId) {
      if (!isValidSessionId(targetSessionId)) return { ok: false, error: "invalid-session" };
      const stored = memoryManager.loadSession(targetSessionId);
      // Not "fall back to the loaded conversation" — that would export the
      // wrong thing under the right name. A missing session is an error.
      if (!Array.isArray(stored)) return { ok: false, error: "not-found" };
      sessionId = targetSessionId;
      messages = stored as GenericMessage[];
    } else {
      messages = conversationLoop.getHistory().getMessages() as GenericMessage[];
    }
    if (messages.length === 0) return { ok: false, error: "empty" };

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

  // ── Row-level conversation edits ───────────────────────────────────────
  // One channel for the three fields a conversation row can change, because
  // they are one action from the user's side: editing this conversation's own
  // card. Each field is read off the payload by name — the payload is NEVER
  // spread into the metadata, so a renderer cannot reach the project binding
  // or the A2A wire identity through here.
  ipcMain.handle(CHANNELS.chat.sessionUpdate, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.sessionUpdate, e); return UNAUTHORIZED_FRAME; }
    const raw = (payload ?? {}) as {
      sessionId?: unknown;
      title?: unknown;
      archived?: unknown;
      unread?: unknown;
    };
    if (!isValidSessionId(raw.sessionId)) return { ok: false, error: "invalid-session" };
    if (!memoryManager.hasSessionMetadataFile(raw.sessionId)
      && !Array.isArray(memoryManager.loadSession(raw.sessionId))) {
      return { ok: false, error: "not-found" };
    }
    const fields: { title?: string; archivedAt?: string | null; unreadSince?: string | null } = {};
    if (raw.title !== undefined) {
      if (typeof raw.title !== "string") return { ok: false, error: "invalid-title" };
      const title = raw.title.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ").trim();
      // An empty rename is not "clear the title" — the row would then fall back
      // to the derived title and the user would see their edit vanish with no
      // explanation. Refuse it and let the caller keep the dialog open.
      if (!title) return { ok: false, error: "empty-title" };
      fields.title = title;
    }
    const now = new Date().toISOString();
    if (raw.archived !== undefined) {
      if (typeof raw.archived !== "boolean") return { ok: false, error: "invalid-archived" };
      fields.archivedAt = raw.archived ? now : null;
    }
    if (raw.unread !== undefined) {
      if (typeof raw.unread !== "boolean") return { ok: false, error: "invalid-unread" };
      fields.unreadSince = raw.unread ? now : null;
    }
    if (Object.keys(fields).length === 0) return { ok: false, error: "no-fields" };
    await memoryManager.updateSessionRowFields(raw.sessionId, fields);
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.chat.sessionDelete, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.sessionDelete, e); return UNAUTHORIZED_FRAME; }
    const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
    if (!isValidSessionId(sessionId)) return { ok: false, error: "invalid-session" };
    // The confirmation lives HERE, not in the renderer. A renderer-side confirm
    // is a promise the caller can skip; this one cannot be reached around.
    const { dialog } = await import("electron");
    const win = getMainWindow();
    const confirmOptions = {
      type: "warning" as const,
      buttons: [t("mainDialog.cancelButton"), t("mainDialog.deleteConversationConfirm")],
      defaultId: 0,
      cancelId: 0,
      message: t("mainDialog.deleteConversationMessage"),
      detail: t("mainDialog.deleteConversationDetail"),
    };
    const confirmation = win
      ? await dialog.showMessageBox(win, confirmOptions)
      : await dialog.showMessageBox(confirmOptions);
    if (confirmation.response !== 1) return { ok: false, canceled: true };

    // Only a LOADED conversation can be mid-turn, so only it needs the
    // mutation guard — and any tile may be the one holding it. Holding a
    // delete of some other conversation behind a loop would refuse a safe
    // action for a reason that does not apply to it.
    const holder = [...groupContexts.values()].find((group) => group.loop.getSessionId() === sessionId);
    if (!holder) {
      await memoryManager.deleteSession(sessionId);
      return { ok: true, wasLoaded: false };
    }
    const mutation = holder.turns.trackSessionMutation(async () => {
      await memoryManager.deleteSession(sessionId);
      return { ok: true as const, wasLoaded: true };
    });
    return (await mutation) ?? { ok: false, error: STREAMING_ACTIVE };
  });

  // Reverse of chat.export. INTERNAL (mutating; not in
  // PUBLIC_CHANNELS — same classification as chat.new/chat.fork above).
  // ALWAYS creates a brand-new DLP-safe UUID session — importing
  // NEVER overwrites an existing session, matching chat.fork's pattern.
  ipcMain.handle(CHANNELS.chat.import, async (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.import, e); return UNAUTHORIZED_FRAME; }
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

  ipcMain.handle(CHANNELS.chat.enterCheckpointView, (e, payload: unknown, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.enterCheckpointView, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(chatGroupId);
    const p = payload as { sessionId?: unknown; compactNum?: unknown };
    if (typeof p?.sessionId !== "string" || !Number.isSafeInteger(p?.compactNum) || (p.compactNum as number) < 0) {
      return { error: "invalid-args" };
    }
    if (p.sessionId !== group.loop.getSessionId()) {
      return { error: "session-mismatch" };
    }
    const result = group.loop.enterViewMode(p.compactNum as number);
    if (!result) return { error: "checkpoint-not-found" };
    return result;
  });

  ipcMain.handle(CHANNELS.chat.exitCheckpointView, (e, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.exitCheckpointView, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(chatGroupId);
    group.loop.exitViewMode();
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.chat.branchFromCheckpoint, async (e, payload: unknown, chatGroupId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.chat.branchFromCheckpoint, e); return UNAUTHORIZED_FRAME; }
    const group = groupOf(chatGroupId);
    const p = payload as { sessionId?: unknown; compactNum?: unknown };
    if (typeof p?.sessionId !== "string" || !Number.isSafeInteger(p?.compactNum) || (p.compactNum as number) < 0) {
      return { error: "invalid-args" };
    }
    if (p.sessionId !== group.loop.getSessionId()) {
      return { error: "session-mismatch" };
    }
    const mutation = group.turns.trackSessionMutation(async () =>
      group.loop.branchFromCheckpoint(p.compactNum as number));
    if (!mutation) return { error: STREAMING_ACTIVE };
    try {
      return await mutation;
    } catch (err) {
      return { error: (err as Error).message };
    }
  });
  // ─── Memory ─────────────────────────────────────
  ipcMain.handle(CHANNELS.memory.entriesList, (e, opts?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.entriesList, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return [];
    return memoryManager.listMemoryEntries(project.options);
  });
  ipcMain.handle(CHANNELS.memory.candidatesList, (e, opts?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.candidatesList, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return [];
    return memoryManager.listMemoryCandidates(project.options);
  });
  ipcMain.handle(CHANNELS.memory.entriesSave, async (e, title: string, content: string, opts?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.entriesSave, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return PROJECT_NOT_ALLOWED;
    if (!memoryCaptureService) {
      throw new Error("memory-reviewer-unavailable");
    }
    try {
      const result = await memoryCaptureService.captureExplicit({
        title,
        content,
        ...project.options,
      });
      if (result.status === "skipped") {
        throw new Error("memory-review-not-saved");
      }
      return result.entry;
    } catch {
      // Never fall back to a raw renderer-provided memory write.
      throw new Error("memory-review-not-saved");
    }
  });
  ipcMain.handle(CHANNELS.memory.entriesDelete, async (e, filename: unknown, opts?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.entriesDelete, e); return UNAUTHORIZED_FRAME; }
    if (typeof filename !== "string") return { ok: false, error: "invalid-input" };
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return PROJECT_NOT_ALLOWED;
    try {
      await memoryManager.deleteMemory(filename, project.options);
      return { ok: true };
    } catch {
      // Do not disclose a path, title, or another project's memory scope to the renderer.
      return { ok: false, error: "write-failed" };
    }
  });
  ipcMain.handle(CHANNELS.memory.candidateActivate, async (e, raw: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.candidateActivate, e); return UNAUTHORIZED_FRAME; }
    const candidate = parseMemoryCandidateActionPayload(raw);
    if (!candidate.ok) return { ok: false, error: "invalid-input" };
    const project = parseMemoryProjectOptions(candidate.options);
    if (!project.ok) return PROJECT_NOT_ALLOWED;
    try {
      const entry = await memoryManager.activateMemoryCandidate(candidate.id, project.options);
      return { ok: true, entry };
    } catch (error) {
      return candidateMemoryActionFailure(error);
    }
  });
  ipcMain.handle(CHANNELS.memory.candidateDelete, async (e, raw: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.candidateDelete, e); return UNAUTHORIZED_FRAME; }
    const candidate = parseMemoryCandidateActionPayload(raw);
    if (!candidate.ok) return { ok: false, error: "invalid-input" };
    const project = parseMemoryProjectOptions(candidate.options);
    if (!project.ok) return PROJECT_NOT_ALLOWED;
    try {
      await memoryManager.deleteMemoryCandidate(candidate.id, project.options);
      return { ok: true };
    } catch (error) {
      return candidateMemoryActionFailure(error);
    }
  });
  ipcMain.handle(CHANNELS.memory.entriesSearch, (e, query: string, opts?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.entriesSearch, e); return UNAUTHORIZED_FRAME; }
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
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.indexGet, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return "";
    return memoryManager.getMemoryIndex(project.options);
  });
  ipcMain.handle(CHANNELS.memory.indexUpdateIfUnchanged, async (e, expectedContent: string, nextContent: string) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.indexUpdateIfUnchanged, e); return UNAUTHORIZED_FRAME; }
    return memoryManager.updateMemoryIndexIfUnchanged(expectedContent, nextContent);
  });
  ipcMain.handle(CHANNELS.memory.indexSectionsUpdate, async (e, sections: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.indexSectionsUpdate, e); return UNAUTHORIZED_FRAME; }
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
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.sessionsList, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return [];
    return memoryManager.listSessionEntries(50, project.options);
  });
  ipcMain.handle(CHANNELS.memory.sessionsSearch, (e, query: string, opts?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.sessionsSearch, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return [];
    return memoryManager.searchSessions(query, project.options);
  });
  ipcMain.handle(CHANNELS.memory.agentsMdGet, (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.agentsMdGet, e); return UNAUTHORIZED_FRAME; }
    return memoryManager.getAgentsMd();
  });
  ipcMain.handle(CHANNELS.memory.agentsMdUpdate, async (e, content: string) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.agentsMdUpdate, e); return UNAUTHORIZED_FRAME; }
    return memoryManager.updateAgentsMd(content);
  });
  ipcMain.handle(CHANNELS.memory.userPrefsGet, (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.userPrefsGet, e); return UNAUTHORIZED_FRAME; }
    return memoryManager.getUserPreferences();
  });
  ipcMain.handle(CHANNELS.memory.userPrefsUpdate, async (e, content: string) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.userPrefsUpdate, e); return UNAUTHORIZED_FRAME; }
    return memoryManager.updateUserPreferences(content);
  });
  ipcMain.handle(CHANNELS.memory.userPrefsRefresh, async (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.userPrefsRefresh, e); return UNAUTHORIZED_FRAME; }
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

  ipcMain.handle(CHANNELS.memory.longTermRefresh, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.memory.longTermRefresh, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!memoryConsolidationService) {
      return { ok: false, error: "memory-consolidation-service-unavailable" };
    }
    try {
      // The default workspace is the app's unscoped global context, not a user
      // selected project. Never create a project overview for it.
      const project = conversationLoop.getSessionProjectIsDefault?.()
        ? undefined
        : conversationLoop.getSessionMemoryProjectContext?.();
      const result = await memoryConsolidationService.refresh({
        reason: "manual",
        ...(project ? { project } : {}),
      });
      return { ok: true, ...result };
    } catch (error) {
      // Provider and source details are host-only; renderer callers receive a
      // stable envelope regardless of the failing adapter or source state.
      log.warn("manual long-term memory consolidation failed: %s", error instanceof Error ? error.message : String(error));
      return { ok: false, error: "memory-consolidation-failed" };
    }
  });

  // ─── Starred messages ────────────────────────────────────
  // read-only, sender guard optional
  ipcMain.handle(CHANNELS.starred.list, () => {
    if (!starredStore) return [];
    return starredStore.list();
  });
  ipcMain.handle(CHANNELS.starred.add, (e, entry: { sessionId?: string; messageIndex: number; role: string; text: string }) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.starred.add, e); return UNAUTHORIZED_FRAME; }
    if (!starredStore) return { ok: false, error: "no-starred-store" };
    if (typeof entry?.messageIndex !== "number" || entry.messageIndex < -1) return { ok: false, error: "invalid-index" };
    if (typeof entry?.text !== "string") return { ok: false, error: "invalid-text" };
    const sessionId = entry.sessionId ?? conversationLoop.getSessionId();
    const record = starredStore.add({ sessionId, messageIndex: entry.messageIndex, role: entry.role, text: entry.text });
    return { ok: true, entry: record };
  });
  ipcMain.handle(CHANNELS.starred.remove, (e, opts: { id?: string; sessionId?: string; messageIndex?: number }) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.starred.remove, e); return UNAUTHORIZED_FRAME; }
    if (!starredStore) return { ok: false, error: "no-starred-store" };
    if (opts?.id) return { ok: starredStore.remove(opts.id) };
    if (opts?.sessionId && typeof opts.messageIndex === "number") {
      return { ok: starredStore.removeBySessionAndIndex(opts.sessionId, opts.messageIndex) };
    }
    return { ok: false, error: "invalid-args" };
  });

  // ─── Message feedback ────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.feedback.submit, async (e, payload: { sessionId: string; messageIndex: number; rating: "up" | "down"; reason?: string }) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.feedback.submit, e); return UNAUTHORIZED_FRAME; }
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
    (e, { sessionId, toolUseId }: { sessionId: string; toolUseId: string }, chatGroupId?: unknown) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.chat.getVerbatimToolResult, e);
        return null;
      }
      const group = groupOf(chatGroupId);
      if (sessionId !== group.loop.getSessionId()) return null;
      const messages = group.loop.getHistory().getMessages() as GenericMessage[];
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
    (e, payload: unknown, chatGroupId?: unknown) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.chat.getSubAgentTranscript, e);
        return { ok: false, error: "unauthorized-frame" };
      }
      const group = groupOf(chatGroupId);
      const p = (payload ?? {}) as Record<string, unknown>;
      const originSessionId = typeof p.originSessionId === "string" && isSafeSessionId(p.originSessionId)
        ? p.originSessionId
        : "";
      if (!originSessionId) return { ok: false, error: "invalid-origin-session-id" };
      if (originSessionId !== group.loop.getSessionId()) {
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
        group.loop.getHistory().getMessages(),
      ) as GenericMessage[];
      // Ownership is established either by the parent's transcript still
      // referencing the child, or by the child's own persisted
      // `originSessionId` — the value the HOST wrote at spawn time, naming the
      // parent that owns it.
      //
      // The metadata check is not a relaxation, it is the stronger of the two.
      // The transcript scan reads a tool_result that compaction is free to
      // strip (`[tool_result stripped: tool=agent_spawn, …]`), at which point a
      // genuinely owned child becomes unreachable — which is exactly what
      // happens to a restored panel row, whose transcript has no in-memory copy
      // to fall back on. Host-written metadata cannot be edited by the model
      // and does not decay with the conversation.
      const ownedByOrigin = runner.isPersistedSpawnOfOrigin?.(originSessionId, childSessionId) === true;
      if (!ownedByOrigin && !hasParentSubAgentReference(messages, childSessionId)) {
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
      if (!validateHostRendererSender(e)) {
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
    if (!validateHostRendererSender(e)) {
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
          };
        })
      : undefined;
    const accepted = askUserQuestionGate.resolve({
      requestId,
      answers,
      dismissed: r.dismissed === true,
    });
    return accepted ? { ok: true } : { ok: false, error: "invalid-answer" };
  });
}
