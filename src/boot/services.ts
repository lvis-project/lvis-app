/**
 * Boot §4.2 Step 0–1+5 — Core service wiring.
 *
 * Instantiates services that have no plugin dependency and must exist
 * before plugin loading (settings, memory, audit, python runtime coordinator,
 * keyword/route/tool registry + native builtin tools).
 */
import { app } from "electron";
import type { BrowserWindow } from "electron";
import { SettingsService } from "../data/settings-store.js";
import { DEFAULT_LOCALE, normalizeLocale, setLocale, tryLoadLocaleMessages } from "../i18n/index.js";
import { MemoryManager } from "../memory/memory-manager.js";
import { KeywordEngine } from "../core/keyword-engine.js";
import { RouteEngine } from "../core/route-engine.js";
import { ToolRegistry } from "../tools/registry.js";
import { BashTool } from "../tools/bash.js";
import { createFileTools } from "../tools/file-tools.js";
import { PowerShellTool } from "../tools/powershell.js";
import { createReadToolResultChunkTool } from "../tools/tool-result-chunk.js";
import { createMemoryWriteTool } from "../tools/memory-write.js";
import { createBashOutputTool, createBashKillTool } from "../tools/background-shell-tools.js";
import { BashAstValidator } from "../main/bash-ast-validator.js";
import { AuditService } from "../main/audit-service.js";
import { PythonRuntimeBootstrapper } from "../main/python-runtime.js";
import { createLogger, initFileLogSink } from "../lib/logger.js";
import { LOG_RETENTION_DAYS, LOG_MAX_BYTES, reprunePersistedRetention } from "../lib/log-file-sink.js";
import { lvisHome } from "../shared/lvis-home.js";
import { join } from "node:path";
const log = createLogger("lvis");

/**
 * Production log file sink signal (#1499 PR-0). The pino file destination is
 * ATTACHED only for a packaged/production run — an unpackaged dev run keeps the
 * console-only behaviour so `~/.lvis/logs/` is not polluted during development.
 * `LVIS_LOG_FILE=1` force-enables it for local diagnosis of the file path.
 *
 * Mirrors logger.ts's isPackagedElectron detection: packaged Electron leaves
 * `process.defaultApp` undefined; dev runs (`bun run start`) set LVIS_DEV=1.
 */
function shouldEnableFileLogSink(): boolean {
  if (process.env.LVIS_LOG_FILE === "1") return true;
  if (process.env.NODE_ENV === "production") return true;
  const isElectron = !!(process as NodeJS.Process & { versions?: { electron?: string } }).versions
    ?.electron;
  const isPackaged =
    isElectron &&
    !(process as NodeJS.Process & { defaultApp?: boolean }).defaultApp &&
    process.env.LVIS_DEV !== "1";
  return isPackaged;
}

export interface CoreServices {
  pythonPath: string | undefined;
  pythonRuntime: PythonRuntimeBootstrapper;
  bashAstValidator: BashAstValidator;
  auditService: AuditService;
  settingsService: SettingsService;
  memoryManager: MemoryManager;
  keywordEngine: KeywordEngine;
  toolRegistry: ToolRegistry;
  routeEngine: RouteEngine;
}

export async function applyBootLocale(
  settingsService: Pick<SettingsService, "get">,
): Promise<void> {
  const bootLocale = normalizeLocale(settingsService.get("appearance").language);
  const loaded = await tryLoadLocaleMessages(bootLocale);
  setLocale(loaded ? bootLocale : DEFAULT_LOCALE);
}

