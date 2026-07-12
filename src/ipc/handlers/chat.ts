/**
 * chat.ts (handlers) — transport-agnostic PUBLIC chat handler logic (#1409 C10).
 *
 * Pure `handle*` functions holding the logic behind the PUBLIC chat channels
 * (`chat send`, `chat sessions`, `chat get-history`, `chat session-history`).
 * They import NOTHING from the electron transport — the `ipcMain.handle`
 * wrapper + `validateSender` trust boundary stay in `domains/chat.ts`, and all
 * renderer fan-out flows through the injected {@link ChatStreamSink}.
 *
 * Shared pure helpers (session-id validation, persona-prompt resolution,
 * payload narrowing) also live here so the transport layer (`domains/chat.ts`)
 * and any future in-process api/cli/sdk consume a single definition rather than
 * re-deriving them.
 */
import type { ChatInputOrigin, ChatSendPayload } from "../../shared/chat-origin.js";
import { isChatSendInputOrigin } from "../../shared/chat-origin.js";
import type { ActiveRolePrompt } from "../../data/role-presets.js";
import { PERSONA_PROMPT_ID_ALLOWLIST } from "../../main/persona-prompt-store.js";
import { redactForLLM } from "../../audit/dlp-filter.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import { serializeHistoryMessage } from "../../shared/chat-history.js";
import type { TurnResult } from "../../engine/conversation-loop.js";
import type { ParentMailboxEntry } from "../../engine/subagent-message-mailbox.js";
import { parseImportedTriggerEnvelope } from "../../shared/overlay-trigger-source.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { createLogger } from "../../lib/logger.js";
import type { SessionKind } from "../../memory/memory-manager.js";
import { resolveAuthorizedWorkspaceProject } from "../../main/project-root-authorization.js";
import { isDefaultWorkspaceRoot } from "../../main/default-workspace-root.js";
import {
  runStreamedTurn,
  STREAM_TURN_OPTIONS,
  type ChatStreamSink,
} from "./chat-stream.js";

const log = createLogger("chat");

export const SESSION_KIND_VALUES = new Set<SessionKind | "all">(["main", "routine", "all"]);
const SESSION_ID_REGEX = /^[a-zA-Z0-9_\-]+$/;
const MAX_PROJECT_ROOT_CHARS = 2_048;
const MAX_PROJECT_NAME_CHARS = 120;

const ACKNOWLEDGING_STOP_REASON = "end_turn";

export interface ParentMailboxTurn {
  parentSessionId: string;
  entryIds: string[];
  initialGuidance: string;
  approvalReasonPrefix: string;
}

interface ParentMailboxRunner {
  peekParentMailbox(parentSessionId: string): Promise<ParentMailboxEntry[]>;
  acknowledgeParentMailbox(parentSessionId: string, entryIds: readonly string[]): Promise<unknown>;
}

function getParentMailboxRunner(deps: IpcDeps): ParentMailboxRunner | undefined {
  const runner = deps.getSubAgentRunner?.() as Partial<ParentMailboxRunner> | undefined;
  return runner
    && typeof runner.peekParentMailbox === "function"
    && typeof runner.acknowledgeParentMailbox === "function"
    ? runner as ParentMailboxRunner
    : undefined;
}

function mailboxApprovalPrefix(entries: readonly ParentMailboxEntry[]): string {
  const labels = [...new Set(entries.map((entry) => entry.approvalLabel))];
  return labels.length === 1 ? labels[0]! : "[Sub-Agent: multiple sources]";
}

/**
 * Snapshot the current main-session mailbox without switching sessions.
 * The snapshot remains durable until a receiving turn acknowledges every id.
 */
