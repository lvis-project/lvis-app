/**
 * Boot Sequence — §4.2 (thin orchestrator).
 *
 * `bootstrap()` builds a {@link BootContext} accumulator and threads it through
 * the ordered boot steps under `src/boot/steps/*`, then hands the fully-
 * populated context to {@link assembleAppServices} to build the returned
 * {@link AppServices}. Each step reads prior services from the context and
 * writes its own outputs back onto it; the construction ORDER of the steps is
 * the contract (approvalGate / permissionManager / routinesStore / whitelist
 * before initPluginRuntime; plugin runtime before the ConversationLoop; loop
 * before the late-bound SubAgentRunner — locked by the C3 integration test).
 *
 * The remaining inline glue here is the earliest bring-up (core services,
 * approval gate, permission manager, routines store, plugin runtime) plus the
 * tail lifecycle hooks (watcher telemetry, before-quit diff-cache cleanup,
 * starred/feedback stores, release prep). Everything with real weight lives in
 * a focused step module:
 *
 *   steps/network-fetch-setup     Electron fetch surface (net + private + plugin
 *                                 egress chooser + SSRF-guarded LLM fetch).
 *   steps/audit-notification      shared AuditLogger + NotificationService +
 *                                 plugin auth-partition tracker seeding.
 *   steps/plugin-runtime          PluginRuntime + per-plugin HostApi factory.
 *   steps/work-board-setup        Work Board persistence + due-soon scanner.
 *   steps/workflow-stores         workflow stores + builtin tool registration.
 *   steps/marketplace-setup       marketplace backend + managed bootstrap +
 *                                 live-refresh closures.
 *   steps/reviewer-permission-wiring  reviewer agent + PermissionManager
 *                                 broadcasts + manifest-integrity bridge.
 *   steps/plugin-tool-executor    plugin-surface ToolExecutor + invoke delegate.
 *   steps/conversation-wiring     routine engine + ConversationLoop + late
 *                                 bindings + SubAgentRunner + work-board engine.
 *   steps/routines-wiring         RoutinesScheduler v2 branch wiring.
 *   steps/mcp-setup               MCP servers + signed-artifact stores.
 *   steps/sandbox-init            OS tool sandbox gate + ASRT init.
 *   steps/post-boot               release prep + plugin update-check timer.
 *
 * No plugin-specific code lives here — all plugins register themselves via the
 * HostApi manufactured in `steps/plugin-runtime.ts`.
 */
import { app, shell } from "electron";
import type { BrowserWindow } from "electron";
import { resolve } from "node:path";
import { sweepOrphanUninstallDirs } from "./plugins/orphan-uninstall-sweeper.js";
import { preparePluginRegistryForBoot } from "./plugins/plugin-boot-recovery.js";
import { purgeStaleSessionDiffDirs, clearSessionDiffCache } from "./tools/write-diff-cache.js";
import { resolvePluginPaths } from "./plugins/plugin-paths.js";
import { StarredStore } from "./data/starred-store.js";
import { FeedbackStore } from "./data/feedback-store.js";
import {
  openAuthWindow as openAuthWindowService,
  clearAuthPartition as clearAuthPartitionService,
} from "./main/auth-window-service.js";
import { openLinkWindow as openLinkWindowService } from "./main/link-window-service.js";
import { openAuthPartitionViewer as openAuthPartitionViewerService } from "./main/auth-partition-viewer-service.js";

