/**
 * Boot §4.2 Step 3-5 — plugin lifecycle callbacks (C6 extraction).
 *
 * Behavior-preserving move of the preparePluginStart / onDisable /
 * onActiveStateChange / onEnable closures out of initPluginRuntime. These fire
 * on post-boot lifecycle events (and onEnable during startAll), so the mutable
 * `pluginRuntime` + `loopbackManager` bindings are read through getters — never
 * value-captured at factory construction (both are assigned AFTER this factory
 * is built).
 */
import { BrowserWindow as ElectronBrowserWindow } from "electron";
import type { BrowserWindow } from "electron";
import { t } from "../../../i18n/index.js";
import { createLogger } from "../../../lib/logger.js";
import { sendToWindow } from "../../../ipc/safe-send.js";
import { declaresHostManagedPythonRuntime } from "./manifest.js";
import type { PluginRuntime, PluginRuntimeOptions } from "../../../plugins/runtime.js";
import type { PluginLoopbackManager } from "../../../mcp/plugin-loopback-manager.js";
import type { KeywordEngine } from "../../../core/keyword-engine.js";
import type { PythonRuntimeBootstrapper } from "../../../main/python-runtime.js";
import type { LateBindingRefs } from "../plugin-runtime.js";

const log = createLogger("lvis");

/** Explicit deps for the lifecycle callbacks. Lazy bindings arrive as getters. */
export interface LifecycleDeps {
  getPluginRuntime: () => PluginRuntime;
  getLoopbackManager: () => PluginLoopbackManager;
  keywordEngine: KeywordEngine;
  lateBinding: LateBindingRefs;
  getMainWindow?: () => BrowserWindow | null;
  mainWindow: BrowserWindow;
  pythonRuntime?: PythonRuntimeBootstrapper;
  installLoadedPluginPartitionPolicy: (pluginId: string) => void;
}

/**
 * Build the four PluginRuntime lifecycle callbacks. Returned as a
 * `Pick<PluginRuntimeOptions, ...>` so the closure params keep the same
 * contextual types they had inline in `new PluginRuntime({...})`.
 */
export function createLifecycleCallbacks(
  deps: LifecycleDeps,
): Pick<PluginRuntimeOptions, "preparePluginStart" | "onDisable" | "onActiveStateChange" | "onEnable"> {
  const {
    getPluginRuntime,
    getLoopbackManager,
    keywordEngine,
    lateBinding,
    getMainWindow,
    mainWindow,
    pythonRuntime,
    installLoadedPluginPartitionPolicy,
  } = deps;

  return {
    preparePluginStart: ({ pluginId, manifest, manifestPath, reportProgress }) => {
      if (!pythonRuntime || !declaresHostManagedPythonRuntime(manifest)) return undefined;
      const win = getMainWindow?.() ?? mainWindow;
      return (async () => {
        reportProgress?.({
          phase: "pending",
          message: t("be_pluginRuntime.pluginRuntimePreparationStarting"),
          progressPct: 5,
        });
        const runtime = await pythonRuntime.ensureReadyForPluginManifest(manifestPath, win, (status) => {
          reportProgress?.({
            phase: status.phase,
            message: status.msg,
            progressPct: status.pct,
          });
        });
        if (!runtime) {
          throw new Error(`plugin '${pluginId}' declares host-managed Python but no accessible lockfile was found`);
        }
        reportProgress?.({
          phase: "ready",
          message: t("be_pluginRuntime.pluginRuntimeReady"),
          progressPct: 100,
        });
        const pluginRuntime = getPluginRuntime();
        pluginRuntime.mergeConfigOverride(pluginId, { pythonExecutable: runtime.pythonPath });
        log.info("plugin dependency runtime ready: %s -> %s", pluginId, runtime.pythonPath);
      })();
    },
    onDisable: (pluginId) => {
      const loopbackManager = getLoopbackManager();
      keywordEngine.unregisterByPlugin(pluginId);
      // legacy-removal flag-day: the loopback manager owns every plugin's tools —
      // stopping its host unregisters them.
      void loopbackManager.stop(pluginId).catch((err) =>
        log.error(`loopback plugin stop failed (${pluginId}): %s`, (err as Error).message),
      );
      lateBinding.conversationLoopRef.fn?.onPluginDisabled(pluginId);
    },
    onActiveStateChange: (pluginId, enabled) => {
      if (!enabled) {
        keywordEngine.unregisterByPlugin(pluginId);
        lateBinding.conversationLoopRef.fn?.onPluginDisabled(pluginId);
        return;
      }
      const pluginRuntime = getPluginRuntime();
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      if (!keywordEngine.hasPluginKeywords(pluginId) && manifest?.keywords && manifest.keywords.length > 0) {
        keywordEngine.registerKeywords(manifest.keywords.map((k) => ({ ...k, pluginId })));
        log.debug(`plugin:${pluginId} re-registered ${manifest.keywords.length} keywords on activation`);
      }
    },
    // Symmetric to `onDisable` — re-registers tools after a successful
    // restart/add/reload. Without this every chat-surface tool call hits
    // `도구를 찾을 수 없습니다` post-restart (see PR #760). Non-fatal:
    // a sync exception is logged but does not become `runtime reload failed`.
    onEnable: (pluginId) => {
      const pluginRuntime = getPluginRuntime();
      const loopbackManager = getLoopbackManager();
      // `restartAll()` is also the managed-marketplace first-sync path:
      // ensureManagedInstalled() writes the registry, then restartAll() loads
      // the new plugin without emitting plugin.installed. Register the
      // partition preload here so freshly managed plugin UIs get
      // window.lvisPlugin immediately instead of only after app restart.
      installLoadedPluginPartitionPolicy(pluginId);
      // legacy-removal flag-day: ALL plugins register through the loopback manager
      // (server/discover → tools/list → reverse projection from `_meta`) — the
      // legacy `pluginToolsForRegistration` direct path is gone.
      const enabledManifest = pluginRuntime.getPluginManifest(pluginId);
      if (enabledManifest) {
        void loopbackManager.start(enabledManifest).catch((err) =>
          log.error(`loopback plugin start failed (${pluginId}): %s`, (err as Error).message),
        );
      }
      // Runtime restart/reload can reach loaded+started after a prior teardown.
      // registerKeywords usually runs through hostApi during start(); keep this
      // guarded manifest replay as the lifecycle safety net without duplicating
      // entries or reviving user-inactive plugins.
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      if (
        pluginRuntime.isPluginEnabled(pluginId) &&
        !keywordEngine.hasPluginKeywords(pluginId) &&
        manifest?.keywords &&
        manifest.keywords.length > 0
      ) {
        keywordEngine.registerKeywords(manifest.keywords.map((k) => ({ ...k, pluginId })));
        log.debug(`plugin:${pluginId} re-registered ${manifest.keywords.length} keywords on enable`);
      }
      // Best-effort renderer refresh signal. Runtime/tool registry state is
      // already updated; a closed window must not make reload fail —
      // sendToWindow owns the isDestroyed guard + send try/catch.
      for (const win of ElectronBrowserWindow.getAllWindows()) {
        sendToWindow(win, "lvis:plugins:runtime-updated", { pluginId }, log);
      }
    },
  };
}