export async function prepareParentMailboxTurn(deps: IpcDeps): Promise<ParentMailboxTurn | null> {
  const { conversationLoop } = deps;
  if (conversationLoop.getSessionKind() !== "main") return null;
  const parentSessionId = conversationLoop.getSessionId();
  const runner = getParentMailboxRunner(deps);
  if (!runner) return null;

  let entries: ParentMailboxEntry[];
  try {
    entries = await runner.peekParentMailbox(parentSessionId);
  } catch (err) {
    deps.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: parentSessionId,
      type: "error",
      input: `subagent-mailbox-peek-failed:${(err as Error).message}`,
    });
    return null;
  }
  if (
    entries.length === 0
    || conversationLoop.getSessionKind() !== "main"
    || conversationLoop.getSessionId() !== parentSessionId
  ) {
    return null;
  }

  return {
    parentSessionId,
    entryIds: entries.map((entry) => entry.id),
    initialGuidance: entries.map((entry) => entry.formattedText).join("\n\n"),
    approvalReasonPrefix: mailboxApprovalPrefix(entries),
  };
}

/** Acknowledge only after the snapshotted parent actually consumed the turn. */
export async function acknowledgeParentMailboxAfterTurn(
  deps: IpcDeps,
  mailboxTurn: ParentMailboxTurn | null,
  result: TurnResult,
): Promise<void> {
  if (
    !mailboxTurn
    || result.route === "command"
    || result.stopReason !== ACKNOWLEDGING_STOP_REASON
  ) return;
  if (deps.conversationLoop.getSessionId() !== mailboxTurn.parentSessionId) return;
  const runner = getParentMailboxRunner(deps);
  if (!runner) return;
  try {
    await runner.acknowledgeParentMailbox(mailboxTurn.parentSessionId, mailboxTurn.entryIds);
  } catch (err) {
    deps.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: mailboxTurn.parentSessionId,
      type: "error",
      input: `subagent-mailbox-ack-failed:${(err as Error).message}`,
    });
  }
}

export interface ChatSessionProjectPayload {
  projectRoot?: string;
  projectName?: string;
}

export function isSafeSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && SESSION_ID_REGEX.test(sessionId);
}

function normalizeProjectString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxChars) : undefined;
}

export function parseChatSessionProjectPayload(raw: unknown): ChatSessionProjectPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const projectRoot = normalizeProjectString(record.projectRoot, MAX_PROJECT_ROOT_CHARS);
  const projectName = normalizeProjectString(record.projectName, MAX_PROJECT_NAME_CHARS);
  return {
    ...(projectRoot ? { projectRoot } : {}),
    ...(projectName ? { projectName } : {}),
  };
}

export function defaultWorkspaceProjectPayload(defaultWorkspaceRoot = process.cwd()): ChatSessionProjectPayload {
  const projectRoot = normalizeProjectString(defaultWorkspaceRoot, MAX_PROJECT_ROOT_CHARS);
  // Default/base-directory project is labeled "default" (not the workspace
  // folder basename) so the sidebar + insights never surface a confusing folder
  // name. The authoritative resolution (resolveAuthorizedWorkspaceProject →
  // defaultWorkspaceProject) also uses this literal; kept in sync here for the
  // request-payload path.
  return {
    ...(projectRoot ? { projectRoot } : {}),
    projectName: "default",
  };
}

export function resolveChatNewProjectPayload(raw: unknown, defaultWorkspaceRoot = process.cwd()): ChatSessionProjectPayload {
  const parsed = parseChatSessionProjectPayload(raw);
  if (parsed.projectRoot) return parsed;
  return defaultWorkspaceProjectPayload(defaultWorkspaceRoot);
}

export function normalizePersonaPromptId(
  inputOrigin: ChatInputOrigin,
  value: unknown,
): { ok: true; personaPromptId?: string } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (inputOrigin !== "user-keyboard") {
    return { ok: false, error: "persona-prompt-origin-restricted" };
  }
  if (typeof value !== "string") return { ok: false, error: "invalid-persona-prompt-id" };
  const id = value.trim();
  if (!PERSONA_PROMPT_ID_ALLOWLIST.test(id) || id === "default") {
    return { ok: false, error: "invalid-persona-prompt-id" };
  }
  return { ok: true, personaPromptId: id };
}

