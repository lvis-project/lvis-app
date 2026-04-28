/**
 * IPC Bridge — §4.1 Main ↔ Renderer ↔ Native
 *
 * 모든 IPC 핸들러를 등록하는 모듈.
 * main.ts에서 인라인으로 30개 핸들러를 두지 않고 여기에 집중.
 */
import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
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
import { parseImportedTriggerEnvelope } from "./engine/proactive-source.js";
import type { WebContents } from "electron";
import { findMethodByCapability } from "./boot/plugins.js";
import { emitEvent as emitHostEvent } from "./boot/types.js";
import { requiredCapabilityForEmit } from "./plugins/capabilities.js";
import {
  REGISTERED_ROUTINES,
  buildRoutineForTrigger,
  getRegisteredRoutine,
} from "./routines/registry.js";
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
import { devLinkedEntryAllowed, isDevModeUnlocked } from "./boot/dev-flags.js";
import { NOTIFICATION_KINDS } from "./main/notification-service.js";
import { runManagedBootstrap } from "./boot/managed-marketplace.js";

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
// Envelope detection shares its pattern with the keyword engine, the
// trigger executor, and the system-prompt guidance gate (see
// `engine/proactive-source.ts`) so all four agree on what counts as a
// valid trigger envelope.

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
    originSource ? { originSource } : undefined,
  );
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



// R2-CR-5: previously a `RESERVED_HOST_CHANNELS` Set was declared here as
// "documentation" of host-owned `lvis:*` channels. It was never `.has()`-ed
// anywhere — adding entries to it provided zero defense against plugins
// registering colliding channel names, so it functioned as an attractive
// nuisance for maintainers (a list that LOOKS like a check but isn't).
//
// The actual defense lives elsewhere and is much narrower: plugin code only
// runs inside a sandboxed `<webview>` partition (#237 Option B) whose
// preload (`plugin-preload.ts`) exposes ONLY the `lvisPlugin` bridge —
// `lvisApi` (the host's privileged surface) is never injected. So a plugin
// cannot reach `ipcRenderer.invoke("lvis:settings:set-api-key", …)` even
// if it knew the channel name. Channel-name collisions on the renderer
// side are therefore not a useful threat model in this build.
//
// If a future host design ever loads plugin code into the same context as
// the renderer (don't), reintroduce a Set here and check it at registration
// time so the documentation matches the code.

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
 * #237 Option B — Plugin webview sender validation.
 *
 * Plugin webviews use a `persist:plugin:<slug>` session partition and load
 * `file://…/plugin-ui-shell.html`.  Their sender frame URL is a file:// URL,
 * which `validateSender` already accepts.  However we want a separate guard
 * so plugin-only handlers cannot be called from the host renderer's frame
 * (where `window.lvisPlugin` is absent but any script could try `ipcRenderer`
 * via the host preload).
 *
 * Strategy: plugin frames are also file:// so we cannot distinguish them by
 * origin alone.  Instead, we trust that the host renderer never invokes plugin-
 * scoped channels (`lvis:plugin:*`) — the host preload does not expose them.
 * This function validates the sender is a frame that loaded a URL containing
 * "plugin-ui-shell" as a simple heuristic; adjust if the shell path changes.
 *
 * In unit tests, a null/undefined event is treated as trusted (matching the
 * same ergonomics as `validateSender`).
 */
/**
 * Plugin webview registry — populated by the host renderer at the
 * webview's `did-attach` event via `lvis:plugin:register-webview`. Main
 * resolves `pluginId` and the verified entry URL from `event.sender.id`
 * on every plugin IPC, eliminating the renderer-supplied pluginId
 * spoofing surface.
 *
 * Key: webContents.id (numeric, assigned by Electron at webview attach).
 * Value: { pluginId, entryUrl } — both validated against
 * `pluginRuntime.listPluginIds()` + the manifest's resolved entry path
 * before being stored.
 */
interface PluginWebviewBinding {
  pluginId: string;
  entryUrl: string;
}
const pluginWebviewRegistry = new Map<number, PluginWebviewBinding>();
export function unregisterPluginWebview(webContentsId: number): void {
  pluginWebviewRegistry.delete(webContentsId);
}

