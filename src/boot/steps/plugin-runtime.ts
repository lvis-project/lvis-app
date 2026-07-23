/**
 * Boot §4.2 Step 3-5 — Plugin runtime + HostApi factory.
 *
 * Extracted from boot.ts to keep orchestration thin. This module:
 *   • constructs the PluginDeploymentGuard and plugin runtime integrity gate
 *   • builds the per-plugin HostApi factory (registerKeywords / emitEvent /
 *     onEvent / getSecret / callLlm /
 *     logEvent / onShutdown)
 *   • creates the PluginRuntime, starts plugins, registers plugin tools,
 *     and wires the dev hot-reload watcher
 *   • returns the runtime + late-binding refs (llmCallerRef / pluginCallLlmRef /
 *     conversationLoopRef) that boot.ts injects once ConversationLoop exists.
 *
 * No plugin-specific literals here — everything is manifest-driven.
 */
import { app } from "electron";
import type { BrowserWindow } from "electron";
import { mkdirSync } from "node:fs";
import { installPluginPartitionPolicy } from "../../main/html-preview-partition.js";
import { isAppUpdateInstallRequested } from "../../main/app-update-install-intent.js";
import { pluginPartitionName } from "../../shared/plugin-partition.js";
import { onEvent as onHostEvent } from "../types.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { PluginRuntime } from "../../plugins/runtime.js";
import type { PythonRuntimeBootstrapper } from "../../main/python-runtime.js";
import { startPluginDevWatcher } from "../../plugins/dev-watcher.js";
import { PluginDeploymentGuard } from "../../plugins/deployment-guard.js";
import {
  setIsPackaged,
  shouldWarnPackagedFlagsIgnored,
  tamperedVarsAtBoot,
} from "../dev-flags.js";
import { resolvePluginPaths } from "../../plugins/plugin-paths.js";
import type {
  AuthWindowCookie,
  OpenAuthWindowBaseOptions,
  OpenAuthWindowFinalUrlResult,
} from "../../plugins/types.js";
import type { KeywordEngine } from "../../core/keyword-engine.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { SettingsService } from "../../data/settings-store.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import type { RoutinesStore } from "../../main/routines-store.js";
import { buildPluginConfigOverrides } from "../plugins.js";
import { PluginLoopbackManager } from "../../mcp/plugin-loopback-manager.js";
import type { PluginBundleLifecycleHandler } from "../../plugins/plugin-bundle-lifecycle.js";
import { createLogger } from "../../lib/logger.js";

// ── C5 extraction — pure/self-contained clusters now live under
//    ./plugin-runtime/*; imported here for the C6 orchestrator body and
//    re-exported below so the public contract stays importable from this path.
import { approvalIssuerRegistry } from "./plugin-runtime/approval-gating.js";
import { buildAppPreferenceReader } from "./plugin-runtime/app-preference.js";
// ── C6 extraction — HIGH-RISK orchestrator clusters (HostApi factory +
//    lifecycle callbacks + registry-entry cache) now live under
//    ./plugin-runtime/*; wired into initPluginRuntime below.
import { createHostApiFactory } from "./plugin-runtime/host-api-factory.js";
import { createLifecycleCallbacks } from "./plugin-runtime/lifecycle.js";
import { createRegistryEntryCache } from "./plugin-runtime/registry-cache.js";
const log = createLogger("lvis");

// ── C5 re-exports — preserve this module path's public export contract. ──────
export { declaresHostManagedPythonRuntime } from "./plugin-runtime/manifest.js";
export { approvalIssuerRegistry, auditApprovalViolation } from "./plugin-runtime/approval-gating.js";
export {
  HOST_PUBLIC_PREFERENCE_KEYS,
  buildAppPreferenceReader,
} from "./plugin-runtime/app-preference.js";
export type { HostPublicPreferenceKey } from "./plugin-runtime/app-preference.js";
export { EXTERNAL_LINK_PARTITION, routeExternalUrl } from "./plugin-runtime/external-url.js";
export {
  TRIGGER_CONVERSATION_DEDUPE_TTL_MS,
  TriggerConversationDedupe,
  TRIGGER_CONVERSATION_RATE_LIMIT_WINDOW_MS,
  TRIGGER_CONVERSATION_RATE_LIMIT_MAX_CALLS,
  sanitizePluginPendingPrompt,
  formatPluginPendingPrompt,
  OVERLAY_SUMMARY_DISPLAY_CAP,
  deriveOverlaySummaryForDisplay,
  TriggerConversationRateLimiter,
  TriggerDenyAuditThrottle,
  evaluateTriggerSpec,
  normalizeTriggerSpecFields,
} from "./plugin-runtime/trigger-gate.js";
export type {
  EvaluateTriggerSpecInput,
  EvaluateTriggerSpecOutcome,
} from "./plugin-runtime/trigger-gate.js";

