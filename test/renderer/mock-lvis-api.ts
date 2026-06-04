/**
 * Mockable LvisApi surface for renderer tests.
 *
 * Every method is a `vi.fn()` so tests can spy on calls, and the default
 * return values are sensible empty/pass values so <App /> can mount without
 * crashing.
 */
import { vi, type Mock } from "vitest";
import { fakeLlmSettings } from "../../src/shared/__tests__/fake-llm-settings.js";
import type { StreamEvent } from "../../src/lib/chat-stream-state.js";

export type MockLvisApi = Record<string, Mock>;

type HistoryMock = {
  sessionId?: string;
  sessionTitle?: string;
  sessionKind?: "main" | "routine";
  messages: unknown[];
};

type ApiOverrides = {
  settings?: unknown;
  personaPrompts?: unknown[];
  sessions?: Array<{
    id: string;
    modifiedAt: string;
    title?: string;
    sessionKind?: "main" | "routine";
    routineId?: string;
    routineTitle?: string;
    routineFiredAt?: string;
  }>;
  currentSession?: string;
  starred?: unknown[];
  history?: ({ sessionId: string } & HistoryMock) | Promise<{ sessionId: string } & HistoryMock>;
  historyBySession?: Record<string, HistoryMock | Promise<HistoryMock>>;
  hasApiKey?: boolean;
  hasProvider?: boolean;
  usage?: unknown;
  appInfo?: unknown;
  marketplacePing?: unknown;
  agentProfiles?: unknown;
  skills?: unknown;
  pluginCards?: unknown[];
  marketplace?: unknown[];
  pluginUiExtensions?: unknown[];
  latestRoutineResult?: unknown;
  pendingRoutineResults?: unknown[];
  routineSessionsByRoutine?: Record<string, unknown[]>;
  memoryIndex?: string;
  mainActiveState?: {
    mainActiveSessionId: string | null;
    mainActiveMode: "resume" | "fresh";
    updatedAt: string;
  } | null;
};

const DEFAULT_SETTINGS = {
  llm: fakeLlmSettings({ provider: "openai", model: "gpt-4o-mini" }),
  chat: { systemPrompt: "", autoCompact: true },
  webSearch: { provider: "none" },
  routine: {},
  privacy: { piiRedactEnabled: false },
  // Z onboarding chain — mark the seed user as already past onboarding so
  // the first-boot probe dispatches `probe-skip` and the chain advances
  // straight to `done`. Without this, the chain stays at the new default
  // initial stage ("showcase") and masks the ChatView empty-state branch
  // that several tests rely on.
  features: { idlePreferenceRefresh: false, onboardingCompleted: true },
};

const DEFAULT_USAGE = {
  today: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
  thisWeek: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
  thisMonth: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
  perVendor: [],
  perModel: [],
  trend: [],
  topConversations: [],
  generatedAt: new Date().toISOString(),
};

const DEFAULT_APP_INFO = {
  version: "0.0.0-test",
  electronVersion: "0.0.0",
  nodeVersion: "0.0.0",
  chromeVersion: "0.0.0",
  v8Version: "0.0.0",
  platform: "test",
  arch: "x64",
  userDataPath: "/tmp/lvis-test-user-data",
};

