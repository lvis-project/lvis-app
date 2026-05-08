/**
 * Boot §4.2 Step 4 — Builtin tool registration + §4.4 knowledge DI.
 *
 * - registerRequestPluginMetaTool: request_plugin meta tool
 * - registerBuiltinTools: memory_*, web_search, web_fetch
 * - wireKnowledgeAndIdleScheduler: worker-client capability 탐지 → HybridRetriever,
 *   knowledge tools 등록, IdleScheduler 배선
 */
import type { ToolRegistry } from "../tools/registry.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { SettingsService } from "../data/settings-store.js";
import type { PluginRuntime } from "../plugins/runtime.js";
import type { AuditService } from "../main/audit-service.js";
import { createDynamicTool, type Tool } from "../tools/base.js";
import { createKnowledgeSearchTools } from "../tools/knowledge-search.js";
import { createSearchMemoryTool, memoryManagerNotesAdapter } from "../tools/search-memory.js";
import { createRenderHtmlTool } from "../tools/render-html.js";
import { createAskUserQuestionTool } from "../tools/ask-user-question.js";
import { createScheduleRoutineTool } from "../tools/schedule-routine.js";
import { createTodoSessionWriteTool } from "../tools/todo-session-write.js";
import { createAgentSpawnTool, type AgentSpawnEvent } from "../tools/agent-spawn.js";
import { createSkillLoadTool, type SkillLoadEvent } from "../tools/skill-load.js";
import type { AskUserQuestionGate } from "../main/ask-user-question-gate.js";
import type { RoutinesStore } from "../main/routines-store.js";
import type { SessionTodoStore } from "../main/session-todo-store.js";
import type { SubAgentRunner } from "../engine/subagent-runner.js";
import type { SkillStore } from "../main/skill-store.js";
import type { SkillOverlay } from "../main/skill-overlay.js";
import type { SkillApprovalsStore } from "../main/skill-approvals-store.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import { HybridRetriever } from "../main/hybrid-retriever.js";
import { MockCloudIndexAdapter } from "../main/cloud-index-adapter.js";
import { IdleSchedulerService, adaptPowerMonitor, type WorkerClientLite } from "../main/idle-scheduler.js";
import { fetchPublicHttpResponse } from "../core/network-guard.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

export function registerRequestPluginMetaTool(toolRegistry: ToolRegistry): void {
  // Phase 1.5 Option C — request_plugin 메타 툴 (항상 활성, scope filter 통과)
  // execute는 no-op — 실제 scope 확장은 ConversationLoop.queryLoop이 가로챈다.
  toolRegistry.register(createDynamicTool({
    name: "request_plugin",
    description:
      "현재 비활성화된 플러그인 중 이번 턴 작업에 필요한 것을 활성화 요청합니다. " +
      "비활성 플러그인 목록은 system prompt '사용 가능한 플러그인' 섹션 참조. " +
      "활성화 후 같은 턴 내에서 해당 플러그인의 tool을 호출할 수 있습니다.",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["pluginId"],
      properties: {
        pluginId: {
          type: "string",
          description: "활성화할 플러그인 ID (카탈로그의 bold 부분)",
        },
      },
    },
    // Handled inline by ConversationLoop; fallback if executor reaches it.
    execute: async () => ({
      output: "request_plugin은 대화 루프에서 직접 처리됩니다.",
      isError: false,
    }),
  }));
}

export interface KnowledgeWiringResult {
  idleScheduler?: IdleSchedulerService;
  knowledgeAvailable: boolean;
}

