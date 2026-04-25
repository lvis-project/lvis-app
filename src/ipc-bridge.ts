/**
 * IPC Bridge — §4.1 Main ↔ Renderer ↔ Native
 *
 * 모든 IPC 핸들러를 등록하는 모듈.
 * main.ts에서 인라인으로 30개 핸들러를 두지 않고 여기에 집중.
 */
import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppServices } from "./boot.js";
import type { ApprovalDecision } from "./permissions/approval-gate.js";
import { loadPolicy, savePolicy } from "./permissions/policy-store.js";
import { redactForLLM, initDlpAudit } from "./audit/dlp-filter.js";
import type { AuditLogger } from "./audit/audit-logger.js";
import type { GenericMessage } from "./engine/llm/types.js";
import type { ConversationLoop } from "./engine/conversation-loop.js";
import type { WebContents } from "electron";
import { findMethodByCapability } from "./boot/plugins.js";
import {
  MS_GRAPH_ENVIRONMENTS,
  MS_GRAPH_ENVIRONMENT_CONFIGS,
  isEnvironmentConfigured,
  type MsGraphEnvironment,
} from "./main/ms-graph-auth-config.js";
import { REGISTERED_ROUTINES, getRegisteredRoutine } from "./routines/registry.js";
import {
  DEFAULT_SHUTDOWN_PROMPT,
  DEFAULT_WAKEUP_ROUTINE_PROMPT,
  MAX_SCHEDULE_ENTRIES,
  scheduleToCron,
  isValidScheduleEntries,
  normalizeScheduleEntries,
} from "./routines/schedule.js";
import {
  clearLatestRoutineResult,
  getLatestRoutineResult,
} from "./routines/routine-delivery.js";

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
 * Shared helper: wire ConversationLoop.runTurn callbacks to a single stream
 * channel. Used by both `lvis:chat:send` and the edit/retry flows so callback
 * wiring isn't duplicated.
 */
async function runStreamedTurn(
  conversationLoop: ConversationLoop,
  input: string,
  webContents: WebContents | undefined,
  channel: string,
  streamId: number,
  options?: {
    shouldSuppressInterruptedTail?: () => boolean;
    clearInterruptedTailSuppression?: () => void;
  },
): Promise<unknown> {
  const send = (payload: unknown) => webContents?.send(channel, { streamId, ...((payload as Record<string, unknown>) ?? {}) });
  const result = await conversationLoop.runTurn(input, {
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
  });
  if (
    options?.shouldSuppressInterruptedTail?.() &&
    (result as ConversationTurnResult).stopReason === "interrupted"
  ) {
    options.clearInterruptedTailSuppression?.();
    return result;
  }
  send({ type: "done" });
  return result;
}

type ConversationTurnResult = {
  stopReason?: "end_turn" | "tool_use" | "interrupted";
};

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
  "lvis:ms-graph:get-state",
  "lvis:ms-graph:switch-environment",
  "lvis:ms-graph:sign-in",
  "lvis:ms-graph:sign-out",
  "lvis:chat:has-provider",
  "lvis:chat:send",
  "lvis:chat:guide",
  "lvis:chat:new",
  "lvis:chat:sessions",
  "lvis:chat:load-session",
  "lvis:memory:entries:list",
  "lvis:memory:entries:save",
  "lvis:memory:entries:delete",
  "lvis:memory:entries:search",
  "lvis:memory:sessions:list",
  "lvis:memory:sessions:search",
  "lvis:memory:lvis-md:get",
  "lvis:memory:lvis-md:update",
  "lvis:memory:user-prefs:get",
  "lvis:memory:user-prefs:update",
  "lvis:plugins:marketplace:list",
  "lvis:plugins:install",
  "lvis:plugins:uninstall",
  "lvis:plugins:ui:list",
  "lvis:plugins:ui:read-module",
  "lvis:plugins:call",
  "lvis:mcp:servers",
  "lvis:mcp:kill",
  "lvis:mcp:config:get",
  "lvis:mcp:config:path",
  "lvis:mcp:config:add",
  "lvis:mcp:config:remove",
  "lvis:mcp:ui-resource",
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
  "lvis:routine:get-latest-result",
  "lvis:routines:dev-trigger-wakeup",
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
  "lvis:plugins:config:get",
  "lvis:plugins:config:set",
  "lvis:feedback:submit",
  "lvis:telemetry:consent-answer",
  "lvis:audit:search",
  "lvis:audit:stats",
  "lvis:plugins:perf-stats",
  "lvis:dlp:stats",
  "lvis:chat:abort",
  "lvis:pageindex:scan-paths",
]);

