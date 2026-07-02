/**
 * MCP Client — §9.5 Transports (stdio + Streamable HTTP)
 *
 * JSON-RPC 2.0 기반 MCP 서버 연결. Transport 전략 패턴으로 stdio와
 * Streamable HTTP (spec revision 2025-03-26) 를 지원한다.
 *
 * 프로토콜 핸드셰이크 (transport 무관):
 *   1. → initialize (client capabilities)
 *   2. ← ServerCapabilities response
 *   3. → notifications/initialized
 *   4. → tools/list
 *   5. ← tool schemas
 *   6. → tools/call (runtime)
 *
 * Transport 선택:
 *   - `stdio`: subprocess + Content-Length framed JSON-RPC on stdin/stdout.
 *   - `http` : POST JSON-RPC to a single URL. Response is either
 *              `application/json` (single response) or `text/event-stream`
 *              (streaming — last `message` event carries the response).
 *              URL은 NetworkGuard(Tier A2)로 사전 검증해 SSRF 차단.
 *
 * 안전 원칙:
 * - MCP 서버 crash가 호스트 앱을 crash하지 않음 (프로세스/요청 격리)
 * - 모든 연결/호출은 McpGovernance를 통해 사전 검증
 * - HTTP transport는 NetworkGuard를 통과하지 못하면 `network guard:` 접두사
 *   NetworkGuardError 로 거부
 * - 도구는 mcp_{prefix}_{name} 네임스페이스로 ToolRegistry에 등록
 */
import { spawn, type ChildProcess } from "node:child_process";
import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpServerState,
  McpStdioServerConfig,
  McpToolSchema,
  McpUiPayload,
} from "./types.js";
import type { McpGovernance } from "./mcp-governance.js";
import type { ToolRegistry } from "../tools/registry.js";
import { mcpToolToTool } from "./mcp-tool-adapter.js";
import type { PermissionManager } from "../permissions/permission-manager.js";
import {
  NetworkGuardError,
  ensurePublicHttpUrl,
  fetchPublicHttpResponse,
  validateHttpUrl,
} from "../core/network-guard.js";
import { createLogger } from "../lib/logger.js";
import { resolveStdioSpawnCommand } from "./uvx-command.js";
import { trackManagedChildProcess } from "../main/managed-child-processes.js";
import {
  isAsrtSandboxActive,
  wrapWorkerCommand,
  cleanupAsrtSandboxAfterCommand,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
} from "../permissions/asrt-sandbox.js";
import { buildSandboxedChildEnv } from "../tools/safe-env.js";
import {
  markMcpServerWrapped,
  unmarkMcpServerWrapped,
} from "../permissions/sandbox-capability.js";
import { shellQuote, resolveShell } from "../lib/shell-resolver.js";
import { t } from "../i18n/index.js";
const log = createLogger("mcp-client");

// ─── JSON-RPC 2.0 Types ──────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ─── MCP Protocol Types ──────────────────────────────

/**
 * A JSON-RPC error returned by the server, carrying the numeric `code` so the
 * connect path can detect `-32601` (method-not-found → dual-era fallback) and
 * `callTool` can map `-32003`/`-32004` (design §8). The base runner previously
 * collapsed these to a plain `Error`, losing the code.
 */
class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpRpcError";
  }
}

/** Legacy `initialize` result — used ONLY on the dual-era external fallback. */
interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

/**
 * `server/discover` result (RC). `DiscoverResult extends CacheableResult`, so
 * `resultType`/`ttlMs`/`cacheScope` are required on the wire; we read only what
 * this slice needs (`supportedVersions`/`capabilities`/`serverInfo`).
 */
interface McpDiscoverResult {
  resultType?: string;
  ttlMs?: number;
  cacheScope?: "public" | "private";
  supportedVersions: string[];
  capabilities: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
    completions?: Record<string, unknown>;
    experimental?: Record<string, unknown>;
    extensions?: Record<string, unknown>;
  };
  serverInfo: {
    name: string;
    version: string;
    title?: string;
  };
  instructions?: string;
}

/** The host's per-request client capabilities (advertised in `_meta`). */
export interface McpClientCapabilities {
  elicitation?: { form?: Record<string, never>; url?: Record<string, never> };
  experimental?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/**
 * Derives the host's client capabilities for a SINGLE outbound request
 * (milestone `governance-per-request`, design §3.6). Per-request — not connect-
 * time — because what the host can offer varies with the active turn: an
 * interactive turn can elicit (advertise `elicitation`); a headless/routine turn
 * cannot (advertise none, so a server requiring it gets a clean `-32003` instead
 * of a hung approval). The exact deriving signals (turn consent state,
 * headless/routine mode, #811 policy) are wired by the host; omitted ⇒ a fixed
 * sound default. This is the client-side half of per-request governance; the
 * per-request server-capability GATING half lands with the cluster-reviewed
 * governance change.
 */
export type McpClientCapabilityProvider = () => McpClientCapabilities;

interface McpToolsListResult {
  tools: McpToolSchema[];
}

interface McpToolCallResult {
  /**
   * RC result discriminator (§8): "complete" | "input_required" | "task" (the
   * last is Tasks-extension only). Absent ⇒ treat as "complete" (legacy/dual-era).
   */
  resultType?: string;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  /**
   * MRTR (§8 `InputRequiredResult`) — present only when `resultType ===
   * "input_required"`. `inputRequests` maps an opaque id → the server's request
   * (an `Elicit` / `CreateMessage` / `ListRoots`); `requestState` is opaque and
   * MUST be echoed verbatim on the retry. ≥1 of the two is present.
   */
  inputRequests?: Record<string, Record<string, unknown>>;
  requestState?: string;
  /** MCP Apps spec §3.2 — optional UI extension metadata. */
  _meta?: {
    ui?: {
      resourceUri?: string;
      slot?: string;
      height?: number;
      title?: string;
      csp?: McpUiPayload["csp"];
    };
    [key: string]: unknown;
  };
}

/**
 * Resolves ONE MRTR `inputRequest` (§8). The host wires this to its capability
 * surfaces — elicitation → the approval-gate modal, sampling → the host LLM —
 * and returns the response value placed under `inputResponses[id]` on retry. The
 * client owns the LOOP (detect / gather / echo `requestState` / retry / bound);
 * the resolver owns WHAT each request means. Absent ⇒ the client cannot satisfy
 * `input_required` and fails with a typed error (No-Fallback).
 */
export type McpInputRequestResolver = (
  id: string,
  request: Record<string, unknown>,
) => Promise<unknown>;

/** §8 Tasks extension — task lifecycle status (`experimental-ext-tasks`). */
type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

/**
 * The task fields a `CreateTaskResult` (`= Result & Task`, §8) carries inline.
 * Read defensively off the result (the extension versions independently of the
 * core RC; its exact result-retrieval shape is re-verified when the
 * `experimental-ext-tasks` draft is pinned — design §6).
 */
interface McpTaskState {
  taskId: string;
  status: McpTaskStatus;
  ttlMs?: number | null;
  pollIntervalMs?: number;
}

// ─── Constants ────────────────────────────────────────

import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

// #1230 — pre-adopt the MCP 2026-07-28 stateless Release Candidate
// (docs/architecture/mcp-alignment-design.md §8). LVIS speaks RC by default:
// no initialize handshake, per-request `_meta` capability negotiation,
// `server/discover` for capabilities. MCP_LEGACY_PROTOCOL_VERSION is used ONLY
// by the documented dual-era exception (design §0) when an EXTERNAL server does
// not implement `server/discover` (a pre-RC server). LVIS's own plugins are
// always RC, so that fallback never runs for first-party plugins.
const MCP_PROTOCOL_VERSION = "2026-07-28";
const MCP_LEGACY_PROTOCOL_VERSION = "2024-11-05";

// Reserved per-request `_meta` keys (verified verbatim vs the upstream MCP
// schema/draft/schema.ts — design §8).
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

// JSON-RPC / MCP error codes (verified §8).
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_MISSING_REQUIRED_CLIENT_CAPABILITY = -32003;
const RPC_UNSUPPORTED_PROTOCOL_VERSION = -32004;

const CLIENT_INFO = { name: "lvis-app", version: "0.1.0" } as const;

/** MCP Apps extension key (§8 `io.modelcontextprotocol/ui`, 2026-01-26 snapshot). */
const MCP_APPS_UI_EXTENSION = "io.modelcontextprotocol/ui";

const DEFAULT_REQUEST_TIMEOUT_MS = TOOL_TIMEOUT_POLICY.mcpRequestDefaultMs;
const MAX_REQUEST_TIMEOUT_MS = TOOL_TIMEOUT_POLICY.mcpRequestMaxMs;
const HANDSHAKE_TIMEOUT_MS = 10_000; // discover / initialize / tools/list 핸드셰이크용
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const MAX_BUFFERED_RESPONSES = 128;
/**
 * MRTR runaway guard (§8): a server that returns `input_required` forever would
 * loop the client indefinitely. Bound the rounds; exceeding it is a typed error.
 */
const MAX_MRTR_ROUNDS = 8;
/**
 * Tasks extension (§8) polling bounds. The synchronous `callTool` await is
 * capped by the per-call `timeoutMs` (already clamped to the 120s tool ceiling);
 * these bound the poll cadence within that window. Truly fire-and-forget tasks
 * beyond the ceiling are a separate background-tracking UX, not this path.
 */
const DEFAULT_TASK_POLL_INTERVAL_MS = 1_000;
const MIN_TASK_POLL_INTERVAL_MS = 50;
const MAX_TASK_POLLS = 600;

// ─── Transport Strategy ──────────────────────────────

/**
 * Minimal transport contract shared by stdio + HTTP.
 * - `send` writes a JSON-RPC request/notification.
 * - Incoming messages are delivered via `onMessage`.
 * - `close` must resolve all pending requests as rejected.
 * - `isAlive` lets the health check poll without caring about the transport.
 */
export interface McpTransport {
  readonly kind: "stdio" | "http" | "loopback";
  open(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  isAlive(): boolean;
  onMessage(handler: (msg: JsonRpcResponse) => void): void;
  onClose(handler: (reason: string) => void): void;
  /**
   * Fired by streaming transports whenever a chunk of data arrives. Lets the
   * client reset per-request timeout timers so long-running SSE responses
   * (e.g., a streaming `tools/call`) don't trip the standard 30s timeout
   * while data is still flowing. Optional — only HTTP+SSE uses it.
   */
  onActivity?(handler: () => void): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  /** Per-chunk activity window — gets reset by `resetPendingTimers` when SSE
   *  data flows so a long-running streaming response isn't killed mid-flight. */
  timeoutMs: number;
  /** Absolute wall-clock deadline (`Date.now()` ms) computed at request
   *  creation. Streaming activity reset cannot push the request past this
   *  point — the per-chunk timer is clamped to `min(timeoutMs, deadlineMs -
   *  now)` so a hostile server cannot trickle one byte every (timeoutMs-1)
   *  to extend the request indefinitely. */
  deadlineMs: number;
  method: string;
}

export class McpClient {
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  /** 응답이 pending 등록 전에 도착한 경우를 위한 버퍼 (race condition 대응) */
  private readonly bufferedResponses = new Map<number, JsonRpcResponse>();
  private healthTimer: NodeJS.Timeout | null = null;
  private transport: McpTransport | null = null;
  /**
   * Protocol era resolved at connect: "rc" (2026-07-28 stateless, per-request
   * `_meta`) or "legacy" (the documented dual-era exception for an EXTERNAL
   * pre-RC server). Defaults to "rc" so the initial `server/discover` probe
   * carries the RC `_meta`; flips to "legacy" only when that probe 404s.
   */
  private mode: "rc" | "legacy" = "rc";
  /**
   * Whether the server ADVERTISED the MCP Apps extension (`io.modelcontextprotocol/ui`)
   * in `server/discover`. The host honors a tool result's `_meta.ui` only when
   * this is true — a server that did not declare Apps cannot smuggle a UI surface
   * (the §3.7 "permission enforcement per `_meta.ui`" gate; the renderer CSP is
   * the second layer). Legacy (dual-era) servers never advertise Apps.
   */
  private appsUiAdvertised = false;

