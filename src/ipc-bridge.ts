/**
 * IPC Bridge — §4.1 Main ↔ Renderer ↔ Native
 *
 * 모든 IPC 핸들러를 등록하는 모듈.
 * main.ts에서 인라인으로 30개 핸들러를 두지 않고 여기에 집중.
 */
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { writeFile } from "node:fs/promises";
import type { AppServices } from "./boot.js";
import type { ApprovalDecision } from "./permissions/approval-gate.js";
import { loadPolicy, savePolicy } from "./permissions/policy-store.js";
import { redactForLLM } from "./audit/dlp-filter.js";
import type { GenericMessage } from "./engine/llm/types.js";
import type { ConversationLoop } from "./engine/conversation-loop.js";
import type { WebContents } from "electron";

/**
 * Convert the UI's "user-assistant-only ordinal" to the real index into
 * ConversationHistory.messages (which also contains tool_result entries).
 * The renderer counts only user + assistant messages; backend handlers must
 * translate before touching the raw message array — otherwise edit/fork/star
 * target the wrong message in conversations that used tools.
 */
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
 * Shared helper: wire ConversationLoop.runTurn callbacks to a single stream
 * channel. Used by both `lvis:chat:send` and the edit/retry flows so callback
 * wiring isn't duplicated.
 */
async function runStreamedTurn(
  conversationLoop: ConversationLoop,
  input: string,
  webContents: WebContents | undefined,
  channel: string,
): Promise<unknown> {
  const send = (payload: unknown) => webContents?.send(channel, payload);
  const result = await conversationLoop.runTurn(input, {
    onReasoningDelta: (text) => send({ type: "reasoning_delta", text }),
    onTextDelta: (text) => send({ type: "text_delta", text }),
    onAssistantRound: ({ roundIndex, text, thought, stopReason, hasToolCalls }) =>
      send({ type: "assistant_round", roundIndex, text, thought, stopReason, hasToolCalls }),
    onToolStart: (name, toolInput, meta) =>
      send({ type: "tool_start", name, input: toolInput, ...meta }),
    onToolEnd: (name, toolResult, isError, meta) =>
      send({ type: "tool_end", name, result: toolResult, isError, ...meta }),
    onError: (error) => send({ type: "error", error }),
    onCompactOccurred: ({ removedMessages, freedTokens }) =>
      send({ type: "compact_notice", removedMessages, freedTokens }),
  });
  send({ type: "done" });
  return result;
}

/**
 * All IPC channels reserved by the host. Plugin manifests must not declare
 * channels that collide with these, as doing so would shadow privileged
 * host handlers and create unpredictable (or malicious) behaviour.
 *
 * MAINTAINERS: add a new entry here whenever you register a new host channel
 * with ipcMain.handle() inside registerIpcHandlers().
 */
const RESERVED_HOST_CHANNELS = new Set([
  "lvis:settings:get",
  "lvis:settings:update",
  "lvis:settings:set-api-key",
  "lvis:settings:has-api-key",
  "lvis:settings:delete-api-key",
  "lvis:settings:set-web-api-key",
  "lvis:settings:has-web-api-key",
  "lvis:settings:delete-web-api-key",
  "lvis:chat:has-provider",
  "lvis:chat:send",
  "lvis:chat:new",
  "lvis:chat:sessions",
  "lvis:chat:load-session",
  "lvis:memory:notes:list",
  "lvis:memory:notes:save",
  "lvis:memory:notes:delete",
  "lvis:memory:notes:search",
  "lvis:memory:lvis-md:get",
  "lvis:memory:lvis-md:update",
  "lvis:memory:user-prefs:get",
  "lvis:memory:user-prefs:update",
  "lvis:plugins:marketplace:list",
  "lvis:plugins:install",
  "lvis:plugins:uninstall",
  "lvis:plugins:ui:list",
  "lvis:plugins:call",
  "lvis:mcp:servers",
  "lvis:mcp:kill",
  "lvis:permission:get-mode",
  "lvis:permission:set-mode",
  "lvis:permission:list-rules",
  "lvis:permission:add-rule",
  "lvis:permission:remove-rule",
  "lvis:approval:respond",
  "lvis:policy:get",
  "lvis:policy:set",
  "lvis:tasks:add",
  "lvis:tasks:update",
  "lvis:tasks:get",
  "lvis:tasks:delete",
  "lvis:tasks:query",
  "lvis:tasks:pending",
  "lvis:tasks:overdue",
  "lvis:tasks:today",
  "lvis:briefing:get",
  "lvis:proactive:dismiss-briefing",
  "lvis:proactive:snooze-briefing",
  // Sprint 4.B — usage observability
  "lvis:usage:summary",
  // Sprint 4.C — conversation UX
  "lvis:chat:get-history",
  "lvis:chat:edit-resend",
  "lvis:chat:fork",
  "lvis:chat:retry-effort",
  "lvis:chat:export",
  "lvis:starred:list",
  "lvis:starred:add",
  "lvis:starred:remove",
  "lvis:plugins:cards",
]);

