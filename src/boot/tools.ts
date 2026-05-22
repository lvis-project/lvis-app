/**
 * Boot §4.2 Step 4 — Builtin tool registration + §4.4 knowledge DI.
 *
 * - registerRequestPluginMetaTool: request_plugin meta tool
 * - registerBuiltinTools: web_search, web_fetch, workflow tools
 * - wireKnowledgeAndIdleScheduler: worker-client capability 탐지 → HybridRetriever,
 *   knowledge tools 등록, IdleScheduler 배선
 */
import type { ToolRegistry } from "../tools/registry.js";
import type { SettingsService } from "../data/settings-store.js";
import type { PluginRuntime } from "../plugins/runtime.js";
import type { AuditService } from "../main/audit-service.js";
import { createDynamicTool, type Tool } from "../tools/base.js";
import { createKnowledgeSearchTools } from "../tools/knowledge-search.js";
import { createRenderHtmlTool } from "../tools/render-html.js";
import { createAskUserQuestionTool } from "../tools/ask-user-question.js";
import { createScheduleRoutineTool } from "../tools/schedule-routine.js";
import { createTodoSessionWriteTool } from "../tools/todo-session-write.js";
import { createAgentSpawnTool, type AgentSpawnEvent } from "../tools/agent-spawn.js";
import { createSkillLoadTool, type SkillLoadEvent } from "../tools/skill-load.js";
import { createSkillListTool } from "../tools/skill-list.js";
import { createAgentListTool } from "../tools/agent-list.js";
import type { AskUserQuestionGate } from "../main/ask-user-question-gate.js";
import type { RoutinesStore } from "../main/routines-store.js";
import type { SessionTodoStore } from "../main/session-todo-store.js";
import type { SubAgentRunner } from "../engine/subagent-runner.js";
import type { SkillStore } from "../main/skill-store.js";
import type { SkillOverlay } from "../main/skill-overlay.js";
import type { SkillApprovalsStore } from "../main/skill-approvals-store.js";
import type { AgentProfileStore } from "../main/agent-profile-store.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import { HybridRetriever } from "../main/hybrid-retriever.js";
import { MockCloudIndexAdapter } from "../main/cloud-index-adapter.js";
import { IdleSchedulerService, adaptPowerMonitor, type WorkerClientLite } from "../main/idle-scheduler.js";
import { fetchPublicHttpResponse } from "../core/network-guard.js";
import { demoHostMapContainsHost } from "../main/demo-host-resolver.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

type DemoHostResolverDeps = {
  demoActiveVendor?: string;
  demoHostMap?: string;
  demoHostMapApplied?: boolean;
  privateNetworkFetch?: typeof fetch;
};

function isDemoHostResolverMappedUrl(
  input: unknown,
  deps?: DemoHostResolverDeps,
): boolean {
  const args = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  return (
    deps?.demoActiveVendor === "azure-foundry" &&
    deps.demoHostMapApplied === true &&
    typeof args.url === "string" &&
    demoHostMapContainsHost(deps.demoHostMap, args.url)
  );
}

function isDemoHostResolverMappedFetchInput(
  input: Parameters<typeof fetch>[0],
  deps?: DemoHostResolverDeps,
): boolean {
  if (typeof input === "string" || input instanceof URL) {
    return isDemoHostResolverMappedUrl({ url: input.toString() }, deps);
  }
  return isDemoHostResolverMappedUrl({ url: input.url }, deps);
}

function webFetchRequiresPrivateNetwork(
  input: unknown,
  deps?: DemoHostResolverDeps,
): boolean {
  const args = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  return args.allowPrivateNetwork === true || isDemoHostResolverMappedUrl(input, deps);
}

function webFetchPrivateNetworkPolicy(
  input: unknown,
  deps?: DemoHostResolverDeps,
): boolean | ((url: URL) => boolean) {
  const args = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  if (args.allowPrivateNetwork === true) return true;
  if (!isDemoHostResolverMappedUrl(input, deps)) return false;
  return (url: URL) => demoHostMapContainsHost(deps?.demoHostMap, url.toString());
}

function webFetchPrivateNetworkApprovalCacheKey(
  input: unknown,
  deps?: DemoHostResolverDeps,
): string | undefined {
  const args = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  if (!webFetchRequiresPrivateNetwork(input, deps) || typeof args.url !== "string") {
    return undefined;
  }
  try {
    const parsed = new URL(args.url);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.host) {
      return undefined;
    }
    return `private-network:${parsed.protocol}//${parsed.host.toLowerCase()}`;
  } catch {
    return undefined;
  }
}

