/**
 * Chat domain IPC handlers.
 * Covers: lvis:chat:*, lvis:routines:*, lvis:routine:*, lvis:trigger:*,
 *         lvis:memory:*, lvis:starred:*, lvis:feedback:submit,
 *         lvis:ask-user-question:respond
 */
import { ipcMain } from "electron";
import type { WebContents } from "electron";
import { redactForLLM } from "../../audit/dlp-filter.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import { userContentText } from "../../engine/llm/types.js";
import type { ConversationLoop, TurnResult } from "../../engine/conversation-loop.js";
import { parseImportedTriggerEnvelope } from "../../engine/proactive-source.js";
import {
  REGISTERED_ROUTINES,
  buildRoutineForTrigger,
  getRegisteredRoutine,
} from "../../routines/registry.js";
import {
  DEFAULT_SHUTDOWN_PROMPT,
  DEFAULT_WAKEUP_ROUTINE_PROMPT,
  MAX_SCHEDULE_ENTRIES,
  scheduleToCron,
  isValidScheduleEntries,
  normalizeScheduleEntries,
} from "../../routines/schedule.js";
import {
  clearLatestRoutineResult,
  getLatestRoutineResult,
} from "../../routines/routine-delivery.js";
import { devLinkedEntryAllowed, isDevModeUnlocked } from "../../boot/dev-flags.js";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("chat");


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

