/**
 * Chat domain IPC handlers.
 * Covers: lvis:chat:*, lvis:memory:*, lvis:starred:*, lvis:feedback:submit,
 *         lvis:ask-user-question:respond
 * Note: routine v2 channels (lvis:routines:v2:*) are handled in misc.ts.
 */
import { ipcMain } from "electron";
import type { WebContents } from "electron";
import type { ChatInputOrigin, ChatSendPayload } from "../../shared/chat-origin.js";
import { isChatSendInputOrigin } from "../../shared/chat-origin.js";
import { redactForLLM } from "../../audit/dlp-filter.js";
import { estimateMessagesTokens } from "../../engine/auto-compact.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import { userContentText } from "../../engine/llm/types.js";
import { serializeHistoryMessage } from "../../shared/chat-history.js";
import type { ConversationLoop, TurnResult } from "../../engine/conversation-loop.js";
import { parseImportedTriggerEnvelope } from "../../shared/overlay-trigger-source.js";
import type { ChatUtteranceMode } from "../../shared/chat-utterance.js";
import type { SelectedAssistantContext } from "../../shared/assistant-context.js";
import { AGENT_NAME_ALLOWLIST } from "../../main/agent-profile-store.js";
import { SKILL_NAME_ALLOWLIST } from "../../main/skill-store.js";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { sendToWebContents } from "../safe-send.js";
import { createLogger } from "../../lib/logger.js";
import { readDiffSidecar, isSafeId } from "../../tools/write-diff-cache.js";
import { isToolResultStubContent } from "../../shared/tool-result-stub.js";
import {
  createStreamingFilter,
  stripSuggestedReplies,
} from "../../engine/suggested-replies.js";
import type { SessionKind } from "../../memory/memory-manager.js";
const log = createLogger("chat");
const MAX_ROLE_PROMPT_CHARS = 12_000;
const MAX_SELECTED_SKILLS = 5;
const SESSION_KIND_VALUES = new Set<SessionKind | "all">(["main", "routine", "all"]);
const SESSION_ID_REGEX = /^[a-zA-Z0-9_\-]+$/;

function isSafeSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && SESSION_ID_REGEX.test(sessionId);
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

function normalizeRolePrompt(
  inputOrigin: ChatInputOrigin,
  value: unknown,
): { ok: true; rolePrompt?: NonNullable<ChatSendPayload["rolePrompt"]> } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  // queue-auto 도 user-keyboard 와 동등 trust (사용자 입력 누적) → rolePrompt
  // 허용. 검증 명: role-prompt-origin-restricted (origin allow-list).
  if (inputOrigin !== "user-keyboard" && inputOrigin !== "queue-auto") {
    return { ok: false, error: "role-prompt-origin-restricted" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "invalid-role-prompt" };
  }
  const candidate = value as { name?: unknown; systemPromptAdd?: unknown };
  if (typeof candidate.name !== "string" || typeof candidate.systemPromptAdd !== "string") {
    return { ok: false, error: "invalid-role-prompt" };
  }
  const systemPromptAdd = candidate.systemPromptAdd.trim().slice(0, MAX_ROLE_PROMPT_CHARS);
  if (!systemPromptAdd) return { ok: true };
  return {
    ok: true,
    rolePrompt: {
      name: candidate.name.trim().slice(0, 80) || "role",
      systemPromptAdd,
    },
  };
}