  readonly state: McpServerState;

  constructor(
    private readonly config: McpServerConfig,
    private readonly governance: McpGovernance,
    private readonly toolRegistry: ToolRegistry,
    private readonly permissionManager?: PermissionManager,
    /**
     * Optional pre-built transport. When provided, `connect()` uses it instead
     * of constructing a stdio/HTTP transport from `config`. This is the seam an
     * in-process first-party plugin uses to bind a {@link McpTransport} straight
     * to its {@link PluginMcpServer} loopback (design §3.1 hybrid topology); the
     * external stdio/HTTP path is unchanged when it is omitted.
     */
    private readonly transportOverride?: McpTransport,
    /**
     * Optional MRTR resolver (milestone `mrtr-input-loop`). When a `tools/call`
     * returns `input_required`, each `inputRequest` is resolved through this and
     * the responses are echoed back on retry. Omitted ⇒ the client fails closed
     * on `input_required` (No-Fallback — it never fabricates a response).
     */
    private readonly inputResolver?: McpInputRequestResolver,
    /**
     * Optional per-request client-capability provider (milestone
     * `governance-per-request`). Called on EVERY outbound request so the
     * advertised capabilities track the active turn. Omitted ⇒ a fixed sound
     * default (elicitation form+url).
     */
    private readonly capabilityProvider?: McpClientCapabilityProvider,
  ) {
    this.state = {
      id: config.id,
      status: "disconnected",
      registeredTools: [],
    };
  }

  // ─── Lifecycle ──────────────────────────────────────

  /** 서버 연결 + 핸드셰이크 + 도구 등록 */
  async connect(): Promise<void> {
    // Layer 1-2: 거버넌스 검증
    const validation = this.governance.validateServer(this.config);
    if (!validation.valid) {
      this.state.status = "error";
      this.state.lastError = validation.reason;
      throw new Error(`[mcp-client] ${t("be_mcpClient.governanceValidationFailed", { layer: String(validation.layer), reason: validation.reason })}`);
    }

    if (this.config.transport !== "stdio" && this.config.transport !== "http") {
      throw new Error(
        `[mcp-client] ${t("be_mcpClient.unsupportedTransport", { transport: this.config.transport })}`,
      );
    }

    this.state.status = "connecting";

    try {
      this.transport = this.transportOverride
        ?? (this.config.transport === "stdio"
          ? new StdioTransport(this.config as McpStdioServerConfig)
          : new HttpTransport(this.config as McpHttpServerConfig));

      this.transport.onMessage((msg) => this.handleResponse(msg));
      this.transport.onClose((reason) => this.handleTransportClose(reason));
      // Streaming transports call this on every incoming chunk — reset
      // per-request timers so long streaming responses don't hit timeout.
      this.transport.onActivity?.(() => this.resetPendingTimers());

      await this.transport.open();

      // RC handshake (#1230, design §3.6): stateless — no `initialize`. Probe
      // `server/discover` (which carries the per-request RC `_meta`) to read the
      // server's capabilities. The probe runs in the default "rc" mode so the
      // `_meta` is stamped.
      try {
        const discover = await this.sendRequest<McpDiscoverResult>(
          "server/discover",
          {},
          HANDSHAKE_TIMEOUT_MS,
        );
        this.mode = "rc";
        // §3.7 MCP Apps permission gate — only honor `_meta.ui` from a server
        // that DECLARED the ui extension at discovery.
        this.appsUiAdvertised =
          discover.capabilities?.extensions?.[MCP_APPS_UI_EXTENSION] !== undefined;
        log.info(
          {
            protocol: MCP_PROTOCOL_VERSION,
            supportedVersions: discover.supportedVersions,
            server: `${discover.serverInfo.name}@${discover.serverInfo.version}`,
            apps: this.appsUiAdvertised,
          },
          `${this.config.id} RC discover 완료`,
        );
      } catch (err) {
        // Documented dual-era exception (design §0): an EXTERNAL pre-RC server
        // does not implement `server/discover` and answers `-32601`. Fall back
        // to the legacy `initialize` handshake. ANY other error is a real
        // failure and propagates. LVIS's own plugins are always RC, so this
        // never runs for first-party plugins.
        if (!(err instanceof McpRpcError) || err.code !== RPC_METHOD_NOT_FOUND) {
          throw err;
        }
        this.mode = "legacy";
        const initResult = await this.sendRequest<McpInitializeResult>(
          "initialize",
          {
            protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: CLIENT_INFO,
          },
          HANDSHAKE_TIMEOUT_MS,
        );
        await this.sendNotification("notifications/initialized", {});
        log.info(
          {
            protocol: initResult.protocolVersion,
            server: `${initResult.serverInfo.name}@${initResult.serverInfo.version}`,
            era: "legacy",
          },
          `${this.config.id} legacy initialize 완료 (dual-era exception)`,
        );
      }

      // 도구 목록 요청 (mode-aware `_meta` via sendRequest)
      const toolsResult = await this.sendRequest<McpToolsListResult>("tools/list", {}, HANDSHAKE_TIMEOUT_MS);
      const tools = toolsResult.tools ?? [];

      // Layer 3: 도구 등록 검증
      const existingToolNames = new Set(this.toolRegistry.listAll().map((t) => t.name));
      const toolValidation = this.governance.validateToolRegistration(
        this.config.id,
        tools,
        existingToolNames,
      );
      if (!toolValidation.valid) {
        await this.disconnect();
        throw new Error(
          `[mcp-client] ${t("be_mcpClient.toolRegistrationValidationFailed", { layer: String(toolValidation.layer), reason: toolValidation.reason })}`,
        );
      }

      // ToolRegistry에 등록 (네임스페이스 적용)
      this.registerTools(tools);

      this.state.status = "connected";
      this.state.connectedAt = new Date().toISOString();

      // Health check 시작
      this.startHealthCheck();

      log.info(
        `${this.config.id} 연결 완료: ${this.state.registeredTools.length}개 도구 등록`,
      );
    } catch (err) {
      this.state.status = "error";
      this.state.lastError = err instanceof Error ? err.message : String(err);
      // transport 정리
      await this.closeTransport();
      throw err;
    }
  }