function isRoutineEnabled(
  routine: { id: string },
  settings: {
    enableWakeupRoutine?: boolean;
    enableScheduleRoutine?: boolean;
    enableShutdownRoutine?: boolean;
  } | null | undefined,
): boolean {
  switch (routine.id) {
    case "wakeup":
      return settings?.enableWakeupRoutine ?? false;
    case "schedule":
      return settings?.enableScheduleRoutine ?? true;
    case "shutdown":
      return settings?.enableShutdownRoutine ?? true;
    default:
      return false;
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
  options?: {
    shouldSuppressInterruptedTail?: () => boolean;
    clearInterruptedTailSuppression?: () => void;
    attachments?: import("../../engine/llm/types.js").UserContentPart[];
  },
): Promise<TurnResult> {
  const send = (payload: unknown) => webContents?.send(channel, { streamId, ...((payload as Record<string, unknown>) ?? {}) });
  const originSource = parseImportedTriggerEnvelope(input);
  const result = await conversationLoop.runTurn(
    input,
    {
      onReasoningDelta: (text) => send({ type: "reasoning_delta", text }),
      onTextDelta: (text) => {
        if (options?.shouldSuppressInterruptedTail?.() && text === "\n\n[중단됨]") return;
        send({ type: "text_delta", text });
      },
      onAssistantRound: ({ roundIndex, text, thought, stopReason, hasToolCalls }) =>
        send({ type: "assistant_round", roundIndex, text, thought, stopReason, hasToolCalls }),
      onToolStart: (name, toolInput, meta) =>
        send({ type: "tool_start", name, input: toolInput, ...meta }),
      onToolEnd: (name, toolResult, isError, meta, uiPayload) =>
        send({ type: "tool_end", name, result: toolResult, isError, ...meta, ...(uiPayload && { uiPayload }) }),
      onError: (error) => send({ type: "error", error }),
      onCompactOccurred: ({ removedMessages, freedTokens }) =>
        send({ type: "compact_notice", removedMessages, freedTokens }),
      onFallback: (from, to) => webContents?.send("lvis:chat:fallback", { from, to }),
    },
    undefined,
    {
      ...(originSource ? { originSource } : {}),
      ...(options?.attachments && options.attachments.length > 0
        ? { attachments: options.attachments }
        : {}),
    },
  );
  if (options?.shouldSuppressInterruptedTail?.() && result.stopReason === "interrupted") {
    options.clearInterruptedTailSuppression?.();
    return result;
  }
  send({ type: "done", ...(result.route === "command" ? { route: "command" } : {}) });
  return result;
}

export function registerChatHandlers(deps: IpcDeps): void {
  const {
    conversationLoop,
    settingsService,
    memoryManager,
    routineEngine,
    triggerExecutor,
    starredStore,
    feedbackStore,
    auditLogger,
    askUserQuestionGate,
    notificationService,
    getMainWindow,
  } = deps;

  // read-only, sender guard optional
  ipcMain.handle("lvis:chat:has-provider", () => conversationLoop.hasProvider());

  let activeStreamTurn: Promise<TurnResult> | null = null;
  let suppressInterruptedTail = false;
  let nextStreamId = 0;
  const trackStreamTurn = (factory: () => Promise<TurnResult>) => {
    const turnPromise = factory().finally(() => {
      if (activeStreamTurn === turnPromise) activeStreamTurn = null;
    });
    activeStreamTurn = turnPromise;
    return turnPromise;
  };
  const streamTurnOptions = {
    shouldSuppressInterruptedTail: () => suppressInterruptedTail,
    clearInterruptedTailSuppression: () => {
      suppressInterruptedTail = false;
    },
  };
  const allocateStreamId = () => ++nextStreamId;
  const sanitizeOutgoingInput = (input: string, webContents: WebContents | undefined) => {
    let effective = input;
    const privacy = settingsService.get("privacy");
    if (privacy?.piiRedactEnabled && typeof input === "string") {
      const r = redactForLLM(input);
      if (r.totalCount > 0) {
        effective = r.redacted;
        webContents?.send("lvis:chat:stream", {
          type: "redact_notice",
          count: r.totalCount,
          byKind: r.counts,
        });
        log.warn({ counts: r.counts }, `user draft redacted — count=${r.totalCount}`);
      }
    }
    return effective;
  };
  const buildGuidancePrompt = (input: string) => `현재 진행 중이던 응답에 대한 추가 방향 지시입니다.
새 주제로 전환하지 말고, 바로 직전 답변의 흐름을 유지한 채 아래 지시를 우선 반영해서 이어서 답변하세요.

[추가 방향 지시]
${input}`;

  const streamTurn = async (
    input: string,
    attachments?: import("../../engine/llm/types.js").UserContentPart[],
  ) => {
    const win = getMainWindow();
    const streamId = allocateStreamId();
    return trackStreamTurn(() => runStreamedTurn(
      conversationLoop,
      input,
      win?.webContents,
      "lvis:chat:stream",
      streamId,
      attachments && attachments.length > 0
        ? { ...streamTurnOptions, attachments }
        : streamTurnOptions,
    ));
  };

  ipcMain.handle("lvis:chat:send", async (
    e,
    input: unknown,
    attachments?: unknown,
  ) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:send", e); return UNAUTHORIZED_FRAME; }
    if (typeof input !== "string") return { ok: false, error: "invalid-input" };
    // IPC payload validation — the renderer is trusted but a corrupt
    // preload bridge or a stray `unknown[]` cast could deliver malformed
    // parts. We validate the shape here so the conversation loop never
    // sees garbage.
    const validated = validateUserContentParts(attachments);
    const win = getMainWindow();
    const effective = sanitizeOutgoingInput(input, win?.webContents);
    const streamId = allocateStreamId();
    return trackStreamTurn(() => runStreamedTurn(
      conversationLoop,
      effective,
      win?.webContents,
      "lvis:chat:stream",
      streamId,
      { ...streamTurnOptions, attachments: validated },
    ));
  });

  ipcMain.handle("lvis:chat:guide", async (e, input: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:guide", e); return UNAUTHORIZED_FRAME; }
    if (typeof input !== "string" || input.trim().length === 0) return { ok: false, error: "empty-text" };
    const win = getMainWindow();
    const streamId = allocateStreamId();
    win?.webContents.send("lvis:chat:stream", { type: "guidance_reset", streamId });
    suppressInterruptedTail = true;
    conversationLoop.abortCurrentTurn();
    if (activeStreamTurn) {
      try {
        await activeStreamTurn;
      } catch {
        // Keep guidance flow alive even if the interrupted turn rejects in future.
      }
    }
    suppressInterruptedTail = false;
    const effective = sanitizeOutgoingInput(buildGuidancePrompt(input), win?.webContents);
    return trackStreamTurn(() => runStreamedTurn(conversationLoop, effective, win?.webContents, "lvis:chat:stream", streamId, streamTurnOptions));
  });

  ipcMain.handle("lvis:chat:abort", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:abort", e); return UNAUTHORIZED_FRAME; }
    conversationLoop.abortCurrentTurn();
    return { ok: true };
  });

  ipcMain.handle("lvis:chat:new", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:new", e); return UNAUTHORIZED_FRAME; }
    conversationLoop.newConversation();
    return { ok: true };
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:chat:sessions", () => ({
    current: conversationLoop.getSessionId(),
    sessions: conversationLoop.listSessions(20).map((s) => ({
      id: s.id,
      modifiedAt: s.modifiedAt.toISOString(),
      title: s.title,
    })),
  }));

  ipcMain.handle("lvis:chat:load-session", (e, sessionId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:load-session", e); return UNAUTHORIZED_FRAME; }
    const loaded = conversationLoop.loadSession(sessionId);
    return { ok: loaded, sessionId: loaded ? sessionId : null };
  });

  ipcMain.handle("lvis:chat:compact", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:compact", e); return UNAUTHORIZED_FRAME; }
    return conversationLoop.manualCompact();
  });

  ipcMain.handle("lvis:chat:session-resume", (e, sessionId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:session-resume", e); return UNAUTHORIZED_FRAME; }
    return conversationLoop.resetAndResume(sessionId);
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:chat:get-history", () => {
    const messages = conversationLoop.getHistory().getMessages() as GenericMessage[];
    return {
      sessionId: conversationLoop.getSessionId(),
      messages: messages.map((m, i) => ({
        index: i,
        role: m.role,
        content: m.role === "tool_result" ? m.content : (m as { content: string }).content,
        toolName: m.role === "tool_result" ? m.toolName : undefined,
        isError: m.role === "tool_result" ? m.isError : undefined,
      })),
    };
  });

  // read-only: load messages for any session by id (does NOT change active session)
  ipcMain.handle("lvis:chat:session-history", (e, sessionId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:session-history", e); return UNAUTHORIZED_FRAME; }
    if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_\-]+$/.test(sessionId)) {
      return { ok: false, messages: [] };
    }
    const loaded = memoryManager.loadSession(sessionId);
    if (!Array.isArray(loaded)) return { ok: false, messages: [] };
    const raw = loaded.filter(
      (m): m is GenericMessage =>
        m != null && typeof m === "object" && "role" in m && "content" in m,
    );
    return {
      ok: true,
      messages: raw.map((m, i) => ({
        index: i,
        role: m.role,
        content: m.role === "user"
          ? userContentText(m.content)
          : m.role === "tool_result"
            ? m.content
            : m.content,
        toolName: m.role === "tool_result" ? m.toolName : undefined,
        isError: m.role === "tool_result" ? m.isError : undefined,
      })),
    };
  });

  ipcMain.handle("lvis:chat:edit-resend", async (e, messageIndex: number, newText: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:edit-resend", e); return UNAUTHORIZED_FRAME; }
    if (typeof messageIndex !== "number" || messageIndex < 0) return { ok: false, error: "invalid-index" };
    if (typeof newText !== "string" || newText.trim().length === 0) return { ok: false, error: "empty-text" };
    const history = conversationLoop.getHistory().getMessages() as GenericMessage[];
    const realIdx = entryOrdinalToHistoryIndex(history, messageIndex);
    if (realIdx < 0) return { ok: false, error: "index-out-of-range" };
    conversationLoop.getHistory().truncate(realIdx);
    const result = await streamTurn(newText);
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
    await memoryManager.saveSession(newId, slice);
    const loaded = conversationLoop.loadSession(newId);
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
      const result = await streamTurn(lastUserText, lastUserAttachments);
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

  // ─── Routines ──────────────────────────────────────────
  // read-only; sender guard optional but added for cross-window consistency
  ipcMain.handle("lvis:routines:list", (_e) => {
    const routineSettings = settingsService.get("routine");
    return REGISTERED_ROUTINES.map((routine) => {
      const sessions = conversationLoop.listRoutineSessions(routine.id, 20).map((session) => ({
        id: session.id,
        modifiedAt: session.modifiedAt.toISOString(),
        title: session.title,
      }));
      return {
        id: routine.id,
        title: routine.title,
        description: routine.description,
        trigger: routine.trigger,
        enabled: isRoutineEnabled(routine, routineSettings),
        scheduleTimeKst: routine.id === "wakeup" ? routineSettings?.scheduleTimeKst ?? "08:30" : undefined,
        contextPrompt: routine.id === "wakeup"
          ? routineSettings?.wakeupRoutinePrompt ?? DEFAULT_WAKEUP_ROUTINE_PROMPT
          : routine.id === "shutdown"
            ? routineSettings?.shutdownPrompt ?? DEFAULT_SHUTDOWN_PROMPT
            : undefined,
        scheduleEntries: routine.id === "schedule"
          ? normalizeScheduleEntries(routineSettings?.scheduleEntries).map((entry) => ({
            ...entry,
            cron: scheduleToCron(entry.schedule),
          }))
          : undefined,
        sessionCount: sessions.length,
        sessions,
      };
    });
  });

  ipcMain.handle("lvis:routines:update", async (e, routineId: string, patch: Record<string, unknown>) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:routines:update", e); return UNAUTHORIZED_FRAME; }
    const routine = getRegisteredRoutine(routineId);
    if (!routine) return { ok: false, error: "routine-not-found" };
    const current = settingsService.get("routine") ?? { enableWakeupRoutine: false };
    const next = { ...current };
    if (routineId === "wakeup") {
      if (typeof patch.enabled === "boolean") next.enableWakeupRoutine = patch.enabled;
      if (typeof patch.scheduleTimeKst === "string") next.scheduleTimeKst = patch.scheduleTimeKst;
      if (typeof patch.contextPrompt === "string") {
        next.wakeupRoutinePrompt = patch.contextPrompt.trim() || DEFAULT_WAKEUP_ROUTINE_PROMPT;
      }
    } else if (routineId === "schedule") {
      if (typeof patch.enabled === "boolean") next.enableScheduleRoutine = patch.enabled;
      if ("scheduleEntries" in patch) {
        const rawEntries = (patch as { scheduleEntries?: unknown }).scheduleEntries;
        if (Array.isArray(rawEntries) && rawEntries.length > MAX_SCHEDULE_ENTRIES) {
          return { ok: false, error: "too-many-schedule-entries" };
        }
        const entries = normalizeScheduleEntries(rawEntries);
        if (!isValidScheduleEntries(entries)) return { ok: false, error: "invalid-schedule-entries" };
        next.scheduleEntries = entries;
      }
    } else if (routineId === "shutdown") {
      if (typeof patch.enabled === "boolean") next.enableShutdownRoutine = patch.enabled;
      if (typeof patch.contextPrompt === "string") {
        next.shutdownPrompt = patch.contextPrompt.trim() || DEFAULT_SHUTDOWN_PROMPT;
      }
    }
    await settingsService.patch({ routine: next });
    return { ok: true };
  });

  ipcMain.handle("lvis:routines:start-session", async (e, routineId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:routines:start-session", e); return UNAUTHORIZED_FRAME; }
    const routine = getRegisteredRoutine(routineId);
    if (!routine) return { ok: false, error: "routine-not-found" };
    const sessionId = await conversationLoop.startRoutineConversation(routine.id, routine.title);
    return { ok: true, sessionId };
  });

  ipcMain.handle("lvis:routine:get-latest-result", () => getLatestRoutineResult());

  // ─── Proactive trigger lifecycle ──────────────────────
  ipcMain.handle("lvis:trigger:dismiss", (e, sessionId: unknown) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:trigger:dismiss", e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return { ok: false, error: "invalid-session-id" };
    }
    if (!triggerExecutor) return { ok: false, error: "executor-unavailable" };
    const removed = triggerExecutor.dismiss(sessionId);
    return { ok: true, removed };
  });

  ipcMain.handle("lvis:trigger:import", (e, sessionId: unknown) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:trigger:import", e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return { ok: false, error: "invalid-session-id" };
    }
    if (!triggerExecutor) return { ok: false, error: "executor-unavailable" };
    return triggerExecutor.importIntoChat(sessionId, conversationLoop);
  });

  // ─── Dev-only routine triggers ─────────────────────────
  const devTriggerHandler = async (e: import("electron").IpcMainInvokeEvent, routineId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, `lvis:routines:dev-trigger-${routineId}`, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!getRegisteredRoutine(routineId)) {
      return { ok: false, error: "routine-not-found" };
    }
    if (!isDevModeUnlocked()) return { ok: false, error: "dev-only" };
    if (!routineEngine) return { ok: false, error: "routine-engine-unavailable" };

    const built = buildRoutineForTrigger(routineId, settingsService.get("routine"));
    if (!built.ok) return { ok: false, error: built.error };

    if (routineId === "wakeup") {
      const current = settingsService.get("routine") ?? { enableWakeupRoutine: false };
      await settingsService.patch({
        routine: { ...current, lastWakeupRoutineAt: undefined },
      });
    }

    const { deliverRoutineResult, notifyRoutineStarted, notifyRoutineFailed } =
      await import("../../routines/routine-delivery.js");
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "dev-trigger",
      type: "info",
      input: `dev-trigger ${routineId}`,
    });
    const trackedId = built.routine.id;
    const startedPayload = { routineId: trackedId, trigger: built.routine.trigger, startedAt: new Date().toISOString() };
    notifyRoutineStarted(getMainWindow(), startedPayload);
    try {
      const result = await routineEngine.runRoutine(built.routine);
      await deliverRoutineResult(getMainWindow(), result, { notificationService });
      return { ok: true, summary: result.summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifyRoutineFailed(getMainWindow(), { routineId: trackedId, trigger: built.routine.trigger }, message);
      return { ok: false, error: message };
    }
  };

  ipcMain.handle("lvis:routines:dev-trigger-wakeup", (e) => { if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:routines:dev-trigger-wakeup", e); return UNAUTHORIZED_FRAME; } return devTriggerHandler(e, "wakeup"); });
  ipcMain.handle("lvis:routines:dev-trigger-schedule", (e) => { if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:routines:dev-trigger-schedule", e); return UNAUTHORIZED_FRAME; } return devTriggerHandler(e, "schedule"); });
  ipcMain.handle("lvis:routines:dev-trigger-shutdown", (e) => { if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:routines:dev-trigger-shutdown", e); return UNAUTHORIZED_FRAME; } return devTriggerHandler(e, "shutdown"); });

  // ─── Memory ─────────────────────────────────────
  ipcMain.handle("lvis:memory:entries:list", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:entries:list", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.listMemoryEntries();
  });
  ipcMain.handle("lvis:memory:entries:save", async (e, title: string, content: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:entries:save", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.saveMemory(title, content);
  });
  ipcMain.handle("lvis:memory:entries:delete", (e, filename: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:entries:delete", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.deleteMemory(filename);
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
  ipcMain.handle("lvis:memory:sessions:list", () => memoryManager.listSessionEntries());
  ipcMain.handle("lvis:memory:sessions:search", (e, query: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:sessions:search", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.searchSessions(query);
  });
  // read-only, sender guard optional
  ipcMain.handle("lvis:memory:lvis-md:get", () => memoryManager.getLvisMd());
  ipcMain.handle("lvis:memory:lvis-md:update", async (e, content: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:lvis-md:update", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.updateLvisMd(content);
  });
  // read-only, sender guard optional
  ipcMain.handle("lvis:memory:user-prefs:get", () => memoryManager.getUserPreferences());
  ipcMain.handle("lvis:memory:user-prefs:update", async (e, content: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:user-prefs:update", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.updateUserPreferences(content);
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
          return {
            choice: typeof a.choice === "string" ? a.choice : undefined,
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
