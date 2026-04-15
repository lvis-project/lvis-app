/**
 * Boot Sequence — §4.2
 *
 * 앱 시작 시 실행되는 초기화 파이프라인.
 * 플러그인 특정 코드 없음 — 모든 플러그인은 HostApi를 통해 자기 등록.
 */
import { resolve } from "node:path";
import { app } from "electron";
import type { BrowserWindow } from "electron";
import { PluginRuntime } from "./plugin-runtime/runtime.js";
import { PluginMarketplaceService } from "./plugin-runtime/marketplace.js";
import { PluginDeploymentGuard } from "./plugin-runtime/deployment-guard.js";
import { TaskService } from "./taskService.js";
import { SettingsService } from "./data/settings-store.js";
import { MemoryManager } from "./core/memory-manager.js";
import { KeywordEngine } from "./core/keyword-engine.js";
import { RouteEngine } from "./core/route-engine.js";
import { ToolRegistry } from "./core/tool-registry.js";
import { SystemPromptBuilder } from "./agent/system-prompt-builder.js";
import { ConversationLoop } from "./agent/conversation-loop.js";
import { PermissionManager } from "./core/permission-manager.js";
import { ProactiveEngine } from "./core/proactive-engine.js";
import { McpGovernance } from "./mcp/mcp-governance.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { PythonRuntimeBootstrapper } from "./main/python-runtime.js";
import { HybridRetriever } from "./main/hybrid-retriever.js";
import { MockCloudIndexAdapter } from "./main/cloud-index-adapter.js";
import { IdleSchedulerService, type WorkerClientLite } from "./main/idle-scheduler.js";
import { BashAstValidator } from "./main/bash-ast-validator.js";
import { AuditService } from "./main/audit-service.js";
import { PostTurnHookChain } from "./agent/post-turn-hook-chain.js";
import { AuditLogger } from "./agent/audit-logger.js";
import { createKnowledgeSearchTools } from "./agent/knowledge-search-tool.js";
import { ApprovalGate } from "./core/approval-gate.js";
import { loadPolicy } from "./core/policy-store.js";
import { DefaultAgentActionRequester } from "./agent/agent-action-requester.js";
import type { PluginHostApi } from "./plugin-runtime/types.js";
import type { ToolDefinition } from "./core/tool-registry.js";

export interface AppServices {
  pluginRuntime: PluginRuntime;
  pluginMarketplace: PluginMarketplaceService;
  taskService: TaskService;
  settingsService: SettingsService;
  memoryManager: MemoryManager;
  keywordEngine: KeywordEngine;
  routeEngine: RouteEngine;
  toolRegistry: ToolRegistry;
  systemPromptBuilder: SystemPromptBuilder;
  conversationLoop: ConversationLoop;
  proactiveEngine: ProactiveEngine;
  mcpManager: McpManager;
  idleScheduler?: IdleSchedulerService;
  bashAstValidator: BashAstValidator;
  auditService: AuditService;
  postTurnHookChain: PostTurnHookChain;
  /** B1: 승인 게이트 — mainWindow 준비 후 생성 */
  approvalGate?: ApprovalGate;
  /** @internal Phase 2 stub — §8 Agent Hub approval caller (Phase 3 ConversationLoop 연동 예정) */
  agentActionRequester?: DefaultAgentActionRequester;
  /** Whether knowledge search tools were successfully registered. */
  knowledgeAvailable: boolean;
}

// ─── 이벤트 버스 (플러그인 간 통신) ────────────────

type EventHandler = (data: unknown) => void;
const eventHandlers = new Map<string, Set<EventHandler>>();

function emitEvent(type: string, data?: unknown): void {
  const handlers = eventHandlers.get(type);
  if (handlers) {
    for (const handler of handlers) {
      try { handler(data); } catch (err) { console.error(`[lvis] event handler error (${type}):`, err); }
    }
  }
}

function onEvent(type: string, handler: EventHandler): void {
  if (!eventHandlers.has(type)) eventHandlers.set(type, new Set());
  eventHandlers.get(type)!.add(handler);
}

// ─── Bootstrap ──────────────────────────────────────

