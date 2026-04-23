/**
 * Phase 1 — mockable LvisApi surface for renderer tests.
 *
 * Every method is a `vi.fn()` so tests can spy on calls, and the default
 * return values are sensible empty/pass values so <App /> can mount without
 * crashing.
 */
import { vi, type Mock } from "vitest";

export type MockLvisApi = Record<string, Mock>;

type ApiOverrides = {
  settings?: unknown;
  sessions?: Array<{ id: string; modifiedAt: string }>;
  currentSession?: string;
  tasks?: unknown[];
  starred?: unknown[];
  history?: { sessionId: string; messages: unknown[] };
  hasApiKey?: boolean;
  hasProvider?: boolean;
  usage?: unknown;
  pluginCards?: unknown[];
  marketplace?: unknown[];
  pluginUiExtensions?: unknown[];
};

const DEFAULT_SETTINGS = {
  llm: { provider: "openai", model: "gpt-4o-mini" },
  chat: { systemPrompt: "", autoCompact: true },
  webSearch: { provider: "none" },
  proactive: { enableDailyBriefing: false },
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
  emitProactive: (b: unknown) => void;
  emitViewActivate: (v: string) => void;
} {
  const settings = overrides.settings ?? DEFAULT_SETTINGS;
  const sessions = overrides.sessions ?? [];
  const currentSession = overrides.currentSession ?? "sess-default";
  const tasks = overrides.tasks ?? [];
  const starred = overrides.starred ?? [];
  const history = overrides.history ?? { sessionId: currentSession, messages: [] };
  const hasApiKey = overrides.hasApiKey ?? true;
  const hasProvider = overrides.hasProvider ?? true;
  const usage = overrides.usage ?? DEFAULT_USAGE;
  const pluginCards = overrides.pluginCards ?? [];
  const marketplace = overrides.marketplace ?? [];
  const pluginUiExtensions = overrides.pluginUiExtensions ?? [];

  const chatStreamHandlers = new Set<(ev: unknown) => void>();
  const proactiveHandlers = new Set<(b: unknown) => void>();
  const viewHandlers = new Set<(v: string) => void>();

  const api: MockLvisApi = {
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (p: unknown) => ({ ...(settings as object), ...(p as object) })),
    setApiKey: vi.fn(async () => ({ ok: true })),
    hasApiKey: vi.fn(async () => hasApiKey),
    deleteApiKey: vi.fn(async () => ({ ok: true })),
    setWebApiKey: vi.fn(async () => ({ ok: true })),
    hasWebApiKey: vi.fn(async () => false),
    deleteWebApiKey: vi.fn(async () => ({ ok: true })),

    chatHasProvider: vi.fn(async () => hasProvider),
    chatSend: vi.fn(async () => ({ ok: true })),
    chatGuide: vi.fn(async () => ({ ok: true })),
    chatNew: vi.fn(async () => ({ ok: true })),
    chatSessions: vi.fn(async () => ({ current: currentSession, sessions })),
    chatLoadSession: vi.fn(async (id: string) => ({ ok: true, sessionId: id })),
    chatSessionResume: vi.fn(async (id: string) => ({ ok: true, compacted: false, compactedAt: null, removedMessageCount: 0 })),
    chatCompact: vi.fn(async () => ({ compacted: false, compactedAt: null, summary: "불필요", removedMessageCount: 0 })),
    chatGetHistory: vi.fn(async () => history),
    chatEditResend: vi.fn(async () => ({ ok: true })),
    chatFork: vi.fn(async () => ({ ok: true, sessionId: currentSession })),
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

    addTask: vi.fn(async (t: unknown) => t),
    queryTasks: vi.fn(async () => tasks),
    updateTask: vi.fn(async (_id: string, t: unknown) => t),
    deleteTask: vi.fn(async () => undefined),
    getTodayTasks: vi.fn(async () => tasks),
    getOverdueTasks: vi.fn(async () => []),
    getTasks: vi.fn(async () => tasks),
    getRecentNotes: vi.fn(async () => []),

    getBriefing: vi.fn(async () => null),
    getUsageSummary: vi.fn(async () => usage),
    dismissBriefing: vi.fn(async () => ({ ok: true })),
    snoozeBriefing: vi.fn(async () => ({ ok: true })),
    onProactiveBriefing: vi.fn((h: (b: unknown) => void) => {
      proactiveHandlers.add(h);
      return () => proactiveHandlers.delete(h);
    }),

    submitFeedback: vi.fn(async () => ({ ok: true })),

    onViewActivate: vi.fn((h: (v: string) => void) => {
      viewHandlers.add(h);
      return () => viewHandlers.delete(h);
    }),

    onMarketplaceUpdatesAvailable: vi.fn(() => () => {}),

    plugins: {
      getPerfStats: vi.fn(async () => ({})),
    },
  };

  api.starredAdd = api.addStarred;
  api.starredRemove = api.removeStarred;

  return {
    api,
    emitChatStream: (ev) => chatStreamHandlers.forEach((h) => h(ev)),
    emitProactive: (b) => proactiveHandlers.forEach((h) => h(b)),
    emitViewActivate: (v) => viewHandlers.forEach((h) => h(v)),
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
      },
    },
    emitApproval: (r: unknown) => approvalHandlers.forEach((h) => h(r)),
  };
}