export function personaPromptIdFromUserMessage(
  message: GenericMessage | undefined,
): { ok: true; personaPromptId?: string } | { ok: false; error: string } {
  if (!message || message.role !== "user") return { ok: true };
  const value = message.meta?.activePersonaPrompt;
  if (value === undefined || value === null) return { ok: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "invalid-persona-prompt-id" };
  }
  return normalizePersonaPromptId("user-keyboard", (value as { id?: unknown }).id);
}

export async function resolvePersonaRolePrompt(
  personaPromptStore: IpcDeps["personaPromptStore"],
  personaPromptId: string | undefined,
): Promise<{ ok: true; rolePrompt?: ActiveRolePrompt } | { ok: false; error: string }> {
  if (!personaPromptId) return { ok: true };
  if (!personaPromptStore) return { ok: false, error: "persona-prompt-not-found" };
  try {
    const prompt = await personaPromptStore.get(personaPromptId);
    if (!prompt) return { ok: false, error: "persona-prompt-not-found" };
    return {
      ok: true,
      rolePrompt: {
        id: prompt.id,
        name: prompt.name,
        systemPromptAdd: prompt.systemPromptAdd,
      },
    };
  } catch {
    return { ok: false, error: "invalid-persona-prompt-id" };
  }
}

/**
 * Validate the multimodal content-parts payload that arrives over IPC. The
 * renderer is trusted but the preload bridge is a `unknown[]` boundary, so
 * we type-narrow each entry here to protect downstream message-mapper code
 * from malformed payloads (missing fields, wrong tags, non-string data).
 *
 * Returns the validated array when at least one entry survived narrowing,
 * or `undefined` when nothing valid is present. The `undefined` form lets
 * the caller drop the `attachments` field from the runTurn options spread
 * entirely (the conversation loop treats absent and empty as equivalent
 * "no parts" — emitting an empty array would be technically valid but adds
 * noise to logs and ruins the option-spread shape).
 *
 * Unknown entries are dropped silently rather than rejecting the whole
 * turn — mirrors how `sanitizeOutgoingInput` handles partial PII redaction.
 */
export function validateUserContentParts(
  raw: unknown,
): import("../../engine/llm/types.js").UserContentPart[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out: import("../../engine/llm/types.js").UserContentPart[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const t = (item as { type?: unknown }).type;
    if (t === "text") {
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string") out.push({ type: "text", text });
      continue;
    }
    if (t === "image") {
      const image = (item as { image?: unknown }).image;
      const mimeType = (item as { mimeType?: unknown }).mimeType;
      if (typeof image !== "string") continue;
      out.push({
        type: "image",
        image,
        ...(typeof mimeType === "string" ? { mimeType } : {}),
      });
      continue;
    }
    if (t === "file") {
      const data = (item as { data?: unknown }).data;
      const mimeType = (item as { mimeType?: unknown }).mimeType;
      if (typeof data !== "string" || typeof mimeType !== "string") continue;
      out.push({ type: "file", data, mimeType });
      continue;
    }
    // Unknown tag → drop
  }
  return out.length > 0 ? out : undefined;
}

export function parseChatSendPayload(
  payload: unknown,
): { ok: true; payload: ChatSendPayload } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "invalid-payload" };
  }
  const candidate = payload as {
    input?: unknown;
    attachments?: unknown;
    inputOrigin?: unknown;
    userActivation?: unknown;
    personaPromptId?: unknown;
  };
  if (typeof candidate.input !== "string") {
    return { ok: false, error: "invalid-input" };
  }
  if (!isChatSendInputOrigin(candidate.inputOrigin)) {
    return { ok: false, error: "missing-input-origin" };
  }
  if (candidate.inputOrigin === "user-keyboard" && candidate.userActivation !== true) {
    return { ok: false, error: "user-keyboard-required" };
  }
  const originSource = parseImportedTriggerEnvelope(candidate.input);
  if (candidate.inputOrigin === "plugin-emitted" && !originSource) {
    return { ok: false, error: "missing-plugin-envelope" };
  }
  const personaPrompt = normalizePersonaPromptId(candidate.inputOrigin, candidate.personaPromptId);
  if (!personaPrompt.ok) return { ok: false, error: personaPrompt.error };
  return {
    ok: true,
    payload: {
      input: candidate.input,
      attachments: candidate.attachments,
      inputOrigin: candidate.inputOrigin,
      ...(candidate.userActivation === true ? { userActivation: true } : {}),
      ...(personaPrompt.personaPromptId ? { personaPromptId: personaPrompt.personaPromptId } : {}),
    },
  };
}