  /** 서버 연결 해제 + 도구 제거 */
  async disconnect(): Promise<void> {
    this.stopHealthCheck();
    this.rejectAllPending(t("be_mcpClient.serverDisconnected"));
    this.clearRegisteredToolOverrides();

    // ToolRegistry에서 도구 제거
    this.toolRegistry.unregisterByMcp(this.config.id);
    this.state.registeredTools = [];

    // transport 종료
    await this.closeTransport();

    this.state.status = "disconnected";
    this.state.lastError = undefined;
    log.info(`${this.config.id} 연결 해제 완료`);
  }

  // ─── Tool Execution ─────────────────────────────────

  /** MCP 도구 호출 — ToolExecutor에서 사용 */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; uiPayload?: McpUiPayload }> {
    if (this.state.status !== "connected" || !this.transport?.isAlive()) {
      throw new Error(`[mcp-client] ${t("be_mcpClient.serverNotConnected", { id: this.config.id })}`);
    }

    const approval = this.governance.getApproval(this.config.id);
    const timeoutMs = Math.min(
      approval?.connectionTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
    );

    try {
      // MRTR loop (§8): a `tools/call` may return `input_required` instead of a
      // `complete` result; the client gathers responses for each `inputRequest`
      // and retries the SAME logical call with `inputResponses` + the echoed
      // (opaque) `requestState`, bounded by MAX_MRTR_ROUNDS.
      let params: Record<string, unknown> = { name, arguments: args };
      let rounds = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result = await this.sendRequest<McpToolCallResult>("tools/call", params, timeoutMs);

        if (result.resultType === "input_required") {
          rounds += 1;
          if (rounds > MAX_MRTR_ROUNDS) {
            throw new Error(
              `[mcp-client] tool '${name}' on '${this.config.id}' exceeded ${MAX_MRTR_ROUNDS} input_required rounds (possible runaway server)`,
            );
          }
          params = await this.resolveInputRequired(name, args, result);
          continue;
        }
        if (result.resultType === "task") {
          // Tasks extension (§8 `io.modelcontextprotocol/tasks`): a long-running
          // tool returns a `CreateTaskResult` (Result & Task); poll to terminal.
          return await this.awaitTask(name, args, result, timeoutMs);
        }

        return this.renderToolResult(result);
      }
    } catch (err) {
      // Map the RC capability/version errors (§8) to clearer host messages.
      if (err instanceof McpRpcError && err.code === RPC_MISSING_REQUIRED_CLIENT_CAPABILITY) {
        throw new Error(
          `[mcp-client] '${this.config.id}' requires a client capability the host did not advertise for tool '${name}' (-32003): ${err.message}`,
        );
      }
      if (err instanceof McpRpcError && err.code === RPC_UNSUPPORTED_PROTOCOL_VERSION) {
        throw new Error(
          `[mcp-client] '${this.config.id}' does not support protocol ${MCP_PROTOCOL_VERSION} for tool '${name}' (-32004): ${err.message}`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[mcp-client] ${t("be_mcpClient.toolCallFailed", { id: this.config.id, name, message })}`);
    }
  }

  /**
   * Resolve one MRTR `input_required` round (§8): gather a response for each
   * `inputRequest` via the injected resolver, then build the retry params for
   * the SAME logical call — `{ name, arguments, inputResponses, requestState }`
   * with `requestState` echoed verbatim (opaque). Fails closed (typed error) if
   * no resolver is wired — the client never fabricates a response (No-Fallback).
   */
  private async resolveInputRequired(
    name: string,
    args: Record<string, unknown>,
    result: McpToolCallResult,
  ): Promise<Record<string, unknown>> {
    if (!this.inputResolver) {
      throw new Error(
        `[mcp-client] tool '${name}' on '${this.config.id}' returned resultType="input_required" but no MRTR input resolver is wired (elicitation/sampling unavailable in this context)`,
      );
    }
    const inputResponses: Record<string, unknown> = {};
    for (const [id, request] of Object.entries(result.inputRequests ?? {})) {
      inputResponses[id] = await this.inputResolver(id, request);
    }
    const retry: Record<string, unknown> = { name, arguments: args, inputResponses };
    // requestState is opaque and MUST be echoed verbatim when present (§8).
    if (result.requestState !== undefined) retry.requestState = result.requestState;
    return retry;
  }

  /** Render a `complete` CallToolResult to text (+ MCP Apps UI). Throws on isError. */
  private renderToolResult(result: McpToolCallResult): { text: string; uiPayload?: McpUiPayload } {
    const content = result.content ?? [];
    if (result.isError) {
      throw new Error(content.map((c) => c.text ?? JSON.stringify(c)).join("\n"));
    }
    const text = content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
    // MCP Apps permission gate (§3.7): ignore `_meta.ui` unless the server
    // advertised the ui extension at discovery.
    const uiMeta = this.appsUiAdvertised ? result._meta?.ui : undefined;
    let uiPayload: McpUiPayload | undefined;
    if (uiMeta?.resourceUri) {
      uiPayload = {
        serverId: this.config.id,
        resourceUri: uiMeta.resourceUri,
        slot: (uiMeta.slot as McpUiPayload["slot"]) ?? "chat",
        height: uiMeta.height,
        title: uiMeta.title,
        csp: uiMeta.csp,
      };
    }
    return { text, uiPayload };
  }

  /** Read the inline `Task` fields off a `CreateTaskResult`/`tasks/get` result (§8). */
  private extractTaskState(result: McpToolCallResult, name: string): McpTaskState {
    const r = result as unknown as Record<string, unknown>;
    const taskId = r.taskId;
    const status = r.status;
    if (typeof taskId !== "string" || typeof status !== "string") {
      throw new Error(
        `[mcp-client] tool '${name}' on '${this.config.id}' returned resultType="task" without a valid taskId/status`,
      );
    }
    return {
      taskId,
      status: status as McpTaskStatus,
      ttlMs: typeof r.ttlMs === "number" ? r.ttlMs : null,
      pollIntervalMs: typeof r.pollIntervalMs === "number" ? r.pollIntervalMs : undefined,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Drive a `CreateTaskResult` to a terminal status (§8 Tasks). Polls `tasks/get`
   * at the server's `pollIntervalMs` (clamped) until `completed` (→ render the
   * Result&Task), `failed`/`cancelled` (→ throw), bounded by the per-call
   * `timeoutMs`; on timeout it issues `tasks/cancel` and throws. In-task
   * `input_required` is a typed not-yet (No-Fallback) — that MRTR-in-task path
   * lands when the `experimental-ext-tasks` draft is pinned.
   */
  private async awaitTask(
    name: string,
    _args: Record<string, unknown>,
    createResult: McpToolCallResult,
    timeoutMs: number,
  ): Promise<{ text: string; uiPayload?: McpUiPayload }> {
    const deadline = Date.now() + timeoutMs;
    let current = createResult;
    let task = this.extractTaskState(current, name);
    let polls = 0;

    for (;;) {
      if (task.status === "completed") {
        return this.renderToolResult(current);
      }
      if (task.status === "failed" || task.status === "cancelled") {
        throw new Error(
          `[mcp-client] task '${task.taskId}' on '${this.config.id}' ended '${task.status}'`,
        );
      }
      if (task.status === "input_required") {
        throw new Error(
          `[mcp-client] task '${task.taskId}' on '${this.config.id}' requires input — in-task MRTR is not implemented yet (experimental-ext-tasks draft pending)`,
        );
      }

      if (Date.now() >= deadline || polls >= MAX_TASK_POLLS) {
        await this.sendRequest("tasks/cancel", { taskId: task.taskId }, timeoutMs).catch(() => {});
        throw new Error(
          `[mcp-client] task '${task.taskId}' on '${this.config.id}' did not complete within ${timeoutMs}ms`,
        );
      }

      polls += 1;
      const interval = Math.max(MIN_TASK_POLL_INTERVAL_MS, task.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS);
      await this.delay(Math.min(interval, Math.max(0, deadline - Date.now())));
      current = await this.sendRequest<McpToolCallResult>("tasks/get", { taskId: task.taskId }, timeoutMs);
      task = this.extractTaskState(current, name);
    }
  }

  /** 서버 상태 조회 */
  getState(): McpServerState {
    return { ...this.state };
  }

  // ─── Resource Read (MCP Apps §3.3) ─────────────────

  /**
   * Fetch a `ui://` resource from the MCP server via `resources/read`.
   * Returns the text content of the first text blob in the response.
   */
  async readResource(uri: string): Promise<string> {
    if (this.state.status !== "connected" || !this.transport?.isAlive()) {
      throw new Error(`[mcp-client] ${t("be_mcpClient.serverNotConnected", { id: this.config.id })}`);
    }

    interface McpResourceReadResult {
      contents: Array<{ type?: string; text?: string; blob?: string; uri?: string; mimeType?: string }>;
    }

    const result = await this.sendRequest<McpResourceReadResult>("resources/read", { uri });
    const textPart = result.contents.find((c) => c.text !== undefined);
    if (!textPart?.text) {
      throw new Error(`[mcp-client] ${t("be_mcpClient.resourceReadNoText", { uri })}`);
    }
    return textPart.text;
  }

  // ─── JSON-RPC Transport ─────────────────────────────

  /**
   * The host's per-request client capabilities (RC `_meta`). This slice
   * advertises a fixed sound default; the `mrtr-input-loop`/`governance-per-request`
   * milestones derive it from the active turn's consent state + #811 policy
   * (design §3.6). `elicitation` declares the host CAN gather approvals.
   */
  private clientCapabilities(): McpClientCapabilities {
    // Per-request when a provider is wired (the active turn decides); otherwise a
    // fixed sound default. `withRequestMeta` calls this on every request.
    return this.capabilityProvider?.() ?? { elicitation: { form: {}, url: {} }, extensions: {} };
  }

  /**
   * Stamp the three required RC reserved `_meta` keys (protocolVersion,
   * clientInfo, clientCapabilities) onto a request's params. In the dual-era
   * "legacy" mode the params are returned unchanged (a pre-RC external server
   * uses the old handshake and does not expect the RC `_meta`).
   */
  private withRequestMeta(params: Record<string, unknown>): Record<string, unknown> {
    if (this.mode === "legacy") return params;
    const existingMeta =
      params._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
        ? (params._meta as Record<string, unknown>)
        : {};
    return {
      ...params,
      _meta: {
        ...existingMeta,
        [META_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION,
        [META_CLIENT_INFO]: CLIENT_INFO,
        [META_CLIENT_CAPABILITIES]: this.clientCapabilities(),
      },
    };
  }

  private sendRequest<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const transport = this.transport;
      if (!transport || !transport.isAlive()) {
        reject(new Error(`[mcp-client] ${t("be_mcpClient.transportNotActive")}`));
        return;
      }

      // Per-request capability gate (milestone `governance-per-request`): every
      // request is checked against the capability it exercises, not just a
      // connect-time whitelist. Discovery/control methods pass; a tools/resources/
      // prompts request on a server not approved for that capability is denied.
      const capabilityCheck = this.governance.validateRequestCapability(this.config.id, method, params);
      if (!capabilityCheck.valid) {
        reject(new Error(`[mcp-client] ${capabilityCheck.reason}`));
        return;
      }

      const maxConcurrentRequests = this.governance.getApproval(this.config.id)?.maxConcurrentRequests;
      if (
        typeof maxConcurrentRequests === "number"
        && maxConcurrentRequests > 0
        && this.pendingRequests.size >= maxConcurrentRequests
      ) {
        reject(
          new Error(
            `[mcp-client] ${t("be_mcpClient.concurrentRequestLimitExceeded", { max: String(maxConcurrentRequests), method })}`,
          ),
        );
        return;
      }

      const id = this.nextRequestId++;
      const timeout = Math.min(timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS);

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`[mcp-client] ${t("be_mcpClient.requestTimeout", { timeout: String(timeout), method })}`));
      }, timeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        timeoutMs: timeout,
        deadlineMs: Date.now() + timeout,
        method,
      });