/**
 * M3 — IPC sender validation. Sensitive handlers (api-key mutation, plugin
 * install/uninstall, policy mutation, routine result control) verify
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

function pluginConfigError(
  error: string,
  message: string,
): { ok: false; error: string; message: string } {
  return { ok: false, error, message };
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
    routineEngine,
    approvalGate,
    refreshPluginNotifications,
    starredStore,
    feedbackStore,
    auditLogger,
    msGraphService,
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

  // ─── Microsoft Graph — dual-environment login ──────
  // 모든 상태 조회는 read-only 라 sender guard 선택.
  // 환경 전환 / sign-in / sign-out 은 side-effect 가 있어 sender guard + audit 전부 수행.
  ipcMain.handle("lvis:ms-graph:get-state", (e) => {
    // get-state 는 read-only 지만 account (UPN/이메일) 을 노출하므로
    // sender guard 를 걸어 untrusted frame 의 identity leak 을 차단한다.
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:ms-graph:get-state", e); return UNAUTHORIZED_FRAME; }
    const environments = MS_GRAPH_ENVIRONMENTS.map((env) => ({
      id: env,
      label: MS_GRAPH_ENVIRONMENT_CONFIGS[env].label,
      description: MS_GRAPH_ENVIRONMENT_CONFIGS[env].description,
      configured: isEnvironmentConfigured(env),
    }));
    return { ...msGraphService.getState(), environments };
  });

  ipcMain.handle("lvis:ms-graph:switch-environment", async (e, envInput: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:ms-graph:switch-environment", e); return UNAUTHORIZED_FRAME; }
    // 허용된 env id 만 수용 — typo/alien value 를 silent 하게 external 로
    // 떨어뜨리지 않고 명시적으로 거부해 호출자가 잘못을 인지하게 한다.
    if (envInput !== "external" && envInput !== "corporate") {
      return { ok: false, error: `invalid environment: ${String(envInput)}` };
    }
    const env: MsGraphEnvironment = envInput;
    await msGraphService.switchEnvironment(env);
    // 사용자 선택을 settings 에 영속화 → 다음 부팅 시 자동 복구.
    await settingsService.patch({ msGraph: { environment: env } });
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "host",
      type: "info",
      output: `ms-graph environment switched: ${env}`,
    });
    return { ok: true, state: msGraphService.getState() };
  });

  ipcMain.handle("lvis:ms-graph:sign-in", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:ms-graph:sign-in", e); return UNAUTHORIZED_FRAME; }
    const envAtStart = msGraphService.getEnvironment();
    try {
      await msGraphService.startInteractiveAuth(async (url: string) => {
        await shell.openExternal(url);
      });
      const state = msGraphService.getState();
      if (!state.isAuthenticated) {
        const error =
          state.environment !== envAtStart
            ? "environment-switched-during-sign-in"
            : "sign-in-did-not-complete";
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "host",
          type: "warn",
          output: `ms-graph sign-in failed: env=${envAtStart} error=${error}`,
        });
        return { ok: false, error, state };
      }
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "host",
        type: "info",
        output: `ms-graph sign-in: env=${envAtStart} account=${state.account ?? "?"} success=${state.isAuthenticated}`,
      });
      return { ok: true, state };
    } catch (err) {
      const msg = (err as Error).message;
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "host",
        type: "warn",
        output: `ms-graph sign-in failed: env=${envAtStart} error=${msg}`,
      });
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle("lvis:ms-graph:sign-out", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:ms-graph:sign-out", e); return UNAUTHORIZED_FRAME; }
    const envAtStart = msGraphService.getEnvironment();
    const accountAtStart = msGraphService.getAccountName();
    await msGraphService.signOut();
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "host",
      type: "info",
      output: `ms-graph sign-out: env=${envAtStart} account=${accountAtStart ?? "?"}`,
    });
    return { ok: true, state: msGraphService.getState() };
  });

  // ─── Chat (ConversationLoop) ────────────────────
  // read-only, sender guard optional
  ipcMain.handle("lvis:chat:has-provider", () => conversationLoop.hasProvider());

  let activeStreamTurn: Promise<unknown> | null = null;
  let suppressInterruptedTail = false;
  let nextStreamId = 0;
  const trackStreamTurn = (factory: () => Promise<unknown>) => {
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
        console.warn(
          `[DLP] user draft redacted — count=${r.totalCount}`,
          r.counts,
        );
      }
    }
    return effective;
  };
  const buildGuidancePrompt = (input: string) => `현재 진행 중이던 응답에 대한 추가 방향 지시입니다.
새 주제로 전환하지 말고, 바로 직전 답변의 흐름을 유지한 채 아래 지시를 우선 반영해서 이어서 답변하세요.

[추가 방향 지시]
${input}`;

  ipcMain.handle("lvis:chat:send", async (e, input: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:chat:send", e); return UNAUTHORIZED_FRAME; }
    const win = getMainWindow();
    const effective = sanitizeOutgoingInput(input, win?.webContents);
    const streamId = allocateStreamId();
    return trackStreamTurn(() => runStreamedTurn(conversationLoop, effective, win?.webContents, "lvis:chat:stream", streamId, streamTurnOptions));
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
    sessions: conversationLoop.listSessions(20).map((s) => ({
      id: s.id,
      modifiedAt: s.modifiedAt.toISOString(),
      title: s.title,
    })),
  }));

  ipcMain.handle("lvis:routines:list", () => {
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

  ipcMain.handle("lvis:routines:dev-trigger-wakeup", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:routines:dev-trigger-wakeup", e); return UNAUTHORIZED_FRAME; }
    const isDev = process.env.LVIS_DEV === "1" || process.env.LVIS_ALLOW_LINKED_PLUGIN_ENTRY === "1";
    if (!isDev) return { ok: false, error: "dev-only" };
    if (!routineEngine) return { ok: false, error: "routine-engine-unavailable" };

    const current = settingsService.get("routine") ?? { enableWakeupRoutine: false };
    await settingsService.patch({
      routine: {
        ...current,
        lastWakeupRoutineAt: undefined,
      },
    });

    const wakeupRoutine = getRegisteredRoutine("wakeup");
    if (!wakeupRoutine) return { ok: false, error: "wakeup-routine-not-found" };
    try {
      const result = await routineEngine.runRoutine(wakeupRoutine);
      const { deliverRoutineResult } = await import("./routines/routine-delivery.js");
      await deliverRoutineResult(getMainWindow(), result);
      return { ok: true, summary: result.summary };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

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
  ipcMain.handle("lvis:plugins:ui:read-module", async (e, payload?: { pluginId?: string; viewId?: string }) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugins:ui:read-module", e);
      throw new Error("Unauthorized renderer frame for lvis:plugins:ui:read-module");
    }

    const pluginId = payload?.pluginId?.trim();
    const viewId = payload?.viewId?.trim();
    if (!pluginId || !viewId) {
      throw new Error("pluginId and viewId are required to load a plugin UI module.");
    }

    const view = pluginRuntime
      .listUiExtensions()
      .find((item) => item.pluginId === pluginId && item.extension.id === viewId);
    if (!view?.entryUrl) {
      throw new Error(`Plugin UI entry not found (plugin=${pluginId}, view=${viewId}).`);
    }
    if (!view.entryUrl.startsWith("file:")) {
      throw new Error(`Plugin UI entry is not file-backed (plugin=${pluginId}, view=${viewId}).`);
    }

    const entryPath = fileURLToPath(view.entryUrl);

    // Dev mode: listUiExtensions() already validated the entry via
    // resolveEntryPath() which permits ../../../ traversal for npm file:-linked
    // packages.  realpathSync would resolve through the link to the source
    // repo directory, making the prefix-based confinement check fail.
    // Trust the already-validated path and read directly.
    const isDevLinkedEntry = process.env.LVIS_DEV === "1" || process.env.LVIS_ALLOW_LINKED_PLUGIN_ENTRY === "1";
    if (isDevLinkedEntry) {
      let target: string;
      try {
        target = realpathSync(entryPath);
      } catch {
        throw new Error(`Plugin UI entry path could not be resolved (plugin=${pluginId}).`);
      }
      return readFile(target, "utf-8");
    }

    // Production: strict path confinement — entry must reside inside pluginRoot.
    const rawPluginRoot = pluginRuntime.getPluginRoot(pluginId);
    if (!rawPluginRoot) {
      throw new Error(`Plugin root not found (plugin=${pluginId}).`);
    }
    const pluginRoot = realpathSync(rawPluginRoot);
    let realEntryPath: string;
    try {
      realEntryPath = realpathSync(entryPath);
    } catch {
      throw new Error(`Plugin UI entry path could not be resolved (plugin=${pluginId}).`);
    }
    const rootWithSep = pluginRoot.endsWith(path.sep) ? pluginRoot : pluginRoot + path.sep;
    if (realEntryPath !== pluginRoot && !realEntryPath.startsWith(rootWithSep)) {
      throw new Error(`Plugin UI entry path escapes plugin directory (plugin=${pluginId}).`);
    }
    return readFile(realEntryPath, "utf-8");
  });
  // read-only, sender guard optional
  ipcMain.handle("lvis:plugins:cards", () => pluginRuntime.listPluginCards());
  ipcMain.handle("lvis:plugins:config:get", (e, pluginId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugins:config:get", e);
      return pluginConfigError("unauthorized-frame", "권한이 없는 프레임입니다.");
    }
    try {
      return { ok: true as const, config: settingsService.getPluginConfig(pluginId) };
    } catch (err) {
      return pluginConfigError(
        "invalid-plugin-config-request",
        (err as Error).message,
      );
    }
  });
  ipcMain.handle("lvis:plugins:config:set", async (e, pluginId: string, config: unknown) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugins:config:set", e);
      return pluginConfigError("unauthorized-frame", "권한이 없는 프레임입니다.");
    }
    try {
      const savedConfig = await settingsService.setPluginConfig(pluginId, config);
      pluginRuntime.setConfigOverride(pluginId, savedConfig);
      await pluginRuntime.restartAll();
      return { ok: true as const, config: savedConfig };
    } catch (err) {
      return pluginConfigError(
        "plugin-config-save-failed",
        (err as Error).message,
      );
    }
  });
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
  ipcMain.handle("lvis:mcp:servers", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:servers", e); return UNAUTHORIZED_FRAME; }
    return services.mcpManager.listServers();
  });
  ipcMain.handle("lvis:mcp:kill", (e, serverId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:kill", e); return UNAUTHORIZED_FRAME; }
    return services.mcpManager.killSwitch(serverId);
  });
  ipcMain.handle("lvis:mcp:config:get", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:config:get", e); return UNAUTHORIZED_FRAME; }
    return services.mcpManager.getConfigs();
  });
  ipcMain.handle("lvis:mcp:config:path", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:config:path", e); return UNAUTHORIZED_FRAME; }
    return services.mcpManager.getConfigPath();
  });
  ipcMain.handle("lvis:mcp:config:add", async (e, config: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:config:add", e); return UNAUTHORIZED_FRAME; }
    return services.mcpManager.addConfig(config as import("./mcp/types.js").McpServerConfig);
  });
  ipcMain.handle("lvis:mcp:config:remove", async (e, serverId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:config:remove", e); return UNAUTHORIZED_FRAME; }
    return services.mcpManager.removeConfig(serverId);
  });
  ipcMain.handle("lvis:mcp:ui-resource", async (e, serverId: string, uri: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:ui-resource", e); return UNAUTHORIZED_FRAME; }
    return services.mcpManager.readUiResource(serverId, uri);
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
      services.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
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
      services.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
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

  // ─── Sprint 4.C: Conversation UX ─────────────────────
  const streamTurn = async (input: string) => {
    const win = getMainWindow();
    const streamId = allocateStreamId();
    return trackStreamTurn(() => runStreamedTurn(conversationLoop, input, win?.webContents, "lvis:chat:stream", streamId, streamTurnOptions));
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
    if (typeof entry?.messageIndex !== "number" || entry.messageIndex < -1) return { ok: false, error: "invalid-index" };
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

  // ─── D6 — Message feedback (thumbs up/down) ─────
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
    // Write free-text reason to FeedbackStore only — keeps PII out of audit log (GDPR).
    if (feedbackStore) {
      feedbackStore.add({ sessionId, messageIndex, rating, ...(reason !== undefined ? { reason } : {}) });
    }
    // Audit log: stripped line without reason — useful only for aggregate rate stats.
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

  // D7 — drag & drop file indexing via document-indexer capability.
  // Resolves the plugin method by capability + suffix filter — NO plugin-id hardcoding.
  ipcMain.handle("lvis:pageindex:scan-paths", async (e, payload: { paths: string[] }) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:pageindex:scan-paths", e); return UNAUTHORIZED_FRAME; }
    const method = findMethodByCapability(pluginRuntime, "document-indexer", (m) => m.endsWith("_scan"));
    if (!method) {
      return { ok: false, error: "no-indexer" };
    }
    try {
      const result = await pluginRuntime.call(method, { paths: payload.paths });
      return { ok: true, ...(result as object) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}
