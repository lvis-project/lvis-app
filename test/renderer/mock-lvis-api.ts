/**
 * Phase 1 — mockable LvisApi surface for renderer tests.
 *
 * Every method is a `vi.fn()` so tests can spy on calls, and the default
 * return values are sensible empty/pass values so <App /> can mount without
 * crashing.
 */
import { vi, type Mock } from "vitest";
import { fakeLlmSettings } from "../../src/shared/__tests__/fake-llm-settings.js";

export type MockLvisApi = Record<string, Mock>;

type ApiOverrides = {
  settings?: unknown;
  sessions?: Array<{ id: string; modifiedAt: string; title?: string }>;
  currentSession?: string;
  starred?: unknown[];
  history?: { sessionId: string; messages: unknown[] } | Promise<{ sessionId: string; messages: unknown[] }>;
  historyBySession?: Record<string, { messages: unknown[] } | Promise<{ messages: unknown[] }>>;
  hasApiKey?: boolean;
  hasProvider?: boolean;
  usage?: unknown;
  pluginCards?: unknown[];
  marketplace?: unknown[];
  pluginUiExtensions?: unknown[];
  latestRoutineResult?: unknown;
  pendingRoutineResults?: unknown[];
};

const DEFAULT_SETTINGS = {
  llm: fakeLlmSettings({ provider: "openai", model: "gpt-4o-mini" }),
  chat: { systemPrompt: "", autoCompact: true },
  webSearch: { provider: "none" },
  routine: {},
  privacy: { piiRedactEnabled: false },
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

export function makeMockLvisApi(overrides: ApiOverrides = {}): {
  api: MockLvisApi;
  emitChatStream: (ev: unknown) => void;
  emitRoutineFiredV2: (r: unknown) => void;
  emitViewActivate: (v: string) => void;
  emitAskUserQuestion: (r: unknown) => void;
} {
  const settings = overrides.settings ?? DEFAULT_SETTINGS;
  const sessions = (overrides.sessions ?? []).map((session) => ({
    ...session,
    title: session.title ?? `세션 ${session.id.slice(0, 8)}`,
  }));
  const currentSession = overrides.currentSession ?? "sess-default";
  const starred = overrides.starred ?? [];
  const history = overrides.history ?? { sessionId: currentSession, messages: [] };
  const historyBySession = overrides.historyBySession ?? {};
  const hasApiKey = overrides.hasApiKey ?? true;
  const hasProvider = overrides.hasProvider ?? true;
  const usage = overrides.usage ?? DEFAULT_USAGE;
  const pluginCards = overrides.pluginCards ?? [];
  const marketplace = overrides.marketplace ?? [];
  const pluginUiExtensions = overrides.pluginUiExtensions ?? [];
  const latestRoutineResult = overrides.latestRoutineResult ?? null;
  const pendingRoutineResults = overrides.pendingRoutineResults ?? [];

  const chatStreamHandlers = new Set<(ev: unknown) => void>();
  const routineFiredV2Handlers = new Set<(r: unknown) => void>();
  const viewHandlers = new Set<(v: string) => void>();
  const askUserQuestionHandlers = new Set<(r: unknown) => void>();

  const api: MockLvisApi = {
    notifyPluginTheme: vi.fn(async () => ({ ok: true })),
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (p: unknown) => ({ ...(settings as object), ...(p as object) })),
    setApiKey: vi.fn(async () => ({ ok: true })),
    hasApiKey: vi.fn(async () => hasApiKey),
    deleteApiKey: vi.fn(async () => ({ ok: true })),
    setWebApiKey: vi.fn(async () => ({ ok: true })),
    hasWebApiKey: vi.fn(async () => false),
    deleteWebApiKey: vi.fn(async () => ({ ok: true })),
    setMarketplaceApiKey: vi.fn(async () => ({ ok: true })),
    hasMarketplaceApiKey: vi.fn(async () => false),
    deleteMarketplaceApiKey: vi.fn(async () => ({ ok: true })),
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
    chatSend: vi.fn(async () => ({ ok: true })),
    chatGuide: vi.fn(async () => ({ ok: true })),
    chatNew: vi.fn(async () => ({ ok: true })),
    chatSessions: vi.fn(async (opts?: { limit?: number; before?: string; beforeId?: string; after?: string }) => {
      const beforeTime = opts?.before ? Date.parse(opts.before) : Number.NaN;
      const afterTime = opts?.after ? Date.parse(opts.after) : Number.NaN;
      const filtered = sessions.filter((session) => {
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
    chatLoadSession: vi.fn(async (id: string) => ({ ok: true, sessionId: id })),
    chatSessionResume: vi.fn(async (id: string) => ({ ok: true, compacted: false, compactedAt: null, removedMessageCount: 0 })),
    chatCompact: vi.fn(async () => ({ compacted: false, compactedAt: null, summary: "불필요", removedMessageCount: 0 })),
    chatGetHistory: vi.fn(async () => history),
    chatSessionHistory: vi.fn(async (sessionId: string) => {
      const sessionHistory = historyBySession[sessionId];
      if (sessionHistory) {
        const resolvedSessionHistory = await sessionHistory;
        return { ok: true, messages: resolvedSessionHistory.messages };
      }
      const resolvedHistory = await history;
      return { ok: true, messages: resolvedHistory.messages };
    }),
    chatEditResend: vi.fn(async () => ({ ok: true })),
    chatFork: vi.fn(async () => ({ ok: true, sessionId: currentSession })),
    // §PR-5: shapes match actual preload/IPC return types exactly — discriminated union:
    // success paths have no `ok` field (enter → { messageIndexAtCreation }, branch → { newSessionId });
    // error paths return { error: string }. IPC may also return UNAUTHORIZED_FRAME { ok: false, error }.
    chatEnterCheckpointView: vi.fn(async (_sessionId: string, _compactNum: number) => ({ messageIndexAtCreation: 5 })),
    chatExitCheckpointView: vi.fn(async () => ({ ok: true })),
    chatBranchFromCheckpoint: vi.fn(async (_sessionId: string, _compactNum: number) => ({ newSessionId: "sess-branch-1" })),
    chatRetryEffort: vi.fn(async () => ({ ok: true })),
    chatExport: vi.fn(async () => ({ ok: true, filePath: "/tmp/out.md" })),
    onChatStream: vi.fn((h: (ev: unknown) => void) => {
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
    memoryListSessions: vi.fn(async () => []),
    memorySearchSessions: vi.fn(async () => []),

    listMarketplacePlugins: vi.fn(async () => marketplace),
    installMarketplacePlugin: vi.fn(async () => ({ ok: true })),
    uninstallMarketplacePlugin: vi.fn(async () => ({ ok: true })),
    listPluginUiExtensions: vi.fn(async () => pluginUiExtensions),
    listPluginCards: vi.fn(async () => pluginCards),
    callPluginMethod: vi.fn(async () => ({ ok: true })),
    window: {
      openDetached: vi.fn(async () => ({ ok: true, windowId: 1 })),
      closeDetached: vi.fn(async () => ({ ok: true })),
      listDetached: vi.fn(async () => []),
      onSnapEdge: vi.fn(() => () => {}),
      onDetachedNavigate: vi.fn(() => () => {}),
    },

    getRecentNotes: vi.fn(async () => []),

    getUsageSummary: vi.fn(async () => usage),
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
    listRoutineSessionsV2: vi.fn(async () => []),
    readRoutineSessionV2: vi.fn(async () => ""),
    // Overlay trigger lifecycle. Tests that don't exercise the
    // trigger card just need these to be callable subscribe/no-op functions.
    onTriggerStarted: vi.fn((_h: (p: unknown) => void) => () => {}),
    onTriggerCompleted: vi.fn((_h: (r: unknown) => void) => () => {}),
    onTriggerFailed: vi.fn((_h: (p: unknown) => void) => () => {}),
    onTriggerExpired: vi.fn((_h: (p: unknown) => void) => () => {}),
    onTriggerImported: vi.fn((_h: (p: unknown) => void) => () => {}),
    dismissTrigger: vi.fn(async () => ({ ok: true, removed: true })),
    importTrigger: vi.fn(async () => ({ ok: true, imported: 0 })),

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
    onBootstrapStatus: vi.fn(() => () => {}),

    plugins: {
      getPerfStats: vi.fn(async () => ({})),
    },
  };

  api.starredAdd = api.addStarred;
  api.starredRemove = api.removeStarred;

  return {
    api,
    emitChatStream: (ev) => chatStreamHandlers.forEach((h) => h(ev)),
    emitRoutineFiredV2: (r) => routineFiredV2Handlers.forEach((h) => h(r)),
    emitViewActivate: (v) => viewHandlers.forEach((h) => h(v)),
    emitAskUserQuestion: (r) => askUserQuestionHandlers.forEach((h) => h(r)),
  };
}

export function makeMockLvisNamespace() {
  const approvalHandlers = new Set<(r: unknown) => void>();
  return {
    ns: {
      permission: {
        getMode: vi.fn(async () => ({ mode: "default" })),
        setMode: vi.fn(async (mode: string) => ({ ok: true, mode })),
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
        enableDevConsole: false,
        debugStream: false,
      },
    },
    emitApproval: (r: unknown) => approvalHandlers.forEach((h) => h(r)),
  };
}