      // Race condition 대응: 이미 버퍼에 응답이 도착해 있으면 즉시 처리
      const buffered = this.bufferedResponses.get(id);
      if (buffered) {
        this.bufferedResponses.delete(id);
        this.handleResponse(buffered);
        return;
      }

      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params: this.withRequestMeta(params) };
      transport.send(request).catch((err: Error) => {
        // send 실패 → pending 정리 후 reject
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        clearTimeout(pending.timer);
        pending.reject(err);
      });
    });
  }

  private async sendNotification(method: string, params: Record<string, unknown>): Promise<void> {
    const transport = this.transport;
    if (!transport || !transport.isAlive()) return;
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    try {
      await transport.send(notification);
    } catch {
      // notification failure is non-fatal per spec
    }
  }

  // ─── Message Handling ───────────────────────────────

  private handleResponse(response: JsonRpcResponse): void {
    if (response.id === undefined || response.id === null) {
      return;
    }

    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      // Race condition: 응답이 pendingRequests 등록 전에 도착한 경우 큐에 보관
      // (서버가 두 응답을 한 chunk로 보낼 때 발생)
      this.bufferBufferedResponse(response);
      return;
    }

    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      pending.reject(
        new McpRpcError(
          response.error.code,
          `${t("be_mcpClient.jsonRpcError", { code: String(response.error.code), message: response.error.message })}`,
          response.error.data,
        ),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  private handleTransportClose(reason: string): void {
    if (this.state.status === "disconnected") return; // 정상 종료

    this.state.status = "error";
    this.state.lastError = reason;
    this.rejectAllPending(reason);
    this.clearRegisteredToolOverrides();
    this.toolRegistry.unregisterByMcp(this.config.id);
    this.state.registeredTools = [];
    this.stopHealthCheck();
  }

  private async closeTransport(): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    this.transport = null;
    try {
      await transport.close();
    } catch {
      // 이미 종료됨
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`[mcp-client] ${reason}`));
    }
    this.pendingRequests.clear();
    this.bufferedResponses.clear();
  }

  private bufferBufferedResponse(response: JsonRpcResponse): void {
    if (this.bufferedResponses.has(response.id)) {
      this.bufferedResponses.delete(response.id);
    }
    this.bufferedResponses.set(response.id, response);
    while (this.bufferedResponses.size > MAX_BUFFERED_RESPONSES) {
      const oldest = this.bufferedResponses.keys().next().value;
      if (oldest === undefined) break;
      this.bufferedResponses.delete(oldest);
    }
  }

  /**
   * Reset per-request timeout timers. Called by streaming transports on each
   * incoming chunk so that long-running SSE responses (e.g., a streaming
   * `tools/call`) aren't killed by the standard timeout while data is still
   * flowing.
   *
   * The new window is clamped by the request's absolute deadline (set at
   * creation) — a hostile server cannot trickle one byte every
   * (timeoutMs - 1) ms to extend the request beyond `MAX_REQUEST_TIMEOUT_MS`.
   * When the deadline has already passed at chunk arrival, the request is
   * rejected immediately.
   */
  private resetPendingTimers(): void {
    const now = Date.now();
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      const method = pending.method;
      const timeoutMs = pending.timeoutMs;
      const remaining = pending.deadlineMs - now;
      if (remaining <= 0) {
        this.pendingRequests.delete(id);
        pending.reject(
          new Error(`[mcp-client] ${t("be_mcpClient.requestAbsoluteTimeout", { timeout: String(timeoutMs), method })}`),
        );
        continue;
      }
      const effectiveWindowMs = Math.min(timeoutMs, remaining);
      const newTimer = setTimeout(() => {
        this.pendingRequests.delete(id);
        pending.reject(
          new Error(`[mcp-client] ${t("be_mcpClient.requestTimeout", { timeout: String(timeoutMs), method })}`),
        );
      }, effectiveWindowMs);
      pending.timer = newTimer;
    }
  }

  // ─── Tool Registration ──────────────────────────────

  private registerTools(tools: McpToolSchema[]): void {
    const serverId = this.config.id;
    const toolPermissionMode = this.governance.getApproval(serverId)?.toolPermissionMode ?? "default";
    const newlyRegistered: string[] = [];

    try {
      for (const tool of tools) {
        const namespacedName = this.governance.applyToolNamespace(serverId, tool.name);
        this.toolRegistry.register(
          mcpToolToTool(serverId, namespacedName, tool, (toolName, args) =>
            this.callTool(toolName, args),
          ),
        );
        this.state.registeredTools.push(namespacedName);
        newlyRegistered.push(namespacedName);
        this.permissionManager?.setToolModeOverride(namespacedName, toolPermissionMode);
      }
    } catch (err) {
      for (const toolName of newlyRegistered) {
        this.permissionManager?.clearToolModeOverride(toolName);
      }
      this.toolRegistry.unregisterByMcp(serverId);
      this.state.registeredTools = this.state.registeredTools.filter(
        (toolName) => !newlyRegistered.includes(toolName),
      );
      throw err;
    }
  }

  private clearRegisteredToolOverrides(): void {
    for (const toolName of this.state.registeredTools) {
      this.permissionManager?.clearToolModeOverride(toolName);
    }
  }

  // ─── Health Check ───────────────────────────────────

  private startHealthCheck(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      this.checkHealth();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private checkHealth(): void {
    const transport = this.transport;
    if (!transport || !transport.isAlive()) {
      log.warn(`${this.config.id} health check 실패: transport 비활성`);
      this.handleTransportClose(t("be_mcpClient.healthCheckTransportInactive"));
      return;
    }

    // stdio transport: exit 이벤트로 프로세스 사망을 감지하므로 active probe 불필요.
    // http transport: 매 30초 POST 요청은 트래픽/비용/로그 노이즈를 유발하고,
    //   서버가 `ping`을 구현하지 않으면 계속 오류가 쌓인다. 연결 상태는
    //   `send()` 실패 시 SSE stream 종료/네트워크 오류 경로로 감지되므로
    //   http 쪽에서도 능동 probe 를 생략한다. 필요하면 향후 서버가 선언한
    //   capability (`capabilities.ping`) 기반으로 enable 한다.
    if (transport.kind !== "stdio") return;

    // ping 요청 (응답 없어도 transport 생존 확인이 목적)
    this.sendRequest("ping", {}, 5000).catch(() => {
      // ping 미지원 서버도 있으므로 무시 (stdio는 exit 이벤트로 감지,
      // http는 send 단계에서 오류 발생 시 transport.close 경로로 처리)
    });
  }
}

