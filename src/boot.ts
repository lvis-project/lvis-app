/**
 * Boot Sequence — §4.2
 *
 * 앱 시작 시 실행되는 초기화 파이프라인. Thin orchestrator —
 * 세부 로직은 src/boot/*.ts 모듈에 분리되어 있다.
 * 플러그인 특정 코드 없음 — 모든 플러그인은 HostApi를 통해 자기 등록.
 */
import { resolve } from "node:path";
import { app } from "electron";
import type { BrowserWindow } from "electron";
import { AuditLogger } from "./audit/audit-logger.js";
import { PluginRuntime } from "./plugins/runtime.js";
import { MockMarketplaceFetcher, PluginMarketplaceService } from "./plugins/marketplace.js";
import type { MarketplaceFetcher } from "./plugins/marketplace.js";
import { RealCloudMarketplaceFetcher } from "./plugins/real-cloud-marketplace-fetcher.js";
import { PluginDeploymentGuard } from "./plugins/deployment-guard.js";
import { McpGovernance } from "./mcp/mcp-governance.js";
import { McpManager } from "./mcp/mcp-manager.js";
import type { PluginHostApi } from "./plugins/types.js";

import { emitEvent, onEvent, type AppServices } from "./boot/types.js";
import { bootstrapCoreServices } from "./boot/services.js";
import {
  buildPluginConfigOverrides,
  registerPluginTools,
  runManifestStartupTools,
  registerPluginNotifications,
} from "./boot/plugins.js";
import {
  registerBuiltinTools,
  registerRequestPluginMetaTool,
  wireKnowledgeAndIdleScheduler,
} from "./boot/tools.js";
import {
  createProactiveEngine,
  loadCalendarToday,
  loadWeeklyCalendarIfMonday,
} from "./boot/proactive.js";
import {
  createSystemPromptBuilder,
  createPermissionManager,
  createPostTurnHookChain,
  createApprovalGate,
  createHookRunner,
  createConversationLoop,
  createCallLlm,
} from "./boot/conversation.js";

export type { AppServices } from "./boot/types.js";