export function makeMockLvisApi(overrides: ApiOverrides = {}): {
  api: MockLvisApi;
  emitChatStream: (ev: StreamEvent) => void;
  emitOverlayShow: (item: unknown) => void;
  emitOverlayDismiss: (id: string) => void;
  emitRoutineFiredV2: (r: unknown) => void;
  emitViewActivate: (v: string) => void;
  emitAskUserQuestion: (r: unknown) => void;
  emitTourStart: (scenarioId: string) => void;
  emitBootstrapStatus: (status: unknown) => void;
  emitPluginInstallProgress: (payload: unknown) => void;
  emitPluginInstallResult: (payload: unknown) => void;
  emitPluginRuntimeUpdated: (payload: { pluginId: string }) => void;
} {
  let settings = overrides.settings ?? DEFAULT_SETTINGS;
  let personaPrompts = overrides.personaPrompts ?? [];
  const sessions = (overrides.sessions ?? []).map((session) => ({
    ...session,
    title: session.title ?? `세션 ${session.id.slice(0, 8)}`,
    sessionKind: session.sessionKind ?? "main",
  }));
  const currentSession = overrides.currentSession ?? "sess-default";
  const starred = overrides.starred ?? [];
  const history = overrides.history ?? { sessionId: currentSession, messages: [] };
  const historyBySession = overrides.historyBySession ?? {};
  const hasApiKey = overrides.hasApiKey ?? true;
  const hasProvider = overrides.hasProvider ?? true;
  const usage = overrides.usage ?? DEFAULT_USAGE;
  const appInfo = overrides.appInfo ?? DEFAULT_APP_INFO;
  const marketplacePing = overrides.marketplacePing ?? { configured: true, online: true };
  const agentProfiles = overrides.agentProfiles ?? { agents: [] };
  const skills = overrides.skills ?? { skills: [] };
  const pluginCards = overrides.pluginCards ?? [];
  const marketplace = overrides.marketplace ?? [];
  const pluginUiExtensions = overrides.pluginUiExtensions ?? [];
  const latestRoutineResult = overrides.latestRoutineResult ?? null;
  const pendingRoutineResults = overrides.pendingRoutineResults ?? [];
  const routineSessionsByRoutine = overrides.routineSessionsByRoutine ?? {};
  const memoryIndex = overrides.memoryIndex ?? "";
  const mainActiveState = overrides.mainActiveState ?? {
    mainActiveSessionId: null,
    mainActiveMode: "fresh" as const,
    updatedAt: new Date().toISOString(),
  };

  const chatStreamHandlers = new Set<(ev: StreamEvent) => void>();
  const overlayShowHandlers = new Set<(item: unknown) => void>();
  const overlayDismissHandlers = new Set<(id: string) => void>();
  const routineFiredV2Handlers = new Set<(r: unknown) => void>();
  const viewHandlers = new Set<(v: string) => void>();
  const settingsUpdatedHandlers = new Set<(settings: unknown) => void>();
  const settingsWindowSavedHandlers = new Set<() => void>();
  const personaPromptsUpdatedHandlers = new Set<() => void>();
  const settingsWindowTabHandlers = new Set<(tab: string) => void>();
  const askUserQuestionHandlers = new Set<(r: unknown) => void>();
  const tourStartHandlers = new Set<(payload: { scenarioId: string }) => void>();
  const bootstrapStatusHandlers = new Set<(status: unknown) => void>();
  const pluginInstallProgressHandlers = new Set<(payload: unknown) => void>();
  const pluginInstallResultHandlers = new Set<(payload: unknown) => void>();
  const pluginRuntimeUpdatedHandlers = new Set<(payload: { pluginId: string }) => void>();
  const sessionTodoHandlers = new Set<(payload: unknown) => void>();

  const api: MockLvisApi = {
    notifyPluginTheme: vi.fn(async () => ({ ok: true })),
    tour: {
      getState: vi.fn(async () => ({
        ok: true,
        state: {
          lastSeenScenario: null,
          completedScenarios: [],
          dismissedAt: null,
        },
      })),
      markComplete: vi.fn(async () => ({ ok: true })),
      dismiss: vi.fn(async () => ({ ok: true })),
      start: vi.fn(async (scenarioId: string) => ({ ok: true, scenarioId })),
      onStart: vi.fn((handler: (payload: { scenarioId: string }) => void) => {
        tourStartHandlers.add(handler);
        return () => tourStartHandlers.delete(handler);
      }),
    },
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (p: unknown) => {
      settings = { ...(settings as object), ...(p as object) };
      settingsUpdatedHandlers.forEach((handler) => handler(settings));
      return settings;
    }),
    onSettingsUpdated: vi.fn((handler: (settings: unknown) => void) => {
      settingsUpdatedHandlers.add(handler);
      return () => settingsUpdatedHandlers.delete(handler);
    }),
    listPersonaPromptSummaries: vi.fn(async () => ({
      prompts: personaPrompts.map((item) => ({
        id: (item as { id?: string }).id ?? "",
        name: (item as { name?: string }).name ?? "",
      })),
    })),
    listPersonaPrompts: vi.fn(async () => ({ prompts: personaPrompts })),
    savePersonaPrompt: vi.fn(async (prompt: { id: string; name: string; systemPromptAdd: string }) => {
      personaPrompts = [
        ...personaPrompts.filter((item) => (item as { id?: unknown }).id !== prompt.id),
        prompt,
      ];
      personaPromptsUpdatedHandlers.forEach((handler) => handler());
      return { ok: true, prompt };
    }),
    deletePersonaPrompt: vi.fn(async (id: string) => {
      const before = personaPrompts.length;
      personaPrompts = personaPrompts.filter((item) => (item as { id?: unknown }).id !== id);
      personaPromptsUpdatedHandlers.forEach((handler) => handler());
      return { ok: true, deleted: personaPrompts.length !== before };
    }),
    onPersonaPromptsUpdated: vi.fn((handler: () => void) => {
      personaPromptsUpdatedHandlers.add(handler);
      return () => personaPromptsUpdatedHandlers.delete(handler);
    }),
    setApiKey: vi.fn(async () => ({ ok: true })),
    hasApiKey: vi.fn(async () => hasApiKey),
    deleteApiKey: vi.fn(async () => ({ ok: true })),
    setWebApiKey: vi.fn(async () => ({ ok: true })),
    hasWebApiKey: vi.fn(async () => false),
    deleteWebApiKey: vi.fn(async () => ({ ok: true })),
    setMarketplaceApiKey: vi.fn(async () => ({ ok: true })),
    hasMarketplaceApiKey: vi.fn(async () => false),
    deleteMarketplaceApiKey: vi.fn(async () => ({ ok: true })),
    demo: {
      status: vi.fn(async () => ({ active: false })),
      activate: vi.fn(async () => ({ ok: true })),
      relaunchAfterActivation: vi.fn(async () => ({ ok: true })),
      clearDemo: vi.fn(async () => ({ ok: true })),
    },
    openSettingsWindow: vi.fn(async (initialTab?: string) => {
      if (initialTab) settingsWindowTabHandlers.forEach((handler) => handler(initialTab));
      return { ok: true, windowId: 2 };
    }),
    notifySettingsWindowSaved: vi.fn(async () => {
      settingsWindowSavedHandlers.forEach((handler) => handler());
      return { ok: true };
    }),
    onSettingsWindowSaved: vi.fn((handler: () => void) => {
      settingsWindowSavedHandlers.add(handler);
      return () => settingsWindowSavedHandlers.delete(handler);
    }),
    onSettingsWindowTab: vi.fn((handler: (tab: string) => void) => {
      settingsWindowTabHandlers.add(handler);
      return () => settingsWindowTabHandlers.delete(handler);
    }),
    listMcpCatalog: vi.fn(async () => []),
    installMcpFromMarketplace: vi.fn(async (slug: string) => ({
      ok: true,
      slug,
      installDir: `/tmp/mcp-servers/${slug}`,
      connected: true,
      needsCredential: false,
      authMode: "none" as const,
    })),
    previewClaudeDesktopMcpImport: vi.fn(async () => ({ entries: [], errors: [] })),
    applyClaudeDesktopMcpImport: vi.fn(async () => ({ ok: true, results: [], parseErrors: [] })),
    permission: {
      getMode: vi.fn(async () => ({ mode: "default" })),
      setMode: vi.fn(async (mode: string) => ({ ok: true, mode })),
      onModeChanged: vi.fn(() => () => undefined),
      listRules: vi.fn(async () => []),
      addRule: vi.fn(async () => ({ ok: true })),
      removeRule: vi.fn(async () => ({ ok: true })),
      deferredList: vi.fn(async () => ({ ok: true, pending: [], total: 0 })),
      deferredResolve: vi.fn(async () => ({ ok: true })),
      onDeferredPending: vi.fn(() => () => undefined),
      hookTrustList: vi.fn(async () => ({ ok: true, active: [], disabled: [], totalDisabled: 0 })),
      dirDispatch: vi.fn(async () => ({ ok: true, verb: "list", defaults: [], userAdditions: [], effective: [] })),
      reviewerDispatch: vi.fn(async () => ({
        ok: true,
        verb: "show",
        settings: {
          mode: "disabled",
          provider: "openai",
          model: "gpt-4o-mini",
          fallbackOnError: "deny",
        },
      })),
      auditShow: vi.fn(async () => ({ ok: true, entries: [], total: 0, summary: { files: 0, bytes: 0 } })),
      auditVerify: vi.fn(async () => ({ ok: true, intact: true, totalFiles: 0, totalEntries: 0, perDay: [] })),
      onManifestViolation: vi.fn(() => () => undefined),
      onUserApprovalHit: vi.fn(() => () => undefined),
    },
    policy: {
      get: vi.fn(async () => ({
        version: 1,
        requireExplicitApproval: false,
        managed: false,
        updatedAt: new Date().toISOString(),
        source: "defaults",
      })),
      set: vi.fn(async () => ({ ok: true })),
    },

    chatHasProvider: vi.fn(async () => hasProvider),
    captureUserKeyboardIntent: vi.fn(() => ({ inputOrigin: "user-keyboard", token: "mock-user-intent" })),
    chatSend: vi.fn(async () => ({ ok: true })),
    chatGuide: vi.fn(async () => ({ ok: true })),
    chatNew: vi.fn(async () => ({ ok: true })),
    chatSessions: vi.fn(async (opts?: { kind?: "main" | "routine" | "all"; routineId?: string; limit?: number; before?: string; beforeId?: string; after?: string }) => {
      const beforeTime = opts?.before ? Date.parse(opts.before) : Number.NaN;
      const afterTime = opts?.after ? Date.parse(opts.after) : Number.NaN;
      const filtered = sessions.filter((session) => {
        const kind = opts?.kind ?? "main";
        if (kind !== "all" && session.sessionKind !== kind) return false;
        if (opts?.routineId && session.routineId !== opts.routineId) return false;
        const t = Date.parse(session.modifiedAt);
        if (!Number.isNaN(afterTime) && t < afterTime) return false;
        if (Number.isNaN(beforeTime)) return true;
        if (t < beforeTime) return true;
        return t === beforeTime && opts?.beforeId !== undefined && session.id < opts.beforeId;
      });
      return {
        current: currentSession,
        sessions: filtered.slice(0, opts?.limit ?? 20),
      };
    }),
    chatSessionResume: vi.fn(async (id: string) => ({ ok: true, compacted: false, compactedAt: null, removedMessageCount: 0 })),
    chatCompact: vi.fn(async () => ({ compacted: false, compactedAt: null, summary: "불필요", removedMessageCount: 0 })),
    chatMainActiveState: vi.fn(async () => mainActiveState),
    chatGetHistory: vi.fn(async () => history),
    chatSessionHistory: vi.fn(async (sessionId: string) => {
      const sessionHistory = historyBySession[sessionId];
      if (sessionHistory) {
        const resolvedSessionHistory = await sessionHistory;
        return {
          ok: true,
          sessionKind: resolvedSessionHistory.sessionKind ?? "main",
          sessionTitle: resolvedSessionHistory.sessionTitle,
          messages: resolvedSessionHistory.messages,
        };
      }
      const resolvedHistory = await history;
      return {
        ok: true,
        sessionKind: resolvedHistory.sessionKind ?? "main",
        sessionTitle: resolvedHistory.sessionTitle,
        messages: resolvedHistory.messages,
      };
    }),
    chatEditResend: vi.fn(async () => ({ ok: true })),
    chatFork: vi.fn(async () => ({ ok: true, sessionId: currentSession })),
    // Shapes match actual preload/IPC return types exactly — discriminated union:
    // success paths have no `ok` field (enter → { messageIndexAtCreation }, branch → { newSessionId, ...branchState });
    // error paths return { error: string }. IPC may also return UNAUTHORIZED_FRAME { ok: false, error }.
    chatEnterCheckpointView: vi.fn(async (_sessionId: string, _compactNum: number) => ({ messageIndexAtCreation: 5 })),
    chatExitCheckpointView: vi.fn(async () => ({ ok: true })),
    chatBranchFromCheckpoint: vi.fn(async (_sessionId: string, _compactNum: number) => ({
      newSessionId: "sess-branch-1",
      lastMessageRole: "assistant",
      shouldAutoContinue: false,
    })),
    chatContinueLastUser: vi.fn(async (_sessionId: string) => ({ ok: true })),
    chatRetryEffort: vi.fn(async () => ({ ok: true })),
    chatExport: vi.fn(async () => ({ ok: true, filePath: "/tmp/out.md" })),
    listSessionTodos: vi.fn(async () => []),
    clearSessionTodos: vi.fn(async () => ({ ok: true })),
    onSessionTodoChanged: vi.fn((handler: (payload: unknown) => void) => {
      sessionTodoHandlers.add(handler);
      return () => sessionTodoHandlers.delete(handler);
    }),
    onChatStream: vi.fn((h: (ev: StreamEvent) => void) => {
      chatStreamHandlers.add(h);
      return () => chatStreamHandlers.delete(h);
    }),
    onChatFallback: vi.fn((_h: (payload: { from: string; to: string }) => void) => () => {}),

    starredList: vi.fn(async () => starred),
    listStarred: vi.fn(async () => starred),
    addStarred: vi.fn(async (entry: unknown) => ({ ok: true, entry })),
    removeStarred: vi.fn(async () => ({ ok: true })),

    memoryListNotes: vi.fn(async () => []),
    memorySaveNote: vi.fn(async () => ({ ok: true })),
    memoryDeleteNote: vi.fn(async () => undefined),
    memorySearchNotes: vi.fn(async () => []),
    memoryListEntries: vi.fn(async () => []),
    memorySaveEntry: vi.fn(async () => ({ ok: true })),
    memoryDeleteEntry: vi.fn(async () => undefined),
    memorySearchEntries: vi.fn(async () => []),
    memoryGetIndex: vi.fn(async () => memoryIndex),
    memoryUpdateIndexIfUnchanged: vi.fn(async () => true),
    memoryUpdateIndexSections: vi.fn(async () => ({ ok: true })),
    memoryListSessions: vi.fn(async () => []),
    memorySearchSessions: vi.fn(async () => []),
    memoryGetAgentsMd: vi.fn(async () => "# Agents"),
    memoryUpdateAgentsMd: vi.fn(async () => undefined),
    memoryGetUserPrefs: vi.fn(async () => "# Preferences"),
    memoryUpdateUserPrefs: vi.fn(async () => undefined),
    memoryRefreshUserPrefs: vi.fn(async () => ({ ok: true, content: "# Refreshed Preferences" })),

    listMarketplacePlugins: vi.fn(async () => marketplace),
    pingMarketplace: vi.fn(async () => marketplacePing),
    installMarketplacePlugin: vi.fn(async () => ({ ok: true })),
    uninstallMarketplacePlugin: vi.fn(async () => ({ ok: true })),
    // Marketplace agent/skill surface. Settings/dashboard tests still read
    // these counts even though the composer no longer injects them per turn.
    listAgentProfiles: vi.fn(async () => agentProfiles),
    listSkills: vi.fn(async () => skills),
    installAgentFromMarketplace: vi.fn(async (slug: string) => ({
      ok: true as const,
      slug,
      agentId: `mock-agent-${slug}`,
      version: "0.0.0",
    })),
    uninstallAgentPackage: vi.fn(async (slug: string) => ({
      ok: true as const,
      slug,
      agentId: `mock-agent-${slug}`,
    })),
    installSkillFromMarketplace: vi.fn(async (slug: string) => ({
      ok: true as const,
      slug,
      skillId: `mock-skill-${slug}`,
      version: "0.0.0",
    })),
    uninstallSkillPackage: vi.fn(async (slug: string) => ({
      ok: true as const,
      slug,
      skillId: `mock-skill-${slug}`,
    })),
    onAgentInstallResult: vi.fn(() => () => {}),
    onAgentUninstallResult: vi.fn(() => () => {}),
    onSkillInstallResult: vi.fn(() => () => {}),
    onSkillUninstallResult: vi.fn(() => () => {}),
    listPluginUiExtensions: vi.fn(async () => pluginUiExtensions),
    listPluginCards: vi.fn(async () => pluginCards),
    callPluginMethod: vi.fn(async () => ({ ok: true })),
    openExternalUrl: vi.fn(async () => ({ ok: true })),
    window: {
      openDetached: vi.fn(async () => ({ ok: true, windowId: 1 })),
      closeDetached: vi.fn(async () => ({ ok: true })),
      listDetached: vi.fn(async () => []),
      openHtmlPreview: vi.fn(async () => ({ ok: true, windowId: 2 })),
      onSnapEdge: vi.fn(() => () => {}),
      onDetachedNavigate: vi.fn(() => () => {}),
      loadSessionInMain: vi.fn(async () => ({ ok: true })),
      onLoadSessionInMain: vi.fn(() => () => {}),
    },

    getRecentNotes: vi.fn(async () => []),

    getUsageSummary: vi.fn(async () => usage),
    getAppInfo: vi.fn(async () => appInfo),
    // Routine v2 API
    listRoutinesV2: vi.fn(async () => []),
    dismissRoutineV2: vi.fn(async () => ({ ok: true })),
    removeRoutineV2: vi.fn(async () => ({ ok: true })),
    triggerRoutineNowV2: vi.fn(async () => ({ ok: true })),
    listPendingRoutineResultsV2: vi.fn(async () => pendingRoutineResults),
    acknowledgeRoutineResultV2: vi.fn(async () => ({ ok: true })),
    addRoutineV2: vi.fn(async () => ({ ok: true, routine: {} })),
    onRoutineFiredV2: vi.fn((h: (r: unknown) => void) => {
      routineFiredV2Handlers.add(h);
      // Replay latestRoutineResult on subscription (simulates mount-time catchup).
      if (latestRoutineResult !== null) {
        Promise.resolve(latestRoutineResult).then((r) => {
          if (r !== null && r !== undefined) h(r);
        });
      }
      return () => routineFiredV2Handlers.delete(h);
    }),
    onRoutineRunningStarted: vi.fn((_h: (p: unknown) => void) => () => {}),
    onRoutineRunningFinished: vi.fn((_h: (id: string) => void) => () => {}),
    onRoutineFailedV2: vi.fn((_handler: (event: { routineId: string; error: string }) => void) => () => {}),
    listRoutineSessionsV2: vi.fn(async (routineId: string) => routineSessionsByRoutine[routineId] ?? []),
    // Overlay trigger lifecycle. Tests that don't exercise the
    // trigger card just need these to be callable subscribe/no-op functions.
    onTriggerStarted: vi.fn((_h: (p: unknown) => void) => () => {}),
    onTriggerCompleted: vi.fn((_h: (r: unknown) => void) => () => {}),
    onTriggerFailed: vi.fn((_h: (p: unknown) => void) => () => {}),
    onTriggerExpired: vi.fn((_h: (p: unknown) => void) => () => {}),
    onTriggerImported: vi.fn((_h: (p: unknown) => void) => () => {}),
    dismissTrigger: vi.fn(async () => ({ ok: true, removed: true })),
    importTrigger: vi.fn(async () => ({ ok: true, imported: 0 })),
    onOverlayShow: vi.fn((handler: (item: unknown) => void) => {
      overlayShowHandlers.add(handler);
      return () => overlayShowHandlers.delete(handler);
    }),
    onOverlayUpdate: vi.fn((_handler: (id: string, patch: unknown) => void) => () => {}),
    onOverlayDismiss: vi.fn((handler: (id: string) => void) => {
      overlayDismissHandlers.add(handler);
      return () => overlayDismissHandlers.delete(handler);
    }),

    onAskUserQuestion: vi.fn((h: (r: unknown) => void) => {
      askUserQuestionHandlers.add(h);
      return () => askUserQuestionHandlers.delete(h);
    }),
    onAskUserQuestionTimeout: vi.fn(() => () => {}),
    respondAskUserQuestion: vi.fn(async () => ({ ok: true })),

    submitFeedback: vi.fn(async () => ({ ok: true })),

    onViewActivate: vi.fn((h: (v: string) => void) => {
      viewHandlers.add(h);
      return () => viewHandlers.delete(h);
    }),

    onMarketplaceUpdatesAvailable: vi.fn(() => () => {}),
    onPluginInstallProgress: vi.fn((handler: (payload: unknown) => void) => {
      pluginInstallProgressHandlers.add(handler);
      return () => pluginInstallProgressHandlers.delete(handler);
    }),
    onPluginInstallResult: vi.fn((handler: (payload: unknown) => void) => {
      pluginInstallResultHandlers.add(handler);
      return () => pluginInstallResultHandlers.delete(handler);
    }),
    onPluginRuntimeUpdated: vi.fn((handler: (payload: { pluginId: string }) => void) => {
      pluginRuntimeUpdatedHandlers.add(handler);
      return () => pluginRuntimeUpdatedHandlers.delete(handler);
    }),
    onBootstrapStatus: vi.fn((handler: (status: unknown) => void) => {
      bootstrapStatusHandlers.add(handler);
      return () => bootstrapStatusHandlers.delete(handler);
    }),
    retryBootstrap: vi.fn(async () => ({ ok: true })),
    // App auto-update bridge — renderer's useAppUpdate hook subscribes
    // immediately at App mount, so the smoke test mock must define these
    // even when the suite doesn't exercise update flow.
    onAppUpdateState: vi.fn(() => () => {}),
    getAppUpdateState: vi.fn(async () => ({ kind: "idle" })),
    downloadAppUpdate: vi.fn(async () => ({ ok: true })),
    installAppUpdate: vi.fn(async () => ({ ok: true })),

    plugins: {
      getPerfStats: vi.fn(async () => ({})),
    },
  };

  api.starredAdd = api.addStarred;
  api.starredRemove = api.removeStarred;

  return {
    api,
    emitChatStream: (ev) => chatStreamHandlers.forEach((h) => h(ev)),
    emitOverlayShow: (item) => overlayShowHandlers.forEach((h) => h(item)),
    emitOverlayDismiss: (id) => overlayDismissHandlers.forEach((h) => h(id)),
    emitRoutineFiredV2: (r) => routineFiredV2Handlers.forEach((h) => h(r)),
    emitViewActivate: (v) => viewHandlers.forEach((h) => h(v)),
    emitAskUserQuestion: (r) => askUserQuestionHandlers.forEach((h) => h(r)),
    emitTourStart: (scenarioId) => tourStartHandlers.forEach((h) => h({ scenarioId })),
    emitBootstrapStatus: (status) => bootstrapStatusHandlers.forEach((h) => h(status)),
    emitPluginInstallProgress: (payload) => pluginInstallProgressHandlers.forEach((h) => h(payload)),
    emitPluginInstallResult: (payload) => pluginInstallResultHandlers.forEach((h) => h(payload)),
    emitPluginRuntimeUpdated: (payload) => pluginRuntimeUpdatedHandlers.forEach((h) => h(payload)),
  };
}