export async function wireKnowledgeAndIdleScheduler(opts: {
  pluginRuntime: PluginRuntime;
  toolRegistry: ToolRegistry;
  auditService: AuditService;
}): Promise<KnowledgeWiringResult> {
  const { pluginRuntime, toolRegistry, auditService } = opts;
  let idleScheduler: IdleSchedulerService | undefined;
  let knowledgeAvailable = false;
  try {
    // Public accessor (runtime.getPluginInstance) replaces the previous
    // `(pluginRuntime as any).plugins?.get(...)` private reach-through.
    const workerClientPluginId = pluginRuntime.findPluginIdByCapability("worker-client");
    const pageIndexPlugin = workerClientPluginId
      ? pluginRuntime.getPluginInstance<{
      getWorkerClient?: () => {
        listDocuments: () => Promise<unknown>;
        getStructure: (docId: string) => Promise<unknown>;
        getPageContent: (docId: string, pages: string) => Promise<unknown>;
        enqueue: (filePath: string, mode?: string, priority?: number) => Promise<unknown>;
        processOne: (priority?: number) => Promise<unknown>;
        getIndexerState: () => Promise<unknown>;
      };
      setIdleScheduler?: (scheduler: IdleSchedulerService) => void;
    }>(workerClientPluginId)
      : undefined;
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
      log.info("boot: knowledge tools registered (%d tools)", knowledgeTools.length);

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
          powerMonitor: adaptPowerMonitor(powerMonitor),
        });
        idleScheduler.start();
        // folderIndexer에 stub 주입 (Agent 4의 setIdleScheduler 경로)
        if (typeof pageIndexPlugin?.setIdleScheduler === "function") {
          pageIndexPlugin.setIdleScheduler(idleScheduler);
          log.info("boot: idle-scheduler wired to folderIndexer");
        } else {
          log.warn("boot: worker-client plugin setIdleScheduler() not available");
        }
      } catch (err) {
        log.warn(
          "boot: idle-scheduler setup failed (non-fatal): %s",
          (err as Error).message,
        );
      }
    } else {
      log.warn(
        "boot: worker-client capability missing getWorkerClient() — knowledge tools skipped",
      );
      auditService.log({
        timestamp: new Date().toISOString(),
        sessionId: "boot",
        type: "error",
        payload: {
          reason: "knowledge tools skipped — getWorkerClient missing",
          pluginId: workerClientPluginId ?? "(capability:worker-client not found)",
        },
      });
    }
  } catch (err) {
    log.warn("boot: knowledge tools DI failed (non-fatal): %s", (err as Error).message);
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
  return { idleScheduler, knowledgeAvailable };
}

export interface WorkflowToolDeps {
  /** Lazy-resolved gate — populated after BrowserWindow is ready. */
  getAskUserQuestionGate?: () => AskUserQuestionGate | undefined;
  routinesStore?: RoutinesStore;
  sessionTodoStore?: SessionTodoStore;
  /** Lazy-resolved sub-agent runner — populated after ConversationLoop wiring. */
  getSubAgentRunner?: () => SubAgentRunner | undefined;
  skillStore?: SkillStore;
  /** C2(c): per-session skill overlay registry. */
  skillOverlay?: SkillOverlay;
  /** C2(d): persistent skill-approval allowlist. */
  skillApprovalsStore?: SkillApprovalsStore;
  /** C2(d): ApprovalGate for first-use skill approval modal. */
  getApprovalGate?: () => ApprovalGate | undefined;
  emitAgentSpawn?: (event: AgentSpawnEvent) => void;
  emitSkillLoad?: (event: SkillLoadEvent) => void;
}