/**
 * M3 — IPC sender validation. Sensitive handlers (api-key mutation, plugin
 * install/uninstall, policy mutation, proactive briefing dismissal) verify
 * that the invoking frame is our own renderer. Accepts `file://` (packaged
 * local renderer) and `http://localhost` (dev server). Anything else (e.g.
 * an embedded webview navigating to a remote origin, or a plugin-spawned
 * BrowserView) is rejected with `{ok:false, error:"unauthorized-frame"}`.
 */
export function validateSender(event: IpcMainInvokeEvent | null | undefined): boolean {
  // Tests may invoke handlers with a synthetic event that omits senderFrame;
  // treat missing frame as trusted so unit tests keep their direct-call
  // ergonomics. Production always supplies a real IpcMainInvokeEvent.
  const frame = event?.senderFrame;
  if (!frame) return true;
  const rawUrl = frame.url ?? "";
  // Parse the frame URL and allowlist only exact origins we control. The
  // previous `startsWith("http://localhost")` check matched hostile hosts
  // like `http://localhost.attacker.com` (audit finding: CRITICAL).
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") return true;
    if (url.protocol === "http:" && url.hostname === "localhost") return true;
    if (url.protocol === "http:" && url.hostname === "127.0.0.1") return true;
    return false;
  } catch {
    return false;
  }
}

const UNAUTHORIZED_FRAME = { ok: false, error: "unauthorized-frame" as const };

