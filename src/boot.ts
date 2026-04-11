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
      configOverrides["meeting"] = { openaiApiKey: apiKey };
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

  // §7/P2-6: 미팅 이벤트 통합 — 액션아이템→태스크, 요약→메모리
  setupMeetingIntegration(pluginRuntime, taskService, memoryManager);

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

          // DuckDuckGo HTML 검색 (Instant Answer API 대신 실제 검색 결과 파싱)
          const ddgRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            method: "POST",
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: `q=${encodeURIComponent(query)}`,
          });
          const ddgHtml = await ddgRes.text();
          const results: any[] = [];
          // 검색 결과 파싱: <a class="result__a"> (제목+URL) + <a class="result__snippet"> (요약)
          const resultBlocks = ddgHtml.split(/class="result\s/g).slice(1, count + 1);
          for (const block of resultBlocks) {
            const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)/);
            const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]+)/);
            if (urlMatch) {
              let url = urlMatch[1];
              // DuckDuckGo redirect URL 디코딩
              const uddg = url.match(/uddg=([^&]+)/);
              if (uddg) url = decodeURIComponent(uddg[1]);
              results.push({
                title: urlMatch[2].trim(),
                snippet: snippetMatch?.[1]?.trim() || "",
                url,
              });
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
  keywordEngine.registerKeywords([
    { keyword: "회의록", skillId: "meeting_start" },
    { keyword: "녹음", skillId: "meeting_start" },
    { keyword: "이메일", skillId: "email_list" },
    { keyword: "메일", skillId: "email_list" },
    { keyword: "인덱스", skillId: "index_scan" },
    { keyword: "문서 검색", skillId: "index_scan" },
  ]);
}

/**
 * §7/P2-6: 미팅 플러그인 이벤트 → LVIS Task/Memory 통합
 *
 * 미팅 종료 후 meeting.events를 폴링하여:
 * - actionItems → TaskService에 자동 태스크 생성
 * - 요약 → MemoryManager notes/에 자동 저장
 */
function setupMeetingIntegration(
  pluginRuntime: PluginRuntime,
  taskService: TaskService,
  memoryManager: MemoryManager,
): void {
  // 미팅 종료 이벤트를 감지하는 폴링 (향후 이벤트 버스로 전환)
  let lastEventCount = 0;

  setInterval(async () => {
    try {
      if (!pluginRuntime.listMethods().includes("meeting.events")) return;

      const events = (await pluginRuntime.call("meeting.events")) as
        Array<{ type: string; sessionId: string; data?: { title?: string; summary?: string }; timestamp: string }>;

      if (!events || events.length <= lastEventCount) return;

      const newEvents = events.slice(lastEventCount);
      lastEventCount = events.length;

      for (const event of newEvents) {
        if (event.type === "meeting.summary.created" && event.data) {
          // 요약을 notes/에 자동 저장
          const title = `미팅-${event.sessionId.slice(0, 8)}-${event.data.title || "회의"}`;
          const content = [
            `# ${event.data.title || "회의 요약"}`,
            `> 세션: ${event.sessionId}`,
            `> 시간: ${event.timestamp}`,
            "",
            event.data.summary || "",
          ].join("\n");

          memoryManager.saveNote(title, content);
          console.log(`[lvis] meeting→memory: saved note "${title}"`);

          // 미팅 결과에서 액션 아이템 추출하여 태스크 생성
          try {
            const meetingResult = await pluginRuntime.call("meeting.stop", { sessionId: event.sessionId }).catch(() => null) as
              { actionItems?: string[] } | null;

            // 이미 stop된 세션이면 세션 스토어에서 가져오기
            const sessions = (await pluginRuntime.call("meeting.sessions").catch(() => [])) as
              Array<{ sessionId: string }>;

            // actionItems가 있으면 태스크 생성
            if (meetingResult?.actionItems) {
              for (const item of meetingResult.actionItems) {
                taskService.add({
                  title: item.slice(0, 100),
                  description: `미팅(${event.data.title})에서 생성된 액션 아이템`,
                  source: "meeting" as const,
                  sourceRef: event.sessionId,
                  priority: "medium" as const,
                  status: "pending" as const,
                });
                console.log(`[lvis] meeting→task: created "${item.slice(0, 50)}"`);
              }
            }
          } catch {
            // 태스크 생성 실패는 비차단
          }
        }
      }
    } catch {
      // 폴링 실패 무시
    }
  }, 5000); // 5초 간격 폴링
}
