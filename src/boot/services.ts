/**
 * Boot §4.2 Step 0–1+5 — Core service wiring.
 *
 * Instantiates services that have no plugin dependency and must exist
 * before plugin loading (settings, memory, audit, python runtime,
 * keyword/route/tool registry + BashTool).
 *
 * MS Graph 인증은 PR 3 이후 ms-graph 플러그인이 자체 소유 — host 에는 관련 코드 없음.
 */
import { app } from "electron";
import type { BrowserWindow } from "electron";
import { SettingsService } from "../data/settings-store.js";
import { MemoryManager } from "../memory/memory-manager.js";
import { KeywordEngine } from "../core/keyword-engine.js";
import { RouteEngine } from "../core/route-engine.js";
import { ToolRegistry } from "../tools/registry.js";
import { BashTool } from "../tools/bash.js";
import { BashAstValidator } from "../main/bash-ast-validator.js";
import { AuditService } from "../main/audit-service.js";
import { AuditLogger } from "../audit/audit-logger.js";
import { PythonRuntimeBootstrapper } from "../main/python-runtime.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

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

export async function bootstrapCoreServices(mainWindow: BrowserWindow): Promise<CoreServices> {
  // §4.2 Step 0: Python Runtime Bootstrap (Agent 1)
  const pythonRuntime = new PythonRuntimeBootstrapper();
  let pythonPath: string | undefined;
  try {
    const runtimeResult = await pythonRuntime.ensureReady(mainWindow);
    pythonPath = runtimeResult.pythonPath;
    log.info("boot: python runtime ready: %s", pythonPath);
  } catch (err) {
    log.warn("boot: python runtime setup failed (non-fatal): %s", (err as Error).message);
  }

  // §4.2 Step 0.5: Governance Services (Agent 6)
  const bashAstValidator = new BashAstValidator({ mode: "deny" });

  const auditService = new AuditService();
  await auditService.start();

  // §4.2 Step 1: Config
  const settingsService = new SettingsService({
    userDataPath: app.getPath("userData"),
  });

  // §14.2 Audit log rotation + retention — boot-time check + 1h interval
  const auditLogger = new AuditLogger();
  const _runAuditMaintenance = () => {
    const auditCfg = settingsService.get("audit");
    void auditLogger.rotateAndPrune({
      maxBytes: auditCfg.auditRotationMaxBytes,
      retentionDays: auditCfg.auditRetentionDays,
    }).catch((err: unknown) => {
      log.warn({ err }, "rotateAndPrune failed");
    });
  };
  _runAuditMaintenance();
  const auditMaintenanceTimer = setInterval(_runAuditMaintenance, 60 * 60 * 1000); // 1 hour
  auditMaintenanceTimer.unref?.();

  // §4.2 Step 5: Core Engines
  const memoryManager = new MemoryManager();
  memoryManager.load();
  log.info("boot: memory loaded from %s", memoryManager.getDir());

  const keywordEngine = new KeywordEngine();
  const toolRegistry = new ToolRegistry();
  // Tier A1: BashTool registers directly — it implements the canonical
  // Tool contract via ZodTool and is tagged source="builtin" + category
  // "dangerous" so the §6.3 permission stack handles approval correctly.
  toolRegistry.register(new BashTool());
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