function normalizeAssistantContext(
  inputOrigin: ChatInputOrigin,
  value: unknown,
): { ok: true; assistantContext?: SelectedAssistantContext } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (inputOrigin !== "user-keyboard" && inputOrigin !== "queue-auto") {
    return { ok: false, error: "assistant-context-origin-restricted" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "invalid-assistant-context" };
  }
  const candidate = value as { agentName?: unknown; skillNames?: unknown };
  let agentName: string | undefined;
  if (candidate.agentName !== undefined && candidate.agentName !== null) {
    if (typeof candidate.agentName !== "string") {
      return { ok: false, error: "invalid-assistant-agent" };
    }
    const trimmed = candidate.agentName.trim();
    if (trimmed) {
      if (!AGENT_NAME_ALLOWLIST.test(trimmed)) {
        return { ok: false, error: "invalid-assistant-agent" };
      }
      agentName = trimmed;
    }
  }

  const skillNames: string[] = [];
  if (candidate.skillNames !== undefined && candidate.skillNames !== null) {
    if (!Array.isArray(candidate.skillNames)) {
      return { ok: false, error: "invalid-assistant-skills" };
    }
    const seen = new Set<string>();
    for (const raw of candidate.skillNames) {
      if (typeof raw !== "string") return { ok: false, error: "invalid-assistant-skills" };
      const name = raw.trim();
      if (!name) continue;
      if (!SKILL_NAME_ALLOWLIST.test(name)) {
        return { ok: false, error: "invalid-assistant-skill" };
      }
      if (!seen.has(name)) {
        seen.add(name);
        skillNames.push(name);
      }
      if (skillNames.length >= MAX_SELECTED_SKILLS) break;
    }
  }

  if (!agentName && skillNames.length === 0) return { ok: true };
  return {
    ok: true,
    assistantContext: {
      ...(agentName ? { agentName } : {}),
      ...(skillNames.length > 0 ? { skillNames } : {}),
    },
  };
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function neutralizeAssistantContextTags(value: string): string {
  return value.replace(
    /<\/?\s*lvis-(?:selected-assistant-context|agent-profile|selected-skill)[^>]*>/gi,
    (match) => match.replace("<", "< "),
  );
}

async function mergeAssistantContextPrompt(
  baseRolePrompt: ChatSendPayload["rolePrompt"],
  assistantContext: SelectedAssistantContext | undefined,
  deps: Pick<IpcDeps, "agentProfileStore" | "skillStore">,
): Promise<ChatSendPayload["rolePrompt"]> {
  if (!assistantContext) return baseRolePrompt;
  const sections: string[] = [];
  const labels: string[] = [];

  if (assistantContext.agentName && deps.agentProfileStore) {
    const agent = await deps.agentProfileStore.load(assistantContext.agentName);
    if (agent) {
      labels.push(`Agent: ${agent.name}`);
      sections.push([
        `<lvis-agent-profile name="${escapeXmlAttribute(agent.name)}">`,
        neutralizeAssistantContextTags(agent.body),
        "</lvis-agent-profile>",
      ].join("\n"));
    }
  }

  if (assistantContext.skillNames?.length && deps.skillStore) {
    const skillRows: string[] = [];
    for (const skillName of assistantContext.skillNames) {
      const skill = await deps.skillStore.load(skillName);
      if (!skill) continue;
      labels.push(`Skill: ${skill.name}`);
      const triggers = skill.triggers.length > 0
        ? ` triggers="${escapeXmlAttribute(skill.triggers.join(", "))}"`
        : "";
      skillRows.push(
        `<lvis-selected-skill name="${escapeXmlAttribute(skill.name)}" source="${skill.source}"${triggers}>${neutralizeAssistantContextTags(skill.description)}</lvis-selected-skill>`,
      );
    }
    if (skillRows.length > 0) {
      sections.push([
        "<lvis-selected-skills>",
        "The user selected these skills for this turn. Do not apply a selected skill body from metadata alone; call the skill_load tool before relying on the full skill instructions so existing approval and body-hash checks run.",
        ...skillRows,
        "</lvis-selected-skills>",
      ].join("\n"));
    }
  }

  if (sections.length === 0) return baseRolePrompt;
  const assistantSection = [
    "<lvis-selected-assistant-context>",
    ...sections,
    "</lvis-selected-assistant-context>",
  ].join("\n");
  const systemPromptAdd = [
    baseRolePrompt?.systemPromptAdd?.trim(),
    assistantSection,
  ].filter((part): part is string => !!part).join("\n\n").slice(0, MAX_ROLE_PROMPT_CHARS);
  if (!systemPromptAdd.trim()) return undefined;
  const baseName = baseRolePrompt?.name?.trim();
  const promptLabels = [baseName, ...labels].filter((label): label is string => !!label);
  return {
    name: promptLabels.length > 0 ? promptLabels.slice(0, 4).join(" + ") : "assistant context",
    systemPromptAdd,
  };
}

