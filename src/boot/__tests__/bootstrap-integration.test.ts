/**
 * bootstrap() integration lock — §4.2 Boot Sequence.
 *
 * `boot.ts::bootstrap()` is the thin orchestrator that assembles the entire
 * AppServices graph. It had ZERO integration coverage: every existing boot
 * test exercises an extracted helper (sandbox-gate, plugin-runtime, managed-
 * marketplace, bootstrap-status, …) but none runs `bootstrap()` end-to-end.
 *
 * This test locks the CURRENT observable contract of a successful boot before
 * the decomposition refactor (C18) rearranges it:
 *
 *   1. AppServices KEY SET — the exact set of assembled service keys
 *      (`toMatchInlineSnapshot`). This is the primary lock: a decomposition
 *      must not silently drop or rename a service.
 *   2. CONSTRUCTION-ORDER invariants — the documented ordering guarantees that
 *      matter for correctness (approvalGate / permissionManager / routinesStore
 *      / whitelist registry all built BEFORE initPluginRuntime; the plugin
 *      runtime built before the ConversationLoop; the ConversationLoop built
 *      before the late-bound SubAgentRunner). Captured via call-order recording
 *      on the mocked seams.
 *   3. Cheap high-value boot outputs — the deferred lifecycle handles main.ts
 *      depends on (`shutdown`, `startRoutinesScheduler`, `startWorkBoardDueSoon`,
 *      `registerPluginEventBridge`) are wired as callables.
 *
 * Everything heavy is mocked at the module seam (electron, the boot step
 * modules, every store/service class, MCP, ASRT sandbox). The OS sandbox gate
 * is held OFF (settings `osToolSandbox:false`, no `LVIS_SANDBOX_ENABLED`) so the
 * boot takes the deterministic skip path and never touches @anthropic-ai/
 * sandbox-runtime. The marketplace fetcher resolves to the disabled variant
 * (no `cloudBaseUrl`), which is why mcp/agent/skill artifact stores are absent
 * from the graph — that is faithful current behavior for an unconfigured host.
 *
 * COVERAGE CAVEAT: this locks the service-assembly SHAPE + ordering, not the
 * runtime behavior of each wired closure (those closures capture mocked deps
 * and are exercised by their own unit tests). It is a structural regression
 * lock for the decomposition, deliberately GREEN against current code.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Shared call-order recorder. `vi.hoisted` guarantees this exists before the
// hoisted vi.mock factories run, so each mocked seam can record when it fires.
const h = vi.hoisted(() => {
  const order: string[] = [];
  const captured: Record<string, unknown> = {};
  const rec = (label: string) => {
    order.push(label);
  };
  const disposer = () => () => {};
  return { order, captured, rec, disposer };
});

// ── electron ───────────────────────────────────────────────────────────────
vi.mock("electron", () => {
  const BrowserWindow = Object.assign(function BrowserWindow() {}, {
    getAllWindows: vi.fn(() => [] as unknown[]),
    getFocusedWindow: vi.fn(() => null),
  });
  return {
    app: {
      getPath: vi.fn(() => "/tmp/lvis-boot-test"),
      isPackaged: false,
      on: vi.fn(),
      prependOnceListener: vi.fn(),
      once: vi.fn(),
    },
    net: { fetch: vi.fn() },
    session: {
      fromPartition: vi.fn(() => ({
        setProxy: vi.fn(async () => {}),
        fetch: vi.fn(),
      })),
    },
    shell: { openExternal: vi.fn() },
    safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
    BrowserWindow,
  };
});

// ── boot step seams (the modules bootstrap orchestrates) ─────────────────────
vi.mock("../services.js", () => ({
  bootstrapCoreServices: vi.fn(async () => {
    h.rec("core");
    return {
      pythonPath: "/usr/bin/python3",
      pythonRuntime: { kind: "python-runtime-stub" },
      bashAstValidator: {},
      auditService: { stop: vi.fn(async () => {}) },
      settingsService: {
        get: vi.fn((key: string) => {
          switch (key) {
            case "marketplace":
              return { cloudBaseUrl: undefined, cloudAllowPrivateNetwork: false };
            case "llm":
              return { provider: "openai", vendors: { openai: { model: "gpt", baseUrl: undefined } } };
            case "features":
              return { osToolSandbox: false, hostClassifiesRisk: false, idlePreferenceRefresh: true };
            default:
              return {};
          }
        }),
        getSecret: vi.fn(() => undefined),
        getAll: vi.fn(() => ({})),
      },
      memoryManager: {},
      keywordEngine: {},
      toolRegistry: { setDenyRules: vi.fn(), size: 0 },
      routeEngine: {},
    };
  }),
}));

vi.mock("../conversation.js", () => ({
  createSystemPromptBuilder: vi.fn(() => ({})),
  createPermissionManager: vi.fn(async () => {
    h.rec("permissionManager");
    return {
      getVisibilityDenyRules: vi.fn(() => []),
      setBroadcastUserApprovalHit: vi.fn(),
      setBroadcastConfigChanged: vi.fn(),
    };
  }),
  createPostTurnHookChain: vi.fn(() => ({ postTurnHookChain: {} })),
  createApprovalGate: vi.fn(async () => {
    h.rec("approvalGate");
    return {};
  }),
  createHookRunner: vi.fn(() => ({})),
  createConversationLoop: vi.fn((deps) => {
    h.rec("conversationLoop");
    h.captured["mainConversationDeps"] = deps;
    return {
      getSessionId: vi.fn(() => undefined),
      getTurnAdditionalDirectories: vi.fn(() => []),
    };
  }),
  createRoutineConversationLoop: vi.fn((deps) => {
    h.captured["routineLoopDeps"] = deps;
    return {};
  }),
  createSideChatConversationLoop: vi.fn((deps) => {
    h.captured["sideConversationDeps"] = deps;
    return {
      getSessionId: vi.fn(() => "side-1"),
      getTurnAdditionalDirectories: vi.fn(() => []),
    };
  }),
  createCallLlm: vi.fn(() => vi.fn()),
  createCallLlmForPlugin: vi.fn(() => vi.fn()),
}));

vi.mock("../routine.js", () => ({
  createRoutineEngine: vi.fn((options) => {
    h.captured["routineEngineOptions"] = options;
    return { runRoutine: vi.fn() };
  }),
}));

vi.mock("../steps/rationale-host-wiring.js", () => ({
  wireRationaleHost: vi.fn(async (ctx) => {
    ctx.rationaleHostService = {
      createCoordinatorFactory: vi.fn(() => vi.fn()),
      closeSession: vi.fn(),
      shutdown: vi.fn(),
    };
  }),
}));

vi.mock("../tools.js", () => ({
  registerBuiltinTools: vi.fn(),
  registerRequestPluginMetaTool: vi.fn(),
  registerToolSearchMetaTool: vi.fn(),
  wireKnowledgeAndIdleScheduler: vi.fn(async () => ({
    idleScheduler: { stop: vi.fn() },
    knowledgeAvailable: true,
  })),
}));

vi.mock("../plugins.js", () => ({
  registerPluginNotifications: vi.fn(() => h.disposer()),
}));

vi.mock("../managed-marketplace.js", () => ({
  runManagedBootstrap: vi.fn(async () => {}),
}));

vi.mock("../steps/plugin-runtime.js", () => ({
  initPluginRuntime: vi.fn(async () => {
    h.rec("initPluginRuntime");
    return {
      pluginRuntime: {
        listPluginIds: vi.fn(() => [] as string[]),
        getPluginManifest: vi.fn(() => null),
        setWildcardConfigOverride: vi.fn(),
        clearWildcardConfigOverride: vi.fn(),
        restartPlugin: vi.fn(async () => {}),
        setToolInvocationDelegate: vi.fn(),
        setGenerationAccess: vi.fn(),
      },
      deploymentGuard: {},
      lateBinding: {
        pluginToolInvokerRef: { fn: undefined },
        conversationLoopRef: { fn: undefined },
        llmCallerRef: { fn: undefined },
        pluginCallLlmRef: { fn: undefined },
      },
      runPluginShutdownHandlers: vi.fn(async () => {}),
      pluginPaths: {
        pluginsRoot: "/tmp/lvis-boot-test/plugins",
        cacheRoot: "/tmp/lvis-boot-test/plugins/.cache",
      },
      loopbackManager: {
        prepareGeneration: vi.fn(),
        prepareRemoval: vi.fn(),
        publishGeneration: vi.fn(),
        postPublishGeneration: vi.fn(),
        discardGeneration: vi.fn(async () => {}),
        retireGeneration: vi.fn(async () => {}),
      },
      setBundleLifecycleHandler: vi.fn(),
      startPlugins: vi.fn(async () => {}),
    };
  }),
}));

vi.mock("../steps/whitelist-bootstrap.js", () => ({
  wireWhitelistRegistry: vi.fn(async () => {
    h.rec("whitelist");
  }),
}));

vi.mock("../steps/ipc-bridge.js", () => ({
  registerPluginEventBridge: vi.fn(() => {
    h.rec("pluginEventBridge");
    return h.disposer();
  }),
}));

vi.mock("../steps/post-boot.js", () => ({
  wireReleasePrep: vi.fn(() => ({
    telemetry: { stop: vi.fn() },
    pluginTelemetry: { stop: vi.fn() },
    autoUpdaterStop: vi.fn(),
  })),
  wireUpdateCheck: vi.fn(),
  wireAnnouncementCheck: vi.fn(),
}));

vi.mock("../steps/reviewer-wiring.js", () => ({
  wireReviewerAgent: vi.fn(() => ({
    rationaleScopeReviewer: { reevaluate: vi.fn() },
  })),
}));

vi.mock("../steps/hook-system-wiring.js", () => ({
  wireHookSystem: vi.fn(async () => ({
    manager: { setPluginGenerationAccess: vi.fn() },
  })),
}));

vi.mock("../steps/refresh-active-llm-wildcard.js", () => ({
  createRefreshActiveLlmWildcard: vi.fn(() => ({ refresh: vi.fn() })),
}));

vi.mock("../steps/watcher-telemetry-collector.js", () => ({
  startWatcherTelemetryCollector: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("../steps/work-board-migration.js", () => ({
  migrateAgentHubBoardToWorkBoard: vi.fn(async () => false),
}));

vi.mock("../plugin-surface-permissions.js", () => ({
  createPluginSurfacePermissionScope: vi.fn(() => ({ createPermissionContext: vi.fn() })),
}));

// ── data / mcp ───────────────────────────────────────────────────────────────
vi.mock("../../data/starred-store.js", () => ({ StarredStore: class {} }));
vi.mock("../../data/feedback-store.js", () => ({ FeedbackStore: class {} }));

vi.mock("../../mcp/mcp-governance.js", () => ({
  McpGovernance: class {
    startPolicyRefresh = vi.fn();
    stopPolicyRefresh = vi.fn();
  },
}));
vi.mock("../../mcp/mcp-manager.js", () => ({
  McpManager: class {
    loadFromConfig = vi.fn(async () => [] as unknown[]);
    connectAll = vi.fn(async () => {});
    disconnectAll = vi.fn(async () => {});
    killSwitch = vi.fn(async () => {});
    listServers = vi.fn(() => [] as unknown[]);
    setPluginGenerationAccess = vi.fn();
  },
}));
vi.mock("../../mcp/mcp-elicitation-resolver.js", () => ({
  createElicitationResolverFactory: vi.fn(() => vi.fn()),
}));

// ── main/* services + helpers ────────────────────────────────────────────────
vi.mock("../../main/auth-window-service.js", () => ({
  openAuthWindow: vi.fn(),
  clearAuthPartition: vi.fn(),
  forgetTrackedPluginAuthPartitions: vi.fn(),
  getTrackedPluginAuthPartitions: vi.fn(() => []),
  wirePluginAuthPartitionPersistence: vi.fn(),
  seedPluginAuthPartitions: vi.fn(),
}));
vi.mock("../../main/plugin-auth-partition-store.js", () => ({
  readPersistedPluginAuthPartitions: vi.fn(async () => null),
  writePersistedPluginAuthPartitions: vi.fn(async () => {}),
  deletePersistedPluginAuthPartitions: vi.fn(async () => {}),
  cleanupStaleTmpFiles: vi.fn(async () => {}),
}));
vi.mock("../../main/link-window-service.js", () => ({ openLinkWindow: vi.fn() }));
vi.mock("../../main/auth-partition-viewer-service.js", () => ({ openAuthPartitionViewer: vi.fn() }));
vi.mock("../../main/routines-store.js", () => ({
  RoutinesStore: class {
    constructor() {
      h.rec("routinesStore");
    }
    load = vi.fn(async () => {});
    update = vi.fn(async () => true);
    list = vi.fn(() => []);
  },
}));
vi.mock("../../main/routines-scheduler.js", () => ({
  RoutinesScheduler: class {
    onLlmSession = vi.fn();
    onNotification = vi.fn();
    start = vi.fn();
    stop = vi.fn();
  },
}));
vi.mock("../../main/work-board-store.js", () => ({
  WorkBoardStore: class {
    load = vi.fn(async () => {});
    reconcileInterruptedRuns = vi.fn(async () => {});
  },
}));
vi.mock("../../main/session-todo-store.js", () => ({ SessionTodoStore: class {} }));
vi.mock("../../main/ask-user-question-gate.js", () => ({
  AskUserQuestionGate: class {
    disposeAll = vi.fn();
  },
}));
vi.mock("../../main/notification-service.js", () => ({
  NotificationService: class {
    fire = vi.fn();
  },
}));
vi.mock("../../main/safe-llm-fetch.js", () => ({ createSafeLlmFetch: vi.fn(() => vi.fn()) }));
vi.mock("../../main/skill-store.js", () => ({
  SkillStore: class {
    listCatalogSync = vi.fn(() => []);
  },
}));
vi.mock("../../main/skill-overlay.js", () => ({
  SkillOverlay: class {
    buildSection = vi.fn(() => "");
  },
}));
vi.mock("../../main/skill-approvals-store.js", () => ({
  SkillApprovalsStore: class {
    load = vi.fn(async () => {});
  },
}));
vi.mock("../../main/agent-profile-store.js", () => ({
  AgentProfileStore: class {
    load = vi.fn(async () => null);
  },
}));
vi.mock("../../main/persona-prompt-store.js", () => ({ PersonaPromptStore: class {} }));
vi.mock("../../main/storage/feature-namespace.js", () => ({
  openFeatureNamespace: vi.fn(() => ({ dir: "/tmp/lvis-boot-test/work-board" })),
}));
vi.mock("../../main/seed-lvis-home-docs.js", () => ({
  seedLvisHomeDocs: vi.fn(() => ({ seeded: [], upgraded: [] })),
  listLvisHomeDocUpgradeMarkers: vi.fn(() => []),
}));

vi.mock("../../memory/preference-refresh-service.js", () => ({
  PreferenceRefreshService: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock("../../engine/subagent-runner.js", () => ({
  SubAgentRunner: class {
    constructor(options: unknown) {
      h.rec("subAgentRunner");
      h.captured["subAgentOptions"] = options;
    }
  },
}));
vi.mock("../../engine/llm/provider-factory.js", () => ({
  createProvider: vi.fn(() => ({})),
  secretKeyFor: vi.fn((v: string) => `llm.apiKey.${v}`),
}));

vi.mock("../../tools/executor.js", () => ({ ToolExecutor: class {} }));
vi.mock("../../tools/write-diff-cache.js", () => ({
  purgeStaleSessionDiffDirs: vi.fn(async () => ({ swept: [], failed: [] })),
  clearSessionDiffCache: vi.fn(async () => {}),
}));

vi.mock("../../core/work-board-engine.js", () => ({ createWorkBoardEngine: vi.fn(() => ({})) }));
vi.mock("../../work-board/sample-data.js", () => ({ seedSampleWorkBoard: vi.fn(async () => {}) }));
vi.mock("../../work-board/due-soon.js", () => ({ scanAndEmitDueSoon: vi.fn(async () => []) }));
vi.mock("../../work-board/storage.js", () => ({ createDirStorage: vi.fn(() => ({})) }));
vi.mock("../../work-board/work-report.js", () => ({ createWorkBoardReporter: vi.fn(() => ({})) }));
vi.mock("../../work-board/work-memory.js", () => ({ appendMemory: vi.fn(async () => {}) }));

// ── plugins/* ────────────────────────────────────────────────────────────────
vi.mock("../../plugins/marketplace.js", () => ({
  DisabledMarketplaceFetcher: class {},
  PluginMarketplaceService: class {},
}));
vi.mock("../../plugins/cloud-marketplace-fetcher.js", () => ({
  CloudMarketplaceFetcher: class {
    updateAllowPrivateNetwork = vi.fn();
  },
}));
vi.mock("../../plugins/plugin-artifact-store.js", () => ({ PluginArtifactStore: class {} }));
vi.mock("../../plugins/publisher-keys.js", () => ({ getBundledPublicKeys: vi.fn(() => ({})) }));
vi.mock("../../plugins/orphan-uninstall-sweeper.js", () => ({
  sweepOrphanUninstallDirs: vi.fn(async () => ({ swept: [], failed: [] })),
}));
vi.mock("../../plugins/plugin-paths.js", () => ({
  resolvePluginPaths: vi.fn(() => ({
    pluginsRoot: "/tmp/lvis-boot-test/plugins",
    registryPath: "/tmp/lvis-boot-test/registry.json",
    cacheRoot: "/tmp/lvis-boot-test/cache",
  })),
}));

// ── permissions/* (incl. dynamically imported sandbox modules) ───────────────
vi.mock("../../permissions/sandbox-capability.js", () => ({
  isActiveSandboxFilesystemContained: vi.fn(() => false),
  isActiveSandboxShellContained: vi.fn(() => false),
  isActiveSandboxFilesystemContainedForPluginEffects: vi.fn(() => false),
  setActiveSandboxCapability: vi.fn(),
  setSandboxRequestedAtBoot: vi.fn(),
}));
vi.mock("../../permissions/asrt-sandbox.js", () => ({
  initializeAsrtSandbox: vi.fn(async () => {}),
  checkAsrtDependencies: vi.fn(async () => ({ errors: [], warnings: [] })),
  isAsrtLinuxRuntimeProbeError: vi.fn(() => false),
  isAsrtSandboxActive: vi.fn(() => false),
  updateAsrtSandboxConfig: vi.fn(async () => {}),
  computeUnionAllowedDomains: vi.fn(() => []),
  normalizeUnionForAsrt: vi.fn(() => []),
  computeDynamicEndpointHosts: vi.fn(() => []),
}));
vi.mock("../../permissions/permission-settings-store.js", () => ({
  readPermissionSettings: vi.fn(() => ({ permissions: { additionalDirectories: [] } })),
}));
vi.mock("../../permissions/user-approval-store.js", () => ({
  migrateCanonicalization: vi.fn(async () => {}),
}));
vi.mock("../../permissions/manifest-integrity.js", () => ({
  bindManifestIntegrityAudit: vi.fn(),
  manifestIntegrityState: { onViolation: vi.fn() },
}));

// ── audit/* (dynamically imported inside bootstrap) ──────────────────────────
vi.mock("../../audit/audit-logger.js", () => ({
  AuditLogger: class {
    setupPermissionAuditChain = vi.fn();
    log = vi.fn();
    logSandboxGate = vi.fn();
    getAuditDir = vi.fn(() => "C:\\tmp\\lvis-boot-test\\audit");
    getPermissionAuditSecret = vi.fn(() => "s".repeat(64));
    getPermissionAuditSealStore = vi.fn(() => ({ read: vi.fn(() => null), write: vi.fn() }));
  },
}));
vi.mock("../../audit/hmac-chain.js", () => ({
  FileSecretStore: class {},
  SafeStorageSecretStore: class {},
  ensureAuditSecret: vi.fn(() => ({})),
  computeLineHmac: vi.fn(() => "h".repeat(64)),
}));

// ── ipc/domains/permissions.js — mocked so the concurrently-edited IPC domain
//    tree is not pulled into this test (bootstrap only needs the broadcaster).
vi.mock("../../ipc/domains/permissions.js", () => ({
  broadcastPermissionConfigChanged: vi.fn(),
}));

import { bootstrap, type AppServices } from "../../boot.js";

function fakeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as import("electron").BrowserWindow;
}

/** Assert both labels were recorded and `a` fired strictly before `b`. */
function assertBefore(a: string, b: string) {
  const ia = h.order.indexOf(a);
  const ib = h.order.indexOf(b);
  expect(ia, `${a} was not recorded`).toBeGreaterThanOrEqual(0);
  expect(ib, `${b} was not recorded`).toBeGreaterThanOrEqual(0);
  expect(ia, `expected ${a} before ${b} (order: ${h.order.join(" -> ")})`).toBeLessThan(ib);
}

