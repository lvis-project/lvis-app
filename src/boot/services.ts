/**
 * Boot §4.2 Step 0–1+5 — Core service wiring.
 *
 * Instantiates services that have no plugin dependency and must exist
 * before plugin loading (settings, memory, audit, ms-graph, python runtime,
 * keyword/route/tool registry + BashTool).
 */
import { resolve } from "node:path";
import { app } from "electron";
import type { BrowserWindow } from "electron";
import { TaskService } from "../taskService.js";
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
import { MsGraphService } from "../main/ms-graph-service.js";

export interface CoreServices {
  pythonPath: string | undefined;
  bashAstValidator: BashAstValidator;
  msGraphService: MsGraphService;
  auditService: AuditService;
  settingsService: SettingsService;
  memoryManager: MemoryManager;
  keywordEngine: KeywordEngine;
  toolRegistry: ToolRegistry;
  routeEngine: RouteEngine;
  taskService: TaskService;
}

export async function bootstrapCoreServices(mainWindow: BrowserWindow): Promise<CoreServices> {
  // §4.2 Step 0: Python Runtime Bootstrap (Agent 1)
  const pythonRuntime = new PythonRuntimeBootstrapper();
  let pythonPath: string | undefined;
  try {
    const runtimeResult = await pythonRuntime.ensureReady(mainWindow);
    pythonPath = runtimeResult.pythonPath;
    console.log("[lvis] boot: python runtime ready:", pythonPath);
  } catch (err) {
    console.warn("[lvis] boot: python runtime setup failed (non-fatal):", (err as Error).message);
  }

  // §4.2 Step 0.5: Governance Services (Agent 6)
  const bashAstValidator = new BashAstValidator({ mode: "deny" });

  const auditService = new AuditService();
  await auditService.start();

  // §4.2 Step 1: Config — MsGraphService 가 이 설정(msGraph.environment) 을 읽으므로 먼저 init.
  const settingsService = new SettingsService({
    userDataPath: app.getPath("userData"),
  });

  // Microsoft Graph 공유 인증 서비스 (이메일·캘린더 플러그인 공용).
  // 환경(external / corporate) 는 settings 에서 택1 — ms-graph-auth-config.ts 참조.
  const msGraphEnv = settingsService.get("msGraph")?.environment ?? "external";
  const msGraphService = new MsGraphService(
    app.getPath("userData"),
    msGraphEnv,
  );
  await msGraphService.loadSavedToken();
  if (msGraphService.isAuthenticated()) {
    console.log(
      `[lvis] boot: ms-graph token loaded [${msGraphEnv}] — ${msGraphService.getAccountName()}`,
    );
  } else {
    console.log(`[lvis] boot: ms-graph env=${msGraphEnv}, unauthenticated`);
  }

  // §14.2 Audit log rotation + retention — boot-time check + 1h interval
  const auditLogger = new AuditLogger();
  const _runAuditMaintenance = () => {
    const auditCfg = settingsService.get("audit");
    void auditLogger.rotateAndPrune({
      maxBytes: auditCfg.auditRotationMaxBytes,
      retentionDays: auditCfg.auditRetentionDays,
    }).catch((err: unknown) => {
      console.warn("[audit] rotateAndPrune failed:", err);
    });
  };
  _runAuditMaintenance();
  const auditMaintenanceTimer = setInterval(_runAuditMaintenance, 60 * 60 * 1000); // 1 hour
  auditMaintenanceTimer.unref?.();

  // §4.2 Step 5: Core Engines
  const memoryManager = new MemoryManager();
  memoryManager.load();
  console.log("[lvis] boot: memory loaded from", memoryManager.getDir());

  const keywordEngine = new KeywordEngine();
  const toolRegistry = new ToolRegistry();
  // Tier A1: BashTool registers directly — it implements the canonical
  // Tool contract via ZodTool and is tagged source="builtin" + category
  // "dangerous" so the §6.3 permission stack handles approval correctly.
  toolRegistry.register(new BashTool());
  const routeEngine = new RouteEngine({ toolRegistry });

  const taskService = new TaskService({
    dbPath: resolve(app.getPath("userData"), "lvis-tasks.db"),
  });

  return {
    pythonPath,
    bashAstValidator,
    msGraphService,
    auditService,
    settingsService,
    memoryManager,
    keywordEngine,
    toolRegistry,
    routeEngine,
    taskService,
  };
}