export function registerBuiltinTools(
  memoryManager: MemoryManager,
  toolRegistry: ToolRegistry,
  settingsService: SettingsService,
  workflowDeps?: WorkflowToolDeps,
): void {
  const builtins: Tool[] = [
    createDynamicTool({
      name: "memory_save",
      description: "사용자가 기억해달라고 한 내용을 memory/에 저장합니다.",
      source: "builtin",
      category: "write",
      jsonSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "메모 제목 (40자 이내)" },
          content: { type: "string", description: "메모 내용" },
        },
        required: ["title", "content"],
      },
      execute: async (rawInput) => {
        const args = (rawInput ?? {}) as Record<string, unknown>;
        const note = await memoryManager.saveMemory(
          args.title as string,
          args.content as string,
        );
        return {
          output: JSON.stringify({ saved: true, filename: note.filename }),
          isError: false,
        };
      },
    }),
    createDynamicTool({
      name: "memory_search",
      description: "사용자의 memory/ 메모를 키워드로 검색합니다.",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: {
        type: "object",
        properties: { query: { type: "string", description: "검색 키워드" } },
        required: ["query"],
      },
      execute: async (rawInput) => {
        const args = (rawInput ?? {}) as Record<string, unknown>;
        const results = memoryManager
          .searchMemoryEntries(args.query as string)
          .map((n) => ({ title: n.title, filename: n.filename }));
        return { output: JSON.stringify(results), isError: false };
      },
    }),
    createSearchMemoryTool({
      getNotes: memoryManagerNotesAdapter(memoryManager),
    }),
    createDynamicTool({
      name: "memory_list",
      description: "저장된 모든 메모 목록을 반환합니다.",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => {
        const notes = memoryManager
          .listMemoryEntries()
          .map((n) => ({ title: n.title, filename: n.filename }));
        return { output: JSON.stringify(notes), isError: false };
      },
    }),
    createDynamicTool({
      name: "web_search",
      description: "인터넷 검색을 통해 최신 정보나 지식을 찾습니다.",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "검색어" },
          count: { type: "integer", description: "반환할 결과 개수 (1-10)" },
        },
        required: ["query"],
      },
      execute: async (rawInput) => {
        const args = (rawInput ?? {}) as Record<string, unknown>;
        const query = args.query as string;
        // Clamp count to integer in [1,10]. Non-numeric / out-of-range falls
        // back to default 5. Prevents arbitrary large values reaching search
        // providers or the DuckDuckGo HTML parser.
        const rawCount = args.count;
        let count = 5;
        if (typeof rawCount === "number" && Number.isFinite(rawCount)) {
          const clamped = Math.min(10, Math.max(1, Math.floor(rawCount)));
          count = clamped;
        }
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
            return {
              output: JSON.stringify({
                query,
                provider: "Tavily",
                results: data.results?.map((r: any) => ({ title: r.title, snippet: r.content, url: r.url })) || [],
              }),
              isError: false,
            };
          }
          if (ws.provider === "serper" && apiKey) {
            const res = await fetch("https://google.serper.dev/search", {
              method: "POST",
              headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
              body: JSON.stringify({ q: query, num: count }),
            });
            const data = await res.json() as any;
            return {
              output: JSON.stringify({
                query,
                provider: "Serper",
                results: data.organic?.map((r: any) => ({ title: r.title, snippet: r.snippet, url: r.link })) || [],
              }),
              isError: false,
            };
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
          return {
            output: JSON.stringify({ query, provider: "DuckDuckGo", results }),
            isError: false,
          };
        } catch (error) {
          return {
            output: JSON.stringify({
              query,
              error: "검색 중 오류 발생",
              details: (error as Error).message,
            }),
            isError: true,
          };
        }
      },
    }),
    createDynamicTool({
      name: "web_fetch",
      description: "특정 URL의 웹 페이지 내용을 읽어 텍스트로 변환합니다.",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: {
        type: "object",
        properties: { url: { type: "string", description: "읽어올 웹 페이지 URL" } },
        required: ["url"],
      },
      execute: async (rawInput) => {
        const args = (rawInput ?? {}) as Record<string, unknown>;
        const url = args.url as string;
        try {
          // SSRF guard: route through NetworkGuard so private / loopback /
          // link-local / metadata endpoints are rejected per hop (incl. redirect
          // chain) and bad schemes / embedded credentials are refused up front.
          const response = await fetchPublicHttpResponse(url, {
            headers: { "User-Agent": "LVIS-Assistant/0.1.0" },
          });
          const html = await response.text();
          const text = html
            .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
            .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          return {
            output: JSON.stringify({
              url,
              content: text.slice(0, 5000),
              truncated: text.length > 5000,
            }),
            isError: false,
          };
        } catch (error) {
          return {
            output: JSON.stringify({
              url,
              error: "웹 페이지를 읽을 수 없습니다.",
              details: (error as Error).message,
            }),
            isError: true,
          };
        }
      },
    }),
    createRenderHtmlTool(),
  ];

  // Workflow system tools (S1+S2). Each is gated on its dependency being
  // wired so unit tests that boot a minimal registry stay green.
  if (workflowDeps?.getAskUserQuestionGate) {
    builtins.push(
      createAskUserQuestionTool({
        getGate: workflowDeps.getAskUserQuestionGate,
      }),
    );
  }
  if (workflowDeps?.routinesStore) {
    builtins.push(createScheduleRoutineTool(workflowDeps.routinesStore));
  }
  if (workflowDeps?.sessionTodoStore) {
    builtins.push(createTodoSessionWriteTool(workflowDeps.sessionTodoStore));
  }
  if (workflowDeps?.getSubAgentRunner && workflowDeps.emitAgentSpawn) {
    builtins.push(
      createAgentSpawnTool({
        getRunner: workflowDeps.getSubAgentRunner,
        emit: workflowDeps.emitAgentSpawn,
      }),
    );
  }
  if (
    workflowDeps?.skillStore &&
    workflowDeps.emitSkillLoad &&
    workflowDeps.skillOverlay &&
    workflowDeps.skillApprovalsStore &&
    workflowDeps.getApprovalGate
  ) {
    builtins.push(
      createSkillLoadTool({
        store: workflowDeps.skillStore,
        overlay: workflowDeps.skillOverlay,
        approvals: workflowDeps.skillApprovalsStore,
        getApprovalGate: workflowDeps.getApprovalGate,
        emit: workflowDeps.emitSkillLoad,
      }),
    );
  }

  toolRegistry.registerBatch(builtins);
}