export async function bootstrap(projectRoot: string, mainWindow: BrowserWindow): Promise<AppServices> {
  console.log("[lvis] boot: starting...");

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

  // §4.2 Step 1: Config
  const settingsService = new SettingsService({
    userDataPath: app.getPath("userData"),
  });

  // §4.2 Step 5: Core Engines
  const memoryManager = new MemoryManager();
  memoryManager.load();
  console.log("[lvis] boot: memory loaded from", memoryManager.getDir());

  const keywordEngine = new KeywordEngine();
  const toolRegistry = new ToolRegistry();
  const routeEngine = new RouteEngine({ toolRegistry });

  const taskService = new TaskService({
    dbPath: resolve(app.getPath("userData"), "lvis-tasks.db"),
  });

  // §4.2 Step 3-4: 플러그인 초기화 (범용 — 플러그인 특정 코드 없음)
  // API 키를 플러그인에 범용적으로 전달
  const configOverrides = buildPluginConfigOverrides(settingsService);

  // pythonExecutable 주입 (Agent 1 산출물)
  // pageindex plugin은 두 가지 id로 lookup될 수 있다:
  //   - "pageindex"             — installed manifest + marketplace catalog 기준 (실제 사용)
  //   - "lvis-plugin-pageindex" — source repo plugin.json 기준 (legacy / 일관성)
  // 양쪽 키에 모두 주입하여 어느 경로로 lookup되어도 매칭되도록 한다.
  if (pythonPath) {
    const pageindexCfg = { pythonExecutable: pythonPath };
    configOverrides["pageindex"] = {
      ...(configOverrides["pageindex"] ?? {}),
      ...pageindexCfg,
    };
    configOverrides["lvis-plugin-pageindex"] = {
      ...(configOverrides["lvis-plugin-pageindex"] ?? {}),
      ...pageindexCfg,
    };
  }

  // §7.2 Plugin Deployment Guard — managed 플러그인 사용자 제거/비활성화 차단.
  // userInstalledDir 밖에 있는 모든 플러그인(번들/IT-push)은 default-deny.
  const deploymentGuard = new PluginDeploymentGuard({
    registryPath: resolve(projectRoot, "plugins/registry.json"),
    userInstalledDir: resolve(projectRoot, "plugins/installed"),
  });

  const pluginRuntime = new PluginRuntime({
    hostRoot: projectRoot,
    registryPath: resolve(projectRoot, "plugins/registry.json"),
    configOverrides,
    deploymentGuard,
    // 플러그인별 스코프된 HostApi 팩토리
    createHostApi: (pluginId: string): PluginHostApi => ({
      registerKeywords: (keywords) => {
        // 도구 이름을 underscore 표준으로 변환
        const converted = keywords.map((k) => ({
          keyword: k.keyword,
          skillId: k.skillId.replace(/\./g, "_"),
        }));
        keywordEngine.registerKeywords(converted);
        console.log(`[lvis] plugin:${pluginId} registered ${converted.length} keywords`);
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
    }),
  });

  await pluginRuntime.startAll();
  console.log("[lvis] boot: plugins loaded:", pluginRuntime.listMethods());

  // 플러그인 메서드를 ToolRegistry에 등록 (범용)
  registerPluginTools(pluginRuntime, toolRegistry);

  // 빌트인 도구 등록 (호스트 자체 기능)
  registerBuiltinTools(memoryManager, toolRegistry, settingsService);

  // §4.4 HybridRetriever + Knowledge Tools DI (Agent 3 산출물 연결)
  // §6.1 IdleSchedulerService 배선 (Agent 5 산출물)
  let idleScheduler: IdleSchedulerService | undefined;
  let knowledgeAvailable = false;
  try {
    // Public accessor (runtime.getPluginInstance) replaces the previous
    // `(pluginRuntime as any).plugins?.get(...)` private reach-through.
    const pageIndexPlugin = pluginRuntime.getPluginInstance<{
      getWorkerClient?: () => {
        listDocuments: () => Promise<unknown>;
        getStructure: (docId: string) => Promise<unknown>;
        getPageContent: (docId: string, pages: string) => Promise<unknown>;
        enqueue: (filePath: string, mode?: string, priority?: number) => Promise<unknown>;
        processOne: (priority?: number) => Promise<unknown>;
        getIndexerState: () => Promise<unknown>;
      };
      setIdleScheduler?: (scheduler: IdleSchedulerService) => void;
    }>("lvis-plugin-pageindex");
    const workerClient = pageIndexPlugin?.getWorkerClient?.() as
      | {
          listDocuments: () => Promise<unknown>;
          getStructure: (docId: string) => Promise<unknown>;
          getPageContent: (docId: string, pages: string) => Promise<unknown>;
          enqueue: (filePath: string, mode?: string, priority?: number) => Promise<unknown>;
          processOne: (priority?: number) => Promise<unknown>;
          getIndexerState: () => Promise<unknown>;
        }
      | undefined;
    if (workerClient) {
      const cloudAdapter = new MockCloudIndexAdapter();
      const hybridRetriever = new HybridRetriever({
        workerClient: workerClient as never,
        cloudAdapter,
      });
      const knowledgeTools = createKnowledgeSearchTools({
        hybridRetriever,
        workerClient: {
          listDocuments: () => workerClient.listDocuments() as never,
          getStructure: (docId: string) => workerClient.getStructure(docId) as never,
          getPageContent: (docId: string, pages: string) =>
            workerClient.getPageContent(docId, pages) as never,
        },
      });
      for (const tool of knowledgeTools) {
        toolRegistry.register(tool);
      }
      knowledgeAvailable = true;
      console.log("[lvis] boot: knowledge tools registered (%d tools)", knowledgeTools.length);

      // §6.1 IdleScheduler: WorkerClient의 enqueue/processOne/getIndexerState를 WorkerClientLite shape으로 래핑
      const idleWorkerAdapter: WorkerClientLite = {
        enqueue: (filePath: string, mode?: string, priority?: number) =>
          workerClient.enqueue(filePath, mode, priority) as never,
        processOne: (priority?: number) => workerClient.processOne(priority) as never,
        getIndexerState: () => workerClient.getIndexerState() as never,
      };
      // Electron powerMonitor lazy import — test 환경에서 electron 로드 회피
      try {
        const { powerMonitor } = await import("electron");
        idleScheduler = new IdleSchedulerService({
          workerClient: idleWorkerAdapter,
          powerMonitor: powerMonitor as unknown as import("./main/idle-scheduler.js").PowerMonitorLike,
        });
        idleScheduler.start();
        // folderIndexer에 stub 주입 (Agent 4의 setIdleScheduler 경로)
        if (typeof pageIndexPlugin?.setIdleScheduler === "function") {
          pageIndexPlugin.setIdleScheduler(idleScheduler);
          console.log("[lvis] boot: idle-scheduler wired to folderIndexer");
        } else {
          console.warn("[lvis] boot: pageindex plugin setIdleScheduler() not available");
        }
      } catch (err) {
        console.warn(
          "[lvis] boot: idle-scheduler setup failed (non-fatal):",
          (err as Error).message,
        );
      }
    } else {
      console.warn(
        "[lvis] boot: pageindex plugin getWorkerClient() not available — knowledge tools skipped",
      );
      auditService.log({
        timestamp: new Date().toISOString(),
        sessionId: "boot",
        type: "error",
        payload: {
          reason: "knowledge tools skipped — getWorkerClient missing",
          pluginId: "lvis-plugin-pageindex",
        },
      });
    }
  } catch (err) {
    console.warn("[lvis] boot: knowledge tools DI failed (non-fatal):", (err as Error).message);
    auditService.log({
      timestamp: new Date().toISOString(),
      sessionId: "boot",
      type: "error",
      payload: {
        reason: "knowledge tools DI failed",
        error: (err as Error).message,
      },
    });
  }

  const pluginMarketplace = new PluginMarketplaceService(projectRoot, deploymentGuard);

  // §4.5.9: SystemPromptBuilder
  const systemPromptBuilder = new SystemPromptBuilder({
    memoryManager,
    toolRegistry,
    getPluginSchemas: () => {
      const methods = pluginRuntime.listMethods();
      if (methods.length === 0) return "";
      return [
        "<active-plugins>",
        `활성 플러그인 메서드: ${methods.join(", ")}`,
        "</active-plugins>",
      ].join("\n");
    },
  });

  // §6.3: PermissionManager (Layer 2-3)
  const permissionManager = new PermissionManager();
  // 기본 allow 규칙: 조회성 도구 자동 허용
  permissionManager.setRules([
    { pattern: "memory_search", action: "allow" },
    { pattern: "memory_list", action: "allow" },
    { pattern: "web_search", action: "allow" },
    { pattern: "web_fetch", action: "allow" },
  ]);
  // B1: 영구 규칙 파일 로드 (~/.lvis/permissions.json → 인메모리 병합)
  await permissionManager.loadRulesFromFile();

  // §7: Proactive Engine (Daily Briefing)
  const proactiveEngine = new ProactiveEngine({
    getTaskSummary: () => taskService.getPendingByPriority().map((t) => ({
      title: t.title, priority: t.priority, status: t.status,
      dueAt: t.dueAt ?? undefined, source: t.source,
    })),
    getRecentNotes: () => memoryManager.listNotes().slice(0, 5),
    getRecentSessions: () => memoryManager.listSessions().slice(0, 5),
  });

  // 이벤트 버스 → Proactive Engine 연동
  onEvent("meeting.summary.created", (data) => proactiveEngine.collectEvent("meeting.summary.created", data));
  onEvent("email.action.needed", (data) => proactiveEngine.collectEvent("email.action.needed", data));
  onEvent("meeting.ended", (data) => proactiveEngine.collectEvent("meeting.ended", data));

  // §4.5 + Agent 6: PostTurnHookChain 조립
  const bootAuditLogger = new AuditLogger();
  const postTurnHookChain = new PostTurnHookChain({
    memoryManager,
    auditLogger: bootAuditLogger,
    idleScheduler,
  });

  // B1: Policy 로드 후 ApprovalGate 생성 — mainWindow.webContents 준비 후
  // §F7: bootAuditLogger 주입 → requested/decided/timeout/send-failed 4 phase 감사
  const bootPolicy = await loadPolicy();
  const approvalGate = new ApprovalGate(mainWindow.webContents, bootPolicy, 5 * 60 * 1000, bootAuditLogger);
  // @internal Phase 2 stub — §8 Agent Hub approval caller (Phase 3 ConversationLoop 연동 예정)
  const agentActionRequester = new DefaultAgentActionRequester(approvalGate);

  // §4.5: ConversationLoop
  const conversationLoop = new ConversationLoop({
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
  });

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
    approvalGate, agentActionRequester, knowledgeAvailable,
  };
}