/** Late-binding container the ConversationLoop fills in after it exists. */
export interface LateBindingRefs {
  llmCallerRef: {
    fn:
      | ((prompt: string, opts?: { maxTokens?: number; systemPrompt?: string; signal?: AbortSignal }) => Promise<string>)
      | null;
  };
  pluginCallLlmRef: {
    fn:
      | ((
          pluginId: string,
          prompt: string,
          opts?: { maxTokens?: number; systemPrompt?: string; signal?: AbortSignal },
        ) => Promise<string>)
      | null;
  };
  conversationLoopRef: {
    fn: import("../../engine/conversation-loop.js").ConversationLoop | null;
  };
  pluginToolInvokerRef: {
    // The gated tool-invocation delegate installed by the `plugin-tool-executor`
    // boot step. Typed off the SoT (`PluginToolInvocationDelegate` →
    // `PluginToolInvocationContext.origin` → `InvocationOrigin`), never an inline
    // restatement of the origin union — a narrower structural copy here silently
    // desynced from the runtime's own delegate type and would reject a new origin.
    fn: import("../../plugins/runtime.js").PluginToolInvocationDelegate | null;
  };
}

export interface InitPluginRuntimeInput {
  projectRoot: string;
  settingsService: SettingsService;
  memoryManager: MemoryManager;
  keywordEngine: KeywordEngine;
  toolRegistry: ToolRegistry;
  pythonPath: string | undefined;
  pythonRuntime?: PythonRuntimeBootstrapper;
  bootAuditLogger: AuditLogger;
  mainWindow: BrowserWindow;
  /**
   * Electron `net`-backed fetch (Chromium stack: OS proxy incl. PAC/WPAD + OS
   * trust store). Backs the capability-gated `hostApi.hostFetch`. Eager (exists
   * at boot) so it needs no late binding, unlike the LLM caller.
   */
  networkFetch: typeof fetch;
  getMainWindow?: () => BrowserWindow | null;
  openAuthWindowService: (
    parent: BrowserWindow,
    opts: OpenAuthWindowBaseOptions & { returnFinalUrl?: boolean },
  ) => Promise<AuthWindowCookie[] | OpenAuthWindowFinalUrlResult>;
  /**
   * §B3 — Light external-link viewer used when
   * `settings.webView.preferredFlow === "in-app"`. Distinct from
   * `openAuthWindowService` (no cookieHosts / completionUrlPatterns).
   * Tests inject a stub; production wiring is `openLinkWindow` from
   * `src/main/link-window-service.ts`.
   */
  openLinkWindowService: (
    parent: BrowserWindow,
    opts: { url: string; windowTitle?: string; persistPartition?: string },
  ) => Promise<void>;
  /**
   * Issue #649 — viewer that loads a URL inside the *caller plugin's*
   * `persist:plugin-auth:<pluginId>` partition so AAD/OIDC cookies deposited
   * by an earlier `openAuthWindow` produce silent SSO. Production wiring is
   * `openAuthPartitionViewer` from `src/main/auth-partition-viewer-service.ts`;
   * tests inject a stub.
   */
  openAuthPartitionViewerService: (
    parent: BrowserWindow,
    opts: import("../../main/auth-partition-viewer-service.js").OpenAuthPartitionViewerOptions,
  ) => Promise<void>;
  /**
   * SDK 5.6.0 — wipe-partition surface used by plugin `clearAuthPartition`
   * to delete cookies / storage / cache / HTTP-auth from one of the
   * plugin's own `persist:plugin-auth:<pluginId>[:<sub>]` partitions
   * after a user-triggered sign-out. Production wiring is
   * `clearAuthPartition` from `src/main/auth-window-service.ts`; tests
   * inject a stub.
   */
  clearAuthPartitionService: (partition: string) => Promise<void>;
  /**
   * §B3 — System browser opener used when
   * `settings.webView.preferredFlow === "system-browser"`. Production wiring
   * is `shell.openExternal` from electron; tests inject a spy.
   */
  shellOpenExternal: (url: string) => Promise<void>;
  /**
   * Cluster review M1 — optional PermissionManager reference. When provided,
   * the per-plugin `resolveApiKey` host implementation merges the manager's
   * `getPluginRevokeSignal` with the caller's request signal so a permission
   * rule change aborts outstanding bearers across plugins. Optional so unit
   * tests that build a minimal runtime can skip the wiring; production boot
   * (boot.ts) always passes the live instance.
   */
  permissionManager?: import("../../permissions/permission-manager.js").PermissionManager;
  /**
   * §8 — required ApprovalGate instance. The `agentApproval` namespace on
   * every plugin's HostApi is wired to this gate so main-process plugin
   * handlers can respond to pending approvals without going through the
   * renderer-only preload bridge. Required (not optional) so that boot
   * sequence inversion is impossible — if approvalGate is not yet built,
   * initPluginRuntime cannot be called.
   */
  approvalGate: import("../../permissions/approval-gate.js").ApprovalGate;
  /**
   * Routines SOT — backs the per-plugin `hostApi.hasRoutineBySource` idempotency
   * query. Injected (not late-bound) because the per-plugin HostApi factory runs
   * during `startAll()` inside this step, so the store must already exist; boot
   * therefore constructs it BEFORE calling initPluginRuntime.
   */
  routinesStore: RoutinesStore;
}