describe("bootstrap() integration lock", () => {
  let services: AppServices;
  let savedSandboxEnv: string | undefined;

  beforeAll(async () => {
    // Hold the OS-sandbox gate OFF for a deterministic skip path (no ASRT init).
    savedSandboxEnv = process.env["LVIS_SANDBOX_ENABLED"];
    delete process.env["LVIS_SANDBOX_ENABLED"];
    const win = fakeWindow();
    services = await bootstrap("/tmp/lvis-boot-test/project", win, () => win);
  });

  afterAll(() => {
    if (savedSandboxEnv === undefined) delete process.env["LVIS_SANDBOX_ENABLED"];
    else process.env["LVIS_SANDBOX_ENABLED"] = savedSandboxEnv;
  });

  it("assembles the exact AppServices key set (C18 must not drop/rename a service)", () => {
    expect(Object.keys(services).sort()).toMatchInlineSnapshot(`
      [
        "a2aRemoteRuntime",
        "agentArtifactStore",
        "agentProfileStore",
        "approvalGate",
        "askUserQuestionGate",
        "auditLogger",
        "auditService",
        "autoUpdaterStop",
        "bashAstValidator",
        "clearAuthPartitionService",
        "conversationLoop",
        "feedbackStore",
        "forgetPluginAuthPartitionsService",
        "getPluginToolInvoker",
        "getSubAgentRunner",
        "idleScheduler",
        "keywordEngine",
        "knowledgeAvailable",
        "listPluginAuthPartitionsService",
        "mcpAppModelContext",
        "mcpArtifactStore",
        "mcpManager",
        "memoryManager",
        "notificationService",
        "personaPromptStore",
        "pluginBundleLifecycle",
        "pluginLoopbackManager",
        "pluginMarketplace",
        "pluginPaths",
        "pluginRuntime",
        "pluginTelemetry",
        "postTurnHookChain",
        "preferenceRefreshService",
        "pythonPath",
        "pythonRuntime",
        "refreshActiveLlmWildcard",
        "refreshMarketplaceFetcherConfig",
        "refreshPluginNotifications",
        "refreshSandboxNetworkConfig",
        "registerPluginEventBridge",
        "remoteA2AActionController",
        "requestPluginOperationGrant",
        "rewireReviewerAgent",
        "routeEngine",
        "routineEngine",
        "routinesScheduler",
        "routinesStore",
        "runPluginShutdownHandlers",
        "scriptHookManager",
        "sessionTodoStore",
        "settingsService",
        "shutdown",
        "sideChatConversationLoop",
        "skillArtifactStore",
        "skillStore",
        "starredStore",
        "startRoutinesScheduler",
        "startWorkBoardDueSoon",
        "systemPromptBuilder",
        "telemetry",
        "toolRegistry",
        "workBoardEngine",
        "workBoardReport",
        "workBoardStore",
      ]
    `);
  });

  it("enforces the documented construction-order invariants", () => {
    // Core services are the foundation — everything else depends on them.
    assertBefore("core", "approvalGate");
    // §B1/§F7 + cluster M1 + Routines-SOT + #893 Stage 2: the ApprovalGate,
    // PermissionManager, RoutinesStore, and whitelist registry are ALL built
    // before initPluginRuntime, because the per-plugin HostApi factory wires
    // against each of them at plugin construction time.
    assertBefore("approvalGate", "initPluginRuntime");
    assertBefore("permissionManager", "initPluginRuntime");
    assertBefore("routinesStore", "initPluginRuntime");
    assertBefore("whitelist", "initPluginRuntime");
    // The plugin runtime exists before the ConversationLoop is composed (the
    // loop captures pluginRuntime among its deps).
    assertBefore("initPluginRuntime", "conversationLoop");
    // The ConversationLoop is built before the late-bound SubAgentRunner, which
    // reuses the loop's dep set.
    assertBefore("conversationLoop", "subAgentRunner");
  });

  it("exposes the deferred lifecycle handles main.ts drives after boot", () => {
    expect(typeof services.shutdown).toBe("function");
    expect(typeof services.startRoutinesScheduler).toBe("function");
    expect(typeof services.startWorkBoardDueSoon).toBe("function");
    expect(typeof services.registerPluginEventBridge).toBe("function");
    expect(typeof services.refreshPluginNotifications).toBe("function");
    expect(services.knowledgeAvailable).toBe(true);
  });

  it("wires the core, conversation, and plugin-runtime seams into the graph", () => {
    // Present as assembled objects (the graph is wired, not partial).
    expect(services.conversationLoop).toBeDefined();
    expect(services.approvalGate).toBeDefined();
    expect(services.pluginRuntime).toBeDefined();
    expect(services.toolRegistry).toBeDefined();
    expect(services.settingsService).toBeDefined();
    // Unconfigured marketplace (no cloudBaseUrl) → the disabled fetcher path,
    // so the signed-artifact stores are intentionally absent from the graph.
    expect(services.mcpArtifactStore).toBeUndefined();
    expect(services.agentArtifactStore).toBeUndefined();
    expect(services.skillArtifactStore).toBeUndefined();
  });

  it("injects dormant rationale only into interactive loop dependencies", () => {
    const mainDeps = h.captured["mainConversationDeps"] as {
      rationaleCoordinatorFactory?: unknown;
      closeRationaleSession?: unknown;
    };
    const sideDeps = h.captured["sideConversationDeps"] as {
      rationaleCoordinatorFactory?: unknown;
      closeRationaleSession?: unknown;
    };

    expect(typeof mainDeps.rationaleCoordinatorFactory).toBe("function");
    expect(typeof sideDeps.rationaleCoordinatorFactory).toBe("function");
    expect(mainDeps.rationaleCoordinatorFactory).not.toBe(
      sideDeps.rationaleCoordinatorFactory,
    );
    expect(typeof mainDeps.closeRationaleSession).toBe("function");
    expect(typeof sideDeps.closeRationaleSession).toBe("function");

    const routineEngineOptions = h.captured["routineEngineOptions"] as {
      createConversationLoop: (input: { scope: unknown }) => unknown;
    };
    routineEngineOptions.createConversationLoop({ scope: {} });
    const routineDeps = h.captured["routineLoopDeps"] as Record<string, unknown>;
    expect(routineDeps["rationaleCoordinatorFactory"]).toBeUndefined();
    expect(routineDeps["closeRationaleSession"]).toBeUndefined();

    const subAgentOptions = h.captured["subAgentOptions"] as {
      parentDeps: Record<string, unknown>;
    };
    expect(
      subAgentOptions.parentDeps["rationaleCoordinatorFactory"],
    ).toBeUndefined();
    expect(subAgentOptions.parentDeps["closeRationaleSession"]).toBeUndefined();
  });
});