/**
 * Apply PII redaction to outgoing chat input. On a hit, publishes a
 * `redact_notice` stream frame through the sink (byte-identical to the pre-C10
 * `webContents.send(lvis:chat:stream, ...)` call) and returns the redacted
 * text; otherwise returns the input unchanged.
 */
export function sanitizeOutgoingInput(
  settingsService: IpcDeps["settingsService"],
  sink: ChatStreamSink,
  input: string,
): string {
  let effective = input;
  const privacy = settingsService.get("privacy");
  if (privacy?.piiRedactEnabled && typeof input === "string") {
    const r = redactForLLM(input);
    if (r.totalCount > 0) {
      effective = r.redacted;
      sink(CHANNELS.chat.stream, {
        type: "redact_notice",
        count: r.totalCount,
        byKind: r.counts,
      });
      log.warn({ counts: r.counts }, `user draft redacted — count=${r.totalCount}`);
    }
  }
  return effective;
}

/**
 * Post-turn main-session bookkeeping. Extracted so both `chat send` and the
 * internal edit-resend / continue-last-user / retry-effort paths call one
 * definition.
 */
export async function markMainActiveAfterTurn(deps: IpcDeps, input: string): Promise<void> {
  const { conversationLoop, memoryManager } = deps;
  if (conversationLoop.getSessionKind() !== "main") return;
  if (conversationLoop.getHistory().length > 0) {
    // "No explicit project" sessions (the default/base-directory binding)
    // must NOT persist projectRoot/projectName into metadata — null project
    // fields are the normal state for them (2026-07 "remove Current Project
    // labeling"). `getSessionProjectIsDefault` is a real, always-present
    // method on ConversationLoop (called unconditionally elsewhere, e.g.
    // handleChatGetHistory) — no duck-typing needed here; a prior
    // duck-typed fallback defaulted to `false` (persist) for test doubles
    // predating this getter, which is the WRONG safe direction (silently
    // persisting default-project metadata risks the ghost-project-group
    // class of bug), so it is removed rather than flipped.
    const isDefaultProject = conversationLoop.getSessionProjectIsDefault();
    if (!isDefaultProject) {
      const project = typeof conversationLoop.getSessionProjectContext === "function"
        ? conversationLoop.getSessionProjectContext()
        : {
            projectRoot: typeof conversationLoop.getSessionProjectRoot === "function" ? conversationLoop.getSessionProjectRoot() ?? undefined : undefined,
            projectName: typeof conversationLoop.getSessionProjectName === "function" ? conversationLoop.getSessionProjectName() ?? undefined : undefined,
          };
      if (project.projectRoot || project.projectName) {
        const existing = memoryManager.loadSessionMetadata(conversationLoop.getSessionId()) ?? {};
        await memoryManager.saveSessionMetadata(conversationLoop.getSessionId(), {
          ...existing,
          sessionKind: "main",
          ...project,
        });
      }
    }
    await memoryManager.markMainActiveResume(conversationLoop.getSessionId());
    return;
  }
  if (input.trim() === "/new") {
    await memoryManager.markMainActiveFresh();
  }
}

/** Injected stream-turn plumbing shared with the registrar's other turn paths. */
export interface ChatSendContext {
  /** IPC (or api/cli) sink that publishes stream + fallback frames. */
  sink: ChatStreamSink;
  /** Allocates the next per-turn stream correlation id (registrar-owned state). */
  allocateStreamId: () => number;
  /** Tracks the in-flight turn so abort / branch see a single active promise. */
  trackStreamTurn: (factory: () => Promise<TurnResult>) => Promise<TurnResult>;
}

