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
import { redactForLLM, initDlpAudit } from "./audit/dlp-filter.js";
import type { AuditLogger } from "./audit/audit-logger.js";
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
  "lvis:memory:sessions:search",
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
  "lvis:usage:range",
  "lvis:usage:export-csv",
  // Sprint 4.C — conversation UX
  "lvis:chat:get-history",
  "lvis:chat:edit-resend",
  "lvis:chat:fork",
  "lvis:chat:retry-effort",
  "lvis:chat:export",
  "lvis:chat:compact",
  "lvis:chat:session-resume",
  "lvis:starred:list",
  "lvis:starred:add",
  "lvis:starred:remove",
  "lvis:plugins:cards",
  "lvis:telemetry:consent-answer",
  "lvis:audit:search",
  "lvis:audit:stats",
  "lvis:plugins:perf-stats",
  "lvis:dlp:stats",
  "lvis:chat:abort",
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

/**
 * Emit a warn-level audit entry when an IPC call is rejected due to an
 * untrusted sender frame. Kept as a module-level helper so handlers can call
 * it without duplicating the AuditEntry shape.
 */
function auditUnauthorized(
  auditLogger: AuditLogger,
  channel: string,
  event: IpcMainInvokeEvent,
): void {
  auditLogger.log({
    timestamp: new Date().toISOString(),
    sessionId: "ipc-guard",
    type: "warn",
    input: JSON.stringify({ channel, frameUrl: event?.senderFrame?.url ?? "" }),
  });
}

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
    auditLogger,
  } = services;

  // Wire DLP audit logging so redactForLLM records hits to audit JSONL.
  initDlpAudit(auditLogger, conversationLoop.getSessionId());

  // ─── Settings (벤더별 API 키) ────────────────────
  // read-only, sender guard optional
  ipcMain.handle("lvis:settings:get", () => settingsService.getAll());
  ipcMain.handle("lvis:settings:update", async (e, partial) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:update", e); return UNAUTHORIZED_FRAME; }
    const result = await settingsService.patch(partial);
    conversationLoop.refreshProvider();
    return result;
  });
  ipcMain.handle("lvis:settings:set-api-key", async (e, vendor: string, apiKey: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:set-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.setSecret(`llm.apiKey.${vendor}`, apiKey);
    conversationLoop.refreshProvider();
    return { ok: true };
  });
  // read-only, sender guard optional
  ipcMain.handle("lvis:settings:has-api-key", (_e, vendor?: string) => {
    const v = vendor ?? settingsService.get("llm").provider;
    return settingsService.getSecret(`llm.apiKey.${v}`) !== null;
  });
  ipcMain.handle("lvis:settings:delete-api-key", async (e, vendor: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:delete-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.deleteSecret(`llm.apiKey.${vendor}`);
    conversationLoop.refreshProvider();
    return { ok: true };
  });

  // ─── Web Search Keys ───────────────────────────
  ipcMain.handle("lvis:settings:set-web-api-key", async (e, provider: string, apiKey: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:set-web-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.setSecret(`web.apiKey.${provider}`, apiKey);
    return { ok: true };
  });
  // read-only, sender guard optional
  ipcMain.handle("lvis:settings:has-web-api-key", (_e, provider: string) => {
    return settingsService.getSecret(`web.apiKey.${provider}`) !== null;
  });
  ipcMain.handle("lvis:settings:delete-web-api-key", async (e, provider: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:delete-web-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.deleteSecret(`web.apiKey.${provider}`);
    return { ok: true };
  });

  // ─── Chat (ConversationLoop) ────────────────────
  // read-only, sender guard optional
  ipcMain.handle("lvis:chat:has-provider", () => conversationLoop.hasProvider());

  ipcMain.handle("lvis:chat:send", async (e, input: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:send", e); return UNAUTHORIZED_FRAME; }
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

  // B4: abort current streaming turn
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
    sessions: conversationLoop.listSessions().slice(0, 20).map((s) => ({
      id: s.id,
      modifiedAt: s.modifiedAt.toISOString(),
    })),
  }));

  ipcMain.handle("lvis:chat:load-session", (e, sessionId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:load-session", e); return UNAUTHORIZED_FRAME; }
    const loaded = conversationLoop.loadSession(sessionId);
    return { ok: loaded, sessionId: loaded ? sessionId : null };
  });

  // B1 — /compact manual command IPC
  ipcMain.handle("lvis:chat:compact", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:compact", e); return UNAUTHORIZED_FRAME; }
    return conversationLoop.manualCompact();
  });

  // B1 — session-resume IPC (load + state reset + auto-compact check)
  ipcMain.handle("lvis:chat:session-resume", (e, sessionId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:session-resume", e); return UNAUTHORIZED_FRAME; }
    return conversationLoop.resetAndResume(sessionId);
  });

  // ─── Memory ─────────────────────────────────────
  // read-only, sender guard optional
  ipcMain.handle("lvis:memory:notes:list", () => memoryManager.listNotes());
  ipcMain.handle("lvis:memory:notes:save", async (e, title: string, content: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:notes:save", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.saveNote(title, content);
  });
  ipcMain.handle("lvis:memory:notes:delete", (e, filename: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:memory:notes:delete", e); return UNAUTHORIZED_FRAME; }
    return memoryManager.deleteNote(filename);
  });
  // read-only, sender guard optional
  ipcMain.handle("lvis:memory:notes:search", (_e, query: string) =>
    memoryManager.searchNotes(query),
  );
  // read-only, sender guard optional — D5 memory search panel
  ipcMain.handle("lvis:memory:sessions:search", (_e, query: string) =>
    memoryManager.searchSessions(query),
  );
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

  // ─── Marketplace ────────────────────────────────
  // read-only, sender guard optional
  ipcMain.handle("lvis:plugins:marketplace:list", () => pluginMarketplace.list());
  ipcMain.handle("lvis:plugins:install", async (e, pluginId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:plugins:install", e); return UNAUTHORIZED_FRAME; }
    const result = await pluginMarketplace.install(pluginId);
    await pluginRuntime.restartAll();
    refreshPluginNotifications?.();
    return result;
  });
  ipcMain.handle("lvis:plugins:uninstall", async (e, pluginId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:plugins:uninstall", e); return UNAUTHORIZED_FRAME; }
    const result = await pluginMarketplace.uninstall(pluginId);
    await pluginRuntime.restartAll();
    refreshPluginNotifications?.();
    return result;
  });
  // read-only, sender guard optional
  ipcMain.handle("lvis:plugins:ui:list", () => pluginRuntime.listUiExtensions());
  // read-only, sender guard optional
  ipcMain.handle("lvis:plugins:cards", () => pluginRuntime.listPluginCards());
  // read-only, sender guard optional
  ipcMain.handle("lvis:plugins:perf-stats", () => pluginRuntime.getPerfStats());
  // H2: renderer-originated plugin calls go through callFromUi() which enforces
  // the per-plugin uiCallable[] allowlist. Methods not declared there must go
  // through ConversationLoop so permission / scope / expansion caps apply.
  ipcMain.handle("lvis:plugins:call", (e, method: string, payload?: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:plugins:call", e); return UNAUTHORIZED_FRAME; }
    return pluginRuntime.callFromUi(method, payload);
  });

  // ─── MCP ──────────────────────────────────────
  // read-only, sender guard optional
  ipcMain.handle("lvis:mcp:servers", () => services.mcpManager.listServers());
  ipcMain.handle("lvis:mcp:kill", (e, serverId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:kill", e); return UNAUTHORIZED_FRAME; }
    return services.mcpManager.killSwitch(serverId);
  });

  // ─── Permission Prompt (§6.3 Layer 3) ─────────
  // read-only, sender guard optional
  ipcMain.handle("lvis:permission:get-mode", () => {
    const mode = conversationLoop.permissionManager?.getMode() ?? "default";
    return { mode };
  });
  ipcMain.handle("lvis:permission:set-mode", async (e, mode: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:permission:set-mode", e); return UNAUTHORIZED_FRAME; }
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
  // read-only, sender guard optional
  ipcMain.handle("lvis:permission:list-rules", async () => {
    const pm = conversationLoop.permissionManager;
    if (!pm) return [];
    return pm.listPersistedRules();
  });
  ipcMain.handle("lvis:permission:add-rule", async (e, pattern: string, action: "allow" | "deny") => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:permission:add-rule", e); return UNAUTHORIZED_FRAME; }
    // §F8: 입력 검증
    const normalized = pattern.trim();
    if (typeof pattern !== "string" || normalized.length === 0) {
      return { ok: false, error: "invalid-pattern", message: "패턴은 빈 문자열일 수 없습니다." };
    }
    if (normalized.length > 128) {
      return { ok: false, error: "invalid-pattern", message: "패턴은 128자를 초과할 수 없습니다." };
    }
    if (action !== "allow" && action !== "deny") {
      return { ok: false, error: "invalid-action", message: `유효하지 않은 action: '${action}'. 허용값: allow, deny` };
    }
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager", message: "권한 매니저가 초기화되지 않았습니다." };
    try {
      if (action === "allow") {
        await pm.addAlwaysAllowedPersist(normalized);
      } else {
        await pm.addAlwaysDeniedPersist(normalized);
      }
      return { ok: true, rule: { pattern: normalized, action } };
    } catch (err) {
      return { ok: false, error: "add-failed", message: (err as Error).message };
    }
  });
  ipcMain.handle("lvis:permission:remove-rule", async (e, pattern: string, action: "allow" | "deny") => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:permission:remove-rule", e); return UNAUTHORIZED_FRAME; }
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager", message: "권한 매니저가 초기화되지 않았습니다." };
    try {
      await pm.removeRule(pattern, action);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: "remove-failed", message: (err as Error).message };
    }
  });

  // ─── Approval Gate (§6.3 Layer 3 + §8) ────────
  // lvis:approval:request 방향은 main→renderer (webContents.send) — ipcMain.handle 불필요
  ipcMain.handle("lvis:approval:respond", (e, decision: ApprovalDecision) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:approval:respond", e); return UNAUTHORIZED_FRAME; }
    if (approvalGate) {
      approvalGate.resolve(decision.requestId, decision);
    }
    return { ok: true };
  });

  // ─── Policy (Governance) ──────────────────────
  // read-only, sender guard optional
  ipcMain.handle("lvis:policy:get", async () => {
    // §C2: LoadedPolicy (source, adminOverrides, adminPath 포함) 전체 반환
    return loadPolicy();
  });
  ipcMain.handle("lvis:policy:set", async (e, patch: Record<string, unknown>) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:policy:set", e); return UNAUTHORIZED_FRAME; }
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
  ipcMain.handle("lvis:tasks:add", (e, task) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:tasks:add", e); return UNAUTHORIZED_FRAME; }
    return taskService.add(task);
  });
  ipcMain.handle("lvis:tasks:update", (e, id: string, patch) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:tasks:update", e); return UNAUTHORIZED_FRAME; }
    return taskService.update(id, patch);
  });
  // read-only, sender guard optional
  ipcMain.handle("lvis:tasks:get", (_e, id: string) => taskService.get(id));
  ipcMain.handle("lvis:tasks:delete", (e, id: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:tasks:delete", e); return UNAUTHORIZED_FRAME; }
    return taskService.delete(id);
  });
  // read-only, sender guard optional
  ipcMain.handle("lvis:tasks:query", (_e, filter) => taskService.query(filter));
  // read-only, sender guard optional
  ipcMain.handle("lvis:tasks:pending", () => taskService.getPendingByPriority());
  // read-only, sender guard optional
  ipcMain.handle("lvis:tasks:overdue", () => taskService.getOverdue());
  // read-only, sender guard optional
  ipcMain.handle("lvis:tasks:today", () => taskService.getDueToday());

  // ─── Daily Briefing ──────────────────────────────
  // read-only, sender guard optional
  ipcMain.handle("lvis:briefing:get", () => conversationLoop.generateBriefing());

  // ─── Usage Observability (Sprint 4.B) ───────────
  // read-only, sender guard optional
  ipcMain.handle("lvis:usage:summary", async (_e, days?: number) => {
    const { getUsageSummary } = await import("./engine/usage-stats.js");
    return getUsageSummary(typeof days === "number" ? days : 60);
  });

  ipcMain.handle("lvis:usage:range", async (_e, opts: { dateFrom: string; dateTo: string }) => {
    const { getUsageRange } = await import("./engine/usage-stats.js");
    return getUsageRange(opts);
  });

  ipcMain.handle("lvis:usage:export-csv", async (_e, rows: Array<Record<string, string | number>>) => {
    const { dialog, BrowserWindow } = await import("electron");
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    const result = win
      ? await dialog.showSaveDialog(win, { defaultPath: "lvis-usage.csv", filters: [{ name: "CSV", extensions: ["csv"] }] })
      : await dialog.showSaveDialog({ defaultPath: "lvis-usage.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const { writeFileSync } = await import("node:fs");
    const headers = ["date", "vendor", "model", "inputTokens", "outputTokens", "totalTokens", "cost"];
    const lines = [
      headers.join(","),
      ...rows.map((r) => headers.map((h) => JSON.stringify(r[h] ?? "")).join(",")),
    ];
    writeFileSync(result.filePath, lines.join("\n"), "utf-8");
    return { ok: true, filePath: result.filePath };
  });

  // Sprint 2-D: user dismissal — sets lastDismissedAt, which suppresses the
  // gated ProactiveEngine.generateDailyBriefing for the following 24h.
  // Sprint 3-A (M1): debounce accepted dismisses to min 1s apart to prevent
  // accidental double-click / rapid-fire IPC abuse.
  let lastDismissAcceptedAt = 0;
  const DISMISS_DEBOUNCE_MS = 1000;
  ipcMain.handle("lvis:proactive:dismiss-briefing", async (e, feedback?: { reason?: string; details?: string }) => {
    if (!validateSender(e)) return UNAUTHORIZED_FRAME;
    const now = Date.now();
    if (now - lastDismissAcceptedAt < DISMISS_DEBOUNCE_MS) {
      return { ok: false, debounced: true };
    }
    lastDismissAcceptedAt = now;
    const cur = settingsService.get("proactive") ?? { enableDailyBriefing: false };
    await settingsService.patch({
      proactive: { ...cur, lastDismissedAt: new Date(now).toISOString() },
    });
    // Sprint E §2 — persist user feedback to ~/.lvis/notes/briefing-feedback.md
    const allowed = new Set(["inaccurate", "uninteresting", "busy", "other"]);
    if (feedback?.reason && allowed.has(feedback.reason)) {
      try {
        await memoryManager.appendBriefingFeedback({
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
  ipcMain.handle("lvis:proactive:snooze-briefing", async (e) => {
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
    await settingsService.patch({
      proactive: { ...cur, lastDismissedAt: shifted },
    });
    return { ok: true, lastDismissedAt: shifted };
  });

  // ─── Sprint 4.C: Conversation UX ─────────────────────
  const streamTurn = async (input: string) => {
    const win = getMainWindow();
    return runStreamedTurn(conversationLoop, input, win?.webContents, "lvis:chat:stream");
  };

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

  ipcMain.handle("lvis:chat:edit-resend", async (e, messageIndex: number, newText: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:edit-resend", e); return UNAUTHORIZED_FRAME; }
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

  ipcMain.handle("lvis:chat:fork", async (e, messageIndex: number) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:fork", e); return UNAUTHORIZED_FRAME; }
    const current = conversationLoop.getHistory().getMessages() as GenericMessage[];
    let upto = current.length;
    if (typeof messageIndex === "number" && messageIndex >= 0) {
      const realIdx = entryOrdinalToHistoryIndex(current, messageIndex);
      if (realIdx >= 0) upto = Math.min(realIdx + 1, current.length);
    }
    const slice = current.slice(0, upto);
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
    const lastUser = messages[lastUserIdx] as { role: "user"; content: string };
    conversationLoop.getHistory().truncate(lastUserIdx);

    const prevLlm = settingsService.get("llm");
    const nextLlm = {
      ...prevLlm,
      enableThinking: opts?.enableThinking ?? true,
      thinkingBudgetTokens: opts?.thinkingBudgetTokens ?? 20000,
    };
    await settingsService.patch({ llm: nextLlm });
    conversationLoop.refreshProvider();
    try {
      const result = await streamTurn(lastUser.content);
      return { ok: true, result };
    } finally {
      await settingsService.patch({ llm: prevLlm });
      conversationLoop.refreshProvider();
    }
  });

  ipcMain.handle("lvis:chat:export", async (e, format: "markdown" | "json") => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:export", e); return UNAUTHORIZED_FRAME; }
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
  // read-only, sender guard optional
  ipcMain.handle("lvis:starred:list", () => {
    if (!starredStore) return [];
    return starredStore.list();
  });
  ipcMain.handle("lvis:starred:add", (e, entry: { sessionId?: string; messageIndex: number; role: string; text: string }) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:starred:add", e); return UNAUTHORIZED_FRAME; }
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
  ipcMain.handle("lvis:starred:remove", (e, opts: { id?: string; sessionId?: string; messageIndex?: number }) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:starred:remove", e); return UNAUTHORIZED_FRAME; }
    if (!starredStore) return { ok: false, error: "no-starred-store" };
    if (opts?.id) return { ok: starredStore.remove(opts.id) };
    if (opts?.sessionId && typeof opts.messageIndex === "number") {
      return { ok: starredStore.removeBySessionAndIndex(opts.sessionId, opts.messageIndex) };
    }
    return { ok: false, error: "invalid-args" };
  });

  // ─── Audit Log Search (Observability) ──────────
  // read-only, sender guard optional
  ipcMain.handle("lvis:audit:search", async (_e, filter: Parameters<typeof auditLogger.search>[0]) => {
    return auditLogger.search(filter);
  });
  // read-only, sender guard optional
  ipcMain.handle("lvis:audit:stats", async (_e, lastDays: number) => {
    return auditLogger.getStats(typeof lastDays === "number" ? lastDays : 7);
  });

  // ─── DLP Hit Statistics (Observability) ─────────
  // TIER 3 read-only, sender guard optional
  ipcMain.handle("lvis:dlp:stats", async (_e, days: number) => {
    const { getDlpStats } = await import("./audit/dlp-stats.js");
    return getDlpStats(typeof days === "number" ? days : 7);
  });

  // S12 — telemetry consent prompt answer (Yes/No from renderer).
  // MUST mark telemetryPromptAnswered=true regardless of answer so the
  // prompt is never shown again. Only sets enabled=true on affirmative.
  ipcMain.handle("lvis:telemetry:consent-answer", async (e, accepted: boolean) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:telemetry:consent-answer", e); return UNAUTHORIZED_FRAME; }
    await settingsService.patch({
      telemetry: {
        ...settingsService.get("telemetry"),
        telemetryPromptAnswered: true,
        enabled: accepted === true,
      },
    });
    return { ok: true };
  });
}
