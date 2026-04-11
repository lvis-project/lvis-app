/**
 * Boot Sequence — §4.2
 *
 * 앱 시작 시 실행되는 초기화 파이프라인.
 * 1. Config 로드
 * 2. 플러그인 시작
 * 3. Core Engines 초기화 (KW, Route, Memory, ToolRegistry)
 * 4. 빌트인 도구 등록
 * 5. ConversationLoop 생성
 * 6. IPC 핸들러 등록
 * 7. 윈도우 생성
 */
import { resolve } from "node:path";
import { app } from "electron";
import { PluginRuntime } from "./plugin-runtime/runtime.js";
import { PluginMarketplaceService } from "./plugin-runtime/marketplace.js";
import { TaskService } from "./taskService.js";
import { SettingsService } from "./data/settings-store.js";
import { MemoryManager } from "./core/memory-manager.js";
import { KeywordEngine } from "./core/keyword-engine.js";
import { RouteEngine } from "./core/route-engine.js";
import { ToolRegistry } from "./core/tool-registry.js";
import { SystemPromptBuilder } from "./agent/system-prompt-builder.js";
import { ConversationLoop } from "./agent/conversation-loop.js";
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
}

export async function bootstrap(projectRoot: string): Promise<AppServices> {
  console.log("[lvis] boot: starting...");

  // §4.2 Step 1: Config 로드
  const settingsService = new SettingsService({
    userDataPath: app.getPath("userData"),
  });

  // §4.2 Step 5: Core Engines 초기화
  const memoryManager = new MemoryManager();
  memoryManager.load();
  console.log("[lvis] boot: memory loaded from", memoryManager.getDir());

  const keywordEngine = new KeywordEngine();
  const toolRegistry = new ToolRegistry();
  const routeEngine = new RouteEngine({ toolRegistry });

  // API 키 준비 (플러그인 주입용)
  const llmSettings = settingsService.get("llm");
  const configOverrides: Record<string, any> = {};
  if (llmSettings.provider === "openai") {
    const apiKey = settingsService.getSecret(`llm.apiKey.openai`);
    if (apiKey) {
      // PageIndex 엔진이 설치되지 않은 환경에서 오류를 방지하기 위해 testMode 강제 적용
      configOverrides["pageindex"] = { apiKey, testMode: true };
      process.env.OPENAI_API_KEY = apiKey;
    }
  }

  // §4.2 Step 3-4: 플러그인 초기화
  const pluginRuntime = new PluginRuntime({
    hostRoot: projectRoot,
    registryPath: resolve(projectRoot, "plugins/registry.json"),
    configOverrides,
  });
  await pluginRuntime.startAll();
  console.log("[lvis] boot: plugins loaded:", pluginRuntime.listMethods());

  // 플러그인 메서드를 ToolRegistry에 등록
  registerPluginTools(pluginRuntime, toolRegistry);

  // 빌트인 도구 등록
  registerBuiltinTools(memoryManager, pluginRuntime, toolRegistry, settingsService);

  // 플러그인 스킬 키워드 등록 (향후 plugin.json의 keywords 필드에서 로드)
  registerDefaultKeywords(keywordEngine);

  const pluginMarketplace = new PluginMarketplaceService(projectRoot);

  const taskService = new TaskService({
    dbPath: resolve(app.getPath("userData"), "lvis-tasks.db"),
  });

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

  // §4.5: ConversationLoop
  const conversationLoop = new ConversationLoop({
    settingsService,
    systemPromptBuilder,
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager,
  });

  console.log("[lvis] boot: ready (%d tools registered)", toolRegistry.size);

  return {
    pluginRuntime,
    pluginMarketplace,
    taskService,
    settingsService,
    memoryManager,
    keywordEngine,
    routeEngine,
    toolRegistry,
    systemPromptBuilder,
    conversationLoop,
  };
}

// ─── Tool Registration ──────────────────────────────

function registerPluginTools(
  pluginRuntime: PluginRuntime,
  toolRegistry: ToolRegistry,
): void {
  for (const method of pluginRuntime.listMethods()) {
    const toolName = method.replace(/\./g, "_"); // dot → underscore (LLM 벤더 호환)
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
        if (typeof finalPayload === "string") { try { finalPayload = JSON.parse(finalPayload); } catch { } }
        
        return pluginRuntime.call(method, finalPayload);
      },
      source: "plugin",
    });
  }
}

function registerBuiltinTools(
  memoryManager: MemoryManager,
  pluginRuntime: PluginRuntime,
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
        properties: {
          query: { type: "string", description: "검색 키워드" },
        },
        required: ["query"],
      },
      execute: async (args) => {
        const results = memoryManager.searchNotes(args.query as string);
        return results.map((n) => ({ title: n.title, filename: n.filename }));
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
      description: "인터넷 검색을 통해 최신 정보나 지식을 찾습니다. 결과 개수를 지정할 수 있습니다.",
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

          // DuckDuckGo fallback
          const response = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`);
          const data = await response.json() as any;
          const results: any[] = [];
          if (data.AbstractText) results.push({ title: data.Heading || query, snippet: data.AbstractText, url: data.AbstractURL });
          if (data.RelatedTopics) {
            for (const t of data.RelatedTopics.slice(0, count - results.length)) {
              if (t.Text && t.FirstURL) results.push({ title: t.Text.split(" - ")[0], snippet: t.Text, url: t.FirstURL });
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
        properties: {
          url: { type: "string", description: "읽어올 웹 페이지 URL" },
        },
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

function registerDefaultKeywords(keywordEngine: KeywordEngine): void {
  // 향후 plugin.json의 keywords 필드에서 동적 로드
  keywordEngine.registerKeywords([
    { keyword: "회의록", skillId: "meeting_start" },
    { keyword: "녹음", skillId: "meeting_start" },
    { keyword: "이메일", skillId: "email_list" },
    { keyword: "메일", skillId: "email_list" },
    { keyword: "인덱스", skillId: "index_scan" },
    { keyword: "문서 검색", skillId: "index_scan" },
  ]);
}