/** PUBLIC `lvis:chat:send` — parse + sanitize + stream one conversation turn. */
export async function handleChatSend(
  deps: IpcDeps,
  payload: unknown,
  ctx: ChatSendContext,
): Promise<TurnResult | { ok: false; error: string }> {
  const { conversationLoop, settingsService, auditLogger, personaPromptStore } = deps;
  const expectedSessionId = conversationLoop.getSessionId();
  const parsed = parseChatSendPayload(payload);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { input, attachments, inputOrigin, personaPromptId } = parsed.payload;
  const personaPrompt = await resolvePersonaRolePrompt(personaPromptStore, personaPromptId);
  if (conversationLoop.getSessionId() !== expectedSessionId) {
    return { ok: false, error: "session-mismatch" };
  }
  if (!personaPrompt.ok) return { ok: false, error: personaPrompt.error };
  // queue-auto inputOrigin is automatic intake from accumulated explicit user input.
  // It runs outside the user gesture context, triggered by the IPC stream-done event,
  // so audit telemetry must distinguish it from user-keyboard turns
  // (critic Round 2 M2), matching the guide path.
  if (inputOrigin === "queue-auto") {
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: conversationLoop.getSessionId(),
      type: "info",
      input: `chat:utterance:queue-auto:start:len=${input.length}`,
    });
  }
  // IPC payload validation — the renderer is trusted but a corrupt
  // preload bridge or a stray `unknown[]` cast could deliver malformed
  // parts. We validate the shape here so the conversation loop never
  // sees garbage.
  const validated = validateUserContentParts(attachments);
  const effective = sanitizeOutgoingInput(settingsService, ctx.sink, input);
  const streamId = ctx.allocateStreamId();
  return ctx.trackStreamTurn(async () => {
    // The mailbox snapshot belongs to the same lease as the receiving turn.
    // Taking it before trackStreamTurn allowed session mutation (new/resume/
    // fork) to switch the loop while durable child guidance was being read.
    const mailboxTurn = inputOrigin === "user-keyboard" || inputOrigin === "queue-auto"
      ? await prepareParentMailboxTurn(deps)
      : null;
    const result = await runStreamedTurn(
      conversationLoop,
      effective,
      ctx.sink,
      streamId,
      {
        ...STREAM_TURN_OPTIONS,
        attachments: validated,
        inputOrigin,
        ...(personaPrompt.rolePrompt ? { rolePrompt: personaPrompt.rolePrompt } : {}),
        ...(mailboxTurn
          ? {
              initialGuidance: mailboxTurn.initialGuidance,
              approvalReasonPrefix: mailboxTurn.approvalReasonPrefix,
            }
          : {}),
      },
    );
    await acknowledgeParentMailboxAfterTurn(deps, mailboxTurn, result);
    await markMainActiveAfterTurn(deps, effective);
    return result;
  });
}

