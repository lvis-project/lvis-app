/**
 * Boot Sequence — §4.2 (thin orchestrator).
 *
 * Composes the 8-step boot pipeline from focused modules under `src/boot/`:
 *
 *   Step 0-1 + 4-5  src/boot/services.ts          core services (python,
 *                                                 audit, settings,
 *                                                 memory, keyword/route,
 *                                                 tool-registry)
 *   Step 3 + 5      src/boot/steps/plugin-runtime — PluginRuntime + per-plugin
 *                                                 HostApi factory + startAll
 *                                                 ToolRegistry registration +
 *                                                 dev hot-reload watcher.
 *   Step 2 + 5 + 6  src/boot/conversation.ts      system-prompt,
 *                                                 permission-manager,
 *                                                 post-turn-hook-chain,
 *                                                 approval-gate,
 *                                                 script-hook manager,
 *                                                 conversation-loop,
 *                                                 callLlm builders.
 *   Step 6          src/boot/routine.ts           routine runtime +
 *                                                 calendar loaders.
 *   Step 6          src/boot/steps/routine-coordinator — trigger coordinator
 *                                                 + idle-scheduler composite.
 *   Step 4          src/boot/tools.ts             builtin tools +
 *                                                 request_plugin meta-tool +
 *                                                 knowledge/idle wiring.
 *   Step 3 + 7      src/boot/plugins.ts           manifest → notification +
 *                                                 event/tool/startup helpers.
 *   Step 7          src/boot/steps/ipc-bridge     manifest-driven plugin →
 *                                                 renderer event forwarder
 *                                                 (with transcript coalescing).
 *   Step 8          src/boot/steps/post-boot      release prep (crash reporter,
 *                                                 telemetry, auto-updater) +
 *                                                 plugin update-check timer.
 *
 * No plugin-specific code lives here — all plugins register themselves via the
 * HostApi manufactured in `steps/plugin-runtime.ts`.
 */
import { app, net, session, shell } from "electron";
import type { BrowserWindow } from "electron";
import { BrowserWindow as BrowserWindowValue } from "electron";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DisabledMarketplaceFetcher, PluginMarketplaceService } from "./plugins/marketplace.js";
import type { MarketplaceFetcher } from "./plugins/marketplace.js";
import { CloudMarketplaceFetcher } from "./plugins/cloud-marketplace-fetcher.js";
import { PluginArtifactStore } from "./plugins/plugin-artifact-store.js";
import { getBundledPublicKeys } from "./plugins/publisher-keys.js";
import { sweepOrphanUninstallDirs } from "./plugins/orphan-uninstall-sweeper.js";
import { purgeStaleSessionDiffDirs, clearSessionDiffCache } from "./tools/write-diff-cache.js";
import { resolvePluginPaths } from "./plugins/plugin-paths.js";
import { StarredStore } from "./data/starred-store.js";
import { FeedbackStore } from "./data/feedback-store.js";
import { McpGovernance } from "./mcp/mcp-governance.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { createElicitationResolverFactory } from "./mcp/mcp-elicitation-resolver.js";
import {
  openAuthWindow as openAuthWindowService,
  clearAuthPartition as clearAuthPartitionService,
  forgetTrackedPluginAuthPartitions as forgetPluginAuthPartitionsService,
  getTrackedPluginAuthPartitions as listPluginAuthPartitionsService,
  wirePluginAuthPartitionPersistence,
  seedPluginAuthPartitions,
} from "./main/auth-window-service.js";
import {
  readPersistedPluginAuthPartitions,
  writePersistedPluginAuthPartitions,
  deletePersistedPluginAuthPartitions,
  cleanupStaleTmpFiles,
} from "./main/plugin-auth-partition-store.js";
import { openLinkWindow as openLinkWindowService } from "./main/link-window-service.js";
import { openAuthPartitionViewer as openAuthPartitionViewerService } from "./main/auth-partition-viewer-service.js";

import { type AppServices, onEvent, emitEvent } from "./boot/types.js";
import { PERMISSIONS, ROUTINES_V2, WORK_BOARD } from "./shared/ipc-channels.js";
import { sendToWindow } from "./ipc/safe-send.js";
import { fanOutToAllWindows } from "./ipc/broadcast-helpers.js";
import { broadcastPermissionConfigChanged as broadcastPermissionConfigChangedFromIpc } from "./ipc/domains/permissions.js";
import { startWatcherTelemetryCollector } from "./boot/steps/watcher-telemetry-collector.js";
import { bootstrapCoreServices } from "./boot/services.js";
import { registerPluginNotifications } from "./boot/plugins.js";
import { createRefreshActiveLlmWildcard } from "./boot/steps/refresh-active-llm-wildcard.js";
import {
  registerBuiltinTools,
  registerRequestPluginMetaTool,
  registerToolSearchMetaTool,
  wireKnowledgeAndIdleScheduler,
  type WorkflowToolDeps,
} from "./boot/tools.js";
import { RoutinesStore } from "./main/routines-store.js";
import { RoutinesScheduler } from "./main/routines-scheduler.js";
import { WorkBoardStore } from "./main/work-board-store.js";
import { createWorkBoardEngine, type WorkBoardEngine } from "./core/work-board-engine.js";
import { migrateAgentHubBoardToWorkBoard } from "./boot/steps/work-board-migration.js";
import { seedSampleWorkBoard } from "./work-board/sample-data.js";
import { scanAndEmitDueSoon } from "./work-board/due-soon.js";
import { createDirStorage } from "./work-board/storage.js";
import { openFeatureNamespace } from "./main/storage/feature-namespace.js";
import { createWorkBoardReporter, type WorkBoardReporter } from "./work-board/work-report.js";
import { appendMemory } from "./work-board/work-memory.js";
import { SessionTodoStore } from "./main/session-todo-store.js";
import { AskUserQuestionGate } from "./main/ask-user-question-gate.js";
import { NotificationService } from "./main/notification-service.js";
import { createSafeLlmFetch } from "./main/safe-llm-fetch.js";
import { getDemoActiveVendor, getDemoHostMap, getDemoHostSubnet, getDemoVendorConfig } from "./main/demo-credentials.js";
import { createPluginNetworkFetch } from "./main/plugin-network-fetch.js";
import {
  demoFoundryHostMapFingerprint,
  demoHostMapContainsHost,
  getAppliedDemoHostResolverFingerprint,
} from "./main/demo-host-resolver.js";
import { PreferenceRefreshService } from "./memory/preference-refresh-service.js";
import { SkillStore } from "./main/skill-store.js";
import { SkillOverlay } from "./main/skill-overlay.js";
import { SkillApprovalsStore } from "./main/skill-approvals-store.js";
import { AgentProfileStore } from "./main/agent-profile-store.js";
import { PersonaPromptStore } from "./main/persona-prompt-store.js";
import { SubAgentRunner } from "./engine/subagent-runner.js";
import type { AgentSpawnEvent } from "./tools/agent-spawn.js";
import type { SkillLoadEvent } from "./tools/skill-load.js";
import {
  createRoutineEngine,
} from "./boot/routine.js";
import {
  createSystemPromptBuilder,
  createPermissionManager,
  createPostTurnHookChain,
  createApprovalGate,
  createHookRunner,
  createConversationLoop,
  createRoutineConversationLoop,
  createCallLlm,
  createCallLlmForPlugin,
} from "./boot/conversation.js";
import { ToolExecutor } from "./tools/executor.js";
import type { PluginToolInvocationContext } from "./plugins/runtime.js";
import {
  currentInvocationOrigin,
  runWithInvocationOrigin,
} from "./plugins/runtime/origin-chain.js";
import { initPluginRuntime } from "./boot/steps/plugin-runtime.js";
import { wireWhitelistRegistry } from "./boot/steps/whitelist-bootstrap.js";
import { registerPluginEventBridge } from "./boot/steps/ipc-bridge.js";
import { wireAnnouncementCheck, wireReleasePrep, wireUpdateCheck } from "./boot/steps/post-boot.js";
import { wireReviewerAgent } from "./boot/steps/reviewer-wiring.js";
import { wireHookSystem } from "./boot/steps/hook-system-wiring.js";
import { isUiOnlyRuntimeInvocation } from "./boot/plugin-tool-invocation.js";
import { createPluginSurfacePermissionScope } from "./boot/plugin-surface-permissions.js";
import { readPermissionSettings } from "./permissions/permission-settings-store.js";
import { migrateCanonicalization } from "./permissions/user-approval-store.js";
import { createProvider, secretKeyFor } from "./engine/llm/provider-factory.js";
import { reviewerVendorFor } from "./permissions/reviewer/reviewer-vendor-map.js";
import type { LLMProvider } from "./engine/llm/types.js";
import { isLLMVendor } from "./shared/llm-vendor-defaults.js";
import {
  bindManifestIntegrityAudit,
  manifestIntegrityState,
} from "./permissions/manifest-integrity.js";
import { runManagedBootstrap } from "./boot/managed-marketplace.js";
import { createLogger } from "./lib/logger.js";
import { lvisHome } from "./shared/lvis-home.js";
import { t } from "./i18n/index.js";
import {
  listLvisHomeDocUpgradeMarkers,
  seedLvisHomeDocs,
  type LvisHomeDocUpgradeMarker,
} from "./main/seed-lvis-home-docs.js";
const log = createLogger("lvis");