export function validatePluginFrame(event: IpcMainInvokeEvent | null | undefined): boolean {
  const frame = event?.senderFrame;
  if (!frame) return true; // unit-test ergonomics
  const rawUrl = frame.url ?? "";
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "file:") return false;
    // Strict path-end match — `rawUrl.includes("plugin-ui-shell")` would
    // accept a `.html.bak` sibling, a confusingly-named directory, or a URL
    // fragment containing the literal. Pin to the canonical filename so the
    // only acceptable senders are the plugin shell document itself (or its
    // child frames, which inherit the same URL pathname).
    const pathname = url.pathname.toLowerCase();
    return pathname.endsWith("/plugin-ui-shell.html");
  } catch {
    return false;
  }
}

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
    triggerExecutor,
    approvalGate,
    refreshPluginNotifications,
    starredStore,
    feedbackStore,
    auditLogger,
    askUserQuestionGate,
    remindersStore,
    sessionTodoStore,
    notificationService,
    mcpArtifactStore,
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

  // ─── Marketplace API Key ──────────────────────
  ipcMain.handle("lvis:settings:marketplace:set-api-key", async (e, apiKey: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:marketplace:set-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.setSecret("marketplace.apiKey", apiKey);
    return { ok: true };
  });
  ipcMain.handle("lvis:settings:marketplace:has-api-key", () =>
    settingsService.getSecret("marketplace.apiKey") != null,
  );
  ipcMain.handle("lvis:settings:marketplace:delete-api-key", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:marketplace:delete-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.deleteSecret("marketplace.apiKey");
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

  // PR 3c: ms-graph 인증은 ms-graph 플러그인이 자체 소유한다. host 의
  // `lvis:ms-graph:*` IPC 채널 (get-state / switch-environment / sign-in /
  // sign-out) 은 모두 제거됨. renderer 는 plugin 의 msgraph_status /
  // msgraph_auth / msgraph_signout tool 을 직접 호출.

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

  // ─── Brain — proactive trigger lifecycle ──────────────────────
  // The renderer's TriggerCard surfaces a captured trigger session and
  // lets the user pick "지금 답하기" (import into chat) or "무시" (drop).
  // Both paths are guarded by validateSender to keep cross-window probes
  // from poking the trigger session cache.
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

  /**
   * Dev-only manual trigger for any of the 3 routine types. Builds the
   * routine using the current settings (so prePrompt mirrors what would
   * fire from natural triggers — idle exit / cron entry / app quit).
   */
  const devTriggerHandler = async (e: IpcMainInvokeEvent, routineId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, `lvis:routines:dev-trigger-${routineId}`, e);
      return UNAUTHORIZED_FRAME;
    }
    // Reject unknown routineId early — limits the audit channel surface and
    // gives the caller a stable error code to discriminate vs. dev-gate fail.
    if (!getRegisteredRoutine(routineId)) {
      return { ok: false, error: "routine-not-found" };
    }
    // Combine `!app.isPackaged` with the env gate so a packaged production
    // binary launched with LVIS_DEV=1 in its environment cannot manually
    // trigger routines (env vars are user-controllable on every desktop OS).
    // Phase 1 §Step 4 — single helper now centralizes the gate.
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
      await import("./routines/routine-delivery.js");
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "dev-trigger",
      type: "info",
      input: `dev-trigger ${routineId}`,
    });
    // started/completed routineId MUST match so useRoutineRunning Map can
    // delete the right key on completion. For schedule dev-trigger,
    // built.routine.id = the picked entry's id (e.g. "schedule-2"), and the
    // engine result's routineId mirrors that. Using the user-facing trigger
    // type (e.g. "schedule") for started would leave a zombie spinner.
    const trackedId = built.routine.id;
    const startedPayload = { routineId: trackedId, trigger: built.routine.trigger, startedAt: new Date().toISOString() };
    notifyRoutineStarted(getMainWindow(), startedPayload);
    try {
      const result = await routineEngine.runRoutine(built.routine);
      await deliverRoutineResult(getMainWindow(), result, { notificationService });
      return { ok: true, summary: result.summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Pair every started with a completed so the renderer's running
      // indicator clears even on failure (zombie spinner regression).
      notifyRoutineFailed(getMainWindow(), { routineId: trackedId, trigger: built.routine.trigger }, message);
      return { ok: false, error: message };
    }
  };

  ipcMain.handle("lvis:routines:dev-trigger-wakeup", (e) => { if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:routines:dev-trigger-wakeup", e); return UNAUTHORIZED_FRAME; } return devTriggerHandler(e, "wakeup"); });
  ipcMain.handle("lvis:routines:dev-trigger-schedule", (e) => { if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:routines:dev-trigger-schedule", e); return UNAUTHORIZED_FRAME; } return devTriggerHandler(e, "schedule"); });
  ipcMain.handle("lvis:routines:dev-trigger-shutdown", (e) => { if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:routines:dev-trigger-shutdown", e); return UNAUTHORIZED_FRAME; } return devTriggerHandler(e, "shutdown"); });

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

  // Phase 2d FU — bootstrap retry. The renderer banner exposes a button so
  // the user doesn't have to restart the app to recover from a transient
  // marketplace outage. Re-runs the same bootstrap loop the boot code uses,
  // including the start/complete/error status emission to the banner.
  ipcMain.handle("lvis:bootstrap:retry", async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:bootstrap:retry", e);
      return UNAUTHORIZED_FRAME;
    }
    const marketplace = settingsService.get("marketplace");
    await runManagedBootstrap({
      pluginMarketplace,
      pluginRuntime,
      mainWindow: getMainWindow(),
      marketplace,
      isPackaged: app.isPackaged,
    });
    return { ok: true } as const;
  });

  ipcMain.handle("lvis:plugins:install", async (e, pluginId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:plugins:install", e); return UNAUTHORIZED_FRAME; }
    // Renderer renders a skeleton card / sidebar placeholder while these
    // phase events fire — see PluginConfigTab + Sidebar progress UI.
    const win = getMainWindow();
    win?.webContents.send("lvis:plugins:install-progress", { slug: pluginId, phase: "installing" });
    const result = await pluginMarketplace.install(pluginId, "user", (evt) => {
      if (evt.phase === "downloading") {
        win?.webContents.send("lvis:plugins:install-progress", {
          slug: pluginId,
          phase: "downloading",
          bytesDownloaded: evt.bytesDownloaded,
          bytesTotal: evt.bytesTotal,
        });
      } else {
        win?.webContents.send("lvis:plugins:install-progress", { slug: pluginId, phase: evt.phase });
      }
    });
    win?.webContents.send("lvis:plugins:install-progress", { slug: pluginId, phase: "restarting" });
    await pluginRuntime.restartAll();
    refreshPluginNotifications?.();
    win?.webContents.send("lvis:plugins:install-result", { slug: pluginId, success: true });
    return result;
  });
  ipcMain.handle("lvis:plugins:uninstall", async (e, pluginId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:plugins:uninstall", e); return UNAUTHORIZED_FRAME; }
    // Broadcast the lifecycle event to every window — mirrors the lvis://install
    // deep-link path's install-result emission via `mainWindow?.webContents.send`.
    // Using `e.sender.send` would only reach the calling frame and break any
    // sibling settings window / sub-frame consumer.
    const broadcastUninstallResult = (payload: { slug: string; success: boolean; error?: string }) => {
      const win = getMainWindow();
      win?.webContents.send("lvis:plugins:uninstall-result", payload);
    };
    let result: Awaited<ReturnType<typeof pluginMarketplace.uninstall>>;
    try {
      result = await pluginMarketplace.uninstall(pluginId);
    } catch (err) {
      const message = (err as Error).message ?? "uninstall failed";
      broadcastUninstallResult({ slug: pluginId, success: false, error: message });
      throw err;
    }
    await pluginRuntime.restartAll();
    refreshPluginNotifications?.();
    broadcastUninstallResult({ slug: pluginId, success: true });
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
    // Phase 1 §Step 4 — gate hard-anchored to !app.isPackaged via dev-flags.
    if (devLinkedEntryAllowed()) {
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
  // Aggregated runtime counters surfaced in the status bar (#231 / #240).
  // Single round-trip so the renderer doesn't need to fan out three calls
  // and reconcile their timing. Sender-guarded — even though the payload
  // is just three numbers, an untrusted plugin webview could otherwise use
  // it as a runtime fingerprint.
  ipcMain.handle("lvis:runtime:counts", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:runtime:counts", e); return UNAUTHORIZED_FRAME; }
    return {
      tools: services.toolRegistry.size,
      plugins: pluginRuntime.listPluginIds().length,
      mcps: services.mcpManager.listServers().filter((s) => s.status === "connected").length,
    };
  });
  // Static environment info surfaced in the status bar (#231 / #240) —
  // platform / hostname / user. Static enough to fetch once on mount.
  // Cwd was deliberately dropped from this payload (least-privilege): no
  // current consumer renders it, and plugin UI panels share the host
  // renderer realm so any field returned here is reachable from third-
  // party code (see #237 for the broader isolation work).
  ipcMain.handle("lvis:runtime:env", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:runtime:env", e); return UNAUTHORIZED_FRAME; }
    const os = await import("node:os");
    return {
      platform: process.platform,
      hostname: os.hostname(),
      user: os.userInfo().username,
    };
  });
  // Marketplace reachability probe for the status-bar online dot. Lives in
  // the main process so corp-CA injection (corp-ca-loader) applies — a
  // direct renderer fetch may not respect the injected CA bundle.
  //
  // SSRF guard: routes through `fetchPublicHttpResponse` so the resolved IP
  // is checked against private/loopback/link-local ranges. The
  // `realCloudAllowPrivateNetwork` flag is honored — same opt-in already
  // used by the marketplace artifact fetcher. Without this, a malicious
  // settings-write that points `realCloudBaseUrl` at 169.254.169.254 would
  // turn this handler into a private-network probe oracle.
  //
  // Base URL composition uses a relative path with a trailing-slash-normalized
  // base so deployments fronted by a sub-path prefix
  // (e.g. `https://corp.example/marketplace/`) preserve the prefix.
  ipcMain.handle("lvis:marketplace:ping", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:marketplace:ping", e); return UNAUTHORIZED_FRAME; }
    const settings = settingsService.get("marketplace");
    if (settings.backend !== "real-cloud" || !settings.realCloudBaseUrl) {
      return { configured: false, online: false } as const;
    }
    try {
      const base = settings.realCloudBaseUrl.replace(/\/?$/, "/");
      const url = new URL("api/v1/health", base).toString();
      let res: Response;
      if (settings.realCloudAllowPrivateNetwork === true) {
        // Local dev path — same explicit opt-in already used by the
        // RealCloudMarketplaceFetcher so loopback (`127.0.0.1:8000`) works.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        try {
          res = await fetch(url, { signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
      } else {
        const { fetchPublicHttpResponse } = await import("./core/network-guard.js");
        res = await fetchPublicHttpResponse(url, { timeoutMs: 3000 });
      }
      return { configured: true, online: res.ok } as const;
    } catch (err) {
      // Telemetry — corp-CA misconfiguration AND SSRF rejections must be
      // distinguishable from a genuinely offline marketplace; surface the
      // underlying error to logs so SREs can diagnose without the user
      // having to reproduce the click.
      console.warn("[lvis] marketplace ping failed", (err as Error).message);
      return { configured: true, online: false } as const;
    }
  });
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

  // ─── #FU259 — MCP marketplace catalog + install ──
  // Both handlers are sender-guarded. Even though `:list` is read-only at
  // the renderer interface, it triggers an authenticated outbound HTTP
  // call (loop #5 security review M-1) — an unauthorized frame could
  // amplify outbound traffic carrying the user's marketplace API key.
  ipcMain.handle("lvis:mcp:catalog:list", async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:mcp:catalog:list", e);
      return UNAUTHORIZED_FRAME;
    }
    const all = await pluginMarketplace.list();
    return all.filter((p) => p.pluginType === "mcp");
  });
  ipcMain.handle("lvis:mcp:install-from-marketplace", async (e, slug: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:mcp:install-from-marketplace", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!mcpArtifactStore) {
      return {
        ok: false,
        error: "marketplace-disabled",
        message: "MCP marketplace install is unavailable: marketplace backend is disabled in this build.",
      } as const;
    }
    if (typeof slug !== "string" || slug.trim().length === 0) {
      return { ok: false, error: "invalid-slug", message: "slug is required" } as const;
    }
    try {
      const { installMcpFromMarketplace } = await import("./mcp/mcp-marketplace-install.js");
      const result = await installMcpFromMarketplace(slug.trim(), {
        fetcher: pluginMarketplace.getFetcher(),
        store: mcpArtifactStore,
      });
      const addResult = await services.mcpManager.addConfig(result.config);
      return {
        ok: true as const,
        slug: slug.trim(),
        installDir: result.installDir,
        connected: addResult.connected,
        warning: addResult.warning,
        needsCredential: result.needsCredential,
        authMode: result.authMode,
      };
    } catch (err) {
      return {
        ok: false as const,
        error: "install-failed",
        message: (err as Error).message ?? "MCP install failed",
      };
    }
  });

  // #FU262 — Claude Desktop config import.
  // Two-phase API: preview (parse only) → apply (mutates mcp-servers.json
  // + connects). Splitting them lets the renderer surface conflict
  // resolution + secret warnings before any state mutation.
  //
  // Both are sender-guarded. Preview was originally exempted as "read-only"
  // but it accepts attacker-controllable string input and returns parsed
  // command/args/env back to the renderer, so an unauthorized frame could
  // exfiltrate filesystem path strings + flagged secret-key names through
  // crafted payloads (loop #5 security review).
  ipcMain.handle("lvis:mcp:import:claude-desktop:preview", async (e, raw: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:mcp:import:claude-desktop:preview", e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof raw === "string" && raw.length > 1_000_000) {
      // Defensive cap on parser input to prevent main-process memory abuse
      // from a 500MB pasted "config".
      return {
        entries: [],
        errors: [{ id: "<root>", reason: "config exceeds 1MB size limit" }],
      };
    }
    const { parseClaudeDesktopConfig } = await import("./mcp/claude-desktop-import.js");
    return parseClaudeDesktopConfig(typeof raw === "string" ? raw : "");
  });
  ipcMain.handle(
    "lvis:mcp:import:claude-desktop:apply",
    async (
      e,
      payload: { raw: string; conflictPolicy?: "skip" | "overwrite" },
    ) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:mcp:import:claude-desktop:apply", e);
        return UNAUTHORIZED_FRAME;
      }
      const { parseClaudeDesktopConfig } = await import("./mcp/claude-desktop-import.js");
      const policy = payload?.conflictPolicy ?? "skip";
      const parsed = parseClaudeDesktopConfig(typeof payload?.raw === "string" ? payload.raw : "");
      // Dedupe entries by id so a single payload that lists `id: x` twice
      // doesn't double-account against the conflict tracker (loop #5
      // code-reviewer HIGH). First occurrence wins; later duplicates of
      // the same id within one payload are dropped.
      const seenIds = new Set<string>();
      const dedupedEntries: typeof parsed.entries = [];
      for (const entry of parsed.entries) {
        if (seenIds.has(entry.id)) continue;
        seenIds.add(entry.id);
        dedupedEntries.push(entry);
      }

      const existing = await services.mcpManager.getConfigs();
      const existingIds = new Set(existing.map((s) => s.id));
      const results: Array<{
        id: string;
        action: "added" | "skipped-conflict" | "overwritten" | "failed";
        reason?: string;
        warning?: string;
      }> = [];
      for (const entry of dedupedEntries) {
        const conflictedAtStart = existingIds.has(entry.id);
        if (conflictedAtStart) {
          if (policy === "skip") {
            results.push({ id: entry.id, action: "skipped-conflict" });
            continue;
          }
          // overwrite: remove then re-add so addConfig's id-uniqueness check
          // doesn't reject the import. Update existingIds so the action
          // labelling below reflects the post-remove state.
          try {
            await services.mcpManager.removeConfig(entry.id);
            existingIds.delete(entry.id);
          } catch (err) {
            results.push({
              id: entry.id,
              action: "failed",
              reason: (err as Error).message ?? "remove failed",
            });
            continue;
          }
        }
        try {
          const addResult = await services.mcpManager.addConfig(entry.config);
          // Track the new entry in existingIds so any subsequent duplicate
          // (in a future payload, not this one — already deduped) sees the
          // correct conflict state.
          existingIds.add(entry.id);
          results.push({
            id: entry.id,
            action: conflictedAtStart ? "overwritten" : "added",
            reason: addResult.connected ? undefined : addResult.warning,
            warning: entry.warning,
          });
        } catch (err) {
          results.push({
            id: entry.id,
            action: "failed",
            reason: (err as Error).message ?? "addConfig failed",
            warning: entry.warning,
          });
        }
      }
      return {
        ok: true as const,
        results,
        parseErrors: parsed.errors,
      };
    },
  );

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
      const result = await streamTurn(lastUser.content);
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

  // ─── #237 Option B — Plugin webview bridge ────────────────────────────────
  //
  // pluginId is NOT supplied by the renderer. The host renderer registers
  // (webContents.id → pluginId, entryUrl) at the webview's `did-attach`
  // event via `lvis:plugin:register-webview`. Every subsequent plugin IPC
  // resolves pluginId from `event.sender.id` against that registry. This
  // removes the spoofing vector from URL crafting / re-navigation /
  // history.pushState entirely.
  //
  //   register-webview — host frame only; validates pluginId against the
  //                      runtime registry + the entryUrl against the
  //                      manifest before binding webContents.id.
  //   call-tool        — plugin frame only; cross-plugin call denied at
  //                      the resolveToolOwner() level.
  //   emit-event       — plugin frame only; same capability + ownership
  //                      gate as boot/steps/plugin-runtime.ts:emitEvent.
  //   get-entry-url    — plugin frame only; returns the verified entry
  //                      URL bound for this webview's pluginId.
  ipcMain.handle("lvis:plugin:register-webview", (e, payload: { webContentsId: number; pluginId: string; entryUrl: string }) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugin:register-webview", e);
      return UNAUTHORIZED_FRAME;
    }
    const { webContentsId, pluginId, entryUrl } = payload ?? {};
    if (typeof webContentsId !== "number" || !Number.isFinite(webContentsId)) {
      return { ok: false, error: "invalid-webcontents-id" };
    }
    if (typeof pluginId !== "string" || !pluginRuntime.getPluginManifest(pluginId)) {
      return { ok: false, error: "unknown-plugin-id" };
    }
    if (typeof entryUrl !== "string" || !entryUrl.startsWith("file://")) {
      return { ok: false, error: "invalid-entry-url" };
    }
    // Defense-in-depth: even though the host renderer derives entryUrl from
    // the manifest, verify it resolves under the plugin's installed root
    // before binding. A compromised host renderer (or a future regression)
    // shouldn't be able to talk main into running an arbitrary file:// URL
    // as the plugin's entry module. Mirrors the strict containment check
    // used by the html-shell read path above (realpathSync on both sides
    // defeats Windows 8.3 short names, junctions, and case-folding tricks).
    const rawInstallRoot = pluginRuntime.getPluginRoot(pluginId);
    if (!rawInstallRoot) {
      return { ok: false, error: "plugin-not-loaded" };
    }
    let entryFsPath: string;
    try {
      entryFsPath = fileURLToPath(entryUrl);
    } catch {
      return { ok: false, error: "invalid-entry-url" };
    }
    // Dev-linked mode (npm file: links) legitimately resolves entry paths
    // outside pluginRoot through a symlink. The prior load-time validator
    // (resolveEntryPath in plugin-runtime) already vetted the entry; trust
    // it and only perform the existence check.
    if (devLinkedEntryAllowed()) {
      try {
        realpathSync(entryFsPath);
      } catch {
        return { ok: false, error: "entry-url-outside-install-root" };
      }
      pluginWebviewRegistry.set(webContentsId, { pluginId, entryUrl });
      return { ok: true };
    }
    let realRoot: string;
    let realEntry: string;
    try {
      realRoot = realpathSync(rawInstallRoot);
      realEntry = realpathSync(entryFsPath);
    } catch {
      return { ok: false, error: "entry-url-outside-install-root" };
    }
    const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (realEntry !== realRoot && !realEntry.startsWith(rootWithSep)) {
      return { ok: false, error: "entry-url-outside-install-root" };
    }
    pluginWebviewRegistry.set(webContentsId, { pluginId, entryUrl });
    return { ok: true };
  });

  function resolvePluginFromSender(e: IpcMainInvokeEvent): PluginWebviewBinding | null {
    if (!validatePluginFrame(e)) return null;
    const senderId = e.sender?.id;
    if (typeof senderId !== "number") return null;
    return pluginWebviewRegistry.get(senderId) ?? null;
  }

  ipcMain.handle("lvis:plugin:get-entry-url", (e) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, "lvis:plugin:get-entry-url", e);
      return UNAUTHORIZED_FRAME;
    }
    return { ok: true as const, entryUrl: binding.entryUrl };
  });

  ipcMain.handle("lvis:plugin:call-tool", async (e, method: string, payload?: unknown) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, "lvis:plugin:call-tool", e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof method !== "string" || !method.trim()) {
      return { ok: false, error: "invalid-method" };
    }
    // Cross-plugin tool invocation guard — the method's owner MUST be the
    // calling plugin (resolved from the webContents binding, not from a
    // renderer-supplied arg).
    const ownerPluginId = pluginRuntime.resolveToolOwner(method);
    if (!ownerPluginId) {
      return { ok: false, error: `Plugin method not found: ${method}` };
    }
    if (ownerPluginId !== binding.pluginId) {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "plugin-frame",
        type: "error",
        input: `[plugin:${binding.pluginId}] cross-plugin call denied: method='${method}' owner='${ownerPluginId}'`,
      });
      return { ok: false, error: "cross-plugin-call-denied" };
    }
    try {
      const result = await pluginRuntime.callFromUi(method, payload);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // Plugin-authored question → host home chat. Plugin webview cannot
  // reach `window.lvisApi.chatSend` (only the narrow lvisPlugin bridge
  // is exposed) so main forwards the request to the host renderer,
  // which performs the same handleAsk path a user keystroke would —
  // navigation to home + chatSend round-trip with the user-bubble
  // append. Sender guard mirrors the other plugin handlers; cap the
  // text length so a runaway plugin can't flood the chat.
  ipcMain.handle("lvis:plugin:ask-home-chat", (e, text: unknown) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, "lvis:plugin:ask-home-chat", e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof text !== "string") {
      return { ok: false, error: "invalid-text" };
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, error: "empty-text" };
    }
    if (trimmed.length > 4000) {
      return { ok: false, error: "text-too-long" };
    }
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      return { ok: false, error: "no-main-window" };
    }
    win.webContents.send("lvis:host:plugin-ask", {
      pluginId: binding.pluginId,
      text: trimmed,
    });
    return { ok: true };
  });

  ipcMain.handle("lvis:plugin:emit-event", (e, type: string, data?: unknown) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, "lvis:plugin:emit-event", e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof type !== "string" || !type.trim()) {
      return { ok: false, error: "invalid-event-type" };
    }
    // Mirror the host-side capability + ownership gate from
    // boot/steps/plugin-runtime.ts:emitEvent. Without this, a plugin
    // webview can forge events it doesn't own (e.g. meeting.summary.created
    // from a non-meeting plugin) and trigger downstream subscribers.
    const manifest = pluginRuntime.getPluginManifest(binding.pluginId);
    if (!manifest) {
      return { ok: false, error: "unknown-plugin-id" };
    }
    const requiredCap = requiredCapabilityForEmit(type);
    if (requiredCap && !manifest.capabilities?.includes(requiredCap)) {
      return { ok: false, error: `missing-capability:${requiredCap}` };
    }
    try {
      pluginRuntime.assertPluginEventEmitAccess(binding.pluginId, type);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    try {
      emitHostEvent(type, { ...((data as Record<string, unknown>) ?? {}), pluginId: binding.pluginId });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ─── Workflow tools (S1+S2) ─────────────────────────────────────────────
  // ask_user_question response — renderer dispatches when the user clicks a
  // choice / submits free text / dismisses. Sender guarded so untrusted
  // frames cannot inject answers on behalf of the user.
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

  // ─── Notifications (#260) ────────────────────────────
  // Renderer signals (via in-app toast click) that the user wants to focus
  // the app. We restore + show + focus the main window. The OS-click path
  // is handled directly inside NotificationService.fireOsNotification's
  // click handler (which sends `lvis:notification:clicked` to the renderer
  // for navigation), so this handler does NOT echo a click event back —
  // doing so would deliver duplicate click events to renderer subscribers.
  ipcMain.handle("lvis:notification:clicked", (e, payload: unknown) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:notification:clicked", e);
      return UNAUTHORIZED_FRAME;
    }
    // Manual shape check — payload comes from the renderer (untrusted).
    // Reject anything that isn't one of the 4 known kinds and log a warn so
    // a misbehaving renderer / plugin webview can't quietly trigger window
    // focus with arbitrary state. No zod needed — the surface is tiny.
    // NOTIFICATION_KINDS is the canonical set exported from notification-service
    // so validation list and NotificationKind type stay in sync automatically.
    const kind = (payload as { kind?: unknown } | null | undefined)?.kind;
    if (typeof kind !== "string" || !NOTIFICATION_KINDS.has(kind as never)) {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "ipc-bridge",
        type: "warn",
        input: JSON.stringify({
          event: "notification.clicked.invalid-payload",
          receivedKind: typeof kind === "string" ? kind.slice(0, 32) : typeof kind,
          // Forensic signal: whether contextRef was present on the malformed payload.
          hasContextRef: typeof (payload as Record<string, unknown> | null | undefined)?.contextRef === "object",
        }),
      });
      return { ok: false, error: "invalid-payload" };
    }
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      try {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      } catch (err) {
        console.warn(
          "[lvis] notification:clicked focus failed:",
          (err as Error).message,
        );
      }
    }
    return { ok: true };
  });

  // reminders — list + dismiss + remove. M3: list is technically read-only
  // but exposes user-authored content (PII risk if a third-party plugin
  // webview probes it), so it goes through validateSender + audit just
  // like the mutation channels. Mirrors the lvis:ms-graph:get-state pattern.
  ipcMain.handle("lvis:reminders:list", (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:reminders:list", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!remindersStore) return [];
    return remindersStore.listActive();
  });
  ipcMain.handle("lvis:reminders:dismiss", async (e, id: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:reminders:dismiss", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!remindersStore) return { ok: false, error: "no-store" };
    const ok = await remindersStore.dismiss(id);
    return { ok };
  });
  ipcMain.handle("lvis:reminders:remove", async (e, id: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:reminders:remove", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!remindersStore) return { ok: false, error: "no-store" };
    const ok = await remindersStore.remove(id);
    return { ok };
  });

  // session-todo — read-only list per chat session (defaults to current
  // ConversationLoop session). The renderer subscribes to push updates via
  // `lvis:session-todo:changed` events emitted by SessionTodoStore listeners.
  // M3: read-only but exposes user-authored content; gate behind validateSender.
  ipcMain.handle("lvis:session-todo:list", (e, sessionId?: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:session-todo:list", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!sessionTodoStore) return [];
    const sid = sessionId ?? conversationLoop.getSessionId();
    return sessionTodoStore.list(sid);
  });
  if (sessionTodoStore) {
    sessionTodoStore.onChange((sessionId, items) => {
      try {
        getMainWindow()?.webContents.send("lvis:session-todo:changed", {
          sessionId,
          items,
        });
      } catch (err) {
        console.warn("[lvis] session-todo emit failed:", (err as Error).message);
      }
    });
  }
}