/** PUBLIC `lvis:chat:sessions` — paginated session list + active session id. */
export function handleChatSessions(
  deps: IpcDeps,
  opts?: { limit?: unknown; before?: unknown; beforeId?: unknown; after?: unknown; kind?: unknown; routineId?: unknown; projectRoot?: unknown },
) {
  const { conversationLoop, memoryManager } = deps;
  const limit = typeof opts?.limit === "number" && Number.isFinite(opts.limit)
    ? Math.max(1, Math.min(100, Math.floor(opts.limit)))
    : 20;
  const beforeTime = typeof opts?.before === "string" ? Date.parse(opts.before) : Number.NaN;
  const before = Number.isNaN(beforeTime) ? undefined : new Date(beforeTime);
  const afterTime = typeof opts?.after === "string" ? Date.parse(opts.after) : Number.NaN;
  const after = Number.isNaN(afterTime) ? undefined : new Date(afterTime);
  const beforeId = isSafeSessionId(opts?.beforeId)
    ? opts.beforeId
    : undefined;
  const kind = SESSION_KIND_VALUES.has(opts?.kind as SessionKind | "all")
    ? opts?.kind as SessionKind | "all"
    : "main";
  const routineId = typeof opts?.routineId === "string" ? opts.routineId : undefined;
  const requestedProjectRoot = normalizeProjectString(opts?.projectRoot, MAX_PROJECT_ROOT_CHARS);
  const resolvedProject = requestedProjectRoot ? resolveAuthorizedWorkspaceProject(requestedProjectRoot) : undefined;
  const projectRoot = resolvedProject
    ? resolvedProject.authorized && resolvedProject.project
      ? resolvedProject.project.projectRoot
      : "__lvis_unauthorized_project_root__"
    : undefined;
  const includeUnscoped = resolvedProject?.authorized === true && resolvedProject.project?.isDefault === true;
  const sessions = memoryManager
    .listSessionsPage({ kind, ...(routineId ? { routineId } : {}), ...(projectRoot ? { projectRoot } : {}), ...(includeUnscoped ? { includeUnscoped: true } : {}), limit, ...(before ? { before } : {}), ...(beforeId ? { beforeId } : {}), ...(after ? { after } : {}) })
    .map((s) => {
      // Scrub legacy default-tagged project metadata at the read chokepoint.
      // Pre-PR, markMainActiveAfterTurn persisted projectRoot/projectName
      // (= the default workspace root / "workspace") for EVERY session, no
      // isDefault guard. Sidebar.tsx's namedProjects excludes the default
      // root from the known-projects list, so a legacy session's default
      // root falls into the "unknown project" fallback map and renders as
      // its own ghost named group (sidebar AND Insights, since both read
      // through this same handler). Stripping here — rather than patching
      // every reader — heals both call sites from one chokepoint. Sessions
      // written post-fix never carry default-root metadata in the first
      // place, so this is a no-op for them.
      const isLegacyDefaultTagged = Boolean(s.projectRoot) && isDefaultWorkspaceRoot(s.projectRoot!);
      return {
        id: s.id,
        modifiedAt: s.modifiedAt.toISOString(),
        title: s.title,
        sessionKind: s.sessionKind,
        ...(s.routineId ? { routineId: s.routineId } : {}),
        ...(s.routineTitle ? { routineTitle: s.routineTitle } : {}),
        ...(s.routineFiredAt ? { routineFiredAt: s.routineFiredAt } : {}),
        ...(!isLegacyDefaultTagged && s.projectRoot ? { projectRoot: s.projectRoot } : {}),
        ...(!isLegacyDefaultTagged && s.projectName ? { projectName: s.projectName } : {}),
        ...(s.branchedFromCompactNum !== undefined ? { branchedFromCompactNum: s.branchedFromCompactNum } : {}),
        ...(s.branchedAt ? { branchedAt: s.branchedAt } : {}),
      };
    });
  return {
    current: conversationLoop.getSessionId(),
    sessions,
  };
}

/** PUBLIC `lvis:chat:get-history` — the active session's serialized history. */
export function handleChatGetHistory(deps: IpcDeps) {
  const { conversationLoop, memoryManager } = deps;
  const messages = conversationLoop.getHistory().getMessages() as GenericMessage[];
  const currentListEntry = memoryManager
    .listSessions({ kind: "all", limit: Number.POSITIVE_INFINITY })
    .find((session) => session.id === conversationLoop.getSessionId());
  return {
    sessionId: conversationLoop.getSessionId(),
    sessionTitle: currentListEntry?.title,
    sessionKind: conversationLoop.getSessionKind(),
    ...(conversationLoop.getSessionRoutineId() ? { routineId: conversationLoop.getSessionRoutineId() } : {}),
    ...(conversationLoop.getSessionRoutineTitle() ? { routineTitle: conversationLoop.getSessionRoutineTitle() } : {}),
    ...(conversationLoop.getSessionProjectRoot() ? { projectRoot: conversationLoop.getSessionProjectRoot() } : {}),
    ...(conversationLoop.getSessionProjectName() ? { projectName: conversationLoop.getSessionProjectName() } : {}),
    // Live in-memory binding: ALWAYS resolved (default included), unlike the
    // persisted session metadata which now omits project fields entirely for
    // "no explicit project" sessions. The renderer needs this flag to tell
    // "user explicitly picked this project" apart from "just the ambient
    // default directory" when the composer/sidebar want to show the real name
    // vs a "Select project" placeholder for the ACTIVE (not-yet-persisted)
    // session.
    ...(conversationLoop.getSessionProjectIsDefault() ? { projectIsDefault: true } : {}),
    messages: messages.map(serializeHistoryMessage),
  };
}