function rolePromptFromUserMessage(
  message: GenericMessage | undefined,
): NonNullable<ChatSendPayload["rolePrompt"]> | undefined {
  if (!message || message.role !== "user") return undefined;
  const normalized = normalizeRolePrompt("user-keyboard", message.meta?.activeRolePrompt);
  return normalized.ok ? normalized.rolePrompt : undefined;
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
function validateUserContentParts(
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

async function runStreamedTurn(
  conversationLoop: ConversationLoop,
  input: string,
  webContents: WebContents | undefined,
  channel: string,
  streamId: number,
    options: {
    attachments?: import("../../engine/llm/types.js").UserContentPart[];
    inputOrigin: ChatInputOrigin;
    rolePrompt?: ChatSendPayload["rolePrompt"];
  },
): Promise<TurnResult> {
  const send = (payload: unknown) => sendToWebContents(webContents, channel, { streamId, ...((payload as Record<string, unknown>) ?? {}) }, log);
  const originSource = options.inputOrigin === "plugin-emitted"
    ? parseImportedTriggerEnvelope(input)
    : null;
  // Per-turn streaming filter for the <suggested_replies> block. Withholds
  // chunks that could be (or are) part of the trailing tag, surfaces the
  // parsed list when the turn ends. See
  // `docs/architecture/proposals/suggested-replies-ghost-text.md`.
  const suggestedRepliesFilter = createStreamingFilter();
  const result = await conversationLoop.runTurn(
    input,
    {
      onReasoningDelta: (text) => send({ type: "reasoning_delta", text }),
      onTextDelta: (text) => {
        const visible = suggestedRepliesFilter.feed(text);
        if (visible) send({ type: "text_delta", text: visible });
      },
      onAssistantRound: ({ roundIndex, text, thought, stopReason, hasToolCalls }) =>
        send({
          type: "assistant_round",
          roundIndex,
          text: stripSuggestedReplies(text),
          thought,
          stopReason,
          hasToolCalls,
        }),
      onToolStart: (name, toolInput, meta) =>
        send({ type: "tool_start", name, input: toolInput, ...meta }),
      onPermissionReview: (event) =>
        send({
          type: "permission_review",
          reviewStatus: event.status,
          name: event.toolName,
          toolCategory: event.toolCategory,
          source: event.source,
          groupId: event.groupId,
          toolUseId: event.toolUseId,
          displayOrder: event.displayOrder,
          verdictLevel: event.verdictLevel,
          reason: event.reason,
          approvalPurpose: event.approvalPurpose,
        }),
      onToolEnd: (name, toolResult, isError, meta, uiPayload, durationMs) =>
        send({ type: "tool_end", name, result: toolResult, isError, ...meta, ...(uiPayload && { uiPayload }), durationMs }),
      onError: (error) => send({ type: "error", error }),
      onPermissionModeChanged: (mode) => send({ type: "permission_mode_changed", mode }),
      onCompactStarted: ({ triggerSource, estimatedBefore, preflight }) =>
        send({
          type: "compact_started",
          triggerSource,
          estimatedBefore,
          preflight,
        }),
      onCompactOccurred: ({ removedMessages, freedTokens, estimatedAfter, trigger, summary, compactNum, compactStatus, truncatedDir }) =>
        send({
          type: "compact_notice",
          removedMessages,
          freedTokens,
          estimatedAfter,
          ...(trigger !== undefined ? { trigger } : {}),
          ...(summary !== undefined ? { summary } : {}),
          ...(compactNum !== undefined ? { compactNum } : {}),
          ...(compactStatus !== undefined ? { compactStatus } : {}),
          ...(truncatedDir !== undefined ? { truncatedDir } : {}),
        }),
      onTurnSummary: ({ turnDurationMs, toolCount, cumulativeToolMs, tokensIn, freshInputTokens, tokensOut, cacheReadTokens, cacheWriteTokens, breakdown }) =>
        send({
          type: "turn_summary",
          turnDurationMs,
          toolCount,
          cumulativeToolMs,
          tokensIn,
          freshInputTokens,
          tokensOut,
          ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
          ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
          ...(breakdown ? { breakdown } : {}),
        }),
      onLlmStatus: (status) => send({ type: "llm_status", ...status }),
      onFallback: (from, to) => sendToWebContents(webContents, "lvis:chat:fallback", { from, to }, log),
      onGuidanceInjected: (text) => send({ type: "guidance_injected", text }),
      onGuidanceDropped: (text) => send({ type: "guidance_dropped", text }),
    },
    undefined,
    {
      ...(originSource ? { originSource } : {}),
      ...(options.attachments && options.attachments.length > 0
        ? { attachments: options.attachments }
        : {}),
      inputOrigin: options.inputOrigin,
      ...(options.rolePrompt ? { rolePrompt: options.rolePrompt } : {}),
    },
  );
  const { trailing, suggestedReplies } = suggestedRepliesFilter.finish();
  if (trailing) send({ type: "text_delta", text: trailing });
  send({ type: "suggested_replies", replies: suggestedReplies });
  send({ type: "done", ...(result.route === "command" ? { route: "command" } : {}) });
  return result;
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
    getMainWindow,
  } = deps;

  // read-only, sender guard optional
  ipcMain.handle("lvis:chat:has-provider", () => conversationLoop.hasProvider());
  ipcMain.handle("lvis:llm:ping", async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:llm:ping", e);
      return UNAUTHORIZED_FRAME;
    }
    return conversationLoop.pingProvider();
  });

  let activeStreamTurn: Promise<TurnResult> | null = null;
  let nextStreamId = 0;
  const trackStreamTurn = (factory: () => Promise<TurnResult>) => {
    const turnPromise = factory().finally(() => {
      if (activeStreamTurn === turnPromise) activeStreamTurn = null;
    });
    activeStreamTurn = turnPromise;
    return turnPromise;
  };
  const streamTurnOptions = {
    inputOrigin: "user-keyboard" as const,
  };
  const markMainActiveAfterTurn = async (input: string) => {
    if (conversationLoop.getSessionKind() !== "main") return;
    if (conversationLoop.getHistory().length > 0) {
      await memoryManager.markMainActiveResume(conversationLoop.getSessionId());
      return;
    }
    if (input.trim() === "/new") {
      await memoryManager.markMainActiveFresh();
    }
  };
  const allocateStreamId = () => ++nextStreamId;
  const sanitizeOutgoingInput = (input: string, webContents: WebContents | undefined) => {
    let effective = input;
    const privacy = settingsService.get("privacy");
    if (privacy?.piiRedactEnabled && typeof input === "string") {
      const r = redactForLLM(input);
      if (r.totalCount > 0) {
        effective = r.redacted;
        sendToWebContents(webContents, "lvis:chat:stream", {
          type: "redact_notice",
          count: r.totalCount,
          byKind: r.counts,
        }, log);
        log.warn({ counts: r.counts }, `user draft redacted — count=${r.totalCount}`);
      }
    }
    return effective;
  };
  const streamTurn = async (
    input: string,
    attachments?: import("../../engine/llm/types.js").UserContentPart[],
    rolePrompt?: ChatSendPayload["rolePrompt"],
  ) => {
    const win = getMainWindow();
    const streamId = allocateStreamId();
    return trackStreamTurn(async () => {
      const result = await runStreamedTurn(
        conversationLoop,
        input,
        win?.webContents,
        "lvis:chat:stream",
        streamId,
        {
          ...streamTurnOptions,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          ...(rolePrompt ? { rolePrompt } : {}),
        },
      );
      await markMainActiveAfterTurn(input);
      return result;
    });
  };

  const parseChatSendPayload = (
    payload: unknown,
  ): { ok: true; payload: ChatSendPayload } | { ok: false; error: string } => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, error: "invalid-payload" };
    }
    const candidate = payload as {
      input?: unknown;
      attachments?: unknown;
      inputOrigin?: unknown;
      userActivation?: unknown;
      rolePrompt?: unknown;
      assistantContext?: unknown;
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
    const rolePrompt = normalizeRolePrompt(candidate.inputOrigin, candidate.rolePrompt);
    if (!rolePrompt.ok) return { ok: false, error: rolePrompt.error };
    const assistantContext = normalizeAssistantContext(candidate.inputOrigin, candidate.assistantContext);
    if (!assistantContext.ok) return { ok: false, error: assistantContext.error };
    return {
      ok: true,
      payload: {
        input: candidate.input,
        attachments: candidate.attachments,
        inputOrigin: candidate.inputOrigin,
        ...(candidate.userActivation === true ? { userActivation: true } : {}),
        ...(rolePrompt.rolePrompt ? { rolePrompt: rolePrompt.rolePrompt } : {}),
        ...(assistantContext.assistantContext ? { assistantContext: assistantContext.assistantContext } : {}),
      },
    };
  };

  ipcMain.handle("lvis:chat:send", async (
    e,
    payload: unknown,
  ) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:send", e); return UNAUTHORIZED_FRAME; }
    const parsed = parseChatSendPayload(payload);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const { input, attachments, inputOrigin, rolePrompt, assistantContext } = parsed.payload;
    // queue-auto inputOrigin path 는 사용자 명시 입력 누적 의 자동 인입.
    // user gesture context 밖 (IPC stream done event 트리거) 라 audit 추가
    // 필요 — security forensics 에서 user-keyboard turn 과 구분 가능해야 함
    // (critic Round 2 M2). guide 와 동일 패턴.
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
    const win = getMainWindow();
    const effective = sanitizeOutgoingInput(input, win?.webContents);
    const effectiveRolePrompt = await mergeAssistantContextPrompt(rolePrompt, assistantContext, deps);
    const streamId = allocateStreamId();
    return trackStreamTurn(async () => {
      const result = await runStreamedTurn(
        conversationLoop,
        effective,
        win?.webContents,
        "lvis:chat:stream",
        streamId,
        { ...streamTurnOptions, attachments: validated, inputOrigin, rolePrompt: effectiveRolePrompt },
      );
      await markMainActiveAfterTurn(effective);
      return result;
    });
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
  ipcMain.handle("lvis:chat:guide", async (e, input: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:chat:guide", e);
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
    const effective = sanitizeOutgoingInput(input, win?.webContents);
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

  ipcMain.handle("lvis:chat:abort", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:abort", e); return UNAUTHORIZED_FRAME; }
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

  ipcMain.handle("lvis:chat:new", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:new", e); return UNAUTHORIZED_FRAME; }
    conversationLoop.newConversation();
    await memoryManager.markMainActiveFresh();
    return { ok: true };
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:chat:sessions", (e, opts?: { limit?: unknown; before?: unknown; beforeId?: unknown; after?: unknown; kind?: unknown; routineId?: unknown }) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:chat:sessions", e);
      return { current: conversationLoop.getSessionId(), sessions: [] };
    }
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
    const sessions = memoryManager
      .listSessionsPage({ kind, ...(routineId ? { routineId } : {}), limit, ...(before ? { before } : {}), ...(beforeId ? { beforeId } : {}), ...(after ? { after } : {}) })
      .map((s) => ({
        id: s.id,
        modifiedAt: s.modifiedAt.toISOString(),
        title: s.title,
        sessionKind: s.sessionKind,
        ...(s.routineId ? { routineId: s.routineId } : {}),
        ...(s.routineTitle ? { routineTitle: s.routineTitle } : {}),
        ...(s.routineFiredAt ? { routineFiredAt: s.routineFiredAt } : {}),
        ...(s.branchedFromCompactNum !== undefined ? { branchedFromCompactNum: s.branchedFromCompactNum } : {}),
        ...(s.branchedAt ? { branchedAt: s.branchedAt } : {}),
      }));
    return {
      current: conversationLoop.getSessionId(),
      sessions,
    };
  });

  ipcMain.handle("lvis:chat:compact", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:compact", e); return UNAUTHORIZED_FRAME; }
    // Wire onCompactStarted/onCompactOccurred so slash-/compact also shows
    // the "자동 압축 중..." StatusBar indicator (parity with token preflight
    // path which gets it via runStreamedTurn callbacks). streamId is omitted
    // because manualCompact runs outside the per-turn stream.
    return conversationLoop.manualCompact({
      onCompactStarted: ({ triggerSource, estimatedBefore, preflight }) =>
        sendToWebContents(e.sender, "lvis:chat:stream", { type: "compact_started", triggerSource, estimatedBefore, preflight }, log),
      onCompactOccurred: ({ removedMessages, freedTokens, estimatedAfter, trigger, summary, compactNum, compactStatus, truncatedDir }) =>
        sendToWebContents(e.sender, "lvis:chat:stream", {
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

  ipcMain.handle("lvis:chat:session-resume", async (e, sessionId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:session-resume", e); return UNAUTHORIZED_FRAME; }
    if (!isSafeSessionId(sessionId)) {
      return { ok: false, compacted: false, compactedAt: null, removedMessageCount: 0 };
    }
    const result = conversationLoop.resetAndResume(sessionId);
    if (result.ok && conversationLoop.getSessionKind() === "main") {
      await memoryManager.markMainActiveResume(sessionId).catch((err: unknown) => {
        log.warn("session-resume markMainActiveResume failed: %s", (err as Error).message);
      });
    }
    return result;
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:chat:get-history", () => {
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
      messages: messages.map(serializeHistoryMessage),
      estimatedInputTokens: estimateMessagesTokens(messages),
    };
  });

  ipcMain.handle("lvis:chat:main-active-state", (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:chat:main-active-state", e);
      return null;
    }
    return memoryManager.loadMainActiveSessionState();
  });

  // read-only: load messages for any session by id (does NOT change active session)
  ipcMain.handle("lvis:chat:session-history", (e, sessionId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:chat:session-history", e);
      // Keep the shape consistent with the success path — renderer always
      // reads `result.messages` and `result.ok`. Returning the bare
      // UNAUTHORIZED_FRAME (which omits `messages`) would force every caller
      // to widen the type and check before reading.
      return { ok: false, messages: [], error: "unauthorized-frame" as const };
    }
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
    try {
      const meta = memoryManager.loadSessionMetadata(sessionId);
      if (meta) {
        sessionKind = meta.sessionKind ?? "main";
        sessionTitle = meta.title;
        routineId = meta.routineId;
        routineTitle = meta.routineTitle;
        routineFiredAt = meta.routineFiredAt;
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
      messages: raw.map(serializeHistoryMessage),
      estimatedInputTokens: estimateMessagesTokens(raw),
      preambleChars,
    };
  });

  ipcMain.handle("lvis:chat:edit-resend", async (e, messageIndex: number, newText: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:edit-resend", e); return UNAUTHORIZED_FRAME; }
    if (typeof messageIndex !== "number" || messageIndex < 0) return { ok: false, error: "invalid-index" };
    if (typeof newText !== "string" || newText.trim().length === 0) return { ok: false, error: "empty-text" };
    const history = conversationLoop.getHistory().getMessages() as GenericMessage[];
    const realIdx = entryOrdinalToHistoryIndex(history, messageIndex);
    if (realIdx < 0) return { ok: false, error: "index-out-of-range" };
    const rolePrompt = rolePromptFromUserMessage(history[realIdx]);
    conversationLoop.getHistory().truncate(realIdx);
    const result = await streamTurn(newText, undefined, rolePrompt);
    return { ok: true, result };
  });

  ipcMain.handle("lvis:chat:fork", async (e, messageIndex: number) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:fork", e); return UNAUTHORIZED_FRAME; }
    const current = conversationLoop.getHistory().getMessages() as GenericMessage[];
    let upto = current.length;
    if (typeof messageIndex === "number" && messageIndex >= 0) {
      const realIdx = entryOrdinalToHistoryIndex(current, messageIndex);
      if (realIdx >= 0) upto = Math.min(realIdx + 1, current.length);
    }
    let slice = current.slice(0, upto);
    slice = removeOrphanToolUse(slice);
    if (current.length > 0) {
      await memoryManager.saveSession(conversationLoop.getSessionId(), current);
    }
    const newId = crypto.randomUUID();
    const sourceSessionId = conversationLoop.getSessionId();
    const forkSlice = memoryManager.rehydrateToolResultArtifacts(sourceSessionId, slice) as GenericMessage[];
    await memoryManager.saveSession(newId, forkSlice);
    const currentMeta = memoryManager.loadSessionMetadata(sourceSessionId);
    await memoryManager.saveSessionMetadata(newId, {
      sessionKind: currentMeta?.sessionKind ?? conversationLoop.getSessionKind(),
      ...(currentMeta?.routineId ? { routineId: currentMeta.routineId } : {}),
      ...(currentMeta?.routineTitle ? { routineTitle: currentMeta.routineTitle } : {}),
      ...(currentMeta?.routineFiredAt ? { routineFiredAt: currentMeta.routineFiredAt } : {}),
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

  ipcMain.handle("lvis:chat:retry-effort", async (
    e,
    opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean },
  ) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:retry-effort", e); return UNAUTHORIZED_FRAME; }
    const messages = conversationLoop.getHistory().getMessages() as GenericMessage[];
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") { lastUserIdx = i; break; }
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
    const rolePrompt = rolePromptFromUserMessage(lastUser);
    conversationLoop.getHistory().truncate(lastUserIdx);

    const prevLlm = settingsService.get("llm");
    const provider = prevLlm.provider;
    const prevBlock = prevLlm.vendors[provider];
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
    conversationLoop.refreshProvider();
    try {
      const result = await streamTurn(lastUserText, lastUserAttachments, rolePrompt);
      return { ok: true, result };
    } finally {
      await settingsService.patch({
        llm: { vendors: { [provider]: prevBlock } },
      });
      conversationLoop.refreshProvider();
    }
  });

  ipcMain.handle("lvis:chat:export", async (e, format: "markdown" | "json") => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:export", e); return UNAUTHORIZED_FRAME; }
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
      title: "대화 내보내기",
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
      const lines: string[] = [`# LVIS 대화 내보내기`, ``, `- 세션: ${sessionId}`, `- 내보낸 시각: ${new Date().toISOString()}`, ``];
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

  // ─── Checkpoint View + Branch ─────────────────────────

  ipcMain.handle("lvis:chat:enter-checkpoint-view", (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:enter-checkpoint-view", e); return UNAUTHORIZED_FRAME; }
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

  ipcMain.handle("lvis:chat:exit-checkpoint-view", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:exit-checkpoint-view", e); return UNAUTHORIZED_FRAME; }
    conversationLoop.exitViewMode();
    return { ok: true };
  });

  ipcMain.handle("lvis:chat:branch-from-checkpoint", async (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:branch-from-checkpoint", e); return UNAUTHORIZED_FRAME; }
    const p = payload as { sessionId?: unknown; compactNum?: unknown };
    if (typeof p?.sessionId !== "string" || !Number.isSafeInteger(p?.compactNum) || (p.compactNum as number) < 0) {
      return { error: "invalid-args" };
    }
    if (p.sessionId !== conversationLoop.getSessionId()) {
      return { error: "session-mismatch" };
    }
    try {
      return await conversationLoop.branchFromCheckpoint(p.compactNum as number);
    } catch (err) {
      return { error: (err as Error).message };
    }
  });

  // ─── Memory ─────────────────────────────────────
  ipcMain.handle("lvis:memory:entries:list", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:entries:list", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.listMemoryEntries();
  });
  ipcMain.handle("lvis:memory:entries:save", async (e, title: string, content: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:entries:save", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.saveMemory(title, content);
  });
  ipcMain.handle("lvis:memory:entries:delete", async (e, filename: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:entries:delete", e); return UNAUTHORIZED_FRAME; }
    await memoryManager.deleteMemory(filename);
    return undefined;
  });
  ipcMain.handle("lvis:memory:entries:search", (e, query: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:entries:search", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.searchMemoryEntries(query).map((note) => ({
      filename: note.filename,
      title: note.title,
      content: note.content,
      excerpt: note.content.replace(/^#\s+.+(?:\r?\n)+/, "").trim(),
      updatedAt: note.updatedAt ?? new Date().toISOString(),
    }));
  });
  ipcMain.handle("lvis:memory:index:get", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:index:get", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.getMemoryIndex();
  });
  ipcMain.handle("lvis:memory:index:update-if-unchanged", async (e, expectedContent: string, nextContent: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:index:update-if-unchanged", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.updateMemoryIndexIfUnchanged(expectedContent, nextContent);
  });
  ipcMain.handle("lvis:memory:index:sections:update", async (e, sections: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:index:sections:update", e); return UNAUTHORIZED_FRAME; }
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
  ipcMain.handle("lvis:memory:sessions:list", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:sessions:list", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.listSessionEntries();
  });
  ipcMain.handle("lvis:memory:sessions:search", (e, query: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:sessions:search", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.searchSessions(query);
  });
  ipcMain.handle("lvis:memory:agents-md:get", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:agents-md:get", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.getAgentsMd();
  });
  ipcMain.handle("lvis:memory:lvis-md:get", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:lvis-md:get", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.getAgentsMd();
  });
  ipcMain.handle("lvis:memory:agents-md:update", async (e, content: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:agents-md:update", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.updateAgentsMd(content);
  });
  ipcMain.handle("lvis:memory:lvis-md:update", async (e, content: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:lvis-md:update", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.updateAgentsMd(content);
  });
  ipcMain.handle("lvis:memory:user-prefs:get", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:user-prefs:get", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.getUserPreferences();
  });
  ipcMain.handle("lvis:memory:user-prefs:update", async (e, content: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:user-prefs:update", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.updateUserPreferences(content);
  });
  ipcMain.handle("lvis:memory:user-prefs:refresh", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:user-prefs:refresh", e); return UNAUTHORIZED_FRAME; }
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
  ipcMain.handle("lvis:starred:list", () => {
    if (!starredStore) return [];
    return starredStore.list();
  });
  ipcMain.handle("lvis:starred:add", (e, entry: { sessionId?: string; messageIndex: number; role: string; text: string }) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:starred:add", e); return UNAUTHORIZED_FRAME; }
    if (!starredStore) return { ok: false, error: "no-starred-store" };
    if (typeof entry?.messageIndex !== "number" || entry.messageIndex < -1) return { ok: false, error: "invalid-index" };
    if (typeof entry?.text !== "string") return { ok: false, error: "invalid-text" };
    const sessionId = entry.sessionId ?? conversationLoop.getSessionId();
    const record = starredStore.add({ sessionId, messageIndex: entry.messageIndex, role: entry.role, text: entry.text });
    return { ok: true, entry: record };
  });
  ipcMain.handle("lvis:starred:remove", (e, opts: { id?: string; sessionId?: string; messageIndex?: number }) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:starred:remove", e); return UNAUTHORIZED_FRAME; }
    if (!starredStore) return { ok: false, error: "no-starred-store" };
    if (opts?.id) return { ok: starredStore.remove(opts.id) };
    if (opts?.sessionId && typeof opts.messageIndex === "number") {
      return { ok: starredStore.removeBySessionAndIndex(opts.sessionId, opts.messageIndex) };
    }
    return { ok: false, error: "invalid-args" };
  });

  // ─── Message feedback ────────────────────────────────────────────────────
  ipcMain.handle("lvis:feedback:submit", async (e, payload: { sessionId: string; messageIndex: number; rating: "up" | "down"; reason?: string }) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:feedback:submit", e); return UNAUTHORIZED_FRAME; }
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
    "lvis:chat:get-verbatim-tool-result",
    (e, { sessionId, toolUseId }: { sessionId: string; toolUseId: string }) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:chat:get-verbatim-tool-result", e);
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
      const artifact = isToolResultStubContent(content)
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

  // ─── Issue #749: write-file diff sidecar lazy-load ──────────────────────
  // Returns { before, after } for a write_file tool call when content exceeded
  // WRITE_DIFF_PREVIEW_LIMIT on either side. The sidecar is written by
  // WriteFileTool.executeTyped into ~/.lvis/diff-cache/<sessionId>/<toolUseId>.json.
  // Returns null when:
  //   - sessionId / toolUseId fail safe-id validation (no path separators)
  //   - sidecar file not found or unreadable
  ipcMain.handle(
    "lvis:chat:get-write-diff",
    async (e, payload: unknown): Promise<{ before: string; after: string } | null> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:chat:get-write-diff", e);
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
  ipcMain.handle("lvis:ask-user-question:respond", (e, response: unknown) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:ask-user-question:respond", e);
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