function webFetchCategoryForInput(
  input: unknown,
  deps?: DemoHostResolverDeps,
): "read" | "network" {
  return webFetchRequiresPrivateNetwork(input, deps) ? "network" : "read";
}

function webFetchFetchImpl(
  input: unknown,
  deps: WorkflowToolDeps | undefined,
  networkFetch: typeof fetch,
): typeof fetch {
  if (!isDemoHostResolverMappedUrl(input, deps)) return networkFetch;
  return (async (fetchInput: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!isDemoHostResolverMappedFetchInput(fetchInput, deps)) {
      return networkFetch(fetchInput, init);
    }
    if (!deps?.privateNetworkFetch) {
      throw new Error("web_fetch: private endpoint fetch is not configured for mapped demo host");
    }
    return deps.privateNetworkFetch(fetchInput, init);
  }) as typeof fetch;
}

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
    const knowledgePlugin = workerClientPluginId
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
    const workerClient = knowledgePlugin?.getWorkerClient?.() as
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
        if (typeof knowledgePlugin?.setIdleScheduler === "function") {
          knowledgePlugin.setIdleScheduler(idleScheduler);
          log.info("boot: idle-scheduler wired to worker-client plugin");
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
  agentProfileStore?: AgentProfileStore;
  /** C2(c): per-session skill overlay registry. */
  skillOverlay?: SkillOverlay;
  /** C2(d): persistent skill-approval allowlist. */
  skillApprovalsStore?: SkillApprovalsStore;
  /** C2(d): ApprovalGate for first-use skill approval modal. */
  getApprovalGate?: () => ApprovalGate | undefined;
  /** Electron network-stack fetch used when host-resolver-rules are active. */
  networkFetch?: typeof fetch;
  /** Direct Electron fetch for demo host-map URLs when system proxy/PAC is active. */
  privateNetworkFetch?: typeof fetch;
  /** Captured demo vendor before packaged env scrub. */
  demoActiveVendor?: string;
  /** Captured Chromium host-resolver-rules map before packaged env scrub. */
  demoHostMap?: string;
  /** True only when Chromium host-resolver-rules were validated and applied at boot. */
  demoHostMapApplied?: boolean;
  emitAgentSpawn?: (event: AgentSpawnEvent) => void;
  emitSkillLoad?: (event: SkillLoadEvent) => void;
}

export function registerBuiltinTools(
  toolRegistry: ToolRegistry,
  settingsService: SettingsService,
  workflowDeps?: WorkflowToolDeps,
): void {
  const networkFetch = workflowDeps?.networkFetch ?? fetch;
  const builtins: Tool[] = [
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
            const res = await networkFetch("https://api.tavily.com/search", {
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
            const res = await networkFetch("https://google.serper.dev/search", {
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
          const ddgRes = await networkFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
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
      categoryForInput: (input) => webFetchCategoryForInput(input, workflowDeps),
      isReadOnly: () => true,
      approvalCacheKey: (input) => webFetchPrivateNetworkApprovalCacheKey(input, workflowDeps),
      jsonSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "읽어올 웹 페이지 URL" },
          allowPrivateNetwork: {
            type: "boolean",
            description:
              "사용자 승인 후 RFC1918/ULA 사설망 주소 접근을 허용합니다. loopback/link-local/metadata 주소는 계속 차단됩니다.",
          },
        },
        required: ["url"],
      },
      execute: async (rawInput) => {
        const args = (rawInput ?? {}) as Record<string, unknown>;
        const url = args.url as string;
        const allowPrivateNetwork = webFetchPrivateNetworkPolicy(rawInput, workflowDeps);
        try {
          // SSRF guard: route through NetworkGuard so private / loopback /
          // link-local / metadata endpoints are rejected per hop (incl. redirect
          // chain) and bad schemes / embedded credentials are refused up front.
          const fetchImpl = webFetchFetchImpl(rawInput, workflowDeps, networkFetch);
          const response = await fetchPublicHttpResponse(url, {
            allowPrivateNetworks: allowPrivateNetwork,
            fetchImpl,
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
    const agentProfileStore = workflowDeps.agentProfileStore;
    builtins.push(
      createAgentSpawnTool({
        getRunner: workflowDeps.getSubAgentRunner,
        getAgentProfile: agentProfileStore
          ? async (name) => await agentProfileStore.load(name)
          : undefined,
        emit: workflowDeps.emitAgentSpawn,
      }),
    );
  }
  if (workflowDeps?.agentProfileStore) {
    builtins.push(createAgentListTool(workflowDeps.agentProfileStore));
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
    builtins.push(createSkillListTool(workflowDeps.skillStore));
  }

  toolRegistry.registerBatch(builtins);
}
