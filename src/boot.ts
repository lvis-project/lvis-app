/**
 * Boot Sequence — §4.2
 *
 * 앱 시작 시 실행되는 초기화 파이프라인.
 * 플러그인 특정 코드 없음 — 모든 플러그인은 HostApi를 통해 자기 등록.
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

export async function bootstrap(projectRoot: string): Promise<AppServices> {
  console.log("[lvis] boot: starting...");

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

  const pluginRuntime = new PluginRuntime({
    hostRoot: projectRoot,
    registryPath: resolve(projectRoot, "plugins/registry.json"),
    configOverrides,
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

  const pluginMarketplace = new PluginMarketplaceService(projectRoot);

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

  console.log("[lvis] boot: ready (%d tools, %d plugins)", toolRegistry.size, pluginRuntime.listPluginIds().length);

  return {
    pluginRuntime, pluginMarketplace, taskService, settingsService,
    memoryManager, keywordEngine, routeEngine, toolRegistry,
    systemPromptBuilder, conversationLoop,
  };
}

// ─── Plugin Config (범용) ───────────────────────────

/** 현재 LLM 벤더의 API 키를 모든 플러그인에 범용으로 전달 */
function buildPluginConfigOverrides(settings: SettingsService): Record<string, Record<string, unknown>> {
  const overrides: Record<string, Record<string, unknown>> = {};
  const llm = settings.get("llm");

  // OpenAI 키는 STT/Summary 플러그인이 공통으로 사용
  const openaiKey = settings.getSecret("llm.apiKey.openai");
  const currentKey = settings.getSecret(`llm.apiKey.${llm.provider}`);

  // OpenAI 키가 있으면 환경변수에도 설정 (pageindex 등 fallback 지원)
  if (openaiKey) {
    process.env.OPENAI_API_KEY = openaiKey;
  } else if (currentKey && (llm.provider === "openai" || llm.provider === "copilot")) {
    process.env.OPENAI_API_KEY = currentKey;
  }

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