export async function bootstrapCoreServices(mainWindow: BrowserWindow): Promise<CoreServices> {
  // #1499 PR-0: production log file sink — attach FIRST, before any other core
  // service. It depends only on `lvisHome()` (no SettingsService / locale), so
  // hoisting it to the very top of bootstrap shrinks the window where early
  // boot log lines (settings load, locale apply, audit start) would be lost to
  // the console-only sink. Destination: `~/.lvis/logs/lvis-<date>.log`
  // (0o700 dir + 0o600 file). createLogFileSink prunes files older than
  // LOG_RETENTION_DAYS at attach time; the console stream is unaffected. Failure
  // is swallowed inside initFileLogSink (logging is best-effort, never bricks
  // boot). Teardown is the LAST step of runAppShutdownCleanup (see below), not a
  // `before-quit` listener, so shutdown-step logs still reach the file.
  if (shouldEnableFileLogSink()) {
    const sink = initFileLogSink({
      retentionDays: LOG_RETENTION_DAYS,
      maxBytes: LOG_MAX_BYTES,
    });
    if (sink) {
      log.info({ file: sink.currentFile }, "boot: production log file sink attached");
    }
  }

  // Python runtime coordination is app-owned, but runtime assets and plugin
  // dependencies are materialized lazily by plugin-level async prepare.
  const pythonRuntime = new PythonRuntimeBootstrapper();
  let pythonPath: string | undefined;
  void mainWindow;

  // §4.2 Step 0.5: Governance Services (Agent 6)
  const bashAstValidator = new BashAstValidator({ mode: "deny" });

  const auditService = new AuditService();
  await auditService.start();

  // §4.2 Step 1: Config
  // Pass the OS locale so a fresh install seeds the UI language from the
  // system rather than defaulting to English. getPreferredSystemLanguages()
  // returns BCP-47 tags ordered by user preference (e.g. ["ko-KR", "en-US"]);
  // normalizeLocale inside SettingsService coerces to a supported locale.
  // app.getPreferredSystemLanguages() requires app.whenReady() — bootstrapCoreServices
  // is always called after that point (see boot/index.ts).
  const settingsService = new SettingsService({
    userDataPath: app.getPath("userData"),
    systemLocale: app.getPreferredSystemLanguages()[0],
    secretPolicy: app.isPackaged ? "packaged" : "development",
  });
  await settingsService.migrateSecrets();

  // Set the main-process UI locale from persisted settings (or system-detected
  // locale on fresh install) so dialog titles, native menus, tray, and
  // notifications render in the user's language. See src/i18n.
  await applyBootLocale(settingsService);

  // #1499 E2: apply the user's diagnostics.logRetentionDays to the log tree.
  // The file sink pruned at LOG_RETENTION_DAYS (the SOT default) before settings
  // were loaded — hoisted so early boot lines are captured. Now that settings
  // exist, honour a tightened/loosened window (no-op if unchanged). Best-effort —
  // reprunePersistedRetention never throws, so a prune failure can't affect boot.
  try {
    reprunePersistedRetention(
      join(lvisHome(), "logs"),
      settingsService.get("diagnostics").logRetentionDays,
    );
  } catch {
    /* non-fatal */
  }

  // §4.2 Step 5: Core Engines
  const memoryManager = new MemoryManager();
  memoryManager.load();
  memoryManager.startPersistentContextWatcher();
  app.once("before-quit", () => {
    memoryManager.stopPersistentContextWatcher();
    memoryManager.closeSearchIndex();
  });
  log.info("boot: memory loaded from %s", memoryManager.getDir());
  // #1500 (E3): FTS5 search index integrity check → rebuild-from-JSONL if
  // corrupt/missing. No-Fallback — this is the only recovery path; search
  // never falls back to a linear scan.
  await memoryManager.verifyOrRebuildSearchIndex().catch((err: unknown) => {
    log.warn("boot: search index verify/rebuild failed: %s", (err as Error).message);
  });

  const keywordEngine = new KeywordEngine();
  const toolRegistry = new ToolRegistry();
  // Tier A1: BashTool registers directly — it implements the canonical
  // Tool contract via ZodTool and is tagged source="builtin" + category
  // "shell" so the §6.3 permission stack handles approval correctly
  // (Layer 3 + Bash AST validation gate at executor Step 2.5).
  toolRegistry.register(new BashTool());
  toolRegistry.register(new PowerShellTool());
  toolRegistry.register(createReadToolResultChunkTool());
  for (const tool of createFileTools()) {
    toolRegistry.register(tool);
  }
  // memory_write: model-directed long-term memory. Not read-only + not
  // auto-approved, so each write flows through the permission chokepoint
  // (user / auto-mode reviewer sees title+content) before it persists.
  toolRegistry.register(createMemoryWriteTool({ memoryManager }));
  // Background-shell companions to `bash` (run_in_background): read incremental
  // output and terminate by shell id. The shell registry is a module singleton
  // (like managed-child-processes); these tools scope every lookup to the
  // caller's session.
  toolRegistry.register(createBashOutputTool());
  toolRegistry.register(createBashKillTool());
  const routeEngine = new RouteEngine({ toolRegistry });

  return {
    pythonPath,
    pythonRuntime,
    bashAstValidator,
    auditService,
    settingsService,
    memoryManager,
    keywordEngine,
    toolRegistry,
    routeEngine,
  };
}