export function registerIpcHandlers(
  services: AppServices,
  getMainWindow: () => BrowserWindow | null,
): void {
  const {
    pluginRuntime,
    pluginMarketplace,
    taskService,
    settingsService,
    memoryManager,
    conversationLoop,
    approvalGate,
    refreshPluginNotifications,
    starredStore,
  } = services;

  // ─── Settings (벤더별 API 키) ────────────────────
  ipcMain.handle("lvis:settings:get", () => settingsService.getAll());
  ipcMain.handle("lvis:settings:update", (_e, partial) => {
    const result = settingsService.patch(partial);
    conversationLoop.refreshProvider();
    return result;
  });
  ipcMain.handle("lvis:settings:set-api-key", (e, vendor: string, apiKey: string) => {
    if (!validateSender(e)) return UNAUTHORIZED_FRAME;
    settingsService.setSecret(`llm.apiKey.${vendor}`, apiKey);
    conversationLoop.refreshProvider();
    return { ok: true };
  });
  ipcMain.handle("lvis:settings:has-api-key", (_e, vendor?: string) => {
    const v = vendor ?? settingsService.get("llm").provider;
    return settingsService.getSecret(`llm.apiKey.${v}`) !== null;
  });
  ipcMain.handle("lvis:settings:delete-api-key", (e, vendor: string) => {
    if (!validateSender(e)) return UNAUTHORIZED_FRAME;
    settingsService.deleteSecret(`llm.apiKey.${vendor}`);
    conversationLoop.refreshProvider();
    return { ok: true };
  });

  // ─── Web Search Keys ───────────────────────────
  ipcMain.handle("lvis:settings:set-web-api-key", (_e, provider: string, apiKey: string) => {
    settingsService.setSecret(`web.apiKey.${provider}`, apiKey);
    return { ok: true };
  });
  ipcMain.handle("lvis:settings:has-web-api-key", (_e, provider: string) => {
    return settingsService.getSecret(`web.apiKey.${provider}`) !== null;
  });
  ipcMain.handle("lvis:settings:delete-web-api-key", (_e, provider: string) => {
    settingsService.deleteSecret(`web.apiKey.${provider}`);
    return { ok: true };
  });

  // ─── Chat (ConversationLoop) ────────────────────
  ipcMain.handle("lvis:chat:has-provider", () => conversationLoop.hasProvider());

  ipcMain.handle("lvis:chat:send", async (_e, input: string) => {
    const win = getMainWindow();
    // Sprint E §3 — privacy.piiRedactEnabled: user draft 를 LLM 으로 보내기 전 PII 리댁트.
    let effective = input;
    const privacy = settingsService.get("privacy");
    if (privacy?.piiRedactEnabled && typeof input === "string") {
      const r = redactForLLM(input);
      if (r.totalCount > 0) {
        effective = r.redacted;
        win?.webContents?.send("lvis:chat:stream", {
          type: "redact_notice",
          count: r.totalCount,
          byKind: r.counts,
        });
        console.warn(
          `[DLP] user draft redacted — count=${r.totalCount}`,
          r.counts,
        );
      }
    }
    return runStreamedTurn(conversationLoop, effective, win?.webContents, "lvis:chat:stream");
  });

  ipcMain.handle("lvis:chat:new", () => {
    conversationLoop.newConversation();
    return { ok: true };
  });

  ipcMain.handle("lvis:chat:sessions", () => ({
    current: conversationLoop.getSessionId(),
    sessions: conversationLoop.listSessions().slice(0, 20).map((s) => ({
      id: s.id,
      modifiedAt: s.modifiedAt.toISOString(),
    })),
  }));

  ipcMain.handle("lvis:chat:load-session", (_e, sessionId: string) => {
    const loaded = conversationLoop.loadSession(sessionId);
    return { ok: loaded, sessionId: loaded ? sessionId : null };
  });

  // ─── Memory ─────────────────────────────────────
  ipcMain.handle("lvis:memory:notes:list", () => memoryManager.listNotes());
  ipcMain.handle("lvis:memory:notes:save", (_e, title: string, content: string) =>
    memoryManager.saveNote(title, content),
  );
  ipcMain.handle("lvis:memory:notes:delete", (_e, filename: string) =>
    memoryManager.deleteNote(filename),
  );
  ipcMain.handle("lvis:memory:notes:search", (_e, query: string) =>
    memoryManager.searchNotes(query),
  );
  ipcMain.handle("lvis:memory:lvis-md:get", () => memoryManager.getLvisMd());
  ipcMain.handle("lvis:memory:lvis-md:update", (_e, content: string) =>
    memoryManager.updateLvisMd(content),
  );
  ipcMain.handle("lvis:memory:user-prefs:get", () => memoryManager.getUserPreferences());
  ipcMain.handle("lvis:memory:user-prefs:update", (_e, content: string) =>
    memoryManager.updateUserPreferences(content),
  );

  // ─── Marketplace ────────────────────────────────
  ipcMain.handle("lvis:plugins:marketplace:list", () => pluginMarketplace.list());
  ipcMain.handle("lvis:plugins:install", async (e, pluginId: string) => {
    if (!validateSender(e)) return UNAUTHORIZED_FRAME;
    const result = await pluginMarketplace.install(pluginId);
    await pluginRuntime.restartAll();
    refreshPluginNotifications?.();
    return result;
  });
  ipcMain.handle("lvis:plugins:uninstall", async (e, pluginId: string) => {
    if (!validateSender(e)) return UNAUTHORIZED_FRAME;
    const result = await pluginMarketplace.uninstall(pluginId);
    await pluginRuntime.restartAll();
    refreshPluginNotifications?.();
    return result;
  });
  ipcMain.handle("lvis:plugins:ui:list", () => pluginRuntime.listUiExtensions());
  ipcMain.handle("lvis:plugins:cards", () => pluginRuntime.listPluginCards());
  // H2: renderer-originated plugin calls go through callFromUi() which enforces
  // the per-plugin uiCallable[] allowlist. Methods not declared there must go
  // through ConversationLoop so permission / scope / expansion caps apply.
  ipcMain.handle("lvis:plugins:call", (_e, method: string, payload?: unknown) =>
    pluginRuntime.callFromUi(method, payload),
  );

  // ─── MCP ──────────────────────────────────────
  ipcMain.handle("lvis:mcp:servers", () => services.mcpManager.listServers());
  ipcMain.handle("lvis:mcp:kill", (_e, serverId: string) => services.mcpManager.killSwitch(serverId));

  // ─── Permission Prompt (§6.3 Layer 3) ─────────
  ipcMain.handle("lvis:permission:get-mode", () => {
    const mode = conversationLoop.permissionManager?.getMode() ?? "default";
    return { mode };
  });
  ipcMain.handle("lvis:permission:set-mode", async (_e, mode: string) => {
    // §F8: whitelist 검증 — 유효하지 않은 mode는 거부
    const VALID_MODES = ["default", "strict", "auto"] as const;
    if (!VALID_MODES.includes(mode as typeof VALID_MODES[number])) {
      return { ok: false, error: "invalid-mode", message: `유효하지 않은 실행 모드: '${mode}'. 허용값: ${VALID_MODES.join(", ")}` };
    }
    const pm = conversationLoop.permissionManager;
    if (pm) {
      await pm.setModePersist(mode as import("./permissions/permission-manager.js").ExecutionMode);
    }
    return { ok: true, mode };
  });
  ipcMain.handle("lvis:permission:list-rules", async () => {
    const pm = conversationLoop.permissionManager;
    if (!pm) return [];
    return pm.listPersistedRules();
  });
  ipcMain.handle("lvis:permission:add-rule", async (_e, pattern: string, action: "allow" | "deny") => {
    // §F8: 입력 검증
    if (typeof pattern !== "string" || pattern.trim().length === 0) {
      return { ok: false, error: "invalid-pattern", message: "패턴은 빈 문자열일 수 없습니다." };
    }
    if (pattern.length > 128) {
      return { ok: false, error: "invalid-pattern", message: "패턴은 128자를 초과할 수 없습니다." };
    }
    if (action !== "allow" && action !== "deny") {
      return { ok: false, error: "invalid-action", message: `유효하지 않은 action: '${action}'. 허용값: allow, deny` };
    }
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false };
    if (action === "allow") {
      await pm.addAlwaysAllowedPersist(pattern);
    } else {
      await pm.addAlwaysDeniedPersist(pattern);
    }
    return { ok: true };
  });
  ipcMain.handle("lvis:permission:remove-rule", async (_e, pattern: string, action: "allow" | "deny") => {
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false };
    await pm.removeRule(pattern, action);
    return { ok: true };
  });

  // ─── Approval Gate (§6.3 Layer 3 + §8) ────────
  // lvis:approval:request 방향은 main→renderer (webContents.send) — ipcMain.handle 불필요
  ipcMain.handle("lvis:approval:respond", (_e, decision: ApprovalDecision) => {
    if (approvalGate) {
      approvalGate.resolve(decision.requestId, decision);
    }
    return { ok: true };
  });

  // ─── Policy (Governance) ──────────────────────
  ipcMain.handle("lvis:policy:get", async () => {
    // §C2: LoadedPolicy (source, adminOverrides, adminPath 포함) 전체 반환
    return loadPolicy();
  });
  ipcMain.handle("lvis:policy:set", async (e, patch: Record<string, unknown>) => {
    if (!validateSender(e)) return UNAUTHORIZED_FRAME;
    // §F8: patch 검증 — managed 키 거부, requireExplicitApproval은 boolean만 허용
    if ("managed" in patch) {
      return { ok: false, error: "invalid-patch", message: "'managed' 필드는 사용자가 변경할 수 없습니다." };
    }
    if ("requireExplicitApproval" in patch && typeof patch.requireExplicitApproval !== "boolean") {
      return { ok: false, error: "invalid-patch", message: "'requireExplicitApproval'은 boolean이어야 합니다." };
    }
    try {
      // §C2: savePolicy(patch, userPath?, adminPath?) — admin-dir 존재 시 throw
      const updated = await savePolicy(patch as Parameters<typeof savePolicy>[0]);
      // 즉시 반영: ApprovalGate에 새 policy 주입
      if (approvalGate) {
        approvalGate.setPolicy(updated);
      }
      return { ok: true, policy: updated };
    } catch (err) {
      // managed 오류는 throw 대신 { ok: false, error: "managed" } 반환
      return { ok: false, error: "managed", message: (err as Error).message };
    }
  });

  // ─── Tasks ──────────────────────────────────────
  ipcMain.handle("lvis:tasks:add", (_e, task) => taskService.add(task));
  ipcMain.handle("lvis:tasks:update", (_e, id: string, patch) => taskService.update(id, patch));
  ipcMain.handle("lvis:tasks:get", (_e, id: string) => taskService.get(id));
  ipcMain.handle("lvis:tasks:delete", (_e, id: string) => taskService.delete(id));
  ipcMain.handle("lvis:tasks:query", (_e, filter) => taskService.query(filter));
  ipcMain.handle("lvis:tasks:pending", () => taskService.getPendingByPriority());
  ipcMain.handle("lvis:tasks:overdue", () => taskService.getOverdue());
  ipcMain.handle("lvis:tasks:today", () => taskService.getDueToday());

  // ─── Daily Briefing ──────────────────────────────
  ipcMain.handle("lvis:briefing:get", () => conversationLoop.generateBriefing());

  // ─── Usage Observability (Sprint 4.B) ───────────
  ipcMain.handle("lvis:usage:summary", async (_e, days?: number) => {
    const { getUsageSummary } = await import("./engine/usage-stats.js");
    return getUsageSummary(typeof days === "number" ? days : 60);
  });

  // Sprint 2-D: user dismissal — sets lastDismissedAt, which suppresses the
  // gated ProactiveEngine.generateDailyBriefing for the following 24h.
  // Sprint 3-A (M1): debounce accepted dismisses to min 1s apart to prevent
  // accidental double-click / rapid-fire IPC abuse.
  let lastDismissAcceptedAt = 0;
  const DISMISS_DEBOUNCE_MS = 1000;
  ipcMain.handle("lvis:proactive:dismiss-briefing", (e, feedback?: { reason?: string; details?: string }) => {
    if (!validateSender(e)) return UNAUTHORIZED_FRAME;
    const now = Date.now();
    if (now - lastDismissAcceptedAt < DISMISS_DEBOUNCE_MS) {
      return { ok: false, debounced: true };
    }
    lastDismissAcceptedAt = now;
    const cur = settingsService.get("proactive") ?? { enableDailyBriefing: false };
    settingsService.patch({
      proactive: { ...cur, lastDismissedAt: new Date(now).toISOString() },
    });
    // Sprint E §2 — persist user feedback to ~/.lvis/notes/briefing-feedback.md
    const allowed = new Set(["inaccurate", "uninteresting", "busy", "other"]);
    if (feedback?.reason && allowed.has(feedback.reason)) {
      try {
        memoryManager.appendBriefingFeedback({
          reason: feedback.reason as "inaccurate" | "uninteresting" | "busy" | "other",
          details: feedback.details,
        });
      } catch (err) {
        console.warn("[lvis] briefing feedback persist failed:", (err as Error).message);
      }
    }
    return { ok: true };
  });

  // Sprint 3-A: snooze 1h — shifts lastDismissedAt forward by 1h from its
  // current value (or from now when unset). Reuses the same 24h suppression
  // gate; snoozing effectively re-arms the window further into the future.
  // PR#44 HIGH: apply same 1s debounce as dismiss (prevents renderer loop
  // abuse) and clamp the shifted value to `now + 7 days` so repeated snoozes
  // cannot push lastDismissedAt arbitrarily far into the future.
  let lastSnoozeAcceptedAt = 0;
  const SNOOZE_DEBOUNCE_MS = 1000;
  const SNOOZE_MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
  ipcMain.handle("lvis:proactive:snooze-briefing", (e) => {
    if (!validateSender(e)) return UNAUTHORIZED_FRAME;
    const now = Date.now();
    if (now - lastSnoozeAcceptedAt < SNOOZE_DEBOUNCE_MS) {
      return { ok: false, debounced: true };
    }
    const cur = settingsService.get("proactive") ?? { enableDailyBriefing: false };
    const baseMs = cur.lastDismissedAt
      ? new Date(cur.lastDismissedAt).getTime()
      : now;
    const effectiveBase = Number.isFinite(baseMs) ? baseMs : now;
    const shiftedMs = effectiveBase + 60 * 60 * 1000;
    if (shiftedMs > now + SNOOZE_MAX_AHEAD_MS) {
      return { ok: false, error: "snooze horizon exceeded (7d)" };
    }
    lastSnoozeAcceptedAt = now;
    const shifted = new Date(shiftedMs).toISOString();
    settingsService.patch({
      proactive: { ...cur, lastDismissedAt: shifted },
    });
    return { ok: true, lastDismissedAt: shifted };
  });

  // ─── Sprint 4.C: Conversation UX ─────────────────────
  const streamTurn = async (input: string) => {
    const win = getMainWindow();
    return runStreamedTurn(conversationLoop, input, win?.webContents, "lvis:chat:stream");
  };

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

  ipcMain.handle("lvis:chat:edit-resend", async (_e, messageIndex: number, newText: string) => {
    if (typeof messageIndex !== "number" || messageIndex < 0) return { ok: false, error: "invalid-index" };
    if (typeof newText !== "string" || newText.trim().length === 0) return { ok: false, error: "empty-text" };
    // messageIndex is a user-assistant-only ordinal from the UI; convert to
    // the real history index before truncating so tool_result entries
    // (which the UI does not count) aren't mis-targeted.
    const history = conversationLoop.getHistory().getMessages() as GenericMessage[];
    const realIdx = entryOrdinalToHistoryIndex(history, messageIndex);
    if (realIdx < 0) return { ok: false, error: "index-out-of-range" };
    conversationLoop.getHistory().truncate(realIdx);
    const result = await streamTurn(newText);
    return { ok: true, result };
  });

  ipcMain.handle("lvis:chat:fork", (_e, messageIndex: number) => {
    const current = conversationLoop.getHistory().getMessages() as GenericMessage[];
    let upto = current.length;
    if (typeof messageIndex === "number" && messageIndex >= 0) {
      const realIdx = entryOrdinalToHistoryIndex(current, messageIndex);
      if (realIdx >= 0) upto = Math.min(realIdx + 1, current.length);
    }
    const slice = current.slice(0, upto);
    if (current.length > 0) {
      memoryManager.saveSession(conversationLoop.getSessionId(), current);
    }
    const newId = crypto.randomUUID();
    memoryManager.saveSession(newId, slice);
    const loaded = conversationLoop.loadSession(newId);
    return { ok: loaded, sessionId: loaded ? newId : null };
  });

  ipcMain.handle("lvis:chat:retry-effort", async (
    _e,
    opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean },
  ) => {
    const messages = conversationLoop.getHistory().getMessages() as GenericMessage[];
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) return { ok: false, error: "no-user-message" };
    const lastUser = messages[lastUserIdx] as { role: "user"; content: string };
    conversationLoop.getHistory().truncate(lastUserIdx);

    const prevLlm = settingsService.get("llm");
    const nextLlm = {
      ...prevLlm,
      enableThinking: opts?.enableThinking ?? true,
      thinkingBudgetTokens: opts?.thinkingBudgetTokens ?? 20000,
    };
    settingsService.patch({ llm: nextLlm });
    conversationLoop.refreshProvider();
    try {
      const result = await streamTurn(lastUser.content);
      return { ok: true, result };
    } finally {
      settingsService.patch({ llm: prevLlm });
      conversationLoop.refreshProvider();
    }
  });

  ipcMain.handle("lvis:chat:export", async (_e, format: "markdown" | "json") => {
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
          lines.push(`## User`, ``, m.content, ``);
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

  // ─── Starred messages (~/.lvis/starred.json) ────────
  ipcMain.handle("lvis:starred:list", () => {
    if (!starredStore) return [];
    return starredStore.list();
  });
  ipcMain.handle("lvis:starred:add", (_e, entry: { sessionId?: string; messageIndex: number; role: string; text: string }) => {
    if (!starredStore) return { ok: false, error: "no-starred-store" };
    if (typeof entry?.messageIndex !== "number" || entry.messageIndex < 0) return { ok: false, error: "invalid-index" };
    if (typeof entry?.text !== "string") return { ok: false, error: "invalid-text" };
    const sessionId = entry.sessionId ?? conversationLoop.getSessionId();
    // NB: messageIndex here is the UI's user-assistant ordinal. Starred
    // storage treats it as an opaque identifier — the renderer's
    // isEntryStarred() compares against the same ordinal so display stays
    // stable across reloads. Edit/fork/retry paths, which touch the raw
    // history array, translate via entryOrdinalToHistoryIndex instead.
    const record = starredStore.add({ sessionId, messageIndex: entry.messageIndex, role: entry.role, text: entry.text });
    return { ok: true, entry: record };
  });
  ipcMain.handle("lvis:starred:remove", (_e, opts: { id?: string; sessionId?: string; messageIndex?: number }) => {
    if (!starredStore) return { ok: false, error: "no-starred-store" };
    if (opts?.id) return { ok: starredStore.remove(opts.id) };
    if (opts?.sessionId && typeof opts.messageIndex === "number") {
      return { ok: starredStore.removeBySessionAndIndex(opts.sessionId, opts.messageIndex) };
    }
    return { ok: false, error: "invalid-args" };
  });
}