// ─── stdio Transport ─────────────────────────────────

class StdioTransport implements McpTransport {
  readonly kind = "stdio" as const;
  private process: ChildProcess | null = null;
  private inputBuffer = Buffer.alloc(0);
  private messageHandler: ((msg: JsonRpcResponse) => void) | null = null;
  private closeHandler: ((reason: string) => void) | null = null;
  private closedExternally = false;
  /**
   * True only when THIS transport's worker was actually spawned through the
   * ASRT wrap (worker-egress PR1). Drives both the per-command cleanup on close
   * (Linux bwrap mount teardown) AND the reviewer's genuine-capability signal
   * via {@link markMcpServerWrapped}. Stays false on the plain-spawn path so an
   * unwrapped server never reports `asrt` to the reviewer (no-leak invariant).
   */
  private wrappedThroughAsrt = false;
  /**
   * One-shot guard for the ASRT cleanup that fires on ANY child termination
   * (unexpected crash, OS kill, or the explicit close() path). Ensures
   * `unmarkMcpServerWrapped` + `cleanupAsrtSandboxAfterCommand` run EXACTLY
   * ONCE per wrapped worker lifetime regardless of exit cause (worker-egress
   * PR1 MAJOR fix — unexpected child death previously bypassed cleanup,
   * violating the no-leak invariant and leaking the bwrap ref-count).
   */
  private asrtCleanupRan = false;

  constructor(private readonly config: McpStdioServerConfig) {}