// ─── Plugin Config (범용) ───────────────────────────

/** 현재 LLM 벤더의 API 키를 모든 플러그인에 범용으로 전달 */
function buildPluginConfigOverrides(settings: SettingsService): Record<string, Record<string, unknown>> {
  const overrides: Record<string, Record<string, unknown>> = {};
  const llm = settings.get("llm");

  // OpenAI 키는 STT/Summary 플러그인이 공통으로 사용.
  // 글로벌 process.env 오염 금지 — configOverrides를 통한 명시적 주입만 허용.
  // (cycle 1 LOW: process.env.OPENAI_API_KEY 글로벌 set 제거)
  const openaiKey = settings.getSecret("llm.apiKey.openai");
  const currentKey = settings.getSecret(`llm.apiKey.${llm.provider}`);

  // 모든 플러그인에 범용적으로 전달 — 각 플러그인이 필요한 키를 선택
  const resolvedApiKey = openaiKey ?? currentKey;
  if (resolvedApiKey) {
    overrides["*"] = {
      llmApiKey: resolvedApiKey,
      llmProvider: llm.provider,
      apiKey: resolvedApiKey,         // pageindex가 사용하는 키 이름
      openaiApiKey: resolvedApiKey,   // meeting이 사용하는 키 이름
    };
  }

  return overrides;
}

