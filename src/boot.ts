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

  // §4.2 Step 3-4: 플러그인 초기화
  const pluginRuntime = new PluginRuntime({
    hostRoot: projectRoot,
    registryPath: resolve(projectRoot, "plugins/registry.json"),
  });
  await pluginRuntime.startAll();
  console.log("[lvis] boot: plugins loaded:", pluginRuntime.listMethods());

  // 플러그인 메서드를 ToolRegistry에 등록
  registerPluginTools(pluginRuntime, toolRegistry);

  // 빌트인 도구 등록
  registerBuiltinTools(memoryManager, pluginRuntime, toolRegistry);

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
      description: `플러그인 메서드: ${method}`,
      parameters: {
        type: "object",
        properties: {
          payload: { type: "string", description: "메서드에 전달할 JSON 페이로드" },
        },
      },
      execute: async (args) => {
        return pluginRuntime.call(method, args.payload ? JSON.parse(args.payload as string) : undefined);
      },
      source: "plugin",
    });
  }
}

function registerBuiltinTools(
  memoryManager: MemoryManager,
  pluginRuntime: PluginRuntime,
  toolRegistry: ToolRegistry,
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