  onMessage(handler: (msg: JsonRpcResponse) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  async open(): Promise<void> {
    if (!this.config.command) {
      throw new Error(`[mcp-client] ${t("be_mcpClient.stdioCommandRequired")}`);
    }
    const spawnCommand = resolveStdioSpawnCommand(this.config.command, this.config.args ?? []);

    // Minimal, secret-stripped base env (Least Privilege). On the PLAIN path this
    // is the spawn env verbatim; on the WRAPPED path it is the baseline that the
    // ASRT proxy keys are merged onto (see buildWrappedStdioEnv).
    const baseEnv: NodeJS.ProcessEnv = {
      // C2 fix: 최소 환경변수만 허용 — API 키 유출 방지 (Least Privilege)
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? process.env.USERPROFILE, // Windows 호환
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      LANG: process.env.LANG,
      NODE_ENV: process.env.NODE_ENV,
      ...this.config.env, // 관리자 승인 환경변수만
      ...(this.config.apiKey && this.config.apiKeyEnv
        ? { [this.config.apiKeyEnv]: this.config.apiKey }
        : {}),
    };

    // worker-egress PR1 — gate DEFAULT-OFF. When the OS-tool sandbox is active,
    // route this long-lived stdio worker through ASRT's wrapWorkerCommand so its
    // egress is enforced by the SAME global strict-union allow-list as host tools
    // and its writes are confined to the per-server filesystem jail. ASRT is
    // stdio-transparent on mac/linux: it wraps as `[shell, -c, <wrapped>]`;
    // a child spawned with inherited stdio:["pipe","pipe","pipe"] passes
    // stdin/stdout through, so MCP's Content-Length framing survives. Windows
    // is fail-closed in openWrapped until ASRT can apply the per-server
    // allowRead/allowWrite grants this path needs.
    // Gate OFF ⇒ the plain spawn below is UNCHANGED.
    if (isAsrtSandboxActive()) {
      try {
        await this.openWrapped(spawnCommand, baseEnv);
        return;
      } catch (err) {
        // Wrap setup failed (e.g. ASRT could not produce an argv). FAIL CLOSED:
        // do NOT silently fall back to an unconfined plain spawn — that would
        // defeat the gate the operator turned on. Surface the error so connect
        // fails and the server stays down until the sandbox is healthy.
        this.wrappedThroughAsrt = false;
        unmarkMcpServerWrapped(this.config.id);
        throw err instanceof Error ? err : new Error(String(err));
      }
    }

    this.process = spawn(spawnCommand.command, spawnCommand.args, {
      stdio: ["pipe", "pipe", "pipe"],
      // Windows: 콘솔 창 생성 방지 (창이 뜨면 stdout 파이프 동작이 달라짐)
      windowsHide: true,
      env: baseEnv,
    });

    trackManagedChildProcess(this.process, { label: `mcp:${this.config.id}` });
    this.setupProcessHandlers();
  }

  /**
   * Spawn the stdio worker WRAPPED by ASRT (worker-egress PR1). The filesystem
   * write-jail confines writes to the host-derived per-server sandbox root. For
   * reads it applies the CENTRALIZED host-secret / sensitive read DENY-LIST
   * ({@link getDefaultSensitiveReadDenyPaths}) — secrets, session/routine
   * history, `~/.ssh`, `~/.aws`, etc. — so a wrapped worker cannot read them.
   * This is a deny-list of known-sensitive subpaths, NOT a read-allow jail:
   * ASRT's read model is deny-only, so a path not on the list stays
   * readable (the worker still needs cwd / its sandbox root / tmp). Network
   * egress is governed by the SHARED boot config (strict union allow-list), not
   * per command. Only invoked when {@link isAsrtSandboxActive}.
   */
  private async openWrapped(
    spawnCommand: { command: string; args: string[] },
    baseEnv: NodeJS.ProcessEnv,
  ): Promise<void> {
    if (process.platform === "win32") {
      throw new Error(
        "[mcp-client] ASRT-wrapped MCP stdio on Windows is disabled because " +
          "ASRT 0.0.63 cannot apply per-server filesystem.allowRead/allowWrite " +
          "grants per exec; only denyRead/denyWrite are supported. Keep MCP " +
          "stdio fail-closed until the Windows session-grant/control-channel " +
          "work in #1367 lands.",
      );
    }

    // FAIL-CLOSED filesystem jail (deny-by-default A.a): the host populates
    // `sandboxRoot` at connect time. If it is somehow still absent (e.g. a
    // direct StdioTransport construction in a test), grant NO writable path at
    // all — NEVER cwd / NEVER HOME / NEVER any pre-existing dir.
    const sandboxRoot = this.config.sandboxRoot;
    const allowWrite = sandboxRoot ? [sandboxRoot] : [];
    // Runtime dirs the worker legitimately needs to READ to start (its own jail
    // root + the system temp dir). HOME is NOT re-allowed for read.
    const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
    const allowRead = [
      ...(sandboxRoot ? [sandboxRoot] : []),
      ...(tmpDir ? [tmpDir] : []),
    ];
    // denyRead is the per-command read deny-list. ASRT's wrapWithSandbox reads
    // `customConfig?.filesystem?.denyRead ?? config.filesystem.denyRead` — a
    // per-command denyRead REPLACES the shared boot-config floor, it does NOT
    // union. So a wrapped worker that only restated the secrets dir would lose
    // the boot-config sensitive-read floor. Restate the CENTRALIZED deny-list
    // here ({@link getDefaultSensitiveReadDenyPaths}, the SAME SOT the boot
    // config unions) so a wrapped worker can never read `~/.lvis/secrets`,
    // session/routine history, `~/.ssh`, `~/.aws`, etc. This is a DENY-LIST of
    // known-sensitive subpaths, NOT a read-allow jail — ASRT's read model is
    // deny-only (`allowRead` only re-allows nested regions inside a deny).
    // Worker-needed dirs (its sandbox root, tmp) are re-allowed via `allowRead`
    // above and are never on the deny-list.
    // No userDataDir arg here — mcp-client does not import electron. The
    // fallback per-platform derivation (XDG-aware on Linux) provides coverage.
    const denyRead = getDefaultSensitiveReadDenyPaths();
    // denyWrite is likewise per-command and replaces the shared boot floor.
    // Restate the centralized persistence-vector floor so an authorized MCP
    // sandboxRoot cannot write shell rc files, credential dirs, LaunchAgents, or
    // cron-like re-exec hooks if a future config broadens allowWrite.
    const denyWrite = getDefaultSensitiveWriteDenyPaths();

    // Assemble the command string DEFENSIVELY: shell-quote the resolved binary
    // and every arg so a path with spaces / metacharacters cannot mis-split or
    // inject a second command. ASRT runs this string under a POSIX shell.
    const cmdline = [spawnCommand.command, ...spawnCommand.args]
      .map((part) => shellQuote(part))
      .join(" ");

    // binShell: mirror bash.ts — on win32 hand ASRT the ABSOLUTE Git Bash / sh
    // path so the POSIX-quoted command string is interpreted by a POSIX shell on
    // every platform (ASRT defaults to `cmd` on win32, which would mis-parse
    // single-quoted cmdlines). On mac/linux leave it undefined (ASRT uses bash).
    // FAIL CLOSED on win32: if Git Bash is not resolvable, throw rather than
    // silently falling back to cmd.exe — cmd.exe mis-parses POSIX single-quoting
    // and would run an incorrectly split command in an unconfined shell.
    let binShell: string | undefined;
    if (process.platform === "win32") {
      let resolvedShell: string | undefined;
      try {
        const candidate = resolveShell().cmd;
        if (/^[A-Za-z]:[\\/]/.test(candidate)) resolvedShell = candidate;
      } catch {
        // resolveShell() threw — fall through to fail-closed error below.
      }
      if (resolvedShell === undefined) {
        throw new Error(
          "[mcp-client] ASRT-wrapped MCP requires Git Bash (or a POSIX shell) on Windows — " +
            "cmd.exe cannot interpret the POSIX-single-quoted command string safely. " +
            "Install Git for Windows and ensure git-bash.exe is resolvable.",
        );
      }
      binShell = resolvedShell;
    }

    const { argv, env } = await wrapWorkerCommand(cmdline, {
      filesystem: { allowWrite, allowRead, denyRead, denyWrite },
      ...(binShell !== undefined ? { binShell } : {}),
    });

    const [cmd, ...args] = argv;
    if (cmd === undefined) {
      throw new Error("[mcp-client] ASRT returned an empty argv for the MCP worker wrap");
    }

    this.wrappedThroughAsrt = true;
    markMcpServerWrapped(this.config.id);

    this.process = spawn(cmd, args, {
      // stdin pipe MUST stay writable for JSON-RPC Content-Length framing.
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: this.buildWrappedStdioEnv(baseEnv, env),
    });

    trackManagedChildProcess(this.process, { label: `mcp:${this.config.id}:asrt` });
    this.setupProcessHandlers();
  }

  /**
   * Compose the WRAPPED worker's env per platform (worker-egress PR1, the 3b
   * cross-platform gotcha):
   *   - mac/linux: ASRT bakes the proxy into the command string and returns
   *     `env === process.env`; buildSandboxedChildEnv contributes only the
   *     allow-listed proxy/CA keys ASRT actually CHANGED (none extra here), so we
   *     keep the existing minimal/secret-stripped base env unchanged.
   *   - win32: ASRT returns a proxy-CARRYING env (srt-win forwards the proxy
   *     vars verbatim); buildSandboxedChildEnv extracts ONLY those allow-listed
   *     proxy/CA keys so the Windows proxy set propagates while host secrets
   *     stay stripped.
   * In both cases the per-server base env (PATH/HOME/... + approved config.env +
   * apiKey) is preserved and the allow-listed ASRT proxy keys are merged on top.
   */
  private buildWrappedStdioEnv(
    baseEnv: NodeJS.ProcessEnv,
    wrappedEnv: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv {
    // buildSandboxedChildEnv (safe-env.ts) returns a safe-whitelist baseline PLUS
    // ONLY the ASRT proxy/CA/SANDBOX_RUNTIME keys ASRT changed relative to
    // process.env. The keys that are present in that composed env but NOT in the
    // safe baseline are exactly the ASRT-injected proxy overlay — none on
    // mac/linux (proxy baked into the command string), the proxy set on win32
    // (srt-win forwards it via env). Overlay that proxy set onto our per-server
    // base env so the worker keeps its approved config.env + apiKey AND egress.
    const asrtComposed = buildSandboxedChildEnv(wrappedEnv);
    const safeBaseline = buildSandboxedChildEnv(process.env);
    const proxyOverlay: Record<string, string> = {};
    for (const [key, value] of Object.entries(asrtComposed)) {
      if (value === undefined) continue;
      if (safeBaseline[key] === value) continue; // part of the static baseline, not an ASRT injection
      proxyOverlay[key] = value;
    }
    return { ...baseEnv, ...proxyOverlay };
  }

  /**
   * Release the per-command ASRT state exactly ONCE per wrapped worker lifetime,
   * regardless of how the child process ends (explicit close(), unexpected crash,
   * OS kill, spawn error). Idempotency is guaranteed by the `asrtCleanupRan`
   * flag: whoever fires first (the process 'exit'/'error' handler OR close())
   * runs the cleanup; the second caller is a no-op.
   *
   * Consequences of running this:
   *   1. Drops the no-leak reviewer marker (`unmarkMcpServerWrapped`) so a later
   *      reconnect that takes the plain-spawn path cannot inherit a stale `asrt`
   *      report — exactly the leak class #1359 targeted.
   *   2. Runs `cleanupAsrtSandboxAfterCommand()` — decrements the ASRT
   *      activeSandboxCount ref-counter and tears down Linux bwrap mount artifacts.
   */
  private runAsrtCleanupOnce(): void {
    if (!this.wrappedThroughAsrt || this.asrtCleanupRan) return;
    this.asrtCleanupRan = true;
    this.wrappedThroughAsrt = false;
    unmarkMcpServerWrapped(this.config.id);
    void cleanupAsrtSandboxAfterCommand();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.process?.stdin?.writable) {
      throw new Error(`[mcp-client] ${t("be_mcpClient.stdinNotWritable")}`);
    }
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
    try {
      this.process.stdin.write(header + json);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async close(): Promise<void> {
    this.closedExternally = true;
    // worker-egress PR1: release the per-command ASRT state via the idempotent
    // one-shot helper. This is the EXPLICIT-CLOSE path; the unexpected-exit path
    // (process 'exit'/'error' handlers in setupProcessHandlers) calls the same
    // helper. Whichever fires first wins; the second is a no-op.
    this.runAsrtCleanupOnce();
    // Capture the process reference BEFORE nulling `this.process` so the
    // SIGKILL fallback timer can still reach it. Without this, `close()` used
    // to null the field synchronously and the 3-second timer would dereference
    // `this.process?.kill("SIGKILL")` as a no-op.
    const proc = this.process;
    this.process = null;
    if (!proc) return;
    try {
      proc.stdin?.end();
      proc.kill("SIGTERM");
      // SIGTERM 후 3초 내 종료 안 되면 SIGKILL
      const forceKillTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // 이미 종료됨
        }
      }, 3000);
      proc.once("exit", () => clearTimeout(forceKillTimer));
    } catch {
      // 이미 종료됨
    }
  }