type LvisNamespaceOverrides = {
  env?: Partial<{
    isDev: boolean;
    isE2E: boolean;
    enableDevConsole: boolean;
    debugStream: boolean;
  }>;
};

export function makeMockLvisNamespace(overrides: LvisNamespaceOverrides = {}) {
  const approvalHandlers = new Set<(r: unknown) => void>();
  return {
    ns: {
      permission: {
        getMode: vi.fn(async () => ({ mode: "default" })),
        setMode: vi.fn(async (mode: string) => ({ ok: true, mode })),
        onModeChanged: vi.fn(() => () => undefined),
        listRules: vi.fn(async () => []),
        addRule: vi.fn(async () => ({ ok: true })),
        removeRule: vi.fn(async () => ({ ok: true })),
      },
      approval: {
        onRequest: vi.fn((cb: (r: unknown) => void) => {
          approvalHandlers.add(cb);
          return () => approvalHandlers.delete(cb);
        }),
        respond: vi.fn(async () => ({ ok: true })),
      },
      policy: {
        get: vi.fn(async () => ({
          version: 1,
          requireExplicitApproval: false,
          managed: false,
          updatedAt: new Date().toISOString(),
          source: "defaults",
        })),
        set: vi.fn(async () => ({ ok: true })),
      },
      env: {
        isDev: false,
        isE2E: false,
        enableDevConsole: false,
        debugStream: false,
        ...overrides.env,
      },
    },
    emitApproval: (r: unknown) => approvalHandlers.forEach((h) => h(r)),
  };
}
