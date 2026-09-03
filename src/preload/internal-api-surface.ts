// The internal renderer API is intentionally assembled in one typed surface.
import { ipcRenderer } from "electron";
import {
  CHANNELS,
  MARKETPLACE,
  OVERLAY_V1,
  PERMISSIONS,
  ROUTINES,
  SETTINGS,
  WORK_BOARD,
  type AgentInstallResultPayload,
  type PluginInstallResultPayload,
  type SkillInstallResultPayload,
} from "../contract/app-contract.js";
import { t } from "../i18n/index.js";
import { parseEnvForcedSettingsPaths } from "../shared/env-backed-settings.js";
import { ipcUserKeyboardIntent } from "./gesture-intent.js";
import { mcpApiSurface } from "./mcp-api-surface.js";
import { buildTelegramConnectionApiSurface } from "./telegram-connection-api-surface.js";
import { buildTailnetObserverApiSurface } from "./tailnet-observer-api-surface.js";
import { buildTailnetSharingApiSurface } from "./tailnet-sharing-api-surface.js";
import { buildAwayAuthorityApiSurface } from "./away-authority-api-surface.js";
import { classifySubscription } from "../plugins/capabilities.js";
import type {
  PermissionReviewSuggestionPayload,
  UserApprovalHitPayload,
  UserApprovalScope,
  UserApprovalVerdict,
} from "../shared/permissions-events.js";
import type { DeferredApprovalSource } from "../shared/permission-review-status.js";
import type { MarketplaceAnnouncementPayload } from "../shared/marketplace-announcements.js";
import type { AiProviderPingIpcResult } from "../shared/ai-provider-ping.js";
import type {
  OpenHtmlPreviewWindowPayload,
  OpenHtmlPreviewWindowResult,
} from "../shared/render-html-preview.js";
import type { SessionTaskItem } from "../shared/session-tasks.js";
import type { SessionGoal } from "../shared/session-goal.js";
import type { ChatStreamEvent, ChatEntry } from "../lib/chat-stream-state.js";
import type { AgentSpawnEvent } from "../shared/subagent-events.js";
import type { SerializedHistoryMessage } from "../shared/chat-history.js";
import type { TurnResult } from "../engine/conversation-loop.js";
// Type-only: the renderer declares the surface it consumes; this file is the
// one implementation and is checked against it (`satisfies` below), so a
// handler shape that drifts on either side is a compile error here.
import type {
  AskUserQuestionRequest,
  AskUserQuestionResponse,
  LvisApi,
  NotificationClickPayload,
  NotificationToastPayload,
  OverlayTriggerCompletedPayload,
  OverlayTriggerExpiredPayload,
  OverlayTriggerFailedPayload,
  OverlayTriggerImportedPayload,
  OverlayTriggerStartedPayload,
} from "../ui/renderer/types.js";
import {
  isSubscriptionRuntimeStatusUpdatedEvent,
  type SubscriptionRuntimeStatusUpdatedEvent,
} from "../shared/subscription-runtime.js";

type MemoryProjectOptions = {
  projectRoot?: string;
  projectName?: string;
  includeUnscoped?: boolean;
};

function invokeWithOptionalMemoryOptions<T>(
  channel: string,
  opts?: MemoryProjectOptions,
): Promise<T> {
  return opts === undefined
    ? ipcRenderer.invoke(channel) as Promise<T>
    : ipcRenderer.invoke(channel, opts) as Promise<T>;
}

function invokeMemorySearch<T>(
  channel: string,
  query: string,
  opts?: MemoryProjectOptions,
): Promise<T> {
  return opts === undefined
    ? ipcRenderer.invoke(channel, query) as Promise<T>
    : ipcRenderer.invoke(channel, query, opts) as Promise<T>;
}

function invokeMemoryDelete<T>(
  channel: string,
  filename: string,
  opts?: MemoryProjectOptions,
): Promise<T> {
  return opts === undefined
    ? ipcRenderer.invoke(channel, filename) as Promise<T>
    : ipcRenderer.invoke(channel, filename, opts) as Promise<T>;
}

function invokeMemoryCandidateAction<T>(
  channel: string,
  id: string,
  opts?: MemoryProjectOptions,
): Promise<T> {
  return opts === undefined
    ? ipcRenderer.invoke(channel, { id }) as Promise<T>
    : ipcRenderer.invoke(channel, { id, opts }) as Promise<T>;
}

type PluginActionResult =
  | {
      ok: true;
      pluginId: string;
      installed?: true;
      /** The install was a no-op: the marketplace had nothing but what is already on disk. */
      unchanged?: true;
      uninstalled?: true;
      rolledBackTo?: string;
      version?: string;
    }
  | { ok: false; error: string; message?: string };

function invalidPluginActionResult(): PluginActionResult {
  return {
    ok: false,
    error: "invalid-result",
    message: t("be_preload.invalidPluginActionResult"),
  };
}

export function normalizePluginActionResult(result: unknown): PluginActionResult {
  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    return result as PluginActionResult;
  }

  const payload = result && typeof result === "object"
    ? result as {
        pluginId?: unknown;
        installed?: unknown;
        unchanged?: unknown;
        uninstalled?: unknown;
        rolledBackTo?: unknown;
        version?: unknown;
      }
    : {};
  const pluginId = typeof payload.pluginId === "string" ? payload.pluginId.trim() : "";
  const installed = payload.installed === true;
  const uninstalled = payload.uninstalled === true;
  const rolledBackTo =
    typeof payload.rolledBackTo === "string" ? payload.rolledBackTo.trim() : "";
  if (!pluginId || (!installed && !uninstalled && !rolledBackTo)) {
    return invalidPluginActionResult();
  }
  const normalized: PluginActionResult = {
    ok: true,
    pluginId,
  };
  if (installed) {
    normalized.installed = true;
  }
  if (payload.unchanged === true) {
    normalized.unchanged = true;
  }
  if (uninstalled) {
    normalized.uninstalled = true;
  }
  if (rolledBackTo) {
    normalized.rolledBackTo = rolledBackTo;
  }
  if (typeof payload.version === "string") {
    normalized.version = payload.version;
  }
  return normalized;
}

export function normalizeMarketplacePackageActionResult(
  result: unknown,
  idField: "agentId" | "skillId",
): PluginActionResult {
  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    return result as PluginActionResult;
  }
  const payload = result && typeof result === "object"
    ? result as Record<string, unknown>
    : {};
  const packageId = typeof payload[idField] === "string" ? payload[idField].trim() : "";
  if (!packageId) return invalidPluginActionResult();
  const normalized: PluginActionResult = { ok: true, pluginId: packageId };
  if (payload.uninstalled === true) normalized.uninstalled = true;
  else normalized.installed = true;
  if (typeof payload.version === "string") normalized.version = payload.version;
  return normalized;
}

type RemoteA2AStatusPromise = ReturnType<LvisApi["remoteA2a"]["status"]>;

function invokeRemoteA2AAction(
  action: "resume",
  taskHandle: string,
  userIntent: string,
): RemoteA2AStatusPromise;
function invokeRemoteA2AAction(
  action: "cancel" | "replay",
  taskHandle: string,
): RemoteA2AStatusPromise;
async function invokeRemoteA2AAction(
  action: "resume" | "cancel" | "replay",
  taskHandle: string,
  userIntent?: string,
): RemoteA2AStatusPromise {
  return ipcRenderer.invoke(
    CHANNELS.remoteA2a.action,
    { action, taskHandle, ...(userIntent === undefined ? {} : { userIntent }), intentToken: ipcUserKeyboardIntent() },
  ) as RemoteA2AStatusPromise;
}

