/**
 * Boot §4.2 Step 4 — Builtin tool registration + §4.4 knowledge DI.
 *
 * - registerRequestPluginMetaTool: request_plugin meta tool
 * - registerToolSearchMetaTool: tool_search meta tool (tool-level deferral)
 * - registerBuiltinTools: web_search, web_fetch, workflow tools
 * - wireKnowledgeAndIdleScheduler: worker-client capability 탐지 → HybridRetriever,
 *   knowledge tools 등록, IdleScheduler 배선
 */
import type { ToolRegistry } from "../tools/registry.js";
import { TOOL_SEARCH_TOOL_NAME } from "../tools/registry.js";
import type { SettingsService } from "../data/settings-store.js";
import type { PluginRuntime } from "../plugins/runtime.js";
import type { AuditService } from "../main/audit-service.js";
import { createDynamicTool, type Tool } from "../tools/base.js";
import { createKnowledgeSearchTools } from "../tools/knowledge-search.js";
import { createRenderHtmlTool } from "../tools/render-html.js";
import { createAskUserQuestionTool } from "../tools/ask-user-question.js";
import { createRoutineScheduleTool } from "../tools/routine-schedule.js";
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
import { t } from "../i18n/index.js";
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

// ─── web_search provider response shapes ────────────────────────────
// Narrow interfaces + runtime shape guards for the external search-provider
// responses. The provider boundary is untrusted: a response-shape change must
// surface as an explicit `isError` diagnostic, not silently degrade to an
// empty result array (which an untyped cast plus an `?? []` fallback hid).

interface TavilyResult {
  title?: unknown;
  content?: unknown;
  url?: unknown;
}
interface TavilyResponse {
  results?: TavilyResult[];
}
interface SerperOrganic {
  title?: unknown;
  snippet?: unknown;
  link?: unknown;
}
interface SerperResponse {
  organic?: SerperOrganic[];
}

/** A single normalized search hit emitted to the model. */
interface NormalizedSearchResult {
  title: string;
  snippet: string;
  url: string;
}

export class WebSearchShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchShapeError";
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Validates a Tavily response against the documented `{ results: [...] }`
 * shape. Throws {@link WebSearchShapeError} on a mismatch so a provider change
 * surfaces as a tool error rather than an empty result set.
 */
export function parseTavilyResponse(data: unknown): NormalizedSearchResult[] {
  if (typeof data !== "object" || data === null) {
    throw new WebSearchShapeError("Tavily response was not a JSON object");
  }
  const { results } = data as TavilyResponse;
  if (results === undefined) {
    throw new WebSearchShapeError("Tavily response missing `results`");
  }
  if (!Array.isArray(results)) {
    throw new WebSearchShapeError("Tavily `results` was not an array");
  }
  return results.map((r) => ({
    title: asString(r?.title),
    snippet: asString(r?.content),
    url: asString(r?.url),
  }));
}

/**
 * Validates a Serper response against the documented `{ organic: [...] }`
 * shape. Throws {@link WebSearchShapeError} on a mismatch.
 */
export function parseSerperResponse(data: unknown): NormalizedSearchResult[] {
  if (typeof data !== "object" || data === null) {
    throw new WebSearchShapeError("Serper response was not a JSON object");
  }
  const { organic } = data as SerperResponse;
  if (organic === undefined) {
    throw new WebSearchShapeError("Serper response missing `organic`");
  }
  if (!Array.isArray(organic)) {
    throw new WebSearchShapeError("Serper `organic` was not an array");
  }
  return organic.map((r) => ({
    title: asString(r?.title),
    snippet: asString(r?.snippet),
    url: asString(r?.link),
  }));
}

export function registerRequestPluginMetaTool(toolRegistry: ToolRegistry): void {
  // Option C — request_plugin 메타 툴 (항상 활성, scope filter 통과)
  // 실제 scope 확장은 ConversationLoop.queryLoop이 가로챈다.
  toolRegistry.register(createDynamicTool({
    name: "request_plugin",
    description: t("be_tools.requestPluginDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["pluginId"],
      properties: {
        pluginId: {
          type: "string",
          description: t("be_tools.requestPluginIdDescription"),
        },
      },
    },
    // Handled inline by ConversationLoop. If execution reaches this fallback,
    // the loop interception regressed; fail closed so traces expose it.
    execute: async () => ({
      output: t("be_tools.requestPluginLoopError"),
      isError: true,
    }),
  }));
}

export function registerToolSearchMetaTool(toolRegistry: ToolRegistry): void {
  // Tool-Level Deferral — tool_search 메타 툴. Statically registered and
  // visible whenever builtins are in scope. execute는 no-op — 실제 promotion 은
  // ConversationLoop.queryLoop 이 가로챈다 (request_plugin 과 동일 패턴).
  toolRegistry.register(createDynamicTool({
    name: TOOL_SEARCH_TOOL_NAME,
    description: t("be_tools.toolSearchDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: t("be_tools.toolSearchQueryDescription"),
        },
      },
    },
    // Handled inline by ConversationLoop. If execution reaches this fallback,
    // the loop interception regressed; fail closed so traces expose it.
    execute: async () => ({
      output: t("be_tools.toolSearchLoopError"),
      isError: true,
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
      description: t("be_tools.webSearchDescription"),
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: t("be_tools.webSearchQueryDescription") },
          count: { type: "integer", description: t("be_tools.webSearchCountDescription") },
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
            const data: unknown = await res.json();
            const results = parseTavilyResponse(data);
            return {
              output: JSON.stringify({ query, provider: "Tavily", results }),
              isError: false,
            };
          }
          if (ws.provider === "serper" && apiKey) {
            const res = await networkFetch("https://google.serper.dev/search", {
              method: "POST",
              headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
              body: JSON.stringify({ q: query, num: count }),
            });
            const data: unknown = await res.json();
            const results = parseSerperResponse(data);
            return {
              output: JSON.stringify({ query, provider: "Serper", results }),
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
          const results: NormalizedSearchResult[] = [];
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
              error: t("be_tools.webSearchError"),
              details: (error as Error).message,
            }),
            isError: true,
          };
        }
      },
    }),
    createDynamicTool({
      name: "web_fetch",
      description: t("be_tools.webFetchDescription"),
      source: "builtin",
      category: "read",
      categoryForInput: (input) => webFetchCategoryForInput(input, workflowDeps),
      isReadOnly: () => true,
      approvalCacheKey: (input) => webFetchPrivateNetworkApprovalCacheKey(input, workflowDeps),
      jsonSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: t("be_tools.webFetchUrlDescription") },
          allowPrivateNetwork: {
            type: "boolean",
            description: t("be_tools.webFetchAllowPrivateNetworkDescription"),
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
              error: t("be_tools.webFetchError"),
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
    builtins.push(createRoutineScheduleTool(workflowDeps.routinesStore));
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