import { type AppServices, onEvent } from "./boot/types.js";
import { startWatcherTelemetryCollector } from "./boot/steps/watcher-telemetry-collector.js";
import { bootstrapCoreServices } from "./boot/services.js";
import { RoutinesStore } from "./main/routines-store.js";
import { RoutinesScheduler } from "./main/routines-scheduler.js";
import {
  createSystemPromptBuilder,
  createPermissionManager,
  createApprovalGate,
} from "./boot/conversation.js";
import { McpAppModelContextStore } from "./mcp/mcp-app-model-context.js";
import { initPluginRuntime } from "./boot/steps/plugin-runtime.js";
import { wireWhitelistRegistry } from "./boot/steps/whitelist-bootstrap.js";
import { wireAnnouncementCheck, wireReleasePrep, wireUpdateCheck } from "./boot/steps/post-boot.js";
import { migrateCanonicalization } from "./permissions/user-approval-store.js";
import { reconcileWorkspaceRoots } from "./permissions/workspace-root-reconciler.js";
import { createLogger } from "./lib/logger.js";
import { lvisHome } from "./shared/lvis-home.js";
import {
  listLvisHomeDocUpgradeMarkers,
  seedLvisHomeDocs,
  type LvisHomeDocUpgradeMarker,
} from "./main/seed-lvis-home-docs.js";

import { createBootContext } from "./boot/context.js";
import { assembleAppServices } from "./boot/assemble-services.js";
import { setupNetworkFetch } from "./boot/steps/network-fetch-setup.js";
import { setupAuditAndNotification } from "./boot/steps/audit-notification.js";
import { setupWorkBoard } from "./boot/steps/work-board-setup.js";
import { setupWorkflowStores } from "./boot/steps/workflow-stores.js";
import { setupMarketplace } from "./boot/steps/marketplace-setup.js";
import { wireReviewerAndPermissions } from "./boot/steps/reviewer-permission-wiring.js";
import { setupPluginToolExecutor } from "./boot/steps/plugin-tool-executor.js";
import { wireRationaleHost } from "./boot/steps/rationale-host-wiring.js";
import {
  createIsolatedConversationMemoryManagers,
  wireConversation,
} from "./boot/steps/conversation-wiring.js";
import { detachWorkspaceRootSessions } from "./memory/workspace-root-session-lifecycle.js";
import { wireRoutinesScheduler } from "./boot/steps/routines-wiring.js";
import { setupMcp } from "./boot/steps/mcp-setup.js";
import { initSandboxGate } from "./boot/steps/sandbox-init.js";
import { createA2ARemoteRuntime } from "./main/a2a-remote-runtime.js";
import { createRemoteA2AActionController } from "./main/remote-a2a-action-controller.js";
import { buildSingleFlightAgentActionApprover } from "./permissions/agent-action-approver.js";
const log = createLogger("lvis");