// ─── Tool Registration (범용) ───────────────────────

function registerPluginTools(pluginRuntime: PluginRuntime, toolRegistry: ToolRegistry): void {
  for (const method of pluginRuntime.listMethods()) {
    const toolName = method.replace(/\./g, "_");
    toolRegistry.register({
      name: toolName,
      description: `플러그인 메서드: ${method}. payload에 필요한 매개변수를 JSON 객체로 전달하세요.`,
      parameters: {
        type: "object",
        properties: {
          payload: { type: "object", description: "메서드에 전달할 매개변수 객체" },
        },
      },
      execute: async (args) => {
        let finalPayload = args.payload;
        if (!finalPayload && Object.keys(args).length > 0) finalPayload = args;
        if (typeof finalPayload === "string") { try { finalPayload = JSON.parse(finalPayload); } catch { /* */ } }
        return pluginRuntime.call(method, finalPayload);
      },
      source: "plugin",
    });
  }
}

function registerBuiltinTools(
  memoryManager: MemoryManager,
  toolRegistry: ToolRegistry,
  settingsService: SettingsService,
): void {
  const builtins: ToolDefinition[] = [
    {
      name: "memory_save",
      description: "사용자가 기억해달라고 한 내용을 notes/에 저장합니다.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "메모 제목 (40자 이내)" },
          content: { type: "string", description: "메모 내용" },
        },
        required: ["title", "content"],
      },
      execute: async (args) => {
        const note = memoryManager.saveNote(args.title as string, args.content as string);
        return { saved: true, filename: note.filename };
      },
      source: "builtin",
    },
    {
      name: "memory_search",
      description: "사용자의 notes/ 메모를 키워드로 검색합니다.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "검색 키워드" } },
        required: ["query"],
      },
      execute: async (args) => {
        return memoryManager.searchNotes(args.query as string).map((n) => ({ title: n.title, filename: n.filename }));
      },
      source: "builtin",
    },
    {
      name: "memory_list",
      description: "저장된 모든 메모 목록을 반환합니다.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        return memoryManager.listNotes().map((n) => ({ title: n.title, filename: n.filename }));
      },
      source: "builtin",
    },
    {
      name: "web_search",
      description: "인터넷 검색을 통해 최신 정보나 지식을 찾습니다.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "검색어" },
          count: { type: "integer", description: "반환할 결과 개수 (1-10)" },
        },
        required: ["query"],
      },
      execute: async (args) => {
        const query = args.query as string;
        const count = (args.count as number) || 5;
        const ws = settingsService.get("webSearch");
        const apiKey = settingsService.getSecret(`web.apiKey.${ws.provider}`);
        try {
          if (ws.provider === "tavily" && apiKey) {
            const res = await fetch("https://api.tavily.com/search", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ api_key: apiKey, query, search_depth: "basic", max_results: count }),
            });
            const data = await res.json() as any;
            return { query, provider: "Tavily", results: data.results?.map((r: any) => ({ title: r.title, snippet: r.content, url: r.url })) || [] };
          }
          if (ws.provider === "serper" && apiKey) {
            const res = await fetch("https://google.serper.dev/search", {
              method: "POST",
              headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
              body: JSON.stringify({ q: query, num: count }),
            });
            const data = await res.json() as any;
            return { query, provider: "Serper", results: data.organic?.map((r: any) => ({ title: r.title, snippet: r.snippet, url: r.link })) || [] };
          }
          // DuckDuckGo HTML 검색
          const ddgRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            method: "POST",
            headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", "Content-Type": "application/x-www-form-urlencoded" },
            body: `q=${encodeURIComponent(query)}`,
          });
          const ddgHtml = await ddgRes.text();
          const results: any[] = [];
          const resultBlocks = ddgHtml.split(/class="result\s/g).slice(1, count + 1);
          for (const block of resultBlocks) {
            const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)/);
            const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]+)/);
            if (urlMatch) {
              let url = urlMatch[1];
              const uddg = url.match(/uddg=([^&]+)/);
              if (uddg) url = decodeURIComponent(uddg[1]);
              results.push({ title: urlMatch[2].trim(), snippet: snippetMatch?.[1]?.trim() || "", url });
            }
          }
          return { query, provider: "DuckDuckGo", results };
        } catch (error) {
          return { query, error: "검색 중 오류 발생", details: (error as Error).message };
        }
      },
      source: "builtin",
    },
    {
      name: "web_fetch",
      description: "특정 URL의 웹 페이지 내용을 읽어 텍스트로 변환합니다.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "읽어올 웹 페이지 URL" } },
        required: ["url"],
      },
      execute: async (args) => {
        const url = args.url as string;
        try {
          const response = await fetch(url, { headers: { "User-Agent": "LVIS-Assistant/0.1.0" } });
          const html = await response.text();
          let text = html
            .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
            .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          return { url, content: text.slice(0, 5000), truncated: text.length > 5000 };
        } catch (error) {
          return { url, error: "웹 페이지를 읽을 수 없습니다.", details: (error as Error).message };
        }
      },
      source: "builtin",
    },
  ];

  toolRegistry.registerBatch(builtins);
}