/**
 * PUBLIC `lvis:chat:session-history` — load messages for ANY session by id.
 *
 * Session-addressing note (#1409): this is a read that intentionally SUCCEEDS
 * for a non-active `sessionId` — it is the sidebar's preview path and never
 * changes the active session. It therefore does NOT fail closed with the
 * `session-not-active` code; behavior is preserved as-is (it never retargets
 * the active session, so there
 * is no cross-session mutation risk). See the C10 report for the session
 * addressing audit.
 */
export function handleChatSessionHistory(deps: IpcDeps, sessionId: string) {
  const { memoryManager } = deps;
  if (!isSafeSessionId(sessionId)) {
    return { ok: false, messages: [] };
  }
  // loadSession() reads the session JSONL via readFileSync; IO/parse errors
  // propagate as throws. Catch them here so a corrupted session file or
  // missing path doesn't reject the IPC call (which would surface as a
  // renderer-side rejection rather than an empty result).
  let loaded: unknown;
  try {
    loaded = memoryManager.loadSession(sessionId);
  } catch {
    return { ok: false, messages: [] };
  }
  if (!Array.isArray(loaded)) return { ok: false, messages: [] };
  const raw = loaded.filter(
    (m): m is GenericMessage =>
      m != null && typeof m === "object" && "role" in m && "content" in m,
  );
  // Surface the rolling-summary preamble length so the renderer
  // can prepend a `kind: "session_resume"` marker. We do not return the
  // preamble text — it is system-prompt material, not chat history, and
  // returning it would leak it into a UI surface that should only show a
  // disclosure ("요약 N자 적용") rather than the verbatim summary.
  let preambleChars = 0;
  let sessionKind: SessionKind = "main";
  let sessionTitle: string | undefined;
  let routineId: string | undefined;
  let routineTitle: string | undefined;
  let routineFiredAt: string | undefined;
  let projectRoot: string | undefined;
  let projectName: string | undefined;
  try {
    const meta = memoryManager.loadSessionMetadata(sessionId);
    if (meta) {
      sessionKind = meta.sessionKind ?? "main";
      sessionTitle = meta.title;
      routineId = meta.routineId;
      routineTitle = meta.routineTitle;
      routineFiredAt = meta.routineFiredAt;
      projectRoot = meta.projectRoot;
      projectName = meta.projectName;
      preambleChars = typeof meta.summaryPreamble === "string" ? meta.summaryPreamble.length : 0;
    }
  } catch {
    // Metadata file missing/corrupt — fall through with empty session-resume hint.
  }
  if (!sessionTitle) {
    sessionTitle = memoryManager
      .listSessions({ kind: "all", limit: Number.POSITIVE_INFINITY })
      .find((session) => session.id === sessionId)?.title;
  }
  return {
    ok: true,
    sessionKind,
    ...(sessionTitle ? { sessionTitle } : {}),
    ...(routineId ? { routineId } : {}),
    ...(routineTitle ? { routineTitle } : {}),
    ...(routineFiredAt ? { routineFiredAt } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    ...(projectName ? { projectName } : {}),
    messages: raw.map(serializeHistoryMessage),
    preambleChars,
  };
}