export type { AppServices } from "./boot/types.js";

function toPluginToolInput(payload: unknown): Record<string, unknown> {
  if (payload === undefined || payload === null) return {};
  if (typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return { payload };
}

function pluginInvocationSessionId(context: PluginToolInvocationContext): string {
  const subject = context.callerPluginId ?? context.ownerPluginId ?? "host";
  return `plugin-${context.origin}-${subject}`;
}

/**
 * @param getMainWindow Live BrowserWindow getter — must read the current
 *   `main.ts` binding because Electron close+reopen replaces the window.
 *   Bootstrap-time consumers (e.g. plugin event bridge) take the resolved
 *   `mainWindow`; runtime consumers (e.g. routinesScheduler) take this getter.
 *   Defaults to a closure over `mainWindow` for callers that don't have a
 *   live reference, but those callers will silently lose IPC after window
 *   recreation.
 */
export async function bootstrap(
  projectRoot: string,
  mainWindow: BrowserWindow,
  getMainWindow: () => BrowserWindow | null = () => mainWindow,
): Promise<AppServices> {
  log.info("boot: starting...");
  const electronNetFetch = net.fetch.bind(net);
  const privateEndpointSession = session.fromPartition("lvis-private-endpoint-fetch");
  await privateEndpointSession.setProxy({ mode: "direct" });
  const electronDirectFetch = privateEndpointSession.fetch.bind(privateEndpointSession);
  const demoActiveVendor = getDemoActiveVendor();
  const demoHostMap = getDemoHostMap();
  const demoHostSubnet = getDemoHostSubnet();
  const demoFoundryConfig = demoActiveVendor === "azure-foundry"
    ? getDemoVendorConfig("azure-foundry")
    : null;
  const appliedDemoHostMapFingerprint = demoFoundryHostMapFingerprint(
    demoFoundryConfig?.baseUrl,
    demoHostMap,
    demoHostSubnet,
  );
  const isAppliedDemoHostMap =
    appliedDemoHostMapFingerprint !== null &&
    appliedDemoHostMapFingerprint === getAppliedDemoHostResolverFingerprint();
  const isDemoPrivateEndpointUrl = (url: URL) =>
    isAppliedDemoHostMap &&
    demoHostMapContainsHost(demoHostMap, url.toString());
  const createElectronFetch = (fetchImpl: typeof electronNetFetch): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const normalizedInput = input instanceof URL ? input.toString() : input;
      return fetchImpl(normalizedInput as string | Request, {
        ...(init ?? {}),
        bypassCustomProtocolHandlers: true,
      });
    }) as typeof fetch;
  const networkFetch = createElectronFetch(electronNetFetch);
  const privateNetworkFetch = createElectronFetch(electronDirectFetch);
  // Tier A host-mediated plugin egress: hostApi.hostFetch is backed by this
  // chooser so demo/corporate Azure private-endpoint URLs egress through the
  // proxy-bypassing direct session (host-resolver-rules → intranet IP), exactly
  // like the chat LLM path. Plugins (e.g. meeting STT) that send to a mapped
  // Azure host therefore stop being hijacked by the corporate forward proxy to
  // the public endpoint (the 403 "public access disabled" regression).
  const pluginNetworkFetch = createPluginNetworkFetch(
    networkFetch,
    privateNetworkFetch,
    isDemoPrivateEndpointUrl,
  );
  const llmFetch = createSafeLlmFetch(electronNetFetch, {
    privateEndpoint: {
      fetch: electronDirectFetch,
      isMappedUrl: isDemoPrivateEndpointUrl,
    },
  });

  // Seed user-facing docs into `~/.lvis/` before any other component reads
  // home state. AGENTS.md is the LLM-facing system reference; on first boot
  // it is copied from packaged resources, and on subsequent upgrades a
  // `.new` sibling is dropped next to the user's edited copy for diff/merge.
  // Non-fatal — failures log and continue.
  let lvisHomeDocUpgradeMarkers: LvisHomeDocUpgradeMarker[] = [];
  try {
    const seeded = seedLvisHomeDocs();
    if (seeded.seeded.length > 0) {
      log.info(`boot: seeded lvis-home docs: ${seeded.seeded.join(", ")}`);
    }
    if (seeded.upgraded.length > 0) {
      log.info(`boot: lvis-home docs upgrade available: ${seeded.upgraded.join(", ")}`);
    }
    lvisHomeDocUpgradeMarkers = listLvisHomeDocUpgradeMarkers();
    if (lvisHomeDocUpgradeMarkers.length > 0) {
      log.info(
        `boot: pending lvis-home docs upgrade markers: ${lvisHomeDocUpgradeMarkers.map((m) => m.markerPath).join(", ")}`,
      );
    }
  } catch (err) {
    log.warn(`boot: seedLvisHomeDocs failed (non-fatal): ${String(err)}`);
  }

  // §4.2 Step 0-1 + 4-5: Core services.
  const core = await bootstrapCoreServices(mainWindow);
  const {
    pythonPath,
    pythonRuntime,
    bashAstValidator,
    auditService,
    settingsService,
    memoryManager,
    keywordEngine,
    toolRegistry,
    routeEngine,
  } = core;

  // Issue #837 — one-shot idempotent migration: re-canonicalize user-approval
  // user-approval keys after PR #828 upgraded canonicalStringify to RFC 8785
  // JCS deep recursion. Runs after bootstrapCoreServices so any failure is
  // caught internally and logged without aborting boot. Noop if marker present.
  await migrateCanonicalization();

  // Shared AuditLogger instance (plugin runtime + hooks + gate).
  const { AuditLogger } = await import("./audit/audit-logger.js");
  const { safeStorage } = await import("electron");
  const {
    FileSecretStore,
    SafeStorageSecretStore,
    ensureAuditSecret,
  } = await import("./audit/hmac-chain.js");
  const bootAuditLogger = new AuditLogger();
  const permissionAuditSecretStore = safeStorage.isEncryptionAvailable()
    ? new SafeStorageSecretStore(safeStorage)
    : new FileSecretStore();
  bootAuditLogger.setupPermissionAuditChain(
    ensureAuditSecret(permissionAuditSecretStore),
    permissionAuditSecretStore,
  );

  // Issue #260 — system notification service. Constructed up-front so
  // turn-end, routine, ask-user, approval, plugin, and system cues can call .fire().
  // Live mainWindow getter avoids a stale handle after Electron close+reopen.
  const notificationService = new NotificationService({
    getMainWindow,
    auditLogger: bootAuditLogger,
  });
  if (lvisHomeDocUpgradeMarkers.length > 0) {
    const markerSummary =
      lvisHomeDocUpgradeMarkers.length === 1
        ? `~/.lvis/${lvisHomeDocUpgradeMarkers[0].markerPath}`
        : t("be_boot.upgradeMarkersPlural", { count: String(lvisHomeDocUpgradeMarkers.length) });
    notificationService.fire({
      kind: "system",
      title: t("be_boot.upgradeNotificationTitle"),
      body: t("be_boot.upgradeNotificationBody", { markerSummary }),
    });
  }
  // Routine delivery sites pass `notificationService` explicitly per-call so
  // there's no module-level singleton to reset between tests/processes.

  // Issue #748 — seed the in-memory plugin-auth-partition tracker from disk so
  // uninstall can wipe partitions created in prior app sessions (not just the
  // current runtime). Wire persistence callbacks so every new observation is
  // immediately flushed to `~/.lvis/plugins/auth-partitions.json`.
  //
  // Sweep crashed-write tombstones from prior session before reading current state.
  // Non-fatal — continue boot if sweep fails.
  await cleanupStaleTmpFiles().catch((err: unknown) => {
    log.warn(
      "boot: cleanupStaleTmpFiles failed (non-fatal): %s",
      (err as Error).message,
    );
  });
  //
  // Corrupt file → throws loudly with an audit entry instead of silently
  // using an empty set (CLAUDE.md "No Fallback Code" rule).
  await readPersistedPluginAuthPartitions()
    .then((persisted) => {
      if (persisted !== null) seedPluginAuthPartitions(persisted);
    })
    .catch((err) => {
      const msg = (err as Error).message;
      bootAuditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "boot",
        type: "error",
        input: "plugin-auth-partition-store: load failed at boot",
        output: msg,
      });
      throw err;
    });
  wirePluginAuthPartitionPersistence({
    write: writePersistedPluginAuthPartitions,
    delete: deletePersistedPluginAuthPartitions,
    onError: (msg) => {
      bootAuditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "boot",
        type: "error",
        input: "plugin-auth-partition-store: async write/delete failed",
        output: msg,
      });
    },
  });

  // B1 + §F7: ApprovalGate with audit. Constructed BEFORE initPluginRuntime so
  // the per-plugin HostApi factory can wire `agentApproval` namespace to the
  // live gate — without this ordering, plugins receive a hostApi missing the
  // namespace and §8 main-process approval routing silently no-ops.
  const approvalGate = await createApprovalGate(mainWindow, bootAuditLogger, notificationService);

  // §4.2 Step 3 + 5: PluginRuntime + per-plugin HostApi factory.
  // Sweep orphan uninstall tombstones from prior session FIRST (before
  // initPluginRuntime touches pluginsRoot for discovery). The Windows
  // uninstall path leaves tombstones under `<pluginsRoot>/+tombstones+/`
  // when SQLite WAL/SHM handles weren't released in time; this is the only
  // moment where the previous worker process is guaranteed gone.
  //
  // pluginsRoot resolution MUST go through `resolvePluginPaths()` (which
  // honors the `LVIS_HOME` env override via `lvisHome()`) — `homedir()`
  // alone would silently sweep `~/.lvis/plugins` even in e2e fixtures
  // pointing at a per-test temp dir, masking real bugs.
  // Fire-and-forget — sweep failure must not block boot.
  const sweeperPluginPaths = resolvePluginPaths();
  void sweepOrphanUninstallDirs(sweeperPluginPaths.pluginsRoot, {
    auditFailures: (failures) => {
      // Surface persistent rm failures (typically antivirus / corp endpoint
      // protection holding handles past process death) into the audit log
      // so operators see them beyond the info-level summary line.
      bootAuditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "boot",
        type: "warn",
        input: `plugin-tombstone-sweep-failed root=${sweeperPluginPaths.pluginsRoot}`,
        output: JSON.stringify(failures),
      });
    },
  })
    .then(({ swept, failed }) => {
      if (swept.length > 0 || failed.length > 0) {
        log.info(
          "boot: orphan-uninstall-sweeper swept=%d failed=%d",
          swept.length,
          failed.length,
        );
      }
    })
    .catch((err) => {
      log.warn("boot: orphan-uninstall-sweeper crashed (non-fatal): %s", (err as Error).message);
    });

  // Issue #749 — boot-time purge of stale write-file diff sidecar dirs.
  // Dirs older than 7 days are deleted fire-and-forget. Mirrors the
  // orphan-uninstall-sweeper pattern: failures surface to audit log only.
  const DIFF_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  void purgeStaleSessionDiffDirs(DIFF_CACHE_MAX_AGE_MS)
    .then(({ swept, failed }) => {
      if (swept.length > 0 || failed.length > 0) {
        log.info("boot: diff-cache-sweeper swept=%d failed=%d", swept.length, failed.length);
      }
      if (failed.length > 0) {
        bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "boot",
          type: "warn",
          input: "diff-cache-sweep-failed",
          output: JSON.stringify(failed),
        });
      }
    })
    .catch((err) => {
      log.warn("boot: diff-cache-sweeper crashed (non-fatal): %s", (err as Error).message);
    });

  // #893 Stage 2 — Load the marketplace whitelist registry BEFORE
  // initPluginRuntime. The per-plugin HostApi factory consults the registry
  // synchronously from `getSecret`; if the registry isn't initialized the
  // tier-3 check fails closed with `whitelist-unreachable`. Resolves on every
  // path (success, offline, demo) so a network blip never blocks boot.
  await wireWhitelistRegistry({ bootAuditLogger });

  // Cluster review M1 — PermissionManager is built BEFORE initPluginRuntime
  // so its per-plugin revoke signal can be wired into the resolveApiKey host
  // factory at plugin construction time. The reviewer + broadcast hookups
  // below still happen after pluginRuntime exists (they depend on the
  // mainWindow getter and the registered plugins).
  const permissionManager = await createPermissionManager();

  const {
    pluginRuntime,
    deploymentGuard,
    lateBinding,
    runPluginShutdownHandlers,
    pluginPaths,
  } = await initPluginRuntime({
    projectRoot,
    settingsService,
    memoryManager,
    keywordEngine,
    toolRegistry,
    pythonPath,
    pythonRuntime,
    bootAuditLogger,
    mainWindow,
    networkFetch: pluginNetworkFetch,
    getMainWindow,
    openAuthWindowService,
    openLinkWindowService,
    openAuthPartitionViewerService: (_parent, opts) => openAuthPartitionViewerService(opts),
    clearAuthPartitionService,
    shellOpenExternal: (url: string) => shell.openExternal(url),
    approvalGate,
    // Cluster review M1 — wire PermissionManager so the per-plugin
    // resolveApiKey host implementation can abort outstanding bearers when
    // permission rules change.
    permissionManager,
  });

  // Workflow system tools (S1+S2) — services constructed up-front so the
  // tool registry can register them in one pass below. Late bindings
  // (subAgentRunner, askUserQuestionGate) hop through closures so the
  // ConversationLoop / BrowserWindow are available before the tool fires.
  const routinesStore = new RoutinesStore();
  await routinesStore.load().catch((err) => {
    log.warn("boot: routines load failed (non-fatal): %s", (err as Error).message);
  });
  const routinesScheduler = new RoutinesScheduler(routinesStore);

  // Work board persistence (~/.lvis/work-board/board.json). One-shot,
  // idempotent migration of a legacy plugin-owned board runs BEFORE the
  // store loads so the store's first read picks up the migrated file. The
  // migration is a no-op once the host board exists (P2 wires the
  // runner/engine; the store is pure persistence here).
  const workBoardMigrated = await migrateAgentHubBoardToWorkBoard();
  const workBoardStore = new WorkBoardStore();
  await workBoardStore.load().catch((err) => {
    log.warn("boot: work-board load failed (non-fatal): %s", (err as Error).message);
  });
  // Reset runs interrupted by a prior process exit (persisted active runStatus
  // with no in-flight run) so those items are re-runnable + don't show a stuck
  // "running" badge.
  await workBoardStore
    .reconcileInterruptedRuns()
    .catch((err) =>
      log.warn("boot: work-board run reconcile failed (non-fatal): %s", (err as Error).message),
    );

  // Due-soon nudge: a 60-min tick scans the board and emits
  // `work_board.work_item.due_soon` on the plugin bus for any subscribed
  // due-soon consumer. Deferred-started (after IPC + plugins are up)
  // via services.startWorkBoardDueSoon; the timer is cleared on shutdown.
  const workBoardStorage = createDirStorage(openFeatureNamespace("work-board").dir);

  // First-run onboarding: seed clearly-labelled sample items so a brand-new
  // board demonstrates the agentic flow (create → approve → execute → output)
  // for the user guide. One-time (keyed by a marker file) and skipped when the
  // board was migrated or already has items — a real board is never seeded.
  await seedSampleWorkBoard({
    store: workBoardStore,
    marker: workBoardStorage,
    alreadyMigrated: workBoardMigrated,
    now: Date.now,
  }).catch((err) =>
    log.warn("boot: work-board sample seed failed (non-fatal): %s", (err as Error).message),
  );

  const DUE_SOON_TICK_MS = 60 * 60_000;
  let dueSoonTimer: ReturnType<typeof setInterval> | undefined;
  const runDueSoonScan = (): void => {
    void scanAndEmitDueSoon(workBoardStore, workBoardStorage, emitEvent, Date.now())
      .then((fired) => {
        if (fired.length) log.info("work-board: emitted %d due_soon nudge(s)", fired.length);
      })
      .catch((err) =>
        log.warn("work-board: due_soon scan failed (non-fatal): %s", (err as Error).message),
      );
  };

  const sessionTodoStore = new SessionTodoStore();
  const skillStore = new SkillStore();
  const agentProfileStore = new AgentProfileStore();
  const personaPromptStore = new PersonaPromptStore();
  const skillOverlay = new SkillOverlay();
  const skillApprovalsStore = new SkillApprovalsStore();
  await skillApprovalsStore.load().catch((err) => {
    log.warn(
      "boot: skill-approvals load failed (non-fatal): %s",
      (err as Error).message,
    );
  });
  const askUserQuestionGate = new AskUserQuestionGate(
    // Lazy resolver — dev-mode reloads destroy the captured webContents.
    // Looking it up on every send keeps the gate working across reloads
    // and across window recreation.
    () => getMainWindow()?.webContents ?? null,
    undefined,
    notificationService,
  );
  let subAgentRunnerRef: { fn: SubAgentRunner | undefined } = { fn: undefined };
  // ApprovalGate ref — gate is constructed up-front (before initPluginRuntime)
  // so this is bound immediately. skill_load reuses the same gate the
  // executor uses so user-authored skills pop the approval modal on first
  // load (and only on first load).
  let approvalGateRef: { fn: import("./permissions/approval-gate.js").ApprovalGate | undefined } = { fn: approvalGate };
  const workflowDeps: WorkflowToolDeps = {
    routinesStore,
    sessionTodoStore,
    skillStore,
    agentProfileStore,
    skillOverlay,
    skillApprovalsStore,
    getAskUserQuestionGate: () => askUserQuestionGate,
    getApprovalGate: () => approvalGateRef.fn,
    getSubAgentRunner: () => subAgentRunnerRef.fn,
    emitAgentSpawn: (event: AgentSpawnEvent) => {
      try {
        getMainWindow()?.webContents.send("lvis:agent-spawn:event", event);
      } catch (err) {
        log.warn("agent_spawn emit failed: %s", (err as Error).message);
      }
    },
    emitSkillLoad: (event: SkillLoadEvent) => {
      try {
        getMainWindow()?.webContents.send("lvis:skill-load:event", event);
      } catch (err) {
        log.warn("skill_load emit failed: %s", (err as Error).message);
      }
    },
    networkFetch,
    privateNetworkFetch,
    demoActiveVendor,
    demoHostMap,
    demoHostMapApplied: isAppliedDemoHostMap,
  };

  // §4.2 Step 4: builtin tools + request_plugin / tool_search meta tools.
  registerBuiltinTools(toolRegistry, settingsService, workflowDeps);
  registerRequestPluginMetaTool(toolRegistry);
  // Statically registered; visible whenever builtins are in scope because
  // tool-level deferral is the only plugin/MCP schema exposure path.
  registerToolSearchMetaTool(toolRegistry);

  // §4.4 HybridRetriever + Knowledge Tools DI, §6.1 IdleSchedulerService.
  const { idleScheduler, knowledgeAvailable } = await wireKnowledgeAndIdleScheduler({
    pluginRuntime,
    toolRegistry,
    auditService,
  });

  // §9.5 marketplace backend selection.
  const marketplaceSettings = settingsService.get("marketplace");
  // Marketplace fetcher selection — single production path:
  //   - real-cloud + URL → CloudMarketplaceFetcher
  //   - otherwise (no URL configured) → DisabledMarketplaceFetcher
  // No `MockMarketplaceFetcher` fallback at boot. Default points at the
  // production tunnel (`https://marketplace.lvisai.xyz`); dev operators
  // running the marketplace server locally override via the settings UI.
  // Tests inject their own fetcher.
  let marketplaceFetcher: MarketplaceFetcher;
  if (marketplaceSettings.cloudBaseUrl) {
    marketplaceFetcher = new CloudMarketplaceFetcher({
      baseUrl: marketplaceSettings.cloudBaseUrl,
      apiKey: settingsService.getSecret("marketplace.apiKey") ?? undefined,
      allowPrivateNetwork: marketplaceSettings.cloudAllowPrivateNetwork,
    });
    log.info("boot: marketplace backend = real-cloud (%s)", marketplaceSettings.cloudBaseUrl);
  } else {
    marketplaceFetcher = new DisabledMarketplaceFetcher();
    log.warn("boot: marketplace backend disabled (no cloudBaseUrl configured)");
  }
  const pluginMarketplace = new PluginMarketplaceService(
    pluginPaths,
    marketplaceFetcher,
    deploymentGuard,
    bootAuditLogger,
  );

  // Closure invoked by the settings IPC handler when MarketplaceTab fields
  // change. Re-reads the persisted `marketplace.cloudAllowPrivateNetwork`
  // value and pushes it into the live CloudMarketplaceFetcher so the
  // SSRF-guard bypass toggle takes effect on the next request (honoring the
  // "즉시 적용" UX badge). No-op when the fetcher is the disabled variant —
  // a disabled marketplace has no live config to refresh.
  const refreshMarketplaceFetcherConfig = (): void => {
    if (!(marketplaceFetcher instanceof CloudMarketplaceFetcher)) return;
    const next = settingsService.get("marketplace").cloudAllowPrivateNetwork ?? false;
    marketplaceFetcher.updateAllowPrivateNetwork(next);
  };

  // #893 — Push the active LLM vendor id into the plugin runtime's wildcard
  // configOverrides slot. Plugins read this via
  // `hostApi.config.get("hostApiVendor")` so a plugin that needs an LLM call
  // doesn't have to ship its own vendor-detection logic. Called once at
  // boot (after plugin runtime is available) and again after every
  // llm-settings IPC change.
  //
  // PR #894 review B2: we no longer inject `hostApiKey` here. The actual
  // secret must always flow through `hostApi.getSecret("llm.apiKey.<vendor>")`,
  // which routes through the three-tier allowlist gate (only plugins that
  // declare the matching `hostSecrets.read[]` entry receive the key).
  // Injecting the apiKey into a wildcard config slot bypassed that gate
  // — every plugin received the key via `config.get("hostApiKey")`
  // regardless of its manifest. Removing it closes that hole.
  // PR #894 Cycle 3 T1-2 — factory extracted to
  // `boot/steps/refresh-active-llm-wildcard.ts` so the debounce + vendor-
  // change-restart contract is independently unit-testable. Same semantics
  // as before: first call seeds, subsequent vendor changes trigger a
  // debounced restart sweep of every loaded plugin.
  const { refresh: refreshActiveLlmWildcard } = createRefreshActiveLlmWildcard({
    getActiveVendor: () => settingsService.get("llm").provider,
    setWildcardConfigOverride: (config) => pluginRuntime.setWildcardConfigOverride(config),
    clearWildcardConfigOverride: (keys) => pluginRuntime.clearWildcardConfigOverride(keys),
    listPluginIds: () => pluginRuntime.listPluginIds(),
    restartPlugin: async (pid) => {
      await pluginRuntime.restartPlugin(pid);
    },
  });
  refreshActiveLlmWildcard();

  // §9.5 — Managed plugin bootstrap. Mandatory enterprise plugins are fetched
  // from the marketplace on boot (VS Code-style), not packaged in app source.
  // Graceful: marketplace unreachable or per-plugin failure never bricks boot.
  // Surfaces lifecycle status (start/complete/error) to the renderer
  // so the user sees something when the marketplace is unreachable or
  // partial-fails. The same helper backs the `lvis:bootstrap:retry` IPC.
  await runManagedBootstrap({
    pluginMarketplace,
    pluginRuntime,
    mainWindow,
    marketplace: marketplaceSettings,
  });

  // §4.5.9: SystemPromptBuilder.
  // Skills use progressive disclosure: lightweight catalog every turn, full
  // bodies only after skill_load and only for the current user-turn window.
  const systemPromptBuilder = createSystemPromptBuilder({
    memoryManager,
    toolRegistry,
    pluginRuntime,
    getAvailableSkills: () => skillStore.listCatalogSync(),
    getActiveSkillsSection: (sessionId) => skillOverlay.buildSection(sessionId),
  });
  // §6.3: PermissionManager — instance was constructed before
  // initPluginRuntime (cluster M1) so the resolveApiKey host wiring could
  // see it. Now that toolRegistry is built, push the visibility deny
  // rules across.
  toolRegistry.setDenyRules(permissionManager.getVisibilityDenyRules());

  // Permission policy P4 — Layer 5 reviewer agent wiring.
  // Reads `permissions.reviewer` from `~/.lvis/settings.json` and binds the
  // classifier + cache + deferred queue onto the live PermissionManager so
  // `dispatchReviewer()` routes HIGH verdicts into the deferred queue.
  // For mode=llm, build an adapter over the host's existing
  // VercelUnifiedProvider streaming surface — the reviewer needs only a
  // one-shot complete() call shape.
  const reviewerStreamProviderFor = (vendor: string): LLMProvider | null => {
    // Reviewer legacy provider names still resolve through the shared map.
    // Active-LLM following passes canonical LLMVendor names directly.
    const llmVendor = reviewerVendorFor(vendor) ?? (isLLMVendor(vendor) ? vendor : null);
    if (!llmVendor) return null;
    const llmSettings = settingsService.get("llm");
    const block = llmSettings.vendors[llmVendor];
    const apiKey = settingsService.getSecret(secretKeyFor(llmVendor));
    const isVertex = llmVendor === "vertex-ai";
    if (!apiKey && !isVertex) return null;
    if (
      isVertex &&
      !block.vertexProject &&
      !process.env.GOOGLE_CLOUD_PROJECT &&
      !process.env.GCLOUD_PROJECT
    ) {
      return null;
    }
    return createProvider({
      vendor: llmVendor,
      apiKey: apiKey ?? "",
      model: block.model,
      ...(llmVendor === "azure-foundry" ? { fetch: llmFetch } : {}),
      ...(block.baseUrl ? { baseUrl: block.baseUrl } : {}),
      ...(block.vertexProject ? { vertexProject: block.vertexProject } : {}),
      ...(block.vertexLocation ? { vertexLocation: block.vertexLocation } : {}),
    });
  };
  const readActiveReviewerLlm = () => {
    const llm = settingsService.get("llm");
    const provider = llm.provider;
    const block = llm.vendors[provider];
    return {
      provider,
      model: block.model,
      ...(block.baseUrl ? { baseUrl: block.baseUrl } : {}),
      ...(block.vertexProject ? { vertexProject: block.vertexProject } : {}),
      ...(block.vertexLocation ? { vertexLocation: block.vertexLocation } : {}),
    };
  };
  const rewireReviewerAgent = (): void => {
    wireReviewerAgent({
      permissionManager,
      readActiveLlm: readActiveReviewerLlm,
      streamProviderFor: reviewerStreamProviderFor,
      // Key inheritance — Foundry reads llm.apiKey.azure-foundry,
      // GCP playground reads llm.apiKey.gemini. Both use the same secret
      // store as the chat LLM providers so no new UI is required.
      getSecret: (key) => settingsService.getSecret(key),
      // Foundry endpoint is a plain (non-secret) setting: the same
      // llm.vendors.azure-foundry.baseUrl field used by the chat provider.
      getFoundryEndpoint: () =>
        settingsService.get("llm").vendors["azure-foundry"]?.baseUrl ?? null,
      onDeferredPendingChange: (summary) => {
        sendToWindow(getMainWindow(), PERMISSIONS.deferredPending, summary, log);
      },
    });
    // A re-wire updates the runtime reviewer mode (notably the
    // llm-degraded-to-rule → llm heal driven by login or settings:update).
    // setReviewer itself does not broadcast, so an already-open PermissionsTab
    // would keep showing a stale degrade banner. Push a config-changed event so
    // its onConfigChanged subscription refetches reviewerDegradedToRule and the
    // banner clears the moment a provider/key heals the reviewer.
    broadcastPermissionConfigChangedFromIpc({ getMainWindow, getAppWindows: () => BrowserWindowValue.getAllWindows() } as Parameters<typeof broadcastPermissionConfigChangedFromIpc>[0]);
  };
  rewireReviewerAgent();

  // CRITICAL 4.1: wire memory-hit auto-approve IPC broadcast once at boot.
  // The broadcast fn is stable across rewires (always sends to the current mainWindow).
  permissionManager.setBroadcastUserApprovalHit((payload) => {
    sendToWindow(getMainWindow(), PERMISSIONS.userApprovalHit, payload, log);
  });

  // Round-4 fix: PermissionManager is the architectural choke point for
  // every persisted rule mutation (addAlwaysAllowedPersist /
  // addAlwaysDeniedPersist / removeRule). Wiring the broadcast here means
  // executor-side dialog approvals (always allow / always deny), slash
  // `/permission rules add|remove`, and the IPC addRule/removeRule
  // handlers all reach multi-window PermissionsTab — without each
  // call site re-implementing the wiring.
  permissionManager.setBroadcastConfigChanged(() => {
    broadcastPermissionConfigChangedFromIpc({ getMainWindow, getAppWindows: () => BrowserWindowValue.getAllWindows() } as Parameters<typeof broadcastPermissionConfigChangedFromIpc>[0]);
  });

  // Manifest integrity proxy. Subscribes the audit logger so every read→write
  // violation lands in `~/.lvis/audit/` and pushes an IPC notification to the
  // renderer. Uses the live mainWindow getter so cross-restart UI keeps
  // receiving events.
  bindManifestIntegrityAudit(bootAuditLogger);
  manifestIntegrityState.onViolation((pluginId, toolName, attempted) => {
    try {
      getMainWindow()?.webContents.send(PERMISSIONS.manifestViolation, {
        pluginId,
        toolName,
        attempted,
      });
    } catch (err) {
      log.warn(
        "manifest-violation IPC emit failed (non-fatal): %s",
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  // In-process HookRunner kept for internal/test hook registration only.
  // Production external hooks flow through ScriptHookManager below so strict
  // quarantine + explicit user trust registration is the single path.
  const hookRunner = createHookRunner();

  // Permission policy P4 — Layer 6 script-hook system (individual `pre-*.sh` /
  // `post-*.sh` / `perm-*.sh` files under `~/.config/lvis/hooks/`).
  // Production boot has no renderer approval prompt: untrusted or changed hook
  // files are strict-denied and moved to `.disabled/`.
  const hookSystem = await wireHookSystem({ auditLogger: bootAuditLogger });
  const scriptHookManager = hookSystem.manager;

  const pluginSurfaceExecutor = new ToolExecutor(
    toolRegistry,
    hookRunner,
    permissionManager,
    bashAstValidator,
    approvalGate,
    scriptHookManager,
    bootAuditLogger,
    () => settingsService.get("features")?.hostClassifiesRisk ?? false,
  );
  const pluginSurfacePermissionScope = createPluginSurfacePermissionScope({
    readPersistedDirectories: () => readPermissionSettings().permissions.additionalDirectories,
    onSessionDirectoryAdded: () => {
      broadcastPermissionConfigChangedFromIpc({ getMainWindow, getAppWindows: () => BrowserWindowValue.getAllWindows() } as Parameters<typeof broadcastPermissionConfigChangedFromIpc>[0]);
    },
  });
  const invokePluginTool = async (
    toolName: string,
    payload: unknown,
    context: PluginToolInvocationContext,
  ): Promise<unknown> => {
    // Issue #664 P2 — UI-origin chain propagation. Enter an
    // AsyncLocalStorage frame so nested ctx.callTool(...) invocations from
    // a wrapper handler inherit the outermost UI origin. `parentOrigin`
    // is the explicit handoff (e.g. tests / future bridges that want to
    // pin the chain start); the ambient chain (set by an outer
    // invokePluginTool) takes precedence over a bare "plugin" current so
    // a UI→wrapper→inner chain stays UI all the way down.
    return runWithInvocationOrigin(context.origin, context.parentOrigin, async () => {
      const effectiveOrigin = currentInvocationOrigin() ?? context.origin;
      if (isUiOnlyRuntimeInvocation(pluginRuntime, toolName, context, effectiveOrigin)) {
        return pluginRuntime.call(toolName, toPluginToolInput(payload));
      }

      const [result] = await pluginSurfaceExecutor.executeAll(
        [{
          id: randomUUID(),
          name: toolName,
          input: toPluginToolInput(payload),
        }],
        {
          sessionId: pluginInvocationSessionId(context),
          permissionContext: pluginSurfacePermissionScope.createPermissionContext(context, {
            // headless follows the *effective* chain origin (#664 P2):
            // a UI-rooted chain keeps `headless: false` even after one or
            // more `ctx.callTool` hops, so the user's outer approval is
            // honoured and the reviewer lane is not re-engaged.
            headless: effectiveOrigin !== "ui",
            trustOrigin: "plugin-emitted",
          }),
        },
      );
      if (!result) {
        throw new Error(`Plugin tool '${toolName}' produced no executor result`);
      }
      if (result.is_error) {
        throw new Error(result.content);
      }
      if (Object.prototype.hasOwnProperty.call(result, "rawResult")) {
        return result.rawResult;
      }
      return result.content;
    });
  };
  lateBinding.pluginToolInvokerRef.fn = invokePluginTool;
  pluginRuntime.setToolInvocationDelegate(invokePluginTool);

  // §7: Routine Engine — 루틴마다 독립된 ConversationLoop를 생성하는 factory를 주입.
  // interactive 채팅의 ConversationLoop 인스턴스를 공유하면 세션 히스토리 오염 및
  // concurrent IPC 채팅 턴과의 race condition이 발생한다. factory는 stateless deps만
  // 캡처하므로 순환 의존 없이 즉시 바인딩할 수 있다.
  const routineLoopDeps = {
    settingsService,
    systemPromptBuilder,
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager,
    permissionManager,
    approvalGate,
    hookRunner,
    scriptHookManager,
    bashAstValidator,
    pluginRuntime,
    auditLogger: bootAuditLogger,
    llmFetch,
  };
  const routineEngine = createRoutineEngine({
    createConversationLoop: (input) => createRoutineConversationLoop(
      routineLoopDeps,
      { scope: input.scope },
    ),
    // Permission policy Layer 4 — snapshot the live plugin runtime's active id set so
    // routines with `scope.pluginIds.mode === "inherit"` are normalized
    // to a concrete allow-list at fire time (never at loop-construction).
    getActivePluginIds: () => pluginRuntime.listPluginIds(),
  });

  // §4.2 Step 7: manifest-driven IPC bridges. Plugin notifications route
  // through `notificationService` (#841) so they inherit the same focus
  // gate, cooldown, sanitization, and audit policy as the host's lifecycle
  // notifications.
  let disposePluginNotifications = registerPluginNotifications(pluginRuntime, mainWindow, notificationService, bootAuditLogger);
  let disposePluginEventBridge = registerPluginEventBridge(pluginRuntime, mainWindow);
  let pluginEventBridgeWindow = mainWindow;
  const replacePluginEventBridge = (win: BrowserWindow) => {
    pluginEventBridgeWindow = win;
    disposePluginEventBridge();
    disposePluginEventBridge = registerPluginEventBridge(pluginRuntime, win);
  };

  // §4.5 + Agent 6: PostTurnHookChain.
  const { postTurnHookChain } = createPostTurnHookChain({
    memoryManager,
    idleScheduler,
    settingsService,
    auditLogger: bootAuditLogger,
    sessionTodoStore,
  });

  // ApprovalGate already constructed above (before initPluginRuntime) so the
  // plugin HostApi factory could wire `agentApproval` to the live gate.
  // approvalGateRef was bound at construction time.

  // §4.5: ConversationLoop.
  const conversationLoop = createConversationLoop({
    settingsService,
    systemPromptBuilder,
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager,
    permissionManager,
    routineEngine,
    idleScheduler,
    postTurnHookChain,
    bashAstValidator,
    approvalGate,
    hookRunner,
    scriptHookManager,
    getAdditionalDirectories: () => readPermissionSettings().permissions.additionalDirectories,
    // Round-3 fix: dialog-driven session-add grants must broadcast so
    // multi-window PermissionsTab refreshes. Boot owns getMainWindow
    // and forwards it to the broadcaster declared in the permissions
    // IPC domain — no engine→ipc coupling, just a callback handed down.
    broadcastPermissionConfigChanged: () => {
      broadcastPermissionConfigChangedFromIpc({ getMainWindow, getAppWindows: () => BrowserWindowValue.getAllWindows() } as Parameters<typeof broadcastPermissionConfigChangedFromIpc>[0]);
    },
    pluginRuntime,
    skillOverlay,
    sessionTodoStore,
    notificationService,
    auditLogger: bootAuditLogger,
    rewireReviewerAgent,
    llmFetch,
  });

  // Late-binding 주입 — ConversationLoop 생성 직후.
  lateBinding.conversationLoopRef.fn = conversationLoop;
  lateBinding.llmCallerRef.fn = createCallLlm(conversationLoop);
  lateBinding.pluginCallLlmRef.fn = createCallLlmForPlugin(conversationLoop, bootAuditLogger);
  log.info("boot: plugin callLlm ready (rate-limited)");

  const preferenceRefreshService = new PreferenceRefreshService({
    memoryManager,
    generateText: lateBinding.llmCallerRef.fn,
    idleScheduler,
    isIdleRefreshEnabled: () => settingsService.get("features")?.idlePreferenceRefresh ?? true,
  });
  preferenceRefreshService.start();

  // Workflow system tools — late bindings now that ConversationLoop exists.
  // SubAgentRunner reuses the parent loop's deps (LLM, registry, gates) but
  // a fresh ConversationLoop is constructed per spawn inside the runner.
  subAgentRunnerRef.fn = new SubAgentRunner({
    parentDeps: {
      settingsService,
      systemPromptBuilder,
      keywordEngine,
      routeEngine,
      toolRegistry,
      memoryManager,
      permissionManager,
      approvalGate,
      bashAstValidator,
      hookRunner,
      scriptHookManager,
      auditLogger: bootAuditLogger,
      getAdditionalDirectories: () => readPermissionSettings().permissions.additionalDirectories,
      rewireReviewerAgent,
      llmFetch,
    },
    toolRegistry,
  });
  // skill_load no longer mutates conversation history. The body is registered
  // into SkillOverlay for the current user-turn window and read by
  // SystemPromptBuilder via getActiveSkillsSection. See main/skill-overlay.ts
  // for the registry; src/tools/skill-load.ts for the tool entry point.

  // WorkBoardEngine — plan→approve→execute orchestration for one work item.
  // Wired here, right after the SubAgentRunner exists, because the engine
  // reuses the runner (via the late-bound subAgentRunnerRef closure) for both
  // child phases. emitProgress mirrors emitAgentSpawn — it pushes a
  // WorkBoardRunEvent to the renderer over the WORK_BOARD.runProgress channel.
  const workBoardEngine: WorkBoardEngine = createWorkBoardEngine({
    store: workBoardStore,
    getRunner: () => subAgentRunnerRef.fn,
    approvalGate,
    getAgentProfile: (name) => agentProfileStore.load(name),
    emitProgress: (event) => {
      // Fan the per-phase WorkBoardRunEvent out to every open window (mirroring
      // the itemChanged broadcast in the work-board IPC domain) so detached
      // panels show the live running indicator in lock-step. sendToWindow's
      // destroyed-check + send-race swallow is reused per window.
      fanOutToAllWindows(BrowserWindowValue.getAllWindows(), WORK_BOARD.runProgress, event, {
        logger: log,
      });
    },
    // Self-improvement (Hermes): after a run completes, append a one-line
    // learning to the work-board MEMORY.md. appendMemory enforces the hard
    // line cap; the engine fires this swallow-on-error so it never fails a run.
    onRunComplete: ({ itemId, title }) =>
      appendMemory(workBoardStorage, [
        `${new Date().toISOString().slice(0, 10)}: 자율 실행 완료 — #${itemId} ${title}`,
      ]),
    // Persist each run's plan+execute conversation to sessions/<id>/<runId>.jsonl
    // so run context survives restart and accumulates across re-runs.
    transcriptStorage: workBoardStorage,
  });

  // Work Board reporter — host-native daily/weekly reports. Reuses the
  // work-board namespace storage (the same activity.jsonl + memories/ the store
  // writes) and the host one-shot LLM caller wired above.
  const workBoardReporter: WorkBoardReporter = createWorkBoardReporter({
    store: workBoardStore,
    storage: workBoardStorage,
    callLlm: lateBinding.llmCallerRef.fn,
    emit: emitEvent,
  });

  // RoutinesScheduler v2 — fires per due routine, branching on execution mode.
  // llm-session routines start a ConversationLoop with prePrompt.
  // notification-only routines fire an OS notification.
  routinesScheduler.onLlmSession(({ routine }) => {
    // Routine turns use a dedicated ConversationLoop but persist through the
    // normal session repository as sessionKind="routine".
    // Emit running-started/finished so renderer can show progress indicator.
    void (async () => {
      const firedAt = routine.lastFiredAt ?? new Date().toISOString();
      const title = routine.title ?? routine.notificationTitle ?? routine.id.slice(0, 8);

      // C1: runningStarted before the headless turn finishes — enriched payload
      // with title+firedAt so renderer can push a proper running OverlayItem
      // immediately. The completed event later carries the routineSessionId.
      try {
        getMainWindow()?.webContents.send(ROUTINES_V2.runningStarted, {
          routineId: routine.id,
          firedAt,
          title,
        });
      } catch {
        // non-fatal
      }

      let runSummary = "";
      let routineSessionId: string | undefined;
      try {
        const runResult = await routineEngine.runRoutine({
          id: routine.id,
          trigger: routine.trigger,
          prePrompt: routine.prePrompt ?? "",
          title: routine.title,
          scope: routine.scope,
          firedAt,
        });
        runSummary = runResult.summary;
        routineSessionId = runResult.sessionId;
        if (routineSessionId) {
          const updated = await routinesStore.update(routine.id, { lastRoutineSessionId: routineSessionId });
          if (!updated) {
            log.warn("routines v2 llm-session session id persist failed: routine not found (%s)", routine.id);
          }
        }
      } catch (err) {
        log.warn("routines v2 llm-session run failed: %s", (err as Error).message);
        // Emit failed so renderer knows to clear running state.
        try {
          getMainWindow()?.webContents.send(ROUTINES_V2.failed, {
            routineId: routine.id,
            error: (err as Error).message,
          });
        } catch {
          // non-fatal
        }
      } finally {
      // Always clear running state regardless of success/failure.
        try {
          getMainWindow()?.webContents.send(ROUTINES_V2.runningFinished, routine.id);
        } catch {
          // non-fatal
        }
      }
      // Use LLM response summary directly — no extractSummary needed.
      const summary = runSummary;
      // Explicit allowlist payload — no ...routine spread to prevent PII leak.
      try {
        getMainWindow()?.webContents.send(ROUTINES_V2.fired, {
          id: routine.id,
          trigger: routine.trigger,
          execution: routine.execution,
          firedAt,
          title,
          summary,
          ...(routineSessionId ? { routineSessionId } : {}),
        } satisfies import("./shared/routines-types.js").RoutineFiredPayload);
      } catch (err) {
        log.warn("routines v2 llm-session emit failed: %s", (err as Error).message);
      }
    })();
  });
  routinesScheduler.onNotification(({ routine }) => {
    try {
      notificationService.fire({
        kind: "routine",
        title: routine.notificationTitle ?? routine.title ?? t("be_boot.routineNotificationFallbackTitle"),
        body: routine.notificationBody ?? "",
        contextRef: { routineId: routine.id },
      });
    } catch (err) {
      log.warn("routines v2 notification emit failed: %s", (err as Error).message);
    }
    // Emit fired event for notification-only branch so the UI reflects the
    // fire consistently across both execution modes.
    // Explicit allowlist — no ...routine spread to prevent prePrompt/notificationBody leak.
    try {
      const firedAt = routine.lastFiredAt ?? new Date().toISOString();
      const title = routine.title ?? routine.notificationTitle ?? routine.id.slice(0, 8);
      getMainWindow()?.webContents.send(ROUTINES_V2.fired, {
        id: routine.id,
        trigger: routine.trigger,
        execution: routine.execution,
        firedAt,
        title,
        summary: "",
      } satisfies import("./shared/routines-types.js").RoutineFiredPayload);
    } catch (err) {
      log.warn("routines v2 notification fired emit failed: %s", (err as Error).message);
    }
  });
  // L1: NOT started here. Boot order matters — if scheduler.start() runs
  // before the renderer has its IPC listeners attached, a past-due
  // routine fires immediately into a void. main.ts now invokes
  // `services.startRoutinesScheduler()` AFTER `registerIpcHandlers()` to
  // close that gap.

  // §9.5: MCP Server 연결.
  const mcpGovernance = new McpGovernance();
  // MRTR live-resolver wiring (milestone mrtr-input-loop): a server's
  // `input_required` (elicitation) is gathered through the host approval gate.
  const mcpInputResolverFactory = createElicitationResolverFactory({ approvalGate });
  const mcpManager = new McpManager(
    mcpGovernance,
    toolRegistry,
    undefined,
    permissionManager,
    bootAuditLogger,
    mcpInputResolverFactory,
  );
  try {
    const configs = await mcpManager.loadFromConfig();
    if (configs.length > 0) {
      await mcpManager.connectAll();
      log.info("boot: MCP servers connected");
    }
  } catch (err) {
    log.warn("boot: MCP initialization failed (non-fatal): %s", (err as Error).message);
  }
  mcpGovernance.startPolicyRefresh((revokedIds) => {
    for (const serverId of revokedIds) {
      void mcpManager.killSwitch(serverId).catch((err) => {
        log.error({ serverId, err }, "boot: revoked MCP server kill failed");
      });
    }
  });

  // §FU#259 — MCP marketplace artifact store. Rooted at ~/.lvis/mcp/ so the
  // server config (servers.json) and install directories share one parent —
  // user-controlled state lives under ~/.lvis/, not Electron's userData.
  // Each installed server gets ~/.lvis/mcp/<slug>/; the catalog config sits
  // at ~/.lvis/mcp/servers.json. Constructed only when the fetcher supports
  // verified downloads (the disabled fetcher throws on any download attempt
  // anyway).
  const mcpArtifactStore = (() => {
    if (marketplaceFetcher instanceof DisabledMarketplaceFetcher) return undefined;
    const mcpInstallRoot = resolve(lvisHome(), "mcp");
    return new PluginArtifactStore({
      installRoot: mcpInstallRoot,
      cacheRoot: resolve(mcpInstallRoot, ".cache"),
      fetcher: marketplaceFetcher,
      publicKeys: getBundledPublicKeys(),
    });
  })();
  const agentArtifactStore = (() => {
    if (marketplaceFetcher instanceof DisabledMarketplaceFetcher) return undefined;
    const agentInstallRoot = resolve(lvisHome(), "agents");
    return new PluginArtifactStore({
      installRoot: agentInstallRoot,
      cacheRoot: resolve(agentInstallRoot, ".cache"),
      fetcher: marketplaceFetcher,
      publicKeys: getBundledPublicKeys(),
    });
  })();
  const skillArtifactStore = (() => {
    if (marketplaceFetcher instanceof DisabledMarketplaceFetcher) return undefined;
    const skillInstallRoot = resolve(lvisHome(), "skills");
    return new PluginArtifactStore({
      installRoot: skillInstallRoot,
      cacheRoot: resolve(skillInstallRoot, ".cache"),
      fetcher: marketplaceFetcher,
      publicKeys: getBundledPublicKeys(),
    });
  })();

  // §691: OS-level tool sandbox — initialized via Anthropic sandbox-runtime
  // (ASRT). Runs after MCP connects so the full service graph is ready before
  // adding spawn isolation.
  //
  // ASRT replaces the prior per-OS runners (bwrap / sandbox-exec). It does not
  // spawn the workload: `initialize` starts its proxy/helper machinery and the
  // host-tool spawn path (bash.ts/powershell.ts) calls `wrapToolCommand` to get
  // the `{ argv, env }` it spawns itself.
  //
  // Gate: SAME as before — the user-facing `osToolSandbox` feature flag
  // (Settings → 권한) OR the `LVIS_SANDBOX_ENABLED=1` env escape-hatch. DEFAULT
  // OFF (osToolSandbox ships false; the env var is unset), so this migration
  // does NOT change runtime behavior unless a user has deliberately opted in.
  //
  // SECURITY PROPERTY (preserved from the old sealed registry): the sandbox
  // gate is decided exactly once here at boot. `initializeAsrtSandbox` flips the
  // module-level active flag that bash.ts/powershell.ts read; there is no
  // runtime channel to enable/disable it after boot, so nothing can inject an
  // untrusted sandbox config mid-run.
  //
  // Platform policy:
  //   - macOS / Linux: initialize ASRT when the gate is on.
  //   - Windows: FAIL-CLOSED. ASRT's `isSupportedPlatform()` returns true on
  //     win32, but the Windows path (srt-win.exe) is network-only (no fs
  //     isolation) + needs UAC install + re-login — a half-sandbox we do not
  //     adopt. We do NOT initialize ASRT on win32 unless a SEPARATE explicit
  //     opt-in (`LVIS_SANDBOX_WINDOWS=1`) is set, which defaults off. Current
  //     win32 behavior is isolation=none, so leaving it off is not a regression.
  //   - Linux: if the gate is on but `checkDependencies()` reports errors
  //     (bwrap / socat / ripgrep missing) we FAIL-CLOSED — throw to abort boot
  //     rather than silently dropping to isolation=none (no-fallback rule). The
  //     operator must install the deps or turn the gate off; we never honor the
  //     sandbox opt-in by running tools unsandboxed.
  {
    const {
      initializeAsrtSandbox,
      checkAsrtDependencies,
      computeUnionAllowedDomains,
      normalizeUnionForAsrt,
    } = await import("./permissions/asrt-sandbox.js");
    const { setActiveSandboxCapability } = await import(
      "./permissions/sandbox-capability.js"
    );
    const { sandboxConfinementForPlatform } = await import(
      "./shared/sandbox-capability-info.js"
    );

    const sandboxOptIn =
      (settingsService.get("features")?.osToolSandbox ?? false) ||
      process.env["LVIS_SANDBOX_ENABLED"] === "1";

    if (sandboxOptIn) {
      // Windows fail-closed behind a separate explicit opt-in (defaults off).
      const windowsOptIn = process.env["LVIS_SANDBOX_WINDOWS"] === "1";
      const platformBlocked = process.platform === "win32" && !windowsOptIn;

      if (platformBlocked) {
        log.warn(
          "boot: OS tool sandbox requested but Windows is fail-closed (srt-win is a network-only half-sandbox). " +
            "Tools run with isolation=none. Set LVIS_SANDBOX_WINDOWS=1 to force-enable (not recommended).",
        );
      } else {
        // Linux: refuse to run unsandboxed when the gate is on but deps are
        // missing. macOS/Windows checkDependencies has no hard errors here.
        const deps = await checkAsrtDependencies();
        if (deps.errors.length > 0) {
          // FAIL-CLOSED (PR #1356 architect finding). The operator explicitly
          // requested the sandbox; ASRT cannot run because bwrap/socat/ripgrep
          // are missing. The no-fallback rule forbids silently dropping to an
          // unsandboxed plain spawn — that would honor the opt-in name while
          // delivering isolation=none. Throw so boot aborts loudly: the
          // operator must install the deps or turn the gate off, NOT discover
          // later that "sandboxed" tools ran with no sandbox.
          const message =
            "boot: OS tool sandbox is ON but its dependencies are missing — refusing to start. " +
            "Install the sandbox dependencies (Linux: bwrap, socat, ripgrep) or disable the sandbox " +
            "(Settings → 권한 'OS 도구 샌드박스' off, or unset LVIS_SANDBOX_ENABLED). " +
            `Missing: ${deps.errors.join("; ")}`;
          log.error(message);
          throw new Error(message);
        } else {
          if (deps.warnings.length > 0) {
            log.warn("boot: ASRT dependency warnings: %s", deps.warnings.join("; "));
          }
          // ENFORCED network model (corrects WIRING-A #1356 — see asrt-sandbox.ts
          // NETWORK ENFORCEMENT MODEL header). ASRT 0.0.59's filterNetworkRequest
          // reads ONLY the SHARED config; the per-command customConfig.network is
          // inert for allow/deny. So we set the SHARED config here to:
          //   strictAllowlist: true  ⇒ GLOBAL hard-deny on any out-of-allow-list
          //                            host, with NO askCb fallthrough (strict
          //                            bypasses the callback entirely). The
          //                            WIRING-A interactive askCb prompt cannot
          //                            coexist with strict and is removed.
          //   allowedDomains: UNION  ⇒ every loaded, host-validated plugin's
          //                            manifest.networkAccess.allowedDomains
          //                            (∪ an optional trusted host baseline,
          //                            empty by default). Computed from the
          //                            trusted plugin-runtime seam.
          // Because filterNetworkRequest reads this shared config, egress is
          // genuinely ENFORCED for BOTH workers and host tools.
          //
          // TRADE-OFF (honest): this is a UNION allow-list, not per-worker
          // isolation — a sandboxed process may reach any domain declared by ANY
          // loaded plugin. Acceptable under LVIS's 1st-party plugin trust model;
          // true per-worker isolation needs a future ASRT with per-process
          // proxies. See asrt-sandbox.ts header.
          //
          // Manifests are already loaded here (this block runs AFTER
          // initPluginRuntime), so the union is computed once at init — no
          // deferred updateConfig needed.
          const manifestAllowLists = pluginRuntime
            .listPluginIds()
            .map((id) => pluginRuntime.getPluginManifest(id)?.networkAccess?.allowedDomains ?? []);
          // Trusted host baseline for host tools is empty by default — no
          // settings surface grants host-tool egress beyond the plugin union.
          // Normalize for ASRT's matcher: a bare `example.com` matches EXACTLY
          // in ASRT (domain-pattern.js), whereas LVIS hostFetch treats it as a
          // dot-boundary suffix. normalizeUnionForAsrt emits both `d` and `*.d`
          // so the sandbox enforces the SAME hosts the fetch path advertises.
          const unionAllowedDomains = normalizeUnionForAsrt(
            computeUnionAllowedDomains(manifestAllowLists, []),
          );

          // Trust boundary: WEAKENING flags are NOT set here (deny-by-default,
          // no Apple events / weaker isolation / unix-socket opening). Only the
          // enforced allow-list + strict flag. Per-command filesystem scoping
          // (write-jail + HOME read-deny) is applied at the call site via the
          // narrow `filesystem` option, never here as a weakening channel.
          await initializeAsrtSandbox({
            allowedDomains: unionAllowedDomains,
            strictAllowlist: true,
          });
          // Publish the active capability to the SOT now that ASRT is
          // genuinely initialized (gate ON, deps present, not Windows-blocked).
          // detectSandboxCapability + the reviewer/UI consumers read this; the
          // reviewer's `kind === 'asrt'` → strong relaxation becomes reachable
          // ONLY here. When the gate is OFF — or on the Windows fail-closed /
          // Linux deps-missing paths above where ASRT is NOT initialized — we
          // never call this, so the SOT stays kind="none" (isolation=none),
          // matching reality. ASRT confines fs + process + network on both
          // macOS (Seatbelt) and Linux (bwrap); the per-wrap FS jail + the
          // shared strict-union network floor are both enforced.
          const asrtBackend =
            process.platform === "darwin" ? "Seatbelt" : "bwrap";
          setActiveSandboxCapability({
            kind: "asrt",
            confidence: "verified",
            platform: process.platform,
            reason: `ASRT (${asrtBackend}) active — fs+process+network contained`,
            // Machine-checkable confinement for the host-shell substrate. ASRT
            // confines fs + process + network egress on macOS (Seatbelt) and
            // Linux (bwrap); both are full per sandboxConfinementForPlatform.
            confines: sandboxConfinementForPlatform(process.platform, "full"),
          });
          log.info(
            "boot: ASRT OS tool sandbox initialized (%s, strict allow-list enforced, %d union domains across %d plugins)",
            process.platform,
            unionAllowedDomains.length,
            manifestAllowLists.length,
          );
        }
      }
    } else if (process.platform === "darwin") {
      log.info(
        "boot: OS tool sandbox gated off (enable via Settings → 권한 'OS 도구 샌드박스' or LVIS_SANDBOX_ENABLED=1)",
      );
    }
  }

  log.info("boot: ready (%d tools, %d plugins, %d mcp)", toolRegistry.size, pluginRuntime.listPluginIds().length, mcpManager.listServers().filter(s => s.status === "connected").length);

  // Watcher telemetry consumer — plugin-emitted watcher poll events are
  // appended to ~/.lvis/logs/watcher-poll.jsonl. This is the pre-metrics
  // pipeline raw source for cold-seed latency / payload distribution tuning.
  const watcherTelemetryLogPath = resolve(lvisHome(), "logs", "watcher-poll.jsonl");
  const watcherTelemetryCollector = startWatcherTelemetryCollector({
    filePath: watcherTelemetryLogPath,
    subscribe: (type, handler) => onEvent(type, handler),
    log: (msg, meta) => log.warn({ meta }, msg),
  });
  app.on("before-quit", () => watcherTelemetryCollector.stop());

  // Issue #749 — clean up CURRENT session's diff-cache dir on quit.
  // NOTE: only clears the CURRENT session's diff-cache dir. Diff caches from
  // sessions touched earlier in this process lifetime persist on disk until
  // the 7-day boot-time purge. Acceptable trade-off because:
  //   (a) cache content is owner-only (0o600),
  //   (b) boot purge backstop exists,
  //   (c) tracking all touched-session-ids would add lifecycle complexity.
  // Fire-and-forget: quit must not block on I/O.
  app.prependOnceListener("before-quit", () => {
    const sid = conversationLoop.getSessionId();
    if (sid) void clearSessionDiffCache(sid).catch((err: unknown) => {
      log.warn("before-quit: diff-cache clear failed: %s", (err as Error).message);
    });
  });

  // Starred store + feedback store.
  const starredStore = new StarredStore();
  const feedbackStore = new FeedbackStore();

  // §4.2 Step 8: Post-boot — release prep (telemetry/crash/updater) + plugin update-check.
  const { telemetry, pluginTelemetry, autoUpdaterStop } = wireReleasePrep({
    mainWindow,
    settingsService,
    bootAuditLogger,
  });
  wireUpdateCheck({
    mainWindow,
    settingsService,
    marketplaceFetcher,
    pluginPaths,
  });
  wireAnnouncementCheck({
    getMainWindow,
    settingsService,
    marketplaceFetcher,
  });

  let shutdownPromise: Promise<void> | null = null;

  return {
    pythonRuntime, pythonPath,
    pluginRuntime, pluginMarketplace, settingsService,
    memoryManager, keywordEngine, routeEngine, toolRegistry,
    systemPromptBuilder, conversationLoop, routineEngine, mcpManager, mcpArtifactStore, agentArtifactStore, skillArtifactStore,
    idleScheduler, preferenceRefreshService, bashAstValidator, auditService, auditLogger: bootAuditLogger, postTurnHookChain,
    approvalGate, rewireReviewerAgent, refreshMarketplaceFetcherConfig, refreshActiveLlmWildcard,
    routinesStore, routinesScheduler, workBoardStore, workBoardEngine, workBoardReport: workBoardReporter, sessionTodoStore, askUserQuestionGate, skillStore, agentProfileStore, personaPromptStore,
    knowledgeAvailable, starredStore, feedbackStore,
    notificationService,
    scriptHookManager,
    telemetry, pluginTelemetry, autoUpdaterStop, runPluginShutdownHandlers,
    pluginPaths,
    clearAuthPartitionService,
    forgetPluginAuthPartitionsService,
    listPluginAuthPartitionsService,
    startRoutinesScheduler: () => routinesScheduler.start(),
    startWorkBoardDueSoon: () => {
      runDueSoonScan();
      dueSoonTimer = setInterval(runDueSoonScan, DUE_SOON_TICK_MS);
    },
    refreshPluginNotifications: () => {
      disposePluginNotifications();
      disposePluginNotifications = registerPluginNotifications(pluginRuntime, pluginEventBridgeWindow, notificationService, bootAuditLogger);
      replacePluginEventBridge(pluginEventBridgeWindow);
    },
    registerPluginEventBridge: replacePluginEventBridge,
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        disposePluginNotifications();
        disposePluginEventBridge();
        autoUpdaterStop?.();
        telemetry?.stop();
        pluginTelemetry?.stop();
        preferenceRefreshService.stop();
        idleScheduler?.stop();
        routinesScheduler.stop();
        if (dueSoonTimer) clearInterval(dueSoonTimer);
        askUserQuestionGate.disposeAll();
        mcpGovernance.stopPolicyRefresh();
        await mcpManager.disconnectAll();
        await auditService.stop();
      })();
      return shutdownPromise;
    },
  };
}