export async function bootstrap(projectRoot: string, mainWindow: BrowserWindow): Promise<AppServices> {
  console.log("[lvis] boot: starting...");

  // §4.2 Step 0–1+5: Core services (python, ms-graph, audit, settings, memory,
  // keyword/route/tool registry + BashTool, task service).
  const core = await bootstrapCoreServices(mainWindow);
  const {
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
  } = core;

  // Sprint 1-A A3 — AuditLogger is created before PluginRuntime so the
  // per-plugin HostApi.logEvent can route through it. Previously it was
  // instantiated later (near PostTurnHookChain); we now share this instance.
  const bootAuditLogger = new AuditLogger();

  // Sprint 1-A A3 — plugin shutdown handler registry. Runs all handlers in
  // parallel with a 5s per-handler timeout. Uses `prependOnceListener` so
  // plugin onShutdown fires BEFORE main.ts's pluginRuntime.stopAll(), and the
  // handler awaits completion via `event.preventDefault()` + `app.quit()` so
  // plugins actually finish their cleanup instead of racing shutdown.
  // Copilot review: previous fire-and-forget `void` path allowed quit to
  // proceed before handlers finished and ordered them after stop().
  const pluginShutdownHandlers: Array<{ pluginId: string; handler: () => void | Promise<void> }> = [];
  let pluginShutdownRan = false;
  app.prependOnceListener("before-quit", (event) => {
    if (pluginShutdownHandlers.length === 0 || pluginShutdownRan) return;
    pluginShutdownRan = true;
    const SHUTDOWN_TIMEOUT_MS = 5000;
    event.preventDefault();
    void (async () => {
      await Promise.allSettled(
        pluginShutdownHandlers.map(async ({ pluginId, handler }) => {
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              Promise.resolve().then(() => handler()),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("shutdown handler timeout")), SHUTDOWN_TIMEOUT_MS);
              }),
            ]);
          } catch (err) {
            console.warn(`[plugin:${pluginId}] shutdown handler error:`, (err as Error).message);
          } finally {
            if (timer) clearTimeout(timer);
          }
        }),
      );
      app.quit();
    })();
  });

  // §4.2 Step 3-4: 플러그인 초기화 (범용 — 플러그인 특정 코드 없음)
  // API 키를 플러그인에 범용적으로 전달
  const configOverrides = buildPluginConfigOverrides(settingsService);

  // pythonExecutable 주입 (Agent 1 산출물)
  // 특정 플러그인 id 하드코딩 없이 모든 플러그인에 선언형으로 주입한다.
  if (pythonPath) {
    configOverrides["*"] = {
      ...(configOverrides["*"] ?? {}),
      pythonExecutable: pythonPath,
    };
  }

  // §7.2 Plugin Deployment Guard — managed 플러그인 사용자 제거/비활성화 차단.
  // userInstalledDir 밖에 있는 모든 플러그인(번들/IT-push)은 default-deny.
  const deploymentGuard = new PluginDeploymentGuard({
    registryPath: resolve(projectRoot, "plugins/registry.json"),
    userInstalledDir: resolve(projectRoot, "plugins/installed"),
  });

  // Late-binding refs — conversationLoop은 pluginRuntime 이후에 생성되므로
  // pluginRuntime 구성 시점에는 null로 시작하고, conversationLoop 생성 직후 주입한다.
  //   - llmCallerRef: 플러그인 callLlm()의 LLM 진입점
  //   - conversationLoopRef: onDisable 콜백이 conversationLoop에 접근하기 위한 핸들
  const llmCallerRef: {
    fn: ((prompt: string, opts?: { maxTokens?: number; systemPrompt?: string }) => Promise<string>) | null;
  } = { fn: null };
  let conversationLoopRef: import("./engine/conversation-loop.js").ConversationLoop | null = null;

  const pluginRuntime = new PluginRuntime({
    hostRoot: projectRoot,
    registryPath: resolve(projectRoot, "plugins/registry.json"),
    configOverrides,
    deploymentGuard,
    onDisable: (pluginId) => {
      keywordEngine.unregisterByPlugin(pluginId);
      toolRegistry.unregisterByPlugin(pluginId);
      conversationLoopRef?.onPluginDisabled(pluginId);
    },
    // 플러그인별 스코프된 HostApi 팩토리
    createHostApi: (pluginId: string): PluginHostApi => ({
      registerKeywords: (keywords) => {
        // Phase 1 Lazy Tool Scoping — plugin 호출 경로에서 pluginId 자동 주입.
        // 플러그인 소스는 수정하지 않고 host가 origin을 tag한다.
        keywordEngine.registerKeywords(
          keywords.map((k) => ({ ...k, pluginId })),
        );
        console.log(`[lvis] plugin:${pluginId} registered ${keywords.length} keywords`);
      },
      emitEvent: (type, data) => {
        emitEvent(type, { pluginId, ...((data as Record<string, unknown>) ?? {}) });
      },
      onEvent: (type, handler) => {
        onEvent(type, handler);
      },
      addTask: (task) => {
        taskService.add({
          title: task.title,
          description: task.description,
          source: task.source as "email" | "meeting" | "calendar" | "teams" | "manual",
          sourceRef: task.sourceRef,
          priority: task.priority ?? "medium",
          status: "pending",
        });
        console.log(`[lvis] plugin:${pluginId} created task: "${task.title.slice(0, 50)}"`);
      },
      saveNote: (title, content) => {
        memoryManager.saveNote(title, content);
        console.log(`[lvis] plugin:${pluginId} saved note: "${title}"`);
      },
      getSecret: (key) => {
        return settingsService.getSecret(key);
      },
      // ─── Microsoft Graph 공유 인증 ────────────────────────────────
      getMsGraphToken: () => msGraphService.getAccessToken(),
      startMsGraphAuth: async (openBrowser) => {
        await msGraphService.startInteractiveAuth(openBrowser);
      },
      isMsGraphAuthenticated: () => msGraphService.isAuthenticated(),
      getMsGraphAccount: () => msGraphService.getAccountName(),
      onMsGraphAuthChange: (handler) => msGraphService.onAuthChange(handler),
      callLlm: async (prompt, opts) => {
        if (!llmCallerRef.fn) throw new Error("LLM provider not ready");
        return llmCallerRef.fn(prompt, opts);
      },
      // Sprint 1-A A3 — structured log event → AuditLogger (plugin context).
      logEvent: (level, message, data) => {
        // AuditLogEntry.type is a fixed enum — "error" for error level,
        // "tool_call" otherwise. Level is encoded as a [LEVEL] tag in
        // `input` so downstream viewers can still distinguish info/warn.
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: level === "error" ? "error" : "tool_call",
            input: `[plugin:${pluginId}] [${level.toUpperCase()}] ${message}`,
            output: data === undefined ? undefined : JSON.stringify(data).slice(0, 500),
          });
        } catch (err) {
          console.warn(`[plugin:${pluginId}] logEvent failed:`, (err as Error).message);
        }
      },
      // Sprint 1-A A3 — shutdown handler registration (fires on before-quit).
      onShutdown: (handler) => {
        pluginShutdownHandlers.push({ pluginId, handler });
      },
    }),
  });

  await pluginRuntime.startAll();
  console.log("[lvis] boot: plugins loaded:", pluginRuntime.listToolNames());

  // 선언형 startupTools 자동 실행 (플러그인별 watcher/bootstrap 훅)
  runManifestStartupTools(pluginRuntime);

  // 플러그인 메서드를 ToolRegistry에 등록 (범용)
  registerPluginTools(pluginRuntime, toolRegistry);

  // 빌트인 도구 등록 (호스트 자체 기능)
  registerBuiltinTools(memoryManager, toolRegistry, settingsService);

  // Phase 1.5 Option C — request_plugin 메타 툴 (항상 활성, scope filter 통과)
  registerRequestPluginMetaTool(toolRegistry);

  // §4.4 HybridRetriever + Knowledge Tools DI (Agent 3 산출물 연결)
  // §6.1 IdleSchedulerService 배선 (Agent 5 산출물)
  const { idleScheduler, knowledgeAvailable } = await wireKnowledgeAndIdleScheduler({
    pluginRuntime,
    toolRegistry,
    auditService,
  });

  // §9.5 M4: select marketplace backend from settings (default = mock local JSON).
  const marketplaceSettings = settingsService.get("marketplace");
  let marketplaceFetcher: MarketplaceFetcher;
  if (
    marketplaceSettings.backend === "real-cloud" &&
    marketplaceSettings.realCloudBaseUrl
  ) {
    marketplaceFetcher = new RealCloudMarketplaceFetcher({
      baseUrl: marketplaceSettings.realCloudBaseUrl,
      apiKey: settingsService.getSecret("marketplace.apiKey") ?? undefined,
      allowPrivateNetwork: marketplaceSettings.realCloudAllowPrivateNetwork,
    });
    console.log("[lvis] boot: marketplace backend = real-cloud (%s)", marketplaceSettings.realCloudBaseUrl);
  } else {
    marketplaceFetcher = new MockMarketplaceFetcher(
      resolve(projectRoot, "plugins/marketplace.json"),
    );
  }
  const pluginMarketplace = new PluginMarketplaceService(
    projectRoot,
    deploymentGuard,
    marketplaceFetcher,
  );

  // §4.5.9: SystemPromptBuilder
  const systemPromptBuilder = createSystemPromptBuilder({
    memoryManager, toolRegistry, pluginRuntime,
  });

  // §6.3: PermissionManager (Layer 2-3)
  const permissionManager = await createPermissionManager();

  // §7: Proactive Engine (Daily Briefing) — event subscriptions + hints.
  // Sprint 2-D: wire 5 gating deps — feature flag, LLM caller, date persistence,
  // dismissal state. `callLlm` uses late-bound llmCallerRef (same entrypoint as
  // plugin HostApi.callLlm), so briefing generation reuses the ConversationLoop
  // LLM path once conversationLoop has been constructed below.
  const proactiveEngine = createProactiveEngine({
    taskService,
    memoryManager,
    pluginRuntime,
    isDailyBriefingEnabled: () =>
      settingsService.get("proactive")?.enableDailyBriefing ?? false,
    callLlm: async (prompt, opts) => {
      if (!llmCallerRef.fn) throw new Error("LLM provider not ready");
      return llmCallerRef.fn(prompt, opts);
    },
    getLastBriefingDate: () => settingsService.get("proactive")?.lastBriefingAt,
    setLastBriefingDate: (dateKst) => {
      const cur = settingsService.get("proactive") ?? { enableDailyBriefing: false };
      settingsService.patch({ proactive: { ...cur, lastBriefingAt: dateKst } });
    },
    getLastDismissedAt: () => settingsService.get("proactive")?.lastDismissedAt,
  });

  // Sprint 2-D: IdleScheduler IDLE_SCAN 진입 시 Daily Briefing 트리거.
  // IdleSchedulerService의 "IDLE_SCAN" 상태를 ProactiveEngine이 기대하는
  // "long_idle"로 매핑. 플래그 off이거나 이미 오늘 생성됐으면 엔진 측 게이팅이
  // skipped를 반환하므로 여기서는 invariants 없이 호출만 한다.
  if (idleScheduler) {
    idleScheduler.setStateChangeListener((newState) => {
      if (newState !== "IDLE_SCAN") return;
      proactiveEngine
        .generateDailyBriefing({ idleState: "long_idle" })
        .then((r) => {
          if (r.status === "generated") {
            console.log("[lvis] boot: daily briefing generated on idle");
            const win = mainWindow;
            if (!win.isDestroyed()) {
              try {
                win.webContents.send("lvis:proactive:briefing", r.briefing);
              } catch (e) {
                console.warn("[lvis] boot: briefing webContents.send failed:", (e as Error).message);
              }
            }
          } else {
            console.log(`[lvis] boot: daily briefing skipped (${r.reason})`);
          }
        })
        .catch((e: Error) =>
          console.warn("[lvis] boot: daily briefing trigger failed (non-fatal):", e.message),
        );
    });
  }

  // 오늘 일정 초기 로드 (calendar-source capability 플러그인에서 *_today 메서드 자동 탐색)
  loadCalendarToday(pluginRuntime, proactiveEngine);

  // manifest.notificationEvents 선언 기반 OS 알림 등록 (플러그인 무관)
  let disposePluginNotifications = registerPluginNotifications(pluginRuntime, mainWindow);

  // §4.5 + Agent 6: PostTurnHookChain 조립 (shares bootAuditLogger from A3 wiring)
  const { postTurnHookChain } = createPostTurnHookChain({
    memoryManager,
    idleScheduler,
    settingsService,
    auditLogger: bootAuditLogger,
  });

  // B1: Policy 로드 후 ApprovalGate 생성 — mainWindow.webContents 준비 후
  // §F7: bootAuditLogger 주입 → requested/decided/timeout/send-failed 4 phase 감사
  const approvalGate = await createApprovalGate(mainWindow, bootAuditLogger);

  // Tier A4 (W3): external hook executor 부착된 HookRunner
  const hookRunner = createHookRunner();

  // §4.5: ConversationLoop
  const conversationLoop = createConversationLoop({
    settingsService,
    systemPromptBuilder,
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager,
    permissionManager,
    proactiveEngine,
    idleScheduler,
    postTurnHookChain,
    bashAstValidator,
    approvalGate,
    hookRunner,
    pluginRuntime,
  });

  // Late-binding 주입 — 두 ref 모두 여기서 채워진다.
  conversationLoopRef = conversationLoop;
  llmCallerRef.fn = createCallLlm(conversationLoop);
  console.log("[lvis] boot: plugin callLlm ready");

  // Feature 4: 월요일 주간 일정 캐시 로드 (KST 기준)
  loadWeeklyCalendarIfMonday(pluginRuntime, proactiveEngine);

  // §9.5: MCP Server 연결 (거버넌스 승인 서버만)
  const mcpGovernance = new McpGovernance();
  const mcpManager = new McpManager(mcpGovernance, toolRegistry);
  try {
    const configs = await mcpManager.loadFromConfig();
    if (configs.length > 0) {
      await mcpManager.connectAll();
      console.log("[lvis] boot: MCP servers connected");
    }
  } catch (err) {
    console.warn("[lvis] boot: MCP initialization failed (non-fatal):", (err as Error).message);
  }
  mcpGovernance.startPolicyRefresh();

  console.log("[lvis] boot: ready (%d tools, %d plugins, %d mcp)", toolRegistry.size, pluginRuntime.listPluginIds().length, mcpManager.listServers().filter(s => s.status === "connected").length);

  return {
    pluginRuntime, pluginMarketplace, taskService, settingsService,
    memoryManager, keywordEngine, routeEngine, toolRegistry,
    systemPromptBuilder, conversationLoop, proactiveEngine, mcpManager,
    idleScheduler, bashAstValidator, auditService, postTurnHookChain,
    approvalGate, knowledgeAvailable,
    refreshPluginNotifications: () => {
      disposePluginNotifications();
      disposePluginNotifications = registerPluginNotifications(pluginRuntime, mainWindow);
    },
  };
}