  isAlive(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  private setupProcessHandlers(): void {
    if (!this.process) return;

    this.process.stdout?.on("data", (chunk: Buffer) => {
      try {
        this.handleStdout(chunk);
      } catch (err) {
        log.error(`${this.config.id} stdout 처리 오류: %s`, err);
      }
    });

    this.process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        // MEDIUM: scrub secrets before logging stderr output from MCP child processes
        log.warn(`${this.config.id} stderr: %s`, scrubSecrets(text));
      }
    });

    this.process.on("exit", (code, signal) => {
      log.warn(`${this.config.id} 프로세스 종료: code=${code}, signal=${signal}`);
      // worker-egress PR1 MAJOR fix: fire ASRT cleanup on ANY child termination,
      // including unexpected crashes/kills. The idempotent one-shot helper ensures
      // this and the explicit close() path do not double-run the cleanup.
      this.runAsrtCleanupOnce();
      if (!this.closedExternally) {
        this.closeHandler?.(t("be_mcpClient.processExitedUnexpectedly"));
      }
    });

    this.process.on("error", (err) => {
      log.error(`${this.config.id} 프로세스 오류: %s`, err.message);
      // Same idempotent cleanup for the error path (spawn failure, broken pipe).
      this.runAsrtCleanupOnce();
      this.closeHandler?.(t("be_mcpClient.processError", { message: err.message }));
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.inputBuffer = Buffer.concat([this.inputBuffer, chunk]);
    this.parseMessages();
  }

  private parseMessages(): void {
    // Content-Length 기반 메시지 파싱 (LSP/MCP 표준)
    // inputBuffer를 Buffer로 유지해 UTF-8 다중바이트 문자 포함 시에도
    // Content-Length(바이트 단위)와 정확히 일치하게 처리한다.
    while (true) {
      // \r\n\r\n 구분자를 바이트 레벨에서 찾기
      const headerEnd = indexOfCrLfCrLf(this.inputBuffer);
      if (headerEnd === -1) break;

      const headerBlock = this.inputBuffer.slice(0, headerEnd).toString("ascii");
      const contentLengthMatch = headerBlock.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        // 잘못된 헤더 — 건너뛰기
        this.inputBuffer = this.inputBuffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.inputBuffer.length < messageEnd) {
        // 메시지가 아직 완전히 도착하지 않음
        break;
      }

      const messageStr = this.inputBuffer.slice(messageStart, messageEnd).toString("utf-8");
      this.inputBuffer = this.inputBuffer.slice(messageEnd);

      try {
        const parsed = JSON.parse(messageStr) as JsonRpcResponse;
        this.messageHandler?.(parsed);
      } catch {
        log.warn(`${this.config.id} JSON 파싱 실패: %s`, messageStr.slice(0, 200));
      }
    }
  }
}

// ─── Streamable HTTP Transport ───────────────────────

/**
 * Implements the MCP Streamable HTTP transport (spec 2025-03-26).
 *
 * Wire protocol:
 *   - POST `url` with JSON-RPC body.
 *   - Response `Content-Type: application/json` → single JSON-RPC response.
 *   - Response `Content-Type: text/event-stream` → SSE stream of
 *     `event: message\ndata: <json>\n\n` blocks. The matching response is
 *     the first `message` whose `id` equals the request `id`; additional
 *     events are passed to the message handler (server-initiated notifications).
 *   - Notifications (no id) expect HTTP 202 or 200 with empty body.
 *
 * SSRF control: every outbound request is routed through
 * {@link fetchPublicHttpResponse}, which re-resolves DNS and rejects any
 * private / link-local / loopback address on every hop. This closes the
 * DNS-rebinding window between `open()` and `send()`: even if an attacker
 * flips the host's A record to 169.254.169.254 after the initial
 * {@link ensurePublicHttpUrl} passed, the per-request re-resolution will
 * block the pivot. The helper also enforces `redirect: "manual"` plus
 * per-hop validation, defeating `Location:`-based redirect pivots.
 *
 * Escape hatch: when the per-server `allowPrivateNetworks` config is set AND
 * the global policy allowed it (governance layer gate), requests bypass
 * NetworkGuard and use raw `fetch` — required for on-prem / loopback
 * deployments. `redirect: "error"` is still set in that mode.
 */
class HttpTransport implements McpTransport {
  readonly kind = "http" as const;
  private alive = false;
  private messageHandler: ((msg: JsonRpcResponse) => void) | null = null;
  private closeHandler: ((reason: string) => void) | null = null;
  private activityHandler: (() => void) | null = null;
  /** Tracks in-flight SSE AbortControllers so `close` can cancel them. */
  private readonly inflight = new Set<AbortController>();

  constructor(private readonly config: McpHttpServerConfig) {}