export interface InitPluginRuntimeOutput {
  pluginRuntime: PluginRuntime;
  deploymentGuard: PluginDeploymentGuard;
  lateBinding: LateBindingRefs;
  pluginShutdownHandlers: Array<{ pluginId: string; handler: () => void | Promise<void> }>;
  runPluginShutdownHandlers: () => Promise<void>;
  /** SoT — shared with MarketplaceService + post-boot update detector. */
  pluginPaths: ReturnType<typeof resolvePluginPaths>;
  /**
   * Owns each plugin's in-process loopback MCP host. Exposed so the render IPC's
   * unified `ui://` resolver can try the loopback host (serverId === pluginId)
   * before the external `mcpManager.clients` registry.
   */
  loopbackManager: PluginLoopbackManager;
  /** Late-bind bundle projections after workflow, Hook, and MCP services exist. */
  setBundleLifecycleHandler: (handler: PluginBundleLifecycleHandler) => void;
}

/**
 * §4.2 Step 3-5 — construct PluginRuntime, register the per-plugin HostApi
 * factory, start all plugins, register plugin tools into ToolRegistry, and
 * wire the dev hot-reload watcher.
 */
export async function initPluginRuntime(
  input: InitPluginRuntimeInput,
): Promise<InitPluginRuntimeOutput> {
  const {
    projectRoot,
    settingsService,
    keywordEngine,
    toolRegistry,
    pythonPath,
    pythonRuntime,
    bootAuditLogger,
    mainWindow,
    networkFetch,
    getMainWindow,
    openAuthWindowService,
    openLinkWindowService,
    openAuthPartitionViewerService,
    clearAuthPartitionService,
    shellOpenExternal,
    approvalGate,
    permissionManager,
    routinesStore,
  } = input;

  // §B3 — host public preference reader, shared across all per-plugin HostApi
  // instances. Reads `settingsService` live so a Settings toggle is visible on
  // the next plugin call without reload.
  const readAppPreference = buildAppPreferenceReader(settingsService, log);

  // Effect-boundary enforcement — the live `hostClassifiesRisk` read, evaluated
  // PER hostApi call so a Settings toggle is honoured without reload. Same SOT key
  // the executor + conversation-loop providers read (boot.ts). When false
  // (default) the enforcement wrapper is a pure pass-through.
  const hostClassifiesRiskEnabled = (): boolean =>
    settingsService.get("features")?.hostClassifiesRisk ?? false;

  // Plugin shutdown handler registry — fires on before-quit (see shared AuditLogger + hooks wiring).
  const pluginShutdownHandlers: Array<{ pluginId: string; handler: () => void | Promise<void> }> = [];
  let pluginShutdownRan = false;
  let pluginShutdownPromise: Promise<void> | null = null;
  const runPluginShutdownHandlers = (): Promise<void> => {
    if (pluginShutdownRan) return pluginShutdownPromise ?? Promise.resolve();
    if (pluginShutdownHandlers.length === 0) return Promise.resolve();
    pluginShutdownRan = true;
    const SHUTDOWN_TIMEOUT_MS = 5000;
    pluginShutdownPromise = (async () => {
      await Promise.allSettled(
        pluginShutdownHandlers.map(async ({ pluginId, handler }) => {
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              Promise.resolve().then(() => handler()),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`shutdown handler timeout [plugin:${pluginId}]`)), SHUTDOWN_TIMEOUT_MS);
              }),
            ]);
          } catch (err) {
            log.warn(`shutdown handler error [plugin:${pluginId}]: %s`, (err as Error).message);
          } finally {
            if (timer) clearTimeout(timer);
          }
        }),
      );
    })();
    return pluginShutdownPromise;
  };
  app.prependOnceListener("before-quit", (event) => {
    if (isAppUpdateInstallRequested()) return;
    if (pluginShutdownHandlers.length === 0 || pluginShutdownRan) return;
    event.preventDefault();
    void (async () => {
      await runPluginShutdownHandlers();
      app.quit();
    })();
  });

  // Generic configOverrides plus declarative pythonExecutable injection.
  const configOverrides = buildPluginConfigOverrides(settingsService);
  if (pythonPath) {
    configOverrides["*"] = {
      ...(configOverrides["*"] ?? {}),
      pythonExecutable: pythonPath,
    };
  }

  // §7.2 Plugin Deployment Guard.
  // Plugin layout anchors at `lvisHome()/plugins/<id>/` — single root for both
  // user-installed and admin-injected plugins (distinguished by metadata,
  // not by physical directory). The resolver always uses
  // `lvisHome()/plugins`; E2E overrides LVIS_HOME once and every caller
  // follows the same app-home SOT.
  const pluginPaths = resolvePluginPaths();
  // mkdir the root once so the trust-root realpath check in PluginRuntime
  // (and any first-install write under pluginsRoot/<id>/) doesn't trip on a
  // missing directory the very first time the app boots.
  mkdirSync(pluginPaths.pluginsRoot, { recursive: true });
  const deploymentGuard = new PluginDeploymentGuard({
    registryPath: pluginPaths.registryPath,
    pluginsRoot: pluginPaths.pluginsRoot,
  });

  // #958/#959 security — registry-entry cache (host-verified installSource +
  // install-time manifest SHA pin; `plugin.json` is untrusted). Extracted to
  // ./plugin-runtime/registry-cache.ts and wired here so the HostApi closures
  // answer lookups synchronously and the install/uninstall listeners refresh it.
  const { refreshRegistryEntryCache, getRegistryEntry } = createRegistryEntryCache({
    registryPath: pluginPaths.registryPath,
    log,
  });
  await refreshRegistryEntryCache();

  // Late-binding refs for ConversationLoop-dependent callers.
  const lateBinding: LateBindingRefs = {
    llmCallerRef: { fn: null },
    pluginCallLlmRef: { fn: null },
    conversationLoopRef: { fn: null },
    pluginToolInvokerRef: { fn: null },
  };

  // §Step 4 — wire `app.isPackaged` into the dev-flag gate before any
  // helper or downstream module reads it. Packaged builds with LVIS_DEV* set
  // get a single audit warning, never a per-flag enumeration.
  setIsPackaged(app.isPackaged);
  if (shouldWarnPackagedFlagsIgnored()) {
    // Snapshot was captured at `dev-flags.ts` import time, BEFORE
    // `main.ts:67-73` scrubbed the vars from `process.env`. Listing the
    // specific names lets operators distinguish a stale launcher
    // (`LVIS_PLUGINS_DIR`) from an active dev tamper (`LVIS_DEV=1`).
    const names = tamperedVarsAtBoot();
    log.error(`LVIS_DEV* ignored in packaged build: ${names.join(", ")}`);
  }

  // Plugin-owned OAuth removed host-owned provider auth APIs. The related
  // capability is advisory metadata only; there is no host-side auth gate.
  let pluginRuntime!: PluginRuntime;
  // Owns the loopback hosts for every plugin — each runs as an in-process MCP
  // server (mcp-alignment-design.md §3.1). Assigned right after PluginRuntime
  // construction; the lifecycle closures below capture it and only fire on
  // post-boot events.
  let loopbackManager!: PluginLoopbackManager;
  let bundleLifecycle: PluginBundleLifecycleHandler | undefined;

  const installLoadedPluginPartitionPolicy = (pluginId: string): void => {
    installPluginPartitionPolicy(pluginPartitionName(pluginId), {
      pluginRoot: pluginRuntime.getPluginRoot(pluginId),
    });
  };

  // §Step 1 + §Step 2 — thread the user-installed dir as a second
  // trust root and the unsigned-user-plugin opt-in flag.
  // C6 — build the extracted factories. Lazy bindings (pluginRuntime,
  // loopbackManager) are passed as getters so the eventual assignments below
  // are visible; both are still unassigned at this point (never value-captured).
  const createHostApi = createHostApiFactory({
    getPluginRuntime: () => pluginRuntime,
    lateBinding,
    getRegistryEntry,
    hostClassifiesRiskEnabled,
    keywordEngine,
    pluginShutdownHandlers,
    readAppPreference,
    settingsService,
    bootAuditLogger,
    networkFetch,
    mainWindow,
    openAuthWindowService,
    openLinkWindowService,
    openAuthPartitionViewerService,
    clearAuthPartitionService,
    shellOpenExternal,
    approvalGate,
    permissionManager,
    routinesStore,
  });
  const { preparePluginStart, onDisable, onActiveStateChange, onEnable } =
    createLifecycleCallbacks({
      getPluginRuntime: () => pluginRuntime,
      getLoopbackManager: () => loopbackManager,
      keywordEngine,
      lateBinding,
      getMainWindow,
      mainWindow,
      pythonRuntime,
      installLoadedPluginPartitionPolicy,
      getBundleLifecycle: () => bundleLifecycle,
    });

  pluginRuntime = new PluginRuntime({
    hostRoot: projectRoot,
    pluginsRoot: pluginPaths.pluginsRoot,
    registryPath: pluginPaths.registryPath,
    configOverrides,
    deploymentGuard,
    installReceiptCacheRoot: pluginPaths.cacheRoot,
    auditLog: (level, message, data) => {
      try {
        bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "plugin-runtime",
          type: level === "error" ? "error" : "tool_call",
          input: `[${level.toUpperCase()}] ${message}`,
          output: data === undefined ? undefined : JSON.stringify(data).slice(0, 500),
        });
      } catch {}
    },
    preparePluginStart,
    onDisable,
    onActiveStateChange,
    onEnable,
    createHostApi,
  });

  // AC1.2 — periodic purge of stale ApprovalIssuerRegistry entries.
  // ApprovalGate's per-request timeout (default 5 min) resolves deny-once but
  // doesn't reach back into this registry; if the respond path is never hit
  // (renderer crash, plugin crash) the issuer entry would leak. We sweep on
  // a 1-minute cadence, dropping anything older than the gate timeout. The
  // interval is cleared on `before-quit` to avoid keeping the process alive
  // during shutdown.
  const APPROVAL_REGISTRY_PURGE_MAX_AGE_MS = 5 * 60 * 1000;
  const APPROVAL_REGISTRY_PURGE_INTERVAL_MS = 60 * 1000;
  const approvalRegistryPurgeTimer = setInterval(() => {
    try {
      const purged = approvalIssuerRegistry.purgeStalerThan(
        APPROVAL_REGISTRY_PURGE_MAX_AGE_MS,
      );
      if (purged > 0) {
        log.info("approval issuer registry purged %d stale entries", purged);
      }
    } catch (err) {
      log.warn("approval registry purge failed: %s", (err as Error).message);
    }
  }, APPROVAL_REGISTRY_PURGE_INTERVAL_MS);
  // Don't keep the event loop alive solely for this housekeeping timer.
  approvalRegistryPurgeTimer.unref?.();
  app.prependOnceListener("before-quit", () => {
    clearInterval(approvalRegistryPurgeTimer);
  });

  // PluginRuntime now exists — wire the loopback manager before any plugin
  // starts (startAll fires onEnable, whose closures use it).
  loopbackManager = new PluginLoopbackManager(pluginRuntime, toolRegistry);

  await pluginRuntime.startAll();
  log.info("boot: plugins loaded: %s", pluginRuntime.listToolNames());

  // Pre-register the per-partition `setPreloads(...)` policy for every
  // loaded plugin (#498). Electron's `<webview partition="persist:plugin:..."
  // preload="...">` honors `preload=` only when sandbox=no; with sandbox=yes
  // the preload script must be registered on the partition's Session via
  // `session.setPreloads()`. The previous attach-time hook in main.ts
  // tries to read `contents.session.partition` to decide which partition
  // got attached, but that property is undocumented and returns
  // `undefined` on current Electron — so the hook never fires `setPreloads`
  // and plugin webviews load without the `lvisPlugin` contextBridge,
  // surfacing as "lvisPlugin bridge missing" in the shell. Pre-registering
  // by walking the loaded-plugin set sidesteps the partition-name read
  // entirely.
  for (const pluginId of pluginRuntime.listPluginIds()) {
    installLoadedPluginPartitionPolicy(pluginId);
  }
  // Cover plugins added AFTER startAll() — deep-link install
  // (`lvis://install/<slug>` → `addPlugin`), dev hot-reload watcher
  // (LVIS_DEV_RELOAD=1), Settings sideload. The boot loop above only sees
  // `startAll`-era plugins; the attach-time hook in main.ts is dead code
  // for these (it reads `contents.session.partition` which is undocumented
  // and returns `undefined`), so the partition policy must be installed at
  // plugin-install time.
  // Install events: partition policy is per-install (Electron `session`s are
  // created lazily and pinned per pluginId), so it stays here. ToolRegistry
  // resync runs through the runtime's `onEnable` hook wired above —
  // `addPlugin` / `restartPlugin` already fire it before this event lands.
  onHostEvent("plugin.installed", (data) => {
    const pluginId = (data as { pluginId?: string } | undefined)?.pluginId;
    if (typeof pluginId !== "string") return;
    installLoadedPluginPartitionPolicy(pluginId);
    // #958/#959 — keep installSource + manifest SHA pin in sync so a freshly
    // installed admin plugin gets both decisions on first call.
    void refreshRegistryEntryCache();
  });

  // Uninstall: `onDisable` only unregisters the removed plugin's tools, but a
  // full resync also sweeps any ghost entries (e.g. a stale registry row from
  // a previous load generation). `onEnable` covers add/restart/reload; it
  // does NOT fire on uninstall, so the listener-driven sync is still load-bearing.
  onHostEvent("plugin.uninstalled", (data) => {
    const pluginId = (data as { pluginId?: string } | undefined)?.pluginId;
    if (typeof pluginId !== "string") return;
    // legacy-removal flag-day: reconcile the loopback hosts to the post-uninstall
    // runtime state (stops the removed plugin's host, leaves the rest).
    void loopbackManager
      .syncAll(pluginRuntime.listPluginManifests())
      .catch((err) =>
        log.error(`loopback re-sync failed after plugin.uninstalled (${pluginId}): %s`, (err as Error).message),
      );
    // #958/#959 — drop the stale cache entry so a re-install does not inherit
    // the previous Tier-3 bypass or manifest SHA decision.
    void refreshRegistryEntryCache();
  });

  // legacy-removal flag-day: ALL plugins register through the loopback manager
  // (server/discover → tools/list → reverse projection). This replaces the legacy
  // `syncPluginToolRegistry` sweep + `pluginToolsForRegistration`. Awaited so tool
  // registration completes before boot proceeds.
  await loopbackManager.syncAll(pluginRuntime.listPluginManifests());

  // I2 — Dev-mode live-reload watcher. No-op unless LVIS_DEV_RELOAD=1.
  // ToolRegistry resync runs through the runtime's `onEnable` callback wired
  // above — `reloadPlugin` fires it on success — so the watcher only
  // surfaces the hot-reload log line here.
  const pluginDevWatcher = startPluginDevWatcher({
    pluginRuntime,
    onReloaded: (pluginId) => {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      if (!manifest) return;
      log.info(`plugin:${pluginId} hot-reloaded (${manifest.tools.length} tools)`);
    },
  });
  app.prependOnceListener("before-quit", () => { pluginDevWatcher.stop(); });

  return {
    pluginRuntime,
    deploymentGuard,
    lateBinding,
    pluginShutdownHandlers,
    runPluginShutdownHandlers,
    pluginPaths,
    loopbackManager,
    setBundleLifecycleHandler: (handler) => { bundleLifecycle = handler; },
  };
}

// Re-export so boot.ts's return statement can still reach BrowserWindow type.
export type { BrowserWindow };