export type { AppServices } from "./boot/types.js";

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
  const ctx = createBootContext({ projectRoot, mainWindow, getMainWindow });

  await setupNetworkFetch(ctx);

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
  ctx.lvisHomeDocUpgradeMarkers = lvisHomeDocUpgradeMarkers;

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
  ctx.pythonPath = pythonPath;
  ctx.pythonRuntime = pythonRuntime;
  ctx.bashAstValidator = bashAstValidator;
  ctx.auditService = auditService;
  ctx.settingsService = settingsService;
  ctx.memoryManager = memoryManager;
  ctx.keywordEngine = keywordEngine;
  ctx.toolRegistry = toolRegistry;
  ctx.routeEngine = routeEngine;

  // Issue #837 — one-shot idempotent migration: re-canonicalize user-approval
  // user-approval keys after PR #828 upgraded canonicalStringify to RFC 8785
  // JCS deep recursion. Runs after bootstrapCoreServices so any failure is
  // caught internally and logged without aborting boot. Noop if marker present.
  await migrateCanonicalization();

  // Shared AuditLogger + NotificationService + plugin auth-partition seeding.
  await setupAuditAndNotification(ctx);

  // B1 + §F7: ApprovalGate with audit. Constructed BEFORE initPluginRuntime so
  // the per-plugin HostApi factory can wire `agentApproval` namespace to the
  // live gate — without this ordering, plugins receive a hostApi missing the
  // namespace and §8 main-process approval routing silently no-ops.
  const approvalGate = await createApprovalGate(mainWindow, ctx.bootAuditLogger, ctx.notificationService);
  ctx.approvalGate = approvalGate;
  const remoteA2AAgentActionApprover = buildSingleFlightAgentActionApprover(
    approvalGate,
    {
      onConcurrent: () => ctx.bootAuditLogger.log({ timestamp: new Date().toISOString(), sessionId: "a2a-remote", type: "warn", input: "a2a-remote:approval-concurrent-denied" }),
      onError: () => ctx.bootAuditLogger.log({ timestamp: new Date().toISOString(), sessionId: "a2a-remote", type: "warn", input: "a2a-remote:approval-error-denied" }),
    },
    { allowOnceOnly: true },
  );
  if (!remoteA2AAgentActionApprover) throw new Error("a2a-remote-approval-unavailable");
  ctx.a2aRemoteRuntime = createA2ARemoteRuntime({
    settings: settingsService,
    agentActionApprover: remoteA2AAgentActionApprover,
    projectRoot,
    audit: (code) => ctx.bootAuditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "a2a-remote",
      type: "warn",
      input: `a2a-remote:${code}`,
    }),
  }) ?? undefined;
  await ctx.a2aRemoteRuntime?.ready();
  ctx.remoteA2AActionController = ctx.a2aRemoteRuntime?.gates.outboundRouting
    ? createRemoteA2AActionController({
        runtime: ctx.a2aRemoteRuntime,
        config: settingsService.get("a2aRemote"),
        projectRoot,
      })
    : undefined;

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
  // Recover crash-interrupted replacement rows before runtime discovery. A
  // pending row is visible to bundle planners but hidden from runtime loading;
  // recovery clears it only after exact prior bytes + receipt are proven or
  // restored from its durable backup metadata.
  await preparePluginRegistryForBoot(sweeperPluginPaths)
    .then(({ recovered, unresolved, removals, pendingRecoverySkipped }) => {
      if (removals.restored.length > 0 || removals.cleaned.length > 0 || removals.unresolved.length > 0) {
        log.info(
          "boot: plugin-removal-recovery restored=%d cleaned=%d unresolved=%d",
          removals.restored.length,
          removals.cleaned.length,
          removals.unresolved.length,
        );
        ctx.bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "boot",
          type: removals.unresolved.length > 0 ? "warn" : "info",
          input: "plugin-removal-recovery",
          output: JSON.stringify(removals),
        });
      }
      if (pendingRecoverySkipped) {
        log.warn("boot: pending plugin recovery skipped because removal recovery is unresolved");
      }
      if (recovered.length > 0 || unresolved.length > 0) {
        log.info(
          "boot: plugin-update-recovery recovered=%d unresolved=%d",
          recovered.length,
          unresolved.length,
        );
      }
      if (unresolved.length > 0) {
        ctx.bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "boot",
          type: "warn",
          input: "plugin-update-recovery-unresolved",
          output: JSON.stringify(unresolved),
        });
      }
    })
    .catch((err) => {
      log.warn("boot: plugin migration/recovery failed (pending rows remain hidden): %s", (err as Error).message);
      ctx.bootAuditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "boot",
        type: "warn",
        input: "plugin-migration-recovery-failed",
        output: (err as Error).message,
      });
    });
  void sweepOrphanUninstallDirs(sweeperPluginPaths.pluginsRoot, {
    auditFailures: (failures) => {
      // Surface persistent rm failures (typically antivirus / corp endpoint
      // protection holding handles past process death) into the audit log
      // so operators see them beyond the info-level summary line.
      ctx.bootAuditLogger.log({
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
        ctx.bootAuditLogger.log({
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
  await wireWhitelistRegistry({ bootAuditLogger: ctx.bootAuditLogger });

  // Cluster review M1 — PermissionManager is built BEFORE initPluginRuntime
  // so its per-plugin revoke signal can be wired into the resolveApiKey host
  // factory at plugin construction time. The reviewer + broadcast hookups
  // below still happen after pluginRuntime exists (they depend on the
  // mainWindow getter and the registered plugins).
  const permissionManager = await createPermissionManager();
  ctx.permissionManager = permissionManager;
  // Routines SOT must exist before project reconciliation so durable routine
  // scope pruning can succeed before the permission registry is narrowed.
  const routinesStore = new RoutinesStore();
  await routinesStore.load().catch((err) => {
    log.warn("boot: routines load failed (non-fatal): %s", (err as Error).message);
  });
  ctx.routinesStore = routinesStore;
  // Open every durable conversation namespace before reconciliation. The same
  // instances are wired into the live loops below, preserving root tombstones
  // against late writes in this process.
  const isolatedConversationMemoryManagers = createIsolatedConversationMemoryManagers();
  const workspaceSessionStores = [
    memoryManager,
    isolatedConversationMemoryManagers.sideChatMemoryManager,
    isolatedConversationMemoryManagers.subAgentMemoryManager,
  ];
  // Project roots are persisted permissions, so reconcile them before any
  // plugin receives a HostApi. Confirmed missing/non-directory roots are
  // removed and their path grants pruned; transient filesystem failures retain
  // the user's setting. Conversation JSONL is preserved while stale project
  // metadata is detached and reindexed before the interactive loop is created.
  const rootReconciliation = await reconcileWorkspaceRoots({
    source: "boot",
    auditLogger: ctx.bootAuditLogger,
    permissionManager,
    beforeRemove: async (runtimeRoot, context) => {
      const pruneOptions = { preserveRoots: context.preserveRoots };
      const errors: unknown[] = [];
      let prunedGrants = 0;
      try {
        await routinesStore.revokeWorkspaceRoot(runtimeRoot, pruneOptions);
      } catch (error: unknown) {
        errors.push(error);
      }
      try {
        const pruned = await permissionManager.prunePathGrantsUnderRoot(
          runtimeRoot,
          pruneOptions,
        );
        prunedGrants = pruned.length;
      } catch (error: unknown) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw Object.assign(
          new AggregateError(errors, "workspace-root-durable-scope-cleanup-failed"),
          { code: "WORKSPACE_ROOT_DURABLE_SCOPE_CLEANUP_FAILED" },
        );
      }
      return prunedGrants;
    },
    beforeComplete: async (runtimeRoot) => {
      await detachWorkspaceRootSessions(runtimeRoot, workspaceSessionStores);
    },
  });



  const {
    pluginRuntime,
    deploymentGuard,
    lateBinding,
    runPluginShutdownHandlers,
    pluginPaths,
    loopbackManager,
  } = await initPluginRuntime({
    projectRoot,
    settingsService,
    memoryManager,
    keywordEngine,
    toolRegistry,
    pythonPath,
    pythonRuntime,
    bootAuditLogger: ctx.bootAuditLogger,
    mainWindow,
    networkFetch: ctx.pluginNetworkFetch,
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
    // Idempotency SOT for `hostApi.hasRoutineBySource` (constructed above).
    routinesStore,
  });
  ctx.pluginRuntime = pluginRuntime;
  ctx.deploymentGuard = deploymentGuard;
  ctx.lateBinding = lateBinding;
  ctx.runPluginShutdownHandlers = runPluginShutdownHandlers;
  ctx.pluginPaths = pluginPaths;
  ctx.pluginLoopbackManager = loopbackManager;

  // Workflow system tools (S1+S2) — services constructed up-front so the
  // tool registry can register them in one pass below. Late bindings
  // (subAgentRunner, askUserQuestionGate) hop through closures so the
  // ConversationLoop / BrowserWindow are available before the tool fires.
  // (routinesStore is constructed above — it must exist before initPluginRuntime.)
  const routinesScheduler = new RoutinesScheduler(routinesStore);
  ctx.routinesScheduler = routinesScheduler;

  await setupWorkBoard(ctx);
  await setupWorkflowStores(ctx);
  await setupMarketplace(ctx);

  // §4.5.9: SystemPromptBuilder.
  // Skills use progressive disclosure: lightweight catalog every turn, full
  // bodies only after skill_load and only for the current user-turn window.
  // MCP-app `ui/update-model-context` slots. Constructed HERE because it has exactly two
  // consumers and they must share one instance: the builder below READS it at turn build,
  // and the gated `mcp.uiModelContext` IPC (via AppServices) WRITES it. There is no third
  // path — in particular none into the conversation loop, which is why an app's context
  // update can never start a turn.
  const mcpAppModelContext = new McpAppModelContextStore();
  ctx.mcpAppModelContext = mcpAppModelContext;

  const systemPromptBuilder = createSystemPromptBuilder({
    memoryManager,
    toolRegistry,
    pluginRuntime,
    getAvailableSkills: () => ctx.skillStore.listCatalogSync(),
    getActiveSkillsSection: (sessionId) => ctx.skillOverlay.buildSection(sessionId),
    getAppModelContext: (sessionId) => mcpAppModelContext.buildSection(sessionId),
  });
  ctx.systemPromptBuilder = systemPromptBuilder;

  // Permission policy P4 — reviewer agent + PermissionManager broadcast wiring.
  wireReviewerAndPermissions(ctx);

  // Permission policy P4 — Layer 6 plugin tool execution surface + delegate.
  await setupPluginToolExecutor(ctx);

  // #17 follow-up — recover durable rationale authority before loop publication.
  await wireRationaleHost(ctx);

  // §4.5 + §7: routine engine, ConversationLoop, late bindings, SubAgentRunner,
  // WorkBoardEngine/reporter, and manifest-driven plugin IPC bridges.
  await wireConversation(
    ctx,
    [...new Set([
      ...rootReconciliation.removed.map((removed) => removed.runtimePath),
      ...(rootReconciliation.inactiveRoots ?? []),
    ])],
    isolatedConversationMemoryManagers,
  );

  // §7: RoutinesScheduler v2 execution-branch wiring.
  wireRoutinesScheduler(ctx);

  // §9.5: MCP servers + signed marketplace artifact stores.
  await setupMcp(ctx);

  // §691: OS-level tool sandbox — decided exactly once here at boot.
  await initSandboxGate(ctx);

  log.info("boot: ready (%d tools, %d plugins, %d mcp)", toolRegistry.size, pluginRuntime.listPluginIds().length, ctx.mcpManager.listServers().filter(s => s.status === "connected").length);

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
    const sid = ctx.conversationLoop.getSessionId();
    if (sid) void clearSessionDiffCache(sid).catch((err: unknown) => {
      log.warn("before-quit: diff-cache clear failed: %s", (err as Error).message);
    });
  });

  // Starred store + feedback store.
  const starredStore = new StarredStore();
  const feedbackStore = new FeedbackStore();
  ctx.starredStore = starredStore;
  ctx.feedbackStore = feedbackStore;

  // §4.2 Step 8: Post-boot — release prep (telemetry/crash/updater) + plugin update-check.
  const { telemetry, pluginTelemetry, autoUpdaterStop } = wireReleasePrep({
    mainWindow,
    settingsService,
    bootAuditLogger: ctx.bootAuditLogger,
  });
  wireUpdateCheck({
    mainWindow,
    settingsService,
    marketplaceFetcher: ctx.marketplaceFetcher,
    pluginPaths,
  });
  wireAnnouncementCheck({
    getMainWindow,
    settingsService,
    marketplaceFetcher: ctx.marketplaceFetcher,
  });
  ctx.telemetry = telemetry;
  ctx.pluginTelemetry = pluginTelemetry;
  ctx.autoUpdaterStop = autoUpdaterStop;

  return assembleAppServices(ctx);
}