  onMessage(handler: (msg: JsonRpcResponse) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  onActivity(handler: () => void): void {
    this.activityHandler = handler;
  }

  async open(): Promise<void> {
    if (!this.config.url) {
      throw new NetworkGuardError("http transport requires a url");
    }
    // Syntactic check first — gives a clean error for malformed URLs.
    validateHttpUrl(this.config.url);

    if (!this.config.allowPrivateNetworks) {
      try {
        await ensurePublicHttpUrl(this.config.url);
      } catch (err) {
        if (err instanceof NetworkGuardError) {
          throw new NetworkGuardError(`network guard: ${err.message}`);
        }
        throw err;
      }
    }
    this.alive = true;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.alive) {
      throw new Error(`[mcp-client] http transport closed`);
    }

    const controller = new AbortController();
    this.inflight.add(controller);

    // Timeout covers the initial HTTP round-trip (until response headers
    // arrive). Cleared once the server responds; SSE body reads continue
    // asynchronously and are reset per chunk so long-running streaming
    // tool calls do not trip the request timer while data is flowing.
    // Note: the reason passed to abort() is stored on signal.reason and is
    // useful for debugging, but fetch() always throws a generic AbortError.
    const timeoutId = setTimeout(
      () => controller.abort(new Error(`[mcp-client] request timeout after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`)),
      DEFAULT_REQUEST_TIMEOUT_MS,
    );

    // Build and validate request headers. `config.headers` comes from admin
    // governance but we still strip CRLF-injection attempts — no trusted
    // source should be immune from hardening.
    // HIGH: normalize all header names to lowercase to prevent case-collision
    // between admin-supplied headers and apiKey injection (e.g. both
    // `Authorization` and `authorization` co-existing in the same object).
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Streamable HTTP servers may return either JSON or SSE.
      accept: "application/json, text/event-stream",
    };
    for (const [k, v] of Object.entries(this.config.headers ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    if (this.config.apiKey) {
      if (this.config.apiKeyHeader) {
        // Single write using normalized key — no double-set risk
        const normalizedKey = this.config.apiKeyHeader.toLowerCase();
        headers[normalizedKey] = this.config.apiKey;
      } else if (!hasAuthorization(headers)) {
        headers.authorization = `Bearer ${this.config.apiKey}`;
      }
    }

    const body = JSON.stringify(message);
    const init: RequestInit = {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      // Disable automatic redirect-following so a server cannot pivot to a
      // private IP via a Location header after passing the open()-time SSRF
      // check. `fetchPublicHttpResponse` re-validates every manual hop; the
      // raw-fetch escape-hatch path surfaces 3xx as a TypeError.
      redirect: "error",
    };

    let response: Response;
    try {
      if (this.config.allowPrivateNetworks) {
        // Governance has already gated `allowPrivateNetworks` behind an
        // admin-policy flag (see McpGovernance.validateServer). Bypass
        // NetworkGuard here for on-prem / loopback deployments.
        response = await fetch(this.config.url, init);
      } else {
        // Every request re-validates DNS via fetchPublicHttpResponse, which
        // re-runs ensurePublicHttpUrl on the initial URL and on each redirect
        // hop. This closes the DNS-rebinding window between open() and send().
        response = await fetchPublicHttpResponse(this.config.url, {
          ...init,
          // `fetchPublicHttpResponse` owns its own AbortController but honours
          // an external `signal`. Keep the caller's signal so close() still
          // cancels in-flight requests.
          signal: controller.signal,
          // Its internal timeout covers each hop; we still want the overall
          // request guarded by the McpClient-level timer above, so match it.
          timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        });
      }
    } catch (err) {
      clearTimeout(timeoutId);
      this.inflight.delete(controller);
      if (err instanceof NetworkGuardError) {
        throw new NetworkGuardError(`network guard: ${err.message}`);
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${t("be_mcpClient.httpFetchFailed", { reason })}`);
    }

    // Response headers received — cancel the initial-response timeout.
    clearTimeout(timeoutId);

    // Notifications (no id) expect no body — release and return.
    if (!("id" in message)) {
      this.inflight.delete(controller);
      // Drain the body to free the socket; ignore errors.
      try {
        await response.arrayBuffer();
      } catch {
        /* ignore */
      }
      if (!response.ok && response.status !== 202) {
        throw new Error(`http transport notification HTTP ${response.status}`);
      }
      return;
    }

    if (!response.ok) {
      this.inflight.delete(controller);
      const body = await response.text().catch(() => "");
      // Scrub obvious secret material before surfacing server error bodies.
      throw new Error(`http transport HTTP ${response.status}: ${scrubSecrets(body)}`);
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
      // Fire-and-forget stream reader — messages arrive asynchronously
      // through the normal `onMessage` path, matching stdio semantics.
      void this.consumeSse(response, controller).catch((err) => {
        log.warn(`${this.config.id} SSE 읽기 오류: %s`, err);
        // A failed SSE stream means the transport is effectively dead;
        // pending requests would otherwise only time out individually.
        // Signal the client so it can reject everything and transition to
        // the error state immediately.
        if (this.alive) {
          this.alive = false;
          this.closeHandler?.("SSE stream terminated unexpectedly");
        }
      });
      return;
    }

    // application/json (or server omitted the header) → single JSON-RPC body.
    this.inflight.delete(controller);
    const text = await response.text();
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as JsonRpcResponse;
      this.messageHandler?.(parsed);
    } catch (err) {
      throw new Error(`${t("be_mcpClient.httpJsonParseFailed", { message: (err as Error).message })}`);
    }
  }

  async close(): Promise<void> {
    this.alive = false;
    for (const ctrl of this.inflight) {
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
    }
    this.inflight.clear();
  }

  isAlive(): boolean {
    return this.alive;
  }

  /**
   * Parses an SSE `text/event-stream` body. Each event block ends on a blank
   * line. `data:` payloads are concatenated (spec-compliant multi-line data).
   * A complete block fires `messageHandler` with the parsed JSON-RPC message.
   */
  private async consumeSse(
    response: Response,
    controller: AbortController,
  ): Promise<void> {
    try {
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // Fire activity so McpClient can reset per-request timeout timers.
        // Long-streaming tool calls otherwise hit the 30s timeout even
        // while data is still flowing.
        this.activityHandler?.();
        buffer += decoder.decode(value, { stream: true });
        // Spec allows \n\n or \r\n\r\n as event delimiter.
        let delimIdx: number;
        // Process every complete event in the buffer.
        while (
          (delimIdx = indexOfAny(buffer, ["\n\n", "\r\n\r\n"])) !== -1
        ) {
          const rawEvent = buffer.slice(0, delimIdx);
          // Skip past whichever delimiter matched.
          const sep = buffer.startsWith("\r\n\r\n", delimIdx) ? 4 : 2;
          buffer = buffer.slice(delimIdx + sep);
          this.dispatchSseEvent(rawEvent);
        }
      }
      // Flush any bytes held in the streaming TextDecoder (e.g., an
      // incomplete multi-byte UTF-8 sequence split across the last chunk).
      // Calling decode() with no arguments uses stream:false (the default),
      // which flushes the internal buffer accumulated by the stream:true calls.
      buffer += decoder.decode();
      // Dispatch any trailing event that arrived without a closing blank line.
      if (buffer.trim().length > 0) {
        this.dispatchSseEvent(buffer);
      }
    } finally {
      this.inflight.delete(controller);
    }
  }

  private dispatchSseEvent(raw: string): void {
    const lines = raw.split(/\r?\n/);
    let eventName = "message";
    const dataParts: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventName = value;
      else if (field === "data") dataParts.push(value);
    }
    if (eventName !== "message" || dataParts.length === 0) return;
    const payload = dataParts.join("\n");
    try {
      const parsed = JSON.parse(payload) as JsonRpcResponse;
      this.messageHandler?.(parsed);
    } catch {
      log.warn(`${this.config.id} SSE JSON 파싱 실패: %s`, payload.slice(0, 200));
    }
  }
}

// ─── Helpers ─────────────────────────────────────────

/** Case-insensitive presence check for an `authorization` header. */
function hasAuthorization(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
}

/**
 * Strip likely secret material from error bodies before surfacing them in logs
 * or UI. This is best-effort redaction, but it should catch the common cases we
 * might reflect from MCP HTTP responses: bearer tokens, API keys in headers,
 * query params, and JSON payloads.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/[Bb]earer\s+[A-Za-z0-9._\-~+/=]+/g, "Bearer [redacted]")
    .replace(
      /((?:authorization|x-api-key|x-auth-token)\s*:\s*)[^\s\r\n]+/gi,
      "$1[redacted]",
    )
    .replace(
      /([?&](?:api[_-]?key|token|access[_-]?token|refresh[_-]?token))=([^&\s]+)/gi,
      "$1=[redacted]",
    )
    .replace(
      /(["'](?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|authorization|x-api-key|x-auth-token)["']\s*:\s*["'])[^"']+(["'])/gi,
      "$1[redacted]$2",
    )
    .replace(/\b(?:sk|pk|rk|proj|test|live)-[A-Za-z0-9_-]{8,}\b/g, "[redacted-token]")
    .slice(0, 120);
}

function indexOfAny(haystack: string, needles: string[]): number {
  let earliest = -1;
  for (const needle of needles) {
    const idx = haystack.indexOf(needle);
    if (idx === -1) continue;
    if (earliest === -1 || idx < earliest) earliest = idx;
  }
  return earliest;
}

/**
 * Find the byte offset of the first `\r\n\r\n` sequence in a Buffer.
 * Returns -1 if not found. Used by StdioTransport.parseMessages() to
 * correctly handle Content-Length framing when the JSON body contains
 * multi-byte UTF-8 characters (Korean, CJK, etc.) — the Content-Length
 * header value is in bytes, not JS string characters.
 */
function indexOfCrLfCrLf(buf: Buffer): number {
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
      return i;
    }
  }
  return -1;
}
