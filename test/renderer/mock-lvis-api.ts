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
  sessions?: Array<{ id: string; modifiedAt: string }>;
  currentSession?: string;
  starred?: unknown[];
  history?: { sessionId: string; messages: unknown[] };
  hasApiKey?: boolean;
  hasProvider?: boolean;
  usage?: unknown;
  pluginCards?: unknown[];
  marketplace?: unknown[];
  pluginUiExtensions?: unknown[];
  latestRoutineResult?: unknown;
};

const DEFAULT_SETTINGS = {
  llm: fakeLlmSettings({ provider: "openai", model: "gpt-4o-mini" }),
  chat: { systemPrompt: "", autoCompact: true },
  webSearch: { provider: "none" },
  routine: { enableWakeupRoutine: false },
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
  emitRoutineCompleted: (r: unknown) => void;
  emitViewActivate: (v: string) => void;
} {
  const settings = overrides.settings ?? DEFAULT_SETTINGS;
  const sessions = overrides.sessions ?? [];
  const currentSession = overrides.currentSession ?? "sess-default";
  const starred = overrides.starred ?? [];
  const history = overrides.history ?? { sessionId: currentSession, messages: [] };
  const hasApiKey = overrides.hasApiKey ?? true;
  const hasProvider = overrides.hasProvider ?? true;
  const usage = overrides.usage ?? DEFAULT_USAGE;
  const pluginCards = overrides.pluginCards ?? [];
  const marketplace = overrides.marketplace ?? [];
  const pluginUiExtensions = overrides.pluginUiExtensions ?? [];
  const latestRoutineResult = overrides.latestRoutineResult ?? null;

  const chatStreamHandlers = new Set<(ev: unknown) => void>();
  const routineCompletedHandlers = new Set<(r: unknown) => void>();
  const viewHandlers = new Set<(v: string) => void>();

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

    chatHasProvider: vi.fn(async () => hasProvider),
    chatSend: vi.fn(async () => ({ ok: true })),
    chatGuide: vi.fn(async () => ({ ok: true })),
    chatNew: vi.fn(async () => ({ ok: true })),
    chatSessions: vi.fn(async () => ({ current: currentSession, sessions })),
    chatLoadSession: vi.fn(async (id: string) => ({ ok: true, sessionId: id })),
    chatSessionResume: vi.fn(async (id: string) => ({ ok: true, compacted: false, compactedAt: null, removedMessageCount: 0 })),
    chatCompact: vi.fn(async () => ({ compacted: false, compactedAt: null, summary: "불필요", removedMessageCount: 0 })),
    chatGetHistory: vi.fn(async () => history),
    chatSessionHistory: vi.fn(async (_sessionId: string) => ({ ok: false, messages: [] })),
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
    window: {
      openDetached: vi.fn(async () => ({ ok: true, windowId: 1 })),
      closeDetached: vi.fn(async () => ({ ok: true })),
      listDetached: vi.fn(async () => []),
      onSnapEdge: vi.fn(() => () => {}),
      onDetachedNavigate: vi.fn(() => () => {}),
    },

    getRecentNotes: vi.fn(async () => []),

    getUsageSummary: vi.fn(async () => usage),
    getLatestRoutineResult: vi.fn(async () => latestRoutineResult),
    triggerWakeupRoutineDev: vi.fn(async () => ({ ok: true, summary: "dev trigger" })),
    triggerScheduleRoutineDev: vi.fn(async () => ({ ok: true, summary: "dev trigger schedule" })),
    triggerShutdownRoutineDev: vi.fn(async () => ({ ok: true, summary: "dev trigger shutdown" })),
    onRoutineStarted: vi.fn((_h: (p: unknown) => void) => () => {}),
    onRoutineCompleted: vi.fn((h: (r: unknown) => void) => {
      routineCompletedHandlers.add(h);
      return () => routineCompletedHandlers.delete(h);
    }),
    // Brain — proactive trigger lifecycle. Tests that don't exercise the
    // trigger card just need these to be callable subscribe/no-op functions.
    onTriggerStarted: vi.fn((_h: (p: unknown) => void) => () => {}),
    onTriggerCompleted: vi.fn((_h: (r: unknown) => void) => () => {}),
    onTriggerFailed: vi.fn((_h: (p: unknown) => void) => () => {}),
    onTriggerExpired: vi.fn((_h: (p: unknown) => void) => () => {}),
    onTriggerImported: vi.fn((_h: (p: unknown) => void) => () => {}),
    dismissTrigger: vi.fn(async () => ({ ok: true, removed: true })),
    importTrigger: vi.fn(async () => ({ ok: true, imported: 0 })),

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
    emitRoutineCompleted: (r) => routineCompletedHandlers.forEach((h) => h(r)),
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
        debugStream: false,
      },
    },
    emitApproval: (r: unknown) => approvalHandlers.forEach((h) => h(r)),
  };
}