export function buildInternalApiSurface() {
  return {
  // ─── Settings ────────────────────────────────────
  getSettings: async () => ipcRenderer.invoke(CHANNELS.settings.get),
  updateSettings: async (partial: unknown) => ipcRenderer.invoke(CHANNELS.settings.update, partial),
  // Parsed here rather than in the renderer: an unrecognized path is drift in
  // this build's own registry, not something to render.
  envForcedSettings: async () =>
    parseEnvForcedSettingsPaths(await ipcRenderer.invoke(CHANNELS.settings.envForcedSettings)) ?? [],
  telemetryAllowedHosts: async () => {
    const hosts: unknown = await ipcRenderer.invoke(CHANNELS.telemetry.allowedHosts);
    return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
  },
  remoteA2a: {
    targets: async () => ipcRenderer.invoke(CHANNELS.remoteA2a.targets),
    status: async () => ipcRenderer.invoke(CHANNELS.remoteA2a.status),
    send: async (targetAgentId: number, userIntent: string) => ipcRenderer.invoke(
      CHANNELS.remoteA2a.send,
      { targetAgentId, userIntent, intentToken: ipcUserKeyboardIntent() },
    ),
    task: async (taskHandle: string) => ipcRenderer.invoke(CHANNELS.remoteA2a.task, { taskHandle }),
    action: invokeRemoteA2AAction,
  },
  tailnetSharing: buildTailnetSharingApiSurface(),
  tailnetObserver: buildTailnetObserverApiSurface(),
  telegramConnection: buildTelegramConnectionApiSurface(),
  awayAuthority: buildAwayAuthorityApiSurface(),
  onSettingsUpdated: (handler: Parameters<LvisApi["onSettingsUpdated"]>[0]) => {
    const listener = (_event: unknown, settings: Parameters<typeof handler>[0]) => handler(settings);
    ipcRenderer.on(SETTINGS.updated, listener);
    return () => ipcRenderer.removeListener(SETTINGS.updated, listener);
  },
  onSubscriptionRuntimeStatusUpdated: (
    handler: (event: SubscriptionRuntimeStatusUpdatedEvent) => void,
  ) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (isSubscriptionRuntimeStatusUpdatedEvent(payload)) {
        handler(payload);
      }
    };
    ipcRenderer.on(CHANNELS.settings.subscriptionRuntimeStatusUpdated, listener);
    return () => ipcRenderer.removeListener(CHANNELS.settings.subscriptionRuntimeStatusUpdated, listener);
  },
  setApiKey: async (vendor: string, apiKey: string) => ipcRenderer.invoke(CHANNELS.settings.setApiKey, vendor, apiKey),
  hasApiKey: async (vendor?: string) => ipcRenderer.invoke(CHANNELS.settings.hasApiKey, vendor) as Promise<boolean>,
  deleteApiKey: async (vendor: string) => ipcRenderer.invoke(CHANNELS.settings.deleteApiKey, vendor),
  listLlmModels: async (request: unknown) => ipcRenderer.invoke(CHANNELS.settings.listLlmModels, request),
  codexSubscriptionStatus: async () => ipcRenderer.invoke(CHANNELS.settings.codexSubscriptionStatus),
  codexSubscriptionStartBrowserLogin: async () => ipcRenderer.invoke(CHANNELS.settings.codexSubscriptionStartBrowserLogin),
  codexSubscriptionStartDeviceCodeLogin: async () => ipcRenderer.invoke(CHANNELS.settings.codexSubscriptionStartDeviceCodeLogin),
  codexSubscriptionCancelLogin: async () => ipcRenderer.invoke(CHANNELS.settings.codexSubscriptionCancelLogin),
  codexSubscriptionLogout: async () => ipcRenderer.invoke(CHANNELS.settings.codexSubscriptionLogout),
  codexSubscriptionListModels: async () => ipcRenderer.invoke(CHANNELS.settings.codexSubscriptionListModels),
  subscriptionRuntimeStatus: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionRuntimeStatus, provider),
  subscriptionChooseRuntime: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionChooseRuntime, provider),
  subscriptionForgetRuntime: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionForgetRuntime, provider),
  subscriptionVerifyRuntime: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionVerifyRuntime, provider),
  subscriptionStartLogin: async (provider: unknown, method: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionStartLogin, provider, method),
  subscriptionOpenLoginBrowser: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionOpenLoginBrowser, provider),
  subscriptionCancelLogin: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionCancelLogin, provider),
  subscriptionLogout: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionLogout, provider),
  subscriptionListModels: async (provider: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.subscriptionListModels, provider),
  subscriptionUseForChat: async (provider: unknown, model?: unknown) => model === undefined
    ? ipcRenderer.invoke(CHANNELS.settings.subscriptionUseForChat, provider)
    : ipcRenderer.invoke(CHANNELS.settings.subscriptionUseForChat, provider, model),
  subscriptionUseApiForChat: async () => ipcRenderer.invoke(CHANNELS.settings.subscriptionUseApiForChat),
  acpSubscriptionStatus: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionStatus, provider),
  acpSubscriptionChooseRuntime: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionChooseRuntime, provider),
  acpSubscriptionForgetRuntime: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionForgetRuntime, provider),
  acpSubscriptionVerify: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionVerify, provider),
  acpSubscriptionStartLogin: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionStartLogin, provider),
  acpSubscriptionOpenLoginBrowser: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionOpenLoginBrowser, provider),
  acpSubscriptionCancelLogin: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionCancelLogin, provider),
  acpSubscriptionLogout: async (provider: unknown) => ipcRenderer.invoke(CHANNELS.settings.acpSubscriptionLogout, provider),
  installMarketplaceProviderPreset: async (preset: unknown) =>
    ipcRenderer.invoke(CHANNELS.settings.marketplaceInstallProviderPreset, preset),
  uninstallMarketplaceProviderPreset: async (providerId: string) =>
    ipcRenderer.invoke(CHANNELS.settings.marketplaceUninstallProviderPreset, providerId),
  setWebApiKey: async (provider: string, apiKey: string) => ipcRenderer.invoke(CHANNELS.settings.setWebApiKey, provider, apiKey),
  hasWebApiKey: async (provider: string) => ipcRenderer.invoke(CHANNELS.settings.hasWebApiKey, provider) as Promise<boolean>,
  deleteWebApiKey: async (provider: string) => ipcRenderer.invoke(CHANNELS.settings.deleteWebApiKey, provider),
  setMarketplaceApiKey: async (apiKey: string) => ipcRenderer.invoke(CHANNELS.settings.marketplaceSetApiKey, apiKey),
  hasMarketplaceApiKey: async () => ipcRenderer.invoke(CHANNELS.settings.marketplaceHasApiKey) as Promise<boolean>,
  deleteMarketplaceApiKey: async () => ipcRenderer.invoke(CHANNELS.settings.marketplaceDeleteApiKey),
  // ─── Internal Usage Insights ─────────────────────
  // This can trigger a provider-backed LLM call, so it is intentionally kept
  // out of the externally-parity-safe public surface and local API allowlist.
  getUsageDailySummary: async (input: unknown) => ipcRenderer.invoke(CHANNELS.usage.dailySummary, input),
  // ─── Interactive PTY terminal (#1444) ────────────────
  // Host-renderer-only surface. spawn/input/resize/kill are invokes; onData /
  // onExit subscribe to main→renderer events and return an unsubscribe fn (the
  // settings.updated / auth.progress pattern). All channels are INTERNAL — an
  // external origin can never reach them (fail-closed isPublicChannel).
  terminal: {
    spawn: async (payload: { tabId: string; cwd?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke(CHANNELS.terminal.spawn, payload) as Promise<
        | { ok: true; tabId: string; replayed: boolean }
        | { ok: false; reason: string; message: string }
      >,
    input: async (tabId: string, data: string) =>
      ipcRenderer.invoke(CHANNELS.terminal.input, { tabId, data }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    resize: async (tabId: string, cols: number, rows: number) =>
      ipcRenderer.invoke(CHANNELS.terminal.resize, { tabId, cols, rows }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    kill: async (tabId: string) =>
      ipcRenderer.invoke(CHANNELS.terminal.kill, { tabId }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    onData: (handler: (payload: { tabId: string; chunk: string }) => void) => {
      const listener = (_event: unknown, payload: { tabId?: unknown; chunk?: unknown }) => {
        if (typeof payload?.tabId !== "string" || typeof payload?.chunk !== "string") return;
        handler({ tabId: payload.tabId, chunk: payload.chunk });
      };
      ipcRenderer.on(CHANNELS.terminal.data, listener);
      return () => ipcRenderer.removeListener(CHANNELS.terminal.data, listener);
    },
    onExit: (handler: (payload: { tabId: string; exitCode: number; signal?: number }) => void) => {
      const listener = (
        _event: unknown,
        payload: { tabId?: unknown; exitCode?: unknown; signal?: unknown },
      ) => {
        if (typeof payload?.tabId !== "string" || typeof payload?.exitCode !== "number") return;
        handler({
          tabId: payload.tabId,
          exitCode: payload.exitCode,
          ...(typeof payload?.signal === "number" ? { signal: payload.signal } : {}),
        });
      };
      ipcRenderer.on(CHANNELS.terminal.exit, listener);
      return () => ipcRenderer.removeListener(CHANNELS.terminal.exit, listener);
    },
  },
  // ─── Side chat (workspace rail) ──────────────────────
  // A second, independently-streaming chat session. send/new/load/list/abort
  // are invokes; onStream/onFallback subscribe to the DEDICATED
  // CHANNELS.sidechat.{stream,fallback} events (NOT chat.stream) and return an
  // unsubscribe fn (the onChatStream pattern). All channels are INTERNAL — an
  // external origin can never reach them (fail-closed isPublicChannel).
  sideChat: {
    send: async (input: string, attachments?: unknown[]) =>
      ipcRenderer.invoke(CHANNELS.sidechat.send, { input, attachments }) as Promise<
        | { ok: true; result: TurnResult }
        | { ok: false; error: string }
      >,
    new: async () =>
      ipcRenderer.invoke(CHANNELS.sidechat.new) as Promise<
        | { ok: true; sessionId: string }
        | { ok: false; error: string }
      >,
    load: async (sessionId: string) =>
      ipcRenderer.invoke(CHANNELS.sidechat.load, sessionId) as Promise<
        | { ok: true; sessionId: string; messages: SerializedHistoryMessage[] }
        | { ok: false; error: string; messages: SerializedHistoryMessage[] }
      >,
    list: async () =>
      ipcRenderer.invoke(CHANNELS.sidechat.list) as Promise<{
        current: string | null;
        sessions: Array<{ id: string; modifiedAt: string; title: string }>;
      }>,
    abort: async () =>
      ipcRenderer.invoke(CHANNELS.sidechat.abort) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    onStream: (handler: (event: ChatStreamEvent) => void) => {
      const listener = (_event: unknown, payload: ChatStreamEvent) => handler(payload);
      ipcRenderer.on(CHANNELS.sidechat.stream, listener);
      return () => ipcRenderer.removeListener(CHANNELS.sidechat.stream, listener);
    },
    onFallback: (handler: (payload: { from: string; to: string }) => void) => {
      const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
      ipcRenderer.on(CHANNELS.sidechat.fallback, listener);
      return () => ipcRenderer.removeListener(CHANNELS.sidechat.fallback, listener);
    },
  },
  // Tutorial-C — SpotlightTour state bridge. Host stores tour completion
  // under `~/.lvis/onboarding/tour-state.json`; `tour.start` broadcasts a
  // `lvis:tour:start` event through the host's trusted renderer target set.
  // `getState` is read-never-throws (returns the default
  // shape on any failure) per the project storage contract.
  tour: {
    getState: async () =>
      ipcRenderer.invoke(CHANNELS.tour.getState) as Promise<
        | {
            ok: true;
            state: {
              lastSeenScenario: string | null;
              completedScenarios: string[];
              dismissedAt: string | null;
            };
          }
        | { ok: false; error: string; message: string }
      >,
    markComplete: async (scenarioId: string) =>
      ipcRenderer.invoke(CHANNELS.tour.markComplete, { scenarioId }) as Promise<
        | {
            ok: true;
            state: {
              lastSeenScenario: string | null;
              completedScenarios: string[];
              dismissedAt: string | null;
            };
          }
        | { ok: false; error: string; message: string }
      >,
    dismiss: async (scenarioId: string) =>
      ipcRenderer.invoke(CHANNELS.tour.dismiss, { scenarioId }) as Promise<
        | {
            ok: true;
            state: {
              lastSeenScenario: string | null;
              completedScenarios: string[];
              dismissedAt: string | null;
            };
          }
        | { ok: false; error: string; message: string }
      >,
    start: async (scenarioId: string) =>
      ipcRenderer.invoke(CHANNELS.tour.start, { scenarioId }) as Promise<
        | { ok: true; scenarioId: string }
        | { ok: false; error: string; message: string }
      >,
    onStart: (handler: (payload: { scenarioId: string }) => void) => {
      const listener = (
        _event: unknown,
        payload: { scenarioId?: unknown },
      ) => {
        const id = payload?.scenarioId;
        if (typeof id === "string" && id.length > 0) {
          handler({ scenarioId: id });
        }
      };
      ipcRenderer.on(CHANNELS.tour.start, listener);
      return () => ipcRenderer.removeListener(CHANNELS.tour.start, listener);
    },
  },
  // Open an http(s) URL in the system browser. Main-side validates the
  // scheme and rejects file://, javascript:, and any other handler.
  openExternalUrl: async (url: string) =>
    ipcRenderer.invoke(CHANNELS.shell.openExternal, url) as Promise<{
      ok: boolean;
      error?: string;
      protocol?: string;
      message?: string;
    }>,
  // MCP marketplace catalog + install
  listMcpCatalog: async () => ipcRenderer.invoke(CHANNELS.mcp.catalogList),
  installMcpFromMarketplace: async (slug: string) =>
    ipcRenderer.invoke(CHANNELS.mcp.installFromMarketplace, slug),
  // Claude Desktop config import (two-phase: preview → apply).
  previewClaudeDesktopMcpImport: async (raw: string) =>
    ipcRenderer.invoke(CHANNELS.mcp.importClaudeDesktopPreview, raw),
  applyClaudeDesktopMcpImport: async (payload: { raw: string; conflictPolicy?: "skip" | "overwrite" }) =>
    ipcRenderer.invoke(CHANNELS.mcp.importClaudeDesktopApply, payload),

  notifyPluginTheme: (payload: {
    bundleId: string;
    shell: "light" | "dark";
    tokens: Record<string, string>;
  }) =>
    ipcRenderer.invoke(CHANNELS.host.pluginThemeNotify, payload),

  // Plugin-owned OAuth removed host-owned provider auth IPC bridges.



  // ─── Memory ──────────────────────────────────────
  memoryListEntries: async (opts?: MemoryProjectOptions) =>
    invokeWithOptionalMemoryOptions(CHANNELS.memory.entriesList, opts),
  memoryListCandidates: async (opts?: MemoryProjectOptions) =>
    invokeWithOptionalMemoryOptions(CHANNELS.memory.candidatesList, opts),
  memorySaveEntry: async (title: string, content: string, opts?: MemoryProjectOptions) =>
    ipcRenderer.invoke(CHANNELS.memory.entriesSave, title, content, opts),
  memoryDeleteEntry: async (filename: string, opts?: MemoryProjectOptions) =>
    invokeMemoryDelete(CHANNELS.memory.entriesDelete, filename, opts),
  memoryActivateCandidate: async (id: string, opts?: MemoryProjectOptions) =>
    invokeMemoryCandidateAction(CHANNELS.memory.candidateActivate, id, opts),
  memoryDeleteCandidate: async (id: string, opts?: MemoryProjectOptions) =>
    invokeMemoryCandidateAction(CHANNELS.memory.candidateDelete, id, opts),
  memorySearchEntries: async (query: string, opts?: MemoryProjectOptions) =>
    invokeMemorySearch(CHANNELS.memory.entriesSearch, query, opts),
  memoryGetIndex: async (opts?: MemoryProjectOptions) =>
    invokeWithOptionalMemoryOptions<string>(CHANNELS.memory.indexGet, opts),
  memoryUpdateIndexIfUnchanged: async (expectedContent: string, nextContent: string) =>
    ipcRenderer.invoke(CHANNELS.memory.indexUpdateIfUnchanged, expectedContent, nextContent) as Promise<boolean>,
  memoryUpdateIndexSections: async (sections: { urgentMemory?: string; references?: string }) =>
    ipcRenderer.invoke(CHANNELS.memory.indexSectionsUpdate, sections),
  memoryListSessions: async (opts?: MemoryProjectOptions) =>
    invokeWithOptionalMemoryOptions(CHANNELS.memory.sessionsList, opts),
  memorySearchSessions: async (query: string, opts?: MemoryProjectOptions) =>
    invokeMemorySearch(CHANNELS.memory.sessionsSearch, query, opts),
  memoryGetAgentsMd: async () => ipcRenderer.invoke(CHANNELS.memory.agentsMdGet) as Promise<string>,
  memoryUpdateAgentsMd: async (content: string) => ipcRenderer.invoke(CHANNELS.memory.agentsMdUpdate, content),
  memoryGetUserPrefs: async () => ipcRenderer.invoke(CHANNELS.memory.userPrefsGet) as Promise<string>,
  memoryUpdateUserPrefs: async (content: string) => ipcRenderer.invoke(CHANNELS.memory.userPrefsUpdate, content),
  memoryRefreshUserPrefs: async () => ipcRenderer.invoke(CHANNELS.memory.userPrefsRefresh),
  memoryRefreshLongTerm: async () => ipcRenderer.invoke(CHANNELS.memory.longTermRefresh),

  // ─── ~/.lvis reference docs ──────────────────────
  homeDocsStatus: async () => ipcRenderer.invoke(CHANNELS.homeDocs.upgradeMarkersList),
  homeDocsReadMarker: async (markerPath: string) =>
    ipcRenderer.invoke(CHANNELS.homeDocs.markerRead, markerPath),
  homeDocsApplyPackaged: async (markerPath: string) =>
    ipcRenderer.invoke(CHANNELS.homeDocs.packagedApply, markerPath),
  homeDocsKeepMine: async (markerPath: string) =>
    ipcRenderer.invoke(CHANNELS.homeDocs.markerKeepMine, markerPath),
  homeDocsGetCustom: async () =>
    ipcRenderer.invoke(CHANNELS.homeDocs.customGet) as Promise<string>,
  homeDocsUpdateCustom: async (content: string) =>
    ipcRenderer.invoke(CHANNELS.homeDocs.customUpdate, content),
  homeDocsMerge: async (markerPath?: string) =>
    ipcRenderer.invoke(CHANNELS.homeDocs.mergeRun, markerPath),
  homeDocsApplyMerged: async (expectedContent: string) =>
    ipcRenderer.invoke(CHANNELS.homeDocs.mergeApply, expectedContent),
  homeDocsDiscardMerged: async () => ipcRenderer.invoke(CHANNELS.homeDocs.mergeDiscard),

  // ─── Plugins ─────────────────────────────────────
  listPersonaPromptSummaries: async () => ipcRenderer.invoke(CHANNELS.prompts.listSummaries),
  listPersonaPrompts: async () => ipcRenderer.invoke(CHANNELS.prompts.list),
  savePersonaPrompt: async (prompt: { id: string; name: string; systemPromptAdd: string }) =>
    ipcRenderer.invoke(CHANNELS.prompts.save, prompt),
  deletePersonaPrompt: async (id: string) => ipcRenderer.invoke(CHANNELS.prompts.delete, id),
  listAgentProfiles: async () => ipcRenderer.invoke(CHANNELS.agents.list),
  listSkills: async () => ipcRenderer.invoke(CHANNELS.skills.list),
  installAgentFromMarketplace: async (slug: string) =>
    ipcRenderer.invoke(CHANNELS.agents.install, slug),
  uninstallAgentPackage: async (slug: string) =>
    ipcRenderer.invoke(CHANNELS.agents.uninstall, slug),
  installSkillFromMarketplace: async (slug: string) =>
    ipcRenderer.invoke(CHANNELS.skills.install, slug),
  uninstallSkillPackage: async (slug: string) =>
    ipcRenderer.invoke(CHANNELS.skills.uninstall, slug),
  listPluginUiExtensions: async () => ipcRenderer.invoke(CHANNELS.plugins.uiList),
  // #237 — host renderer pre-binds (webContents.id → pluginId, entryUrl)
  // before each plugin webview navigates. Main rejects unknown pluginId
  // and any non-host frame.
  registerPluginWebview: async (payload: { webContentsId: number; pluginId: string; entryUrl: string }) =>
    ipcRenderer.invoke(CHANNELS.pluginBridge.registerWebview, payload) as Promise<{ ok: boolean; error?: string }>,
  // Awaited before the panel renders its <webview> — see the channel comment.
  ensurePluginPartition: async (pluginId: string) =>
    ipcRenderer.invoke(CHANNELS.pluginBridge.ensurePartition, { pluginId }) as Promise<{ ok: boolean; error?: string }>,
  readPluginUiModule: async (pluginId: string, viewId: string) =>
    ipcRenderer.invoke(CHANNELS.plugins.uiReadModule, { pluginId, viewId }) as Promise<string>,
  // #1176 — toggle a plugin active/inactive. Returns the IPC result frame
  // ({ ok, pluginId, enabled } | { ok:false, error, message }).
  setPluginEnabled: async (pluginId: string, enabled: boolean) =>
    ipcRenderer.invoke(CHANNELS.plugins.setEnabled, pluginId, enabled),
  listPluginContributionTrust: async (pluginId?: string) =>
    ipcRenderer.invoke(CHANNELS.plugins.contributionTrustList, pluginId),
  setPluginContributionTrust: async (input: {
    pluginId: string;
    localId: string;
    kind: "hook" | "mcpServer";
    approved: boolean;
  }) => ipcRenderer.invoke(CHANNELS.plugins.contributionTrustSet, input),
  callPluginMethod: async (
    method: string,
    payload?: unknown,
    options?: { userAction?: boolean; operationGrantToken?: string },
  ) => ipcRenderer.invoke(CHANNELS.plugins.call, method, payload, {
    userAction: options?.userAction === true && navigator.userActivation?.isActive === true,
    ...(options?.operationGrantToken
      ? { operationGrantToken: options.operationGrantToken }
      : {}),
  }),
  e2ePluginBundleSnapshot: async (
    pluginId: string,
    skillLocalId: string,
    hookProbeToolName: string,
  ) =>
    ipcRenderer.invoke(
      CHANNELS.plugins.e2eBundleSnapshot,
      pluginId,
      skillLocalId,
      hookProbeToolName,
    ) as Promise<unknown>,


  // ─── Overlay trigger lifecycle ────────────────────────────────────────
  onTriggerStarted: (handler: (payload: OverlayTriggerStartedPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.trigger.started, listener);
    return () => ipcRenderer.removeListener(CHANNELS.trigger.started, listener);
  },
  onTriggerCompleted: (handler: (result: OverlayTriggerCompletedPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.trigger.completed, listener);
    return () => ipcRenderer.removeListener(CHANNELS.trigger.completed, listener);
  },
  onTriggerFailed: (handler: (payload: OverlayTriggerFailedPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.trigger.failed, listener);
    return () => ipcRenderer.removeListener(CHANNELS.trigger.failed, listener);
  },
  onTriggerExpired: (handler: (payload: OverlayTriggerExpiredPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.trigger.expired, listener);
    return () => ipcRenderer.removeListener(CHANNELS.trigger.expired, listener);
  },
  onTriggerImported: (handler: (payload: OverlayTriggerImportedPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.trigger.imported, listener);
    return () => ipcRenderer.removeListener(CHANNELS.trigger.imported, listener);
  },
  dismissTrigger: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.trigger.dismiss, sessionId) as ReturnType<LvisApi["dismissTrigger"]>,
  importTrigger: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.trigger.import, sessionId) as ReturnType<LvisApi["importTrigger"]>,

  // ─── Marketplace update notifications ────────────
  onMarketplaceUpdatesAvailable: (handler: (updates: Array<{
    pluginId: string;
    pluginName?: string;
    installedVersion: string;
    latestVersion: string;
    networkAccess?: {
      allowedDomains: string[];
      reasoning?: string;
      allowPrivateNetworks?: boolean;
    };
  }>) => void) => {
    const listener = (_event: unknown, updates: Parameters<typeof handler>[0]) => handler(updates);
    ipcRenderer.on(CHANNELS.marketplace.updatesAvailable, listener);
    return () => ipcRenderer.removeListener(CHANNELS.marketplace.updatesAvailable, listener);
  },

  // ─── Marketplace announcements ───────────────────
  // The host pushes the active, not-yet-dismissed announcement set whenever
  // the announcement poller runs (boot + interval). Dismissals are persisted
  // by the renderer via updateSettings, and the host filters them out before
  // the next push so a dismissed banner never reappears.
  onMarketplaceAnnouncements: (handler: (announcements: MarketplaceAnnouncementPayload) => void) => {
    const listener = (_event: unknown, announcements: Parameters<typeof handler>[0]) => handler(announcements);
    ipcRenderer.on(MARKETPLACE.announcements, listener);
    return () => ipcRenderer.removeListener(MARKETPLACE.announcements, listener);
  },

  // ─── App auto-update (electron-updater) ──────────
  // Main process emits `lvis:update:state` whenever the updater state
  // transitions (available / downloading / downloaded). Renderer renders
  // a permanent badge next to the Home button so the user always sees the
  // current state, not a transient toast. The two action commands are
  // user-gated — `downloadAppUpdate` is only called from a badge click,

  // UpdateState type imported from the SoT at src/shared/update-state.ts
  // so adding a new variant only needs editing that one file.
  onAppUpdateState: (
    handler: (state: import("../shared/update-state.js").UpdateState) => void,
  ) => {
    const listener = (_event: unknown, state: Parameters<typeof handler>[0]) => handler(state);
    ipcRenderer.on(CHANNELS.update.state, listener);
    return () => ipcRenderer.removeListener(CHANNELS.update.state, listener);
  },
  /** Fetch the last-known state synchronously (for late-mounting components
   *  that miss the initial broadcast). Returns { kind: "idle" } before the
   *  first check completes. */
  getAppUpdateState: () =>
    ipcRenderer.invoke(CHANNELS.update.getState) as Promise<
      import("../shared/update-state.js").UpdateState
    >,
  /** Start the actual download. Only valid when the current state is
   *  "available"; rejected (ok:false) otherwise. */
  downloadAppUpdate: () =>
    ipcRenderer.invoke(CHANNELS.update.downloadNow) as Promise<{ ok: boolean; reason?: string }>,
  /** Quit and apply the downloaded update. Main validates the sender and
   *  owns the native confirmation dialog before it calls quitAndInstall().
   *  Only valid when the current state is "downloaded"; rejected
   *  (ok:false) otherwise. */
  installAppUpdate: () =>
    ipcRenderer.invoke(CHANNELS.update.installNow) as Promise<{ ok: boolean; reason?: string }>,
  skipAppUpdate: () =>
    ipcRenderer.invoke(CHANNELS.update.skipVersion) as Promise<{ ok: boolean; reason?: string }>,

  // ─── Managed bootstrap status ────────────────────
  // The host emits these around `ensureManagedInstalled()` so the renderer
  // can show a banner / toast during startup install. Three lifecycle states:
  //   - { phase: "start" }
  //   - { phase: "complete", installed[], failed[], skippedReason? }
  //   - { phase: "error", message }
  // Best-effort: the host swallows send errors, so the renderer must
  // tolerate missing events (page reload during startup, etc.).
  onBootstrapStatus: (
    handler: (status:
      | { phase: "start" }
      | { phase: "complete"; installed: string[]; failed: Array<{ id: string; error: string }>; skippedReason?: string }
      | { phase: "error"; message: string }
    ) => void,
  ) => {
    const listener = (_event: unknown, status: Parameters<typeof handler>[0]) => handler(status);
    ipcRenderer.on(CHANNELS.bootstrap.status, listener);
    return () => ipcRenderer.removeListener(CHANNELS.bootstrap.status, listener);
  },
  // Banner-driven retry. Re-emits the start/complete/error
  // status sequence so the banner subscriber updates without needing a
  // separate result channel.
  retryBootstrap: () => ipcRenderer.invoke(CHANNELS.bootstrap.retry),

  // ─── lvis:// deep-link install lifecycle ─────────
  // Fires when a marketplace install triggered via lvis://install/{slug} has
  // finished installing + restartAll() in the main process. Renderer uses
  // this to refresh its plugin UI list so newly-installed plugin views
  // appear without requiring an app restart.
  onPluginInstallResult: (handler: (payload: PluginInstallResultPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.plugins.installResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.plugins.installResult, listener);
  },

  /**
   * Dev-only: install a plugin from a local directory (LVIS_DEV=1 required).
   *
   * Return shape:
   *   - `null` — the user cancelled the folder picker. NOT an error.
   *   - `{ pluginId, installed: true }` — install succeeded.
   *   - throws — auth/dev-mode/IO error. Callers should surface this as a
   *     toast/alert rather than collapsing it into `null`, otherwise users
   *     can't distinguish "didn't run" from "ran but failed". See
   *     `installLocal` in `src/plugins/marketplace.ts` for the error
   *     producer side.
   */
  installLocalPlugin: async () => {
    const r = await ipcRenderer.invoke(CHANNELS.plugins.installLocal) as
      | { pluginId: string; installed: true }
      | { ok: false; error: string }
      | null;
    if (!r) return null; // user cancelled the folder picker
    if ("ok" in r) {
      throw new Error(`installLocalPlugin: ${r.error}`);
    }
    return r;
  },

  // Sibling of onPluginInstallResult — fires after PluginConfigTab or any
  // other surface drives uninstall through the IPC handler. Renderer uses
  // this to drop the removed plugin view + marketplace card.
  onPluginUninstallResult: (handler: (payload: { slug: string; success: boolean; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.plugins.uninstallResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.plugins.uninstallResult, listener);
  },
  // #1176 — fires after a plugin's active/inactive state is toggled (via this
  // surface or any other). Renderer surfaces use this to refresh plugin cards
  // so a disabled plugin's tools/UI disappear (and reappear on re-enable).
  onPluginEnabledChanged: (handler: (payload: { pluginId: string; enabled: boolean }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.plugins.enabledChanged, listener);
    return () => ipcRenderer.removeListener(CHANNELS.plugins.enabledChanged, listener);
  },
  onPluginRuntimeUpdated: (handler: (payload: { pluginId: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.plugins.runtimeUpdated, listener);
    return () => ipcRenderer.removeListener(CHANNELS.plugins.runtimeUpdated, listener);
  },
  onPersonaPromptsUpdated: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on(CHANNELS.prompts.updated, listener);
    return () => ipcRenderer.removeListener(CHANNELS.prompts.updated, listener);
  },

  onAgentInstallResult: (handler: (payload: AgentInstallResultPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.agents.installResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.agents.installResult, listener);
  },
  onAgentUninstallResult: (handler: (payload: AgentInstallResultPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.agents.uninstallResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.agents.uninstallResult, listener);
  },
  onSkillInstallResult: (handler: (payload: SkillInstallResultPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.skills.installResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.skills.installResult, listener);
  },
  onSkillUninstallResult: (handler: (payload: SkillInstallResultPayload) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.skills.uninstallResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.skills.uninstallResult, listener);
  },

  // Phase progress for in-flight installs. Granular phases fire from inside
  // installFromMarketplace: downloading (byte-level) → verifying → registering.
  // The callers (handleLvisUri, lvis:plugins:install) emit `installing` at the
  // start and `restarting` after the install completes. The result event clears
  // the in-flight state. Renderer renders a skeleton card.
  onPluginInstallProgress: (handler: (payload:
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" | "preparing" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.plugins.installProgress, listener);
    return () => ipcRenderer.removeListener(CHANNELS.plugins.installProgress, listener);
  },
  onAgentInstallProgress: (handler: (payload:
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.agents.installProgress, listener);
    return () => ipcRenderer.removeListener(CHANNELS.agents.installProgress, listener);
  },
  onSkillInstallProgress: (handler: (payload:
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.skills.installProgress, listener);
    return () => ipcRenderer.removeListener(CHANNELS.skills.installProgress, listener);
  },

  // Status bar — aggregated runtime counters (tools / plugins / mcps).
  getRuntimeCounts: async () =>
    ipcRenderer.invoke(CHANNELS.runtime.counts) as Promise<{
      tools: number;
      plugins: number;
      mcps: number;
    }>,
  // Status bar — static environment info (platform / hostname / user).
  // Static enough to fetch once on mount; values don't change while the
  // process is alive. Cwd is intentionally NOT exposed — least-privilege
  // for plugin UI panels that share this contextBridge.
  getRuntimeEnv: async () =>
    ipcRenderer.invoke(CHANNELS.runtime.env) as Promise<{
      platform: string;
      hostname: string;
      user: string;
    }>,
  // Status bar — marketplace reachability probe. Returns `configured: false`
  // when the user is on the mock backend (nothing to ping).
  pingMarketplace: async () =>
    ipcRenderer.invoke(CHANNELS.marketplace.ping) as Promise<{
      configured: boolean;
      online: boolean;
    }>,
  // Status bar — active LLM provider reachability probe. This performs a
  // tiny one-shot model call from the main process so "connected" means the
  // provider itself answered, not only that the marketplace backend is online.
  pingAiProvider: async () =>
    ipcRenderer.invoke(CHANNELS.llm.ping) as Promise<AiProviderPingIpcResult>,

  // Settings "일반" dashboard — host metadata. SoT for `version` is the
  // LVIS project package.json (resolved by the main process via
  // `app.getAppPath()`); stack fields come from `process.versions`. The
  // renderer never hard-codes these values.
  getAppInfo: async () =>
    ipcRenderer.invoke(CHANNELS.app.info) as Promise<{
      version: string;
      electronVersion: string;
      nodeVersion: string;
      chromeVersion: string;
      v8Version: string;
      platform: NodeJS.Platform;
      arch: string;
      userDataPath: string;
    }>,

  // ─── Plugin Events ──────────────────────────────
  onPluginEvent: (
    eventType: string,
    handler: (data: unknown) => void,
  ): (() => void) => {
    // Reject subscriptions to private-namespace events at the preload boundary.
    // This prevents renderer code from subscribing to sensitive host state
    // (memory contents, secrets, audit trails, DLP decisions) even if the IPC
    // channel delivers them.
    //
    // "What counts as private" has exactly one definition —
    // `classifySubscription` in plugins/capabilities.ts, the same authority the
    // emit gate (`canEmitEvent`) and the runtime access control use. Do not
    // re-derive it from PLUGIN_PRIVATE_NAMESPACES here: the classifier already
    // distinguishes prefix namespaces from exact host-owned event types
    // (PUBLIC_HOST_EVENT_TYPES was split out of PUBLIC_EVENT_NAMESPACES for
    // exactly that reason), and a re-derivation cannot track a refinement of
    // the private branch.
    if (classifySubscription(eventType) === "private") {
      // Return a no-op unsubscribe — the subscription is silently rejected.
      return () => undefined;
    }
    const listener = (_event: unknown, type: string, data: unknown) => {
      if (type === eventType) handler(data);
    };
    ipcRenderer.on(CHANNELS.pluginBridge.event, listener);
    return () => ipcRenderer.removeListener(CHANNELS.pluginBridge.event, listener);
  },

  // ─── MCP ─────────────────────────────────────────
  // Assembled in its own module for size; spliced in here unchanged.
  mcp: mcpApiSurface,

  // ─── Permission ───────────────────────────────────
  permission: {
    getMode: async () => ipcRenderer.invoke(PERMISSIONS.getMode),
    setMode: async (mode: string) => ipcRenderer.invoke(PERMISSIONS.setMode, {
      mode,
      intent: ipcUserKeyboardIntent(),
    }),
    onModeChanged: (cb: (mode: string) => void) => {
      const listener = (_event: unknown, payload: { mode?: unknown }) => {
        if (typeof payload?.mode === "string") cb(payload.mode);
      };
      ipcRenderer.on(PERMISSIONS.modeChanged, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.modeChanged, listener);
    },
    /**
     * Hint event — directory config mutated. Listeners refresh state by
     * calling `permission.dirDispatch("list")` rather than receiving the
     * full directory list in the broadcast payload (slash dispatcher is
     * the single source of truth).
     */
    onConfigChanged: (cb: () => void) => {
      const listener = () => cb();
      ipcRenderer.on(PERMISSIONS.configChanged, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.configChanged, listener);
    },
    /** Read-only: honest OS sandbox capability for the current platform. */
    sandboxCapability: async () => ipcRenderer.invoke(PERMISSIONS.sandboxCapability),
    /** Read-only: Windows srt-win install readiness (group + WFP + instructions). */
    sandboxWindowsStatus: async () => ipcRenderer.invoke(PERMISSIONS.sandboxWindowsStatus),
    /**
     * MUTATING: trigger the one-time Windows srt-win install (one self-elevating
     * UAC prompt). The ONLY user-consented privilege-escalation entry point —
     * only ever called from an explicit "Install now" click. Auto-injects the
     * user-keyboard intent the sender-guarded handler requires.
     */
    sandboxWindowsInstall: async () =>
      ipcRenderer.invoke(PERMISSIONS.sandboxWindowsInstall, { intent: ipcUserKeyboardIntent() }),
    listRules: async () => ipcRenderer.invoke(PERMISSIONS.listRules),
    addRule: async (pattern: string, action: string) =>
      ipcRenderer.invoke(PERMISSIONS.addRule, { pattern, action, intent: ipcUserKeyboardIntent() }),
    removeRule: async (pattern: string, action: string) =>
      ipcRenderer.invoke(PERMISSIONS.removeRule, { pattern, action, intent: ipcUserKeyboardIntent() }),
    /** Permission policy — deferred queue for reviewer HIGH verdicts. */
    deferredList: async () => ipcRenderer.invoke(PERMISSIONS.deferredList),
    /** Permission policy issue #633 — hook quarantine state for non-modal settings badge. */
    hookTrustList: async () => ipcRenderer.invoke(PERMISSIONS.hookTrustList),
    /** Permission policy — `/permission dir ...` slash dispatch via IPC. */
    dirDispatch: async (rawArgs: string) =>
      ipcRenderer.invoke(PERMISSIONS.dirDispatch, { rawArgs, intent: ipcUserKeyboardIntent() }),
    deferredResolve: async (
      id: string,
      decision: "approved" | "rejected",
      reason: string | undefined,
      // Required: callers must explicitly opt into a provenance value
      // before main writes the HMAC-chained audit row.
      approvalSource: DeferredApprovalSource,
      // Grant breadth + adjacency acknowledgement for an approval. Omitting
      // `scope` grants the narrowest breadth; main never widens on its own.
      options?: { scope?: "session" | "always"; acknowledgeWarnings?: boolean },
    ) =>
      ipcRenderer.invoke(PERMISSIONS.deferredResolve, {
        id,
        decision,
        reason,
        approvalSource,
        ...(options?.scope ? { scope: options.scope } : {}),
        ...(options?.acknowledgeWarnings
          ? { acknowledgeWarnings: true }
          : {}),
        intent: ipcUserKeyboardIntent(),
      }),
    /** Foreground-entry pending notification — main→renderer event. */
    onDeferredPending: (cb: (summary: { pending: number }) => void) => {
      const listener = (_event: unknown, summary: { pending: number }) =>
        cb(summary);
      ipcRenderer.on(PERMISSIONS.deferredPending, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.deferredPending, listener);
    },
    /** Memory-hit auto-approve disclosure — main→renderer event. */
    onUserApprovalHit: (cb: (payload: UserApprovalHitPayload) => void) => {
      const listener = (_event: unknown, payload: UserApprovalHitPayload) =>
        cb(payload);
      ipcRenderer.on(PERMISSIONS.userApprovalHit, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.userApprovalHit, listener);
    },
    onReviewSuggestion: (cb: (payload: PermissionReviewSuggestionPayload) => void) => {
      const listener = (_event: unknown, payload: PermissionReviewSuggestionPayload) =>
        cb(payload);
      ipcRenderer.on(PERMISSIONS.reviewSuggestion, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.reviewSuggestion, listener);
    },
    /** Permission policy — `/permission reviewer ...` slash dispatch via IPC. */
    reviewerDispatch: async (rawArgs: string) =>
      ipcRenderer.invoke(PERMISSIONS.reviewerDispatch, { rawArgs, intent: ipcUserKeyboardIntent() }),
    /** Check whether a reviewer provider has its required API key stored. */
    reviewerProviderHasKey: async (provider: string) =>
      ipcRenderer.invoke(PERMISSIONS.reviewerProviderHasKey, provider),
    /** Permission policy — `/permission audit show` — fetch recent permission audit entries. */
    auditShow: async (last: number) =>
      ipcRenderer.invoke(PERMISSIONS.auditShow, { last }),
    /** Permission policy — `/permission audit verify` — chain integrity check. */
    auditVerify: async () =>
      ipcRenderer.invoke(PERMISSIONS.auditVerify),
    /**
     * Permission policy — manifest integrity violation notifier. Subscribes
     * to `PERMISSIONS.manifestViolation` so the renderer can
     * surface a "Plugin X disabled — reinstall?" prompt.
     */
    onManifestViolation: (
      handler: (payload: {
        pluginId: string;
        toolName: string;
        attempted: string;
      }) => void,
    ) => {
      const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) =>
        handler(payload);
      ipcRenderer.on(PERMISSIONS.manifestViolation, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.manifestViolation, listener);
    },
  },

  // ─── Policy (Governance) ─────────────────────────
  policy: {
    get: async () => ipcRenderer.invoke(PERMISSIONS.policyGet),
    set: async (patch: unknown) =>
      ipcRenderer.invoke(PERMISSIONS.policySet, { patch, intent: ipcUserKeyboardIntent() }),
  },

  // ─── Approval Gate ─────────────────────────────
  approval: {
    /** main→renderer 단방향 이벤트 구독 */
    onRequest: (cb: Parameters<LvisApi["approval"]["onRequest"]>[0]) => {
      const listener = (_event: unknown, req: Parameters<typeof cb>[0]) => cb(req);
      ipcRenderer.on(CHANNELS.approval.request, listener);
      return () => ipcRenderer.removeListener(CHANNELS.approval.request, listener);
    },
    /**
     * main→renderer: a request the host is no longer waiting on. Window-wide
     * like `onRequest` — the queue it reconciles is the window's one FIFO,
     * and the surface drawing the card is decided renderer-side.
     */
    onSettled: (cb: Parameters<LvisApi["approval"]["onSettled"]>[0]) => {
      const listener = (_event: unknown, payload: Parameters<typeof cb>[0]) => cb(payload);
      ipcRenderer.on(CHANNELS.approval.settled, listener);
      return () => ipcRenderer.removeListener(CHANNELS.approval.settled, listener);
    },
    /** 사용자 결정을 main으로 전송 */
    respond: async (decision: unknown) =>
      ipcRenderer.invoke(PERMISSIONS.approvalRespond, decision),
    /**
     * The requests the host is still waiting on, exactly as `onRequest`
     * delivered them. A renderer that (re)loads while a turn is parked on an
     * approval subscribed after the request went out, so this is how it gets
     * the card back instead of leaving the turn to time out.
     */
    listPending: async () => ipcRenderer.invoke(PERMISSIONS.approvalPending),
    /**
     * `/allow <sentence>` — ask the host which of the PENDING request's own
     * scopes the sentence meant. Returns a choice to pre-select; it decides
     * nothing, so `respond` above is still the only way to answer a prompt.
     */
    selectSentence: async (requestId: string, input: string) =>
      ipcRenderer.invoke(PERMISSIONS.approvalSentenceSelect, {
        requestId,
        input,
        intent: ipcUserKeyboardIntent(),
      }),
  },

  // ─── User-Approval Store ─────────────
  userApproval: {
    /** Record an exact user decision (legacy callers default to allow). */
    record: async (entry: {
      /** Server-side ApprovalRequest binding — required for IPC handler validation. */
      requestId: string;
      toolName: string;
      args: string;
      source: string;
      decision?: "allow" | "deny";
      scope: UserApprovalScope;
      verdictAtApproval: UserApprovalVerdict;
      nlJustification: string | null;
      /** Propagated for record/lookup key symmetry. */
      trustOrigin?: string;
      /** Propagated for record/lookup key symmetry. */
      approvalCacheKey?: string;
    }) => ipcRenderer.invoke(PERMISSIONS.userApprovalRecord, { ...entry, intent: ipcUserKeyboardIntent() }),
    /** Revoke an approval by raw composite key. */
    revokeByKey: async (key: string) =>
      ipcRenderer.invoke(PERMISSIONS.userApprovalRevoke, { key, intent: ipcUserKeyboardIntent() }),
    /** List all approval entries (for PermissionsTab display). */
    list: async () => ipcRenderer.invoke(PERMISSIONS.userApprovalList),
  },

  // ─── DLP Hit Statistics (Observability) ─────────
  dlp: {
    getStats: async (days: number) => ipcRenderer.invoke(CHANNELS.dlp.stats, days),
  },

  // ─── Audit Log Search (Observability) ────────────
  audit: {
    search: async (filter: {
      dateFrom?: string;
      dateTo?: string;
      type?: string;
      textSearch?: string;
      limit?: number;
      offset?: number;
    }) => ipcRenderer.invoke(CHANNELS.audit.search, filter),
    getStats: async (lastDays: number) => ipcRenderer.invoke(CHANNELS.audit.stats, lastDays),
  },

  // ─── Diagnostics bundle + crash list ──
  diagnostics: {
    /** Build a redacted diagnostics ZIP and save via native dialog. */
    export: async (opts?: { dateFrom?: string; dateTo?: string; includeCrashDumps?: boolean }) =>
      ipcRenderer.invoke(CHANNELS.diagnostics.export, opts),
    /** List crash-dump metadata (filename/time/size). */
    crashList: async () => ipcRenderer.invoke(CHANNELS.diagnostics.crashList),
  },

  // ─── Production log tail viewer ──
  logs: {
    /** Recent N redacted log lines, optional level filter. */
    tail: async (args?: { lines?: number; level?: string }) =>
      ipcRenderer.invoke(CHANNELS.logs.tail, args),
  },

  // ─── Message feedback ────────────────────────────
  submitFeedback: async (payload: { sessionId: string; messageIndex: number; rating: "up" | "down"; reason?: string }) =>
    ipcRenderer.invoke(CHANNELS.feedback.submit, payload) as Promise<{ ok: boolean; error?: string }>,

  // ─── View Events ─────────────────────────────────
  onViewActivate: (handler: (viewKey: string, settingsTab?: string) => void) => {
    const listener = (_event: unknown, payload: { viewKey?: string; settingsTab?: string }) =>
      handler(payload?.viewKey ?? "home", typeof payload?.settingsTab === "string" ? payload.settingsTab : undefined);
    ipcRenderer.on(CHANNELS.view.activate, listener);
    return () => ipcRenderer.removeListener(CHANNELS.view.activate, listener);
  },

  // ─── Workflow tools ──────────────────────────────
  // ask_user_question — main process pushes FIFO question requests to the
  // renderer's non-modal composer dock; the card resolves via this channel.
  onAskUserQuestion: (handler: (req: AskUserQuestionRequest) => void) => {
    const listener = (_e: unknown, req: Parameters<typeof handler>[0]) => handler(req);
    ipcRenderer.on(CHANNELS.askUserQuestion.request, listener);
    return () => ipcRenderer.removeListener(CHANNELS.askUserQuestion.request, listener);
  },
  respondAskUserQuestion: async (response: AskUserQuestionResponse) =>
    ipcRenderer.invoke(CHANNELS.askUserQuestion.respond, response),
  // Timeout side-channel — main process notifies the renderer when an
  // ask_user_question request expired (5 min default) so the card can drop
  // the stale prompt before the user clicks into a no-op.
  onAskUserQuestionTimeout: (
    handler: (payload: { requestId: string }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on(CHANNELS.askUserQuestion.timeout, listener);
    return () => ipcRenderer.removeListener(CHANNELS.askUserQuestion.timeout, listener);
  },

  // routine_schedule — persistent routine list + lifecycle
  listRoutines: async () => ipcRenderer.invoke(ROUTINES.list),
  dismissRoutine: async (id: string) => ipcRenderer.invoke(ROUTINES.dismiss, id),
  removeRoutine: async (id: string) => ipcRenderer.invoke(ROUTINES.remove, id),
  triggerRoutineNow: async (id: string) => ipcRenderer.invoke(ROUTINES.triggerNow, id),
  listPendingRoutineResults: async () =>
    ipcRenderer.invoke(ROUTINES.pendingResults) as Promise<
      import("../shared/routines-types.js").RoutineFiredPayload[]
    >,
  acknowledgeRoutineResult: async (routineId: string, firedAt: string) =>
    ipcRenderer.invoke(ROUTINES.acknowledgeResult, routineId, firedAt) as Promise<{ ok: boolean; error?: string }>,
  addRoutine: async (input: import("../shared/routines-types.js").AddRoutineInput) =>
    ipcRenderer.invoke(ROUTINES.add, input) as Promise<
      { ok: true; routine: import("../shared/routines-types.js").RoutineRecord } | { ok: false; error: string }
    >,
  onRoutineFired: (
    handler: (event: import("../shared/routines-types.js").RoutineFiredPayload) => void,
  ) => {
    const listener = (_e: unknown, r: Parameters<typeof handler>[0]) => handler(r);
    ipcRenderer.on(ROUTINES.fired, listener);
    return () => ipcRenderer.removeListener(ROUTINES.fired, listener);
  },
  // Routine running indicator: emitted when a routine LLM session starts/finishes
  // runningStarted payload enriched to { routineId, firedAt, title } so the
  // renderer can push a proper OverlayItem immediately without waiting for fired.
  onRoutineRunningStarted: (handler: (payload: { routineId: string; firedAt: string; title: string }) => void) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(ROUTINES.runningStarted, listener);
    return () => ipcRenderer.removeListener(ROUTINES.runningStarted, listener);
  },
  onRoutineRunningFinished: (handler: (routineId: string) => void) => {
    const listener = (_e: unknown, id: string) => handler(id);
    ipcRenderer.on(ROUTINES.runningFinished, listener);
    return () => ipcRenderer.removeListener(ROUTINES.runningFinished, listener);
  },
  // failed: emitted when the routine LLM session throws (e.g. provider error).
  // Without this bridge the renderer never learns the session failed and the
  // running OverlayItem stays stuck with running:true indefinitely.
  onRoutineFailed: (handler: (event: { routineId: string; error: string }) => void) => {
    const listener = (_e: unknown, payload: { routineId: string; error: string }) => handler(payload);
    ipcRenderer.on(ROUTINES.failed, listener);
    return () => ipcRenderer.removeListener(ROUTINES.failed, listener);
  },
  // Routine session history — unified conversation sessions scoped by routineId
  listRoutineSessions: async (routineId: string, limit?: number) =>
    ipcRenderer.invoke(ROUTINES.listSessions, routineId, limit) as Promise<
      Array<{ routineId: string; firedAt: string; sessionId: string; title: string; preview: string }>
    >,

  // ─── Work Board ──────────────────────────────────
  // Personal board CRUD + lifecycle. Each method maps 1:1 to a WORK_BOARD.*
  // channel; the main-process store returns discriminated `status` envelopes
  // (or `{ ok:false, error }` for unauthorized-frame / no-store), forwarded
  // verbatim — no fallback / re-shaping. Shared payload + result types come
  // from the renderer-safe `shared/work-board-types.js` (no Node built-ins).
  listWorkBoard: async (filter?: import("../shared/work-board-types.js").WorkItemListFilter) =>
    ipcRenderer.invoke(WORK_BOARD.list, filter) as Promise<
      | import("../shared/work-board-types.js").WorkItemListResult
      | { ok: false; error: string }
    >,
  getWorkBoardItem: async (id: number) =>
    ipcRenderer.invoke(WORK_BOARD.get, id) as Promise<
      | import("../shared/work-board-types.js").WorkItemGetResult
      | { ok: false; error: string }
    >,
  addWorkBoardItem: async (input: import("../shared/work-board-types.js").WorkItemCreateInput) =>
    ipcRenderer.invoke(WORK_BOARD.add, input) as Promise<
      | import("../shared/work-board-types.js").WorkItemCreateResult
      | { ok: false; error: string }
    >,
  updateWorkBoardItem: async (id: number, patch: import("../shared/work-board-types.js").WorkItemUpdateInput) =>
    ipcRenderer.invoke(WORK_BOARD.update, id, patch) as Promise<
      | import("../shared/work-board-types.js").WorkItemUpdateResult
      | { ok: false; error: string }
    >,
  transitionWorkBoardItem: async (id: number, to: import("../shared/work-board-types.js").WorkItemStatusStored) =>
    ipcRenderer.invoke(WORK_BOARD.transition, id, to) as Promise<
      | import("../shared/work-board-types.js").WorkItemTransitionResult
      | { ok: false; error: string }
    >,
  completeWorkBoardItem: async (id: number) =>
    ipcRenderer.invoke(WORK_BOARD.complete, id) as Promise<
      | import("../shared/work-board-types.js").WorkItemCompleteResult
      | { ok: false; error: string }
    >,
  reopenWorkBoardItem: async (id: number) =>
    ipcRenderer.invoke(WORK_BOARD.reopen, id) as Promise<
      | import("../shared/work-board-types.js").WorkItemReopenResult
      | { ok: false; error: string }
    >,
  removeWorkBoardItem: async (id: number) =>
    ipcRenderer.invoke(WORK_BOARD.remove, id) as Promise<
      | import("../shared/work-board-types.js").WorkItemDeleteResult
      | { ok: false; error: string }
    >,
  // Board view live refresh: emitted by the work-board IPC domain after any
  // successful mutation (created/updated/transitioned/completed/reopened/
  // removed) so the renderer board view re-lists without polling.
  onWorkBoardItemChanged: (
    handler: (payload: import("../shared/work-board-types.js").WorkItemChangedEventPayload) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.itemChanged, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.itemChanged, listener);
  },
  // Agent-orchestration run: kick off plan→approve→execute for one item. The
  // promise resolves with the terminal WorkItemRunResult, but live phase
  // updates flow over onWorkBoardRunProgress; coarse started/finished/failed
  // markers (for the per-item running indicator) flow over the on* siblings.
  // `opts.agentName` selects a named agent profile (drives the child model).
  runWorkBoardItem: async (id: number, opts?: { agentName?: string }) =>
    ipcRenderer.invoke(WORK_BOARD.run, id, opts) as Promise<
      | import("../shared/work-board-types.js").WorkItemRunResult
      | { ok: false; error: string }
    >,
  // Generate a daily / weekly personal work report from the board state +
  // activity log + learned memory. Resolves with the report markdown (ok),
  // an empty-period envelope, an error envelope (LLM failure), or no-reporter.
  generateWorkBoardReport: async (
    kind: "daily" | "weekly",
    input?: { date?: string; weekIso?: string; weekOffset?: number; projectRoot?: string; includeUnscoped?: boolean },
  ) =>
    ipcRenderer.invoke(WORK_BOARD.generateReport, kind, input) as Promise<
      | import("../shared/work-board-types.js").WorkBoardReportResult
      | { ok: false; error: string }
    >,
  // Run the daily / weekly briefing: a read-only sub-agent survey of the user's
  // work whose findings are filed onto the board as proposals. Resolves with
  // the ids of the cards it wrote (ok), a nothing-found envelope, an error
  // envelope, or no-engine.
  runWorkBoardBriefing: async (
    kind: import("../shared/work-board-types.js").WorkBoardBriefingKind,
    projectRoot?: string,
  ) =>
    ipcRenderer.invoke(WORK_BOARD.runBriefing, kind, projectRoot) as Promise<
      | import("../shared/work-board-types.js").WorkBoardBriefingResult
      | { ok: false; error: string }
    >,
  // ─── Recommended work (plugin-proposed cards) ────
  // Read the open proposals, promote one into a work item, or close it. There
  // is no renderer path that CREATES a proposal — a proposal is a plugin's
  // claim, and the user's own additions are ordinary work items.
  listWorkProposals: async () =>
    ipcRenderer.invoke(WORK_BOARD.listProposals) as Promise<
      | import("../shared/work-board-types.js").WorkProposalListResult
      | { ok: false; error: string }
    >,
  acceptWorkProposal: async (proposalId: string, projectRoot?: string) =>
    ipcRenderer.invoke(WORK_BOARD.acceptProposal, proposalId, projectRoot) as Promise<
      | import("../shared/work-board-types.js").WorkProposalAcceptResult
      | { ok: false; error: string }
    >,
  dismissWorkProposal: async (proposalId: string) =>
    ipcRenderer.invoke(WORK_BOARD.dismissProposal, proposalId) as Promise<
      | import("../shared/work-board-types.js").WorkProposalDismissResult
      | { ok: false; error: string }
    >,
  onWorkProposalChanged: (
    handler: (payload: import("../shared/work-board-types.js").WorkProposalChangedEventPayload) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.proposalChanged, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.proposalChanged, listener);
  },
  // Read a past run's persisted transcript (plan+execute conversation) for the
  // run-history view. Resolves with the ordered events (empty when absent).
  getWorkBoardRunTranscript: async (itemId: number, runId: string) =>
    ipcRenderer.invoke(WORK_BOARD.runTranscript, itemId, runId) as Promise<
      | { events: import("../shared/work-board-types.js").RunTranscriptEvent[] }
      | { ok: false; error: string }
    >,
  // Live per-phase progress for an in-flight run (planning / awaiting_approval /
  // executing / denied / done / error). Payload === the engine's
  // WorkBoardRunEvent (aliased as RunProgressEventPayload).
  onWorkBoardRunProgress: (
    handler: (payload: import("../shared/work-board-types.js").RunProgressEventPayload) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runProgress, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runProgress, listener);
  },
  // Coarse marker: a run started for `itemId` (renderer sets the running flag).
  onWorkBoardRunStarted: (
    handler: (payload: { itemId: number; at: string }) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runStarted, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runStarted, listener);
  },
  // Coarse marker: a run finished for `itemId` with a terminal status (renderer
  // clears the running flag). `status` mirrors WorkItemRunResult.status.
  onWorkBoardRunFinished: (
    handler: (payload: {
      itemId: number;
      status: "completed" | "denied" | "not_found" | "error" | "already_running";
      at: string;
    }) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runFinished, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runFinished, listener);
  },
  // Coarse marker: the engine threw before producing a result (renderer clears
  // the running flag and surfaces `reason`).
  onWorkBoardRunFailed: (
    handler: (payload: { itemId: number; reason: string; at: string }) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runFailed, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runFailed, listener);
  },

  // Overlay IPC bridges (main → renderer push)
  onOverlayShow: (handler: Parameters<LvisApi["onOverlayShow"]>[0]) => {
    const listener = (_e: unknown, item: Parameters<typeof handler>[0]) => handler(item);
    ipcRenderer.on(OVERLAY_V1.show, listener);
    return () => ipcRenderer.removeListener(OVERLAY_V1.show, listener);
  },
  onOverlayUpdate: (handler: Parameters<LvisApi["onOverlayUpdate"]>[0]) => {
    const listener = (_e: unknown, id: string, patch: Parameters<typeof handler>[1]) => handler(id, patch);
    ipcRenderer.on(OVERLAY_V1.update, listener);
    return () => ipcRenderer.removeListener(OVERLAY_V1.update, listener);
  },
  onOverlayDismiss: (handler: (id: string) => void) => {
    const listener = (_e: unknown, id: string) => handler(id);
    ipcRenderer.on(OVERLAY_V1.dismiss, listener);
    return () => ipcRenderer.removeListener(OVERLAY_V1.dismiss, listener);
  },

  // session_tasks — assistant's current-turn checklist
  listSessionTasks: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.sessionTasks.list, sessionId),
  clearSessionTasks: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.sessionTasks.clear, sessionId),
  onSessionTasksChanged: (
    handler: (payload: {
      sessionId: string;
      items: SessionTaskItem[];
    }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on(CHANNELS.sessionTasks.changed, listener);
    return () => ipcRenderer.removeListener(CHANNELS.sessionTasks.changed, listener);
  },

  // session_goal — the objective this session is working towards
  getSessionGoal: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.sessionGoal.get, sessionId),
  pauseSessionGoal: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.sessionGoal.pause, sessionId),
  resumeSessionGoal: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.sessionGoal.resume, sessionId),
  clearSessionGoal: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.sessionGoal.clear, sessionId),
  onSessionGoalChanged: (
    handler: (payload: { sessionId: string; goal: SessionGoal | null }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on(CHANNELS.sessionGoal.changed, listener);
    return () => ipcRenderer.removeListener(CHANNELS.sessionGoal.changed, listener);
  },

  // agent_spawn — sub-agent lifecycle event stream
  onAgentSpawnEvent: (
    handler: (event: AgentSpawnEvent<ChatEntry>) => void,
  ) => {
    const listener = (_e: unknown, ev: Parameters<typeof handler>[0]) => handler(ev);
    ipcRenderer.on(CHANNELS.agentSpawn.event, listener);
    return () => ipcRenderer.removeListener(CHANNELS.agentSpawn.event, listener);
  },

  // skill_load — chat-side badge event
  onSkillLoaded: (
    handler: (event: {
      name: string;
      description: string;
      sessionId: string;
    }) => void,
  ) => {
    const listener = (_e: unknown, ev: Parameters<typeof handler>[0]) => handler(ev);
    ipcRenderer.on(CHANNELS.skillLoad.event, listener);
    return () => ipcRenderer.removeListener(CHANNELS.skillLoad.event, listener);
  },

  // ─── Notifications (#260) ────────────────────────
  // Main process pushes in-app toast payloads when the window is focused;
  // OS notifications fire when backgrounded/minimized. Renderer also signals
  // back when an in-app toast / OS notification is clicked so main can focus
  // the window and the renderer can scroll/navigate to the source surface.
  onNotificationToast: (handler: (payload: NotificationToastPayload) => void) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on(CHANNELS.notification.toast, listener);
    return () => ipcRenderer.removeListener(CHANNELS.notification.toast, listener);
  },
  onNotificationClicked: (handler: (payload: NotificationClickPayload) => void) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on(CHANNELS.notification.clicked, listener);
    return () => ipcRenderer.removeListener(CHANNELS.notification.clicked, listener);
  },
  notifyClick: async (payload: NotificationClickPayload) =>
    ipcRenderer.invoke(CHANNELS.notification.clicked, payload),

  // ─── Main-window management ──────────────────────────────────────────────
  window: {
    /**
     * Resize the main window to match the current workspace mode.
     * "work" → centered work canvas on the primary work area;
     * "chat" → the right-docked initial bounds (computeInitialMainWindowBounds).
     */
    resizeForMode: async (mode: "chat" | "work") =>
      ipcRenderer.invoke(CHANNELS.window.resizeForMode, mode) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    /**
     * Resize the chat-mode main window for the right-side work panel. Opening
     * adds side-panel width; closing restores the normal chat bounds.
     */
    resizeForSidePanel: async (open: boolean) =>
      ipcRenderer.invoke(CHANNELS.window.resizeForSidePanel, open) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    /** Open a render_html result in an isolated BrowserWindow. */
    openHtmlPreview: async (payload: OpenHtmlPreviewWindowPayload) =>
      ipcRenderer.invoke(CHANNELS.window.openHtmlPreview, payload) as Promise<OpenHtmlPreviewWindowResult>,
  },

  /**
   * Dev tools bridge — only useful in non-production builds. Renderer
   * floating panel uses this to adjust the token preflight threshold
   * at runtime (so compact scenarios can be reproduced without filling
   * the actual model context window).
   */
  dev: {
    setPreflightOverride: async (tokens: number | null) =>
      ipcRenderer.invoke(CHANNELS.dev.setPreflightOverride, tokens) as Promise<
        { ok: true; value: number | null } | { ok: false; error: string }
      >,
    getPreflightStatus: async () =>
      ipcRenderer.invoke(CHANNELS.dev.getPreflightStatus) as Promise<
        | { ok: true; runtimeOverride: number | null; envOverride: number | null; effective: number; provider: string; model: string }
        | { ok: false; error: string }
      >,
  },
  } satisfies Partial<LvisApi>;
}
