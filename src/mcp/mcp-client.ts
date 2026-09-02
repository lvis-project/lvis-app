



import { spawn, type ChildProcess } from "node:child_process";
import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpServerState,
  McpPromptSummary,
  McpResourceSummary,
  McpResourceTemplateSummary,
  McpStdioServerConfig,
  McpToolSchema,
  McpUiPayload,
  McpUiResourceMeta,
  McpUiResourceRead,
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
import {
  isHostFetchRefusedUri,
  isUsableResourceUri,
  MCP_RESOURCE_DESCRIPTION_MAX_CHARS,
  MCP_RESOURCE_MAX_BLOCKS,
  MCP_RESOURCE_MAX_CHARS,
  MCP_RESOURCE_MAX_PAGES,
  MCP_RESOURCE_MAX_PER_SERVER,
  MCP_RESOURCE_NAME_MAX_CHARS,
  MCP_RESOURCE_URI_MAX_CHARS,
  usableResourceText,
} from "../shared/mcp-resource-bounds.js";
import {
  expandResourceUriTemplate,
  isUsableResourceUriTemplate,
  resourceTemplateVariables,
} from "../shared/mcp-resource-template-bounds.js";
import {
  isUsablePromptName,
  MCP_PROMPT_ARG_NAME_MAX_CHARS,
  MCP_PROMPT_MAX_BLOCKS,
  MCP_PROMPT_NAME_MAX_CHARS,
} from "../shared/mcp-prompt-bounds.js";
import { isMcpAppUiUri } from "../shared/mcp-app-partition.js";
import { createLogger } from "../lib/logger.js";
import { resolveBundledUvBinaryPath } from "../main/uv-runtime.js";
import {
  assertManagedChildProcessAdmissionOpen,
  trackManagedChildProcess,
} from "../main/managed-child-processes.js";
import {
  isAsrtSandboxActive,
  wrapWorkerCommand,
  cleanupAsrtSandboxAfterCommand,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
} from "../permissions/asrt-sandbox.js";
import { buildSandboxedChildEnv } from "../tools/safe-env.js";
import { terminateChildProcess } from "../tools/terminate-child-process.js";
import { createSandboxProcessHome } from "../permissions/sandbox-process-home.js";
import {
  markMcpServerWrapped,
  unmarkMcpServerWrapped,
  type McpWrappedOwner,
} from "../permissions/sandbox-capability.js";
import { shellQuote } from "../lib/shell-resolver.js";
import { scrubShortError } from "../shared/dlp.js";
import { t } from "../i18n/index.js";
import { sleep } from "../shared/abortable-deadline.js";
import { errorMessage } from "../shared/error-message.js";
const log = createLogger("mcp-client");

// ─── JSON-RPC 2.0 Types ──────────────────────────────

/**
 * JSON-RPC 2.0 request id. This client mints numbers, so `number` is the
 * default; a server (`plugin-mcp-server`, `stdio-server-loop`) must echo
 * whatever its peer sent and instantiates these with the full wire union.
 */
export type JsonRpcId = number | string;

export interface JsonRpcRequest<Id extends JsonRpcId = number> {
  jsonrpc: "2.0";
  id: Id;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse<Id extends JsonRpcId = number> {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;

  error?: { code: number; message: string; data?: unknown };
  /**
   * Present on an id-less SERVER notification delivered on the same inbound
   * channel (stdio pipe / SSE response stream). A response never carries it.
   */
  method?: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ─── MCP Protocol Types ──────────────────────────────

/**
 * A JSON-RPC error returned by the server, carrying the numeric `code` so the
 * connect path can detect `-32601` (method-not-found → dual-era fallback) and
 * `callTool` can map `-32021`/`-32022` (design §8). The base runner previously
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

/**
 * A non-2xx Streamable HTTP status whose body did NOT carry a routable JSON-RPC
 * error. `modernErrorBody` records whether the body was a recognized (but
 * id-less) modern JSON-RPC error — the final spec's legacy-detection rule turns
 * on exactly this distinction: 400/404/405 with a NON-modern body means "legacy
 * server, fall back to initialize"; a modern body means "modern server, do not".
 */
class McpHttpStatusError extends Error {
  constructor(
    readonly status: number,
    body: string,
    readonly modernErrorBody: boolean,
  ) {
    super(`http transport HTTP ${status}: ${body}`);
    this.name = "McpHttpStatusError";
  }
}

/**
 * The final spec's era-detection rule for the `server/discover` probe: fall
 * back to `initialize` on stdio `-32601`, or on an HTTP 400/404/405 whose body
 * is not a recognized modern JSON-RPC error. A modern body (whatever the code)
 * proves a modern server — the probe error then propagates instead.
 */
function isLegacyFallbackSignal(err: unknown): boolean {
  if (err instanceof McpRpcError) return err.code === RPC_METHOD_NOT_FOUND;
  if (err instanceof McpHttpStatusError) {
    return !err.modernErrorBody && (err.status === 400 || err.status === 404 || err.status === 405);
  }
  return false;
}

/** Parse an HTTP error body as a JSON-RPC error response, or null. */
function parseJsonRpcErrorBody(body: string): JsonRpcResponse | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as JsonRpcResponse;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      parsed.jsonrpc === "2.0" &&
      parsed.error !== undefined &&
      typeof parsed.error.code === "number"
    ) {
      return parsed;
    }
  } catch {
    /* not JSON — legacy/proxy body */
  }
  return null;
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
 * cannot (advertise none, so a server requiring it gets a clean `-32021` instead
 * of a hung approval). The exact deriving signals (turn consent state,
 * headless/routine mode, #811 policy) are wired by the host; omitted ⇒ a fixed
 * sound default. This is the client-side half of per-request governance; the
 * per-request server-capability GATING half lands with the governance change.
 */
export type McpClientCapabilityProvider = () => McpClientCapabilities;

interface McpToolsListResult {
  tools: McpToolSchema[];
}

/**
 * `prompts/get` result. Content blocks mirror tool-result blocks: `text` is the
 * only kind LVIS renders inline; image/audio/resource are surfaced as explicit
 * placeholders so a server cannot smuggle unrendered bytes into the turn.
 */
interface McpPromptGetResult {
  description?: string;
  messages: Array<{
    role?: string;
    content?: {
      type?: string;
      text?: string;
      [key: string]: unknown;
    };
  }>;
}

interface McpPromptsListResult {
  prompts: Array<{
    name: string;
    title?: string;
    description?: string;
    arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  }>;
  nextCursor?: string;
}

interface McpResourceTemplatesListResult {
  resourceTemplates?: Array<{
    uriTemplate?: unknown;
    name?: unknown;
    title?: unknown;
    description?: unknown;
    mimeType?: unknown;
  }>;
  nextCursor?: string;
}

interface McpResourcesListResult {
  resources?: Array<{
    uri?: unknown;
    name?: unknown;
    title?: unknown;
    description?: unknown;
    mimeType?: unknown;
    size?: unknown;
  }>;
  nextCursor?: string;
}

interface McpResourcesReadResult {
  contents?: Array<{
    uri?: unknown;
    mimeType?: unknown;
    text?: unknown;
    blob?: unknown;
  }>;
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
      // No `csp` — per spec it lives on the RESOURCE, not the tool result. A server
      // that puts one here is ignored (see readResource).
    };
    [key: string]: unknown;
  };
}

/**
 * Resolves ONE MRTR `inputRequest` (§8). The host wires this to its capability
 * surfaces — elicitation → the approval-gate dock, sampling → the host LLM —
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

// #1230 — the MCP 2026-07-28 stateless protocol, adopted at RC and now FINAL
// (docs/architecture/mcp-alignment-design.md §8). LVIS speaks it by default:
// no initialize handshake, per-request `_meta` capability negotiation,
// `server/discover` for capabilities. MCP_LEGACY_PROTOCOL_VERSION is used ONLY
// by the documented dual-era exception (design §0) when an EXTERNAL server does
// not implement `server/discover` (a pre-final server). LVIS's own plugins
// always speak the final revision, so that fallback never runs for first-party
// plugins. Wire constants live in the shared authority module.
import {
  MCP_PROTOCOL_VERSION,
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_SUPPORTED_LEGACY_VERSIONS,
  META_PROTOCOL_VERSION,
  META_CLIENT_INFO,
  META_CLIENT_CAPABILITIES,
  RPC_HEADER_MISMATCH,
  RPC_METHOD_NOT_FOUND,
  RPC_MISSING_REQUIRED_CLIENT_CAPABILITY,
  RPC_UNSUPPORTED_PROTOCOL_VERSION,
} from "./protocol-constants.js";
import type { PendingJsonRpcRequest } from "../lib/json-rpc-pending-request.js";
import { getLvisAppVersion } from "../shared/app-version.js";

const CLIENT_INFO = { name: "lvis-app", version: getLvisAppVersion() } as const;

/** MCP Apps extension key (§8 `io.modelcontextprotocol/ui`, 2026-01-26 snapshot). */
const MCP_APPS_UI_EXTENSION = "io.modelcontextprotocol/ui";

const DEFAULT_REQUEST_TIMEOUT_MS = TOOL_TIMEOUT_POLICY.mcpRequestDefaultMs;
const MAX_REQUEST_TIMEOUT_MS = TOOL_TIMEOUT_POLICY.mcpRequestMaxMs;
const HANDSHAKE_TIMEOUT_MS = 10_000;
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
/** Absorbs `notifications/tools/list_changed` bursts into one re-fetch. */
const TOOLS_REFRESH_DEBOUNCE_MS = 500;
/**
 * Capability-snapshot TTL clamp (§6a.2): the server's own `DiscoverResult.ttlMs`
 * drives expiry, bounded so a hostile 1ms cannot thrash re-discovery and a
 * hostile `Infinity` cannot pin the snapshot forever.
 */
const SNAPSHOT_TTL_MIN_MS = 30_000;
const SNAPSHOT_TTL_MAX_MS = 86_400_000;
/**
 * Synthetic, implementation-defined code (-32000..-32019 range) the HTTP
 * transport uses to settle the unbounded `subscriptions/listen` request when
 * its stream ends — never sent on the wire, only delivered client-internally.
 */
const RPC_LISTEN_STREAM_ENDED = -32010;
/** Listen re-open backoff (§6a.3): capped exponential, reset on acknowledge. */
const LISTEN_BACKOFF_START_MS = 1_000;
const LISTEN_BACKOFF_MAX_MS = 60_000;

// ─── Transport Strategy ──────────────────────────────

/**
 * Minimal transport contract shared by stdio + HTTP.
 * - `send` writes a JSON-RPC request/notification.
 * - Incoming messages are delivered via `onMessage`.
 * - `close` must resolve all pending requests as rejected.
 * - `isAlive` lets the health check poll without caring about the transport.
 */
/** Per-send transport options. Only the HTTP transport consumes them. */
export interface McpSendOptions {
  /**
   * Extra HTTP headers for THIS request — the `Mcp-Param-{Name}` mirrors the
   * final spec's `x-mcp-header` extension requires of Streamable-HTTP clients.
   * Names/values are pre-validated+encoded by `http-request-headers.ts`.
   */
  extraHeaders?: Readonly<Record<string, string>>;
  /**
   * This request's SSE response stream is LONG-LIVED (`subscriptions/listen`):
   * a dropped/ended stream is reported back as this request's error response
   * instead of killing the whole transport — losing the stream only degrades
   * freshness (§6a.3), never the connection.
   */
  nonFatalStream?: boolean;
}

export interface McpTransport {
  readonly kind: "stdio" | "http" | "loopback";
  open(): Promise<void>;
  send(message: JsonRpcMessage, opts?: McpSendOptions): Promise<void>;
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

/** Timer is null for the one deliberately-unbounded request (`subscriptions/listen`). */
interface PendingRequest extends PendingJsonRpcRequest<NodeJS.Timeout | null> {
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
  /**
   * Per-tool validated `x-mcp-header` annotations (HTTP transport only),
   * captured at discovery so each `tools/call` can mirror the designated
   * argument values into `Mcp-Param-{Name}` headers.
   */
  private readonly paramHeaderAnnotations = new Map<string, McpParamHeaderAnnotation[]>();
  /** Debounce/refresh state for `notifications/tools/list_changed`. */
  private toolsRefreshTimer: NodeJS.Timeout | null = null;
  private toolsRefreshRunning = false;
  /** `subscriptions/listen` re-open state (§6a.3). */
  private listenBackoffMs = LISTEN_BACKOFF_START_MS;
  private listenReopenTimer: NodeJS.Timeout | null = null;
  private listenUnsupported = false;

  private readonly bufferedResponses = new Map<number, JsonRpcResponse>();
  private healthTimer: NodeJS.Timeout | null = null;
  private transport: McpTransport | null = null;
  /**
   * Protocol era resolved at connect: "final" (the current 2026-07-28
   * stateless revision, per-request `_meta`) or "legacy" (the documented
   * dual-era exception for an EXTERNAL pre-final server). Defaults to "final"
   * so the initial `server/discover` probe carries the stateless `_meta`;
   * flips to "legacy" only when the probe signals a pre-final server.
   */
  private mode: "final" | "legacy" = "final";
  /**
   * TTL-aware capability snapshot (§6a.2) — the ONE authority for every "did
   * the server advertise X" question, replacing the connect-time latched
   * booleans. Expiry comes from the server's own `DiscoverResult.ttlMs`
   * (clamped); reads go through {@link capabilityAdvertised}, which refreshes
   * single-flight on expiry. Null until the final-mode discover lands and in
   * legacy mode (pre-final servers never advertise these surfaces).
   */
  private capabilitySnapshot: { discover: McpDiscoverResult; fetchedAt: number } | null = null;
  /** In-flight snapshot refresh (single-flight; concurrent reads await it). */
  private snapshotRefresh: Promise<void> | null = null;

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


  async connect(): Promise<void> {

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
      // server's capabilities. The probe runs in the default "final" mode so the
      // `_meta` is stamped.
      try {
        const discover = await this.sendRequest<McpDiscoverResult>(
          "server/discover",
          {},
          HANDSHAKE_TIMEOUT_MS,
        );
        this.mode = "final";
        // The snapshot (§6a.2) is the one authority every later "did the
        // server advertise X" read consults — including the §3.7 Apps
        // `_meta.ui` honor gate. It expires per the server's own ttlMs.
        this.capabilitySnapshot = { discover, fetchedAt: Date.now() };
        // Server-level usage guidance (read-only surface; never auto-injected here).
        // `discover` is untrusted wire data cast without runtime validation, so
        // coerce a non-string `instructions` to undefined here at the boundary —
        // every downstream consumer then sees only string | undefined.
        this.state.instructions =
          typeof discover.instructions === "string" ? discover.instructions : undefined;
        log.info(
          {
            protocol: MCP_PROTOCOL_VERSION,
            supportedVersions: discover.supportedVersions,
            server: `${discover.serverInfo.name}@${discover.serverInfo.version}`,
            apps: discover.capabilities?.extensions?.[MCP_APPS_UI_EXTENSION] !== undefined,
          },
      `${this.config.id} RC discovery completed`,
        );
      } catch (err) {
        // Documented dual-era exception (design §0): an EXTERNAL pre-final
        // server does not implement `server/discover`. On stdio that surfaces
        // as `-32601`; on Streamable HTTP the final spec's detection rule
        // applies — 400/404/405 with a body that is NOT a recognized modern
        // JSON-RPC error means "legacy server" (a session-enforcing pre-final
        // server answers the probe with a bare 400, never -32601). ANY other
        // error is a real failure and propagates. LVIS's own plugins always
        // speak the final revision, so this never runs for first-party plugins.
        if (!isLegacyFallbackSignal(err)) {
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
        // Legacy negotiation: the server may counter with its own revision. We
        // continue only on a revision whose transport behavior this client
        // actually implements — anything else is a mutual-incompatibility error,
        // not something to limp through.
        if (!MCP_SUPPORTED_LEGACY_VERSIONS.includes(initResult.protocolVersion)) {
          throw new Error(
            `[mcp-client] '${this.config.id}' countered initialize with unsupported protocol ` +
              `'${initResult.protocolVersion}' (supported legacy: ${MCP_SUPPORTED_LEGACY_VERSIONS.join(", ")})`,
          );
        }
        await this.sendNotification("notifications/initialized", {});
        log.info(
          {
            protocol: initResult.protocolVersion,
            server: `${initResult.serverInfo.name}@${initResult.serverInfo.version}`,
            era: "legacy",
          },
      `${this.config.id} legacy initialize completed (dual-era exception)`,
        );
      }

      // 도구 목록 요청 (mode-aware `_meta` via sendRequest)
      const toolsResult = await this.sendRequest<McpToolsListResult>("tools/list", {}, HANDSHAKE_TIMEOUT_MS);
      const tools = this.applyParamHeaderConformance(toolsResult.tools ?? []);

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

      // Discover user-controlled prompts (non-fatal; gated advertised + approved).
      await this.discoverPrompts();
      // Same for application-driven resources.
      await this.discoverResources();
      await this.discoverResourceTemplates();

      this.state.status = "connected";
      this.state.connectedAt = new Date().toISOString();

      // Health check 시작
      this.startHealthCheck();

      // §6a.3 — one long-lived notification stream when the server advertises
      // any listChanged kind (no-op otherwise, and for legacy servers).
      this.openListenStream();

      log.info(
      `${this.config.id} connected: ${this.state.registeredTools.length} tools registered`,
      );
    } catch (err) {
      this.state.status = "error";
      this.state.lastError = errorMessage(err);
      // transport 정리
      await this.closeTransport();
      throw err;
    }
  }

  /**
   * Discover the server's user-controlled prompts. Gated on BOTH the server
   * having ADVERTISED the `prompts` capability at discovery AND the server being
   * APPROVED for it (the same governance whitelist every request is gated on).
   * Non-fatal: prompts are an optional surface, so a failure never breaks the
   * tool connection. Pagination is bounded so a hostile `nextCursor` loop cannot
   * hang the handshake.
   */
  private async discoverPrompts(): Promise<void> {
    if (!(await this.capabilityAdvertised("prompts"))) return;
    if (!this.governance.validateRequestCapability(this.config.id, "prompts/list", {}).valid) {
      return;
    }
    const MAX_PROMPT_PAGES = 20;
    try {
      const prompts: McpPromptSummary[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PROMPT_PAGES; page++) {
        const result = await this.sendRequest<McpPromptsListResult>(
          "prompts/list",
          cursor ? { cursor } : {},
          HANDSHAKE_TIMEOUT_MS,
        );
        for (const p of result.prompts ?? []) {
          // Everything here is WIRE data — the declared TS types are casts, not
          // checks. A non-string name reaches the renderer and is rendered as a
          // React child (throws); a name main will later reject for length would
          // render a field the user can fill but the host silently drops. Both are
          // filtered at this boundary so one shape reaches every consumer.
          if (!isUsablePromptName(p.name, MCP_PROMPT_NAME_MAX_CHARS)) continue;
          const args = (Array.isArray(p.arguments) ? p.arguments : [])
            .filter((a) => a && isUsablePromptName(a.name, MCP_PROMPT_ARG_NAME_MAX_CHARS))
            .map((a) => ({
              name: a.name,
              ...(typeof a.description === "string" ? { description: a.description } : {}),
              required: a.required === true,
            }));
          prompts.push({
            name: p.name,
            ...(typeof p.title === "string" ? { title: p.title } : {}),
            ...(typeof p.description === "string" ? { description: p.description } : {}),
            ...(args.length > 0 ? { arguments: args } : {}),
          });
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      this.state.prompts = prompts;
      log.info(`${this.config.id} discovered ${prompts.length} prompt(s)`);
    } catch (err) {
      log.warn(
        `${this.config.id} prompts/list discovery failed (non-fatal): ${errorMessage(err)}`,
      );
    }
  }

  /**
   * Discover the resources a server declares (`resources/list`).
   *
   * Gated on the server having ADVERTISED the core `resources` capability AND
   * governance approving it — two keys, same as prompts, so nothing leaves the host
   * for a capability the user never approved. Non-fatal: resources are an optional
   * surface and a failure must not break the tool connection.
   *
   * Every field is validated HERE. `resources/list` output arrives as a cast, not a
   * check, so a non-string uri or a control character in a name would otherwise reach
   * host chrome and the audit log. One shape leaves this boundary.
   */
  private async discoverResources(): Promise<void> {
    if (!(await this.capabilityAdvertised("resources"))) return;
    if (!this.governance.validateRequestCapability(this.config.id, "resources/list", {}).valid) {
      return;
    }
    try {
      const resources: McpResourceSummary[] = [];
      const seen = new Set<string>();
      // Every entry the server published is counted, not just the malformed ones: a
      // resource can also fail to appear by being a duplicate URI or by arriving past
      // the per-server limit, and a log line that names only one of those reasons
      // reads as "everything else made it". A user asking where their resource went
      // (`file:///C:/Program Files/x.md`, dropped for the raw space) needs the total
      // to be honest, or the number they can see does not add up. Fail-closed is
      // right; unexplained is not.
      let published = 0;
      let cursor: string | undefined;
      for (let page = 0; page < MCP_RESOURCE_MAX_PAGES; page++) {
        const result = await this.sendRequest<McpResourcesListResult>(
          "resources/list",
          cursor ? { cursor } : {},
          HANDSHAKE_TIMEOUT_MS,
        );
        const entries = Array.isArray(result.resources) ? result.resources : [];
        // Counted per PAGE, not per entry, so reaching the per-server limit still
        // stops the walk instead of iterating a server-sized array to keep score.
        published += entries.length;
        for (const entry of entries) {
          if (resources.length >= MCP_RESOURCE_MAX_PER_SERVER) break;
          if (!entry || typeof entry !== "object") continue;
          if (!isUsableResourceUri(entry.uri)) continue;
          // De-duplicated by URI: the read path resolves a URI to at most one
          // catalogue entry, and two entries sharing a URI would make which one the
          // user picked unobservable.
          if (seen.has(entry.uri)) continue;
          const name = usableResourceText(entry.name, MCP_RESOURCE_NAME_MAX_CHARS)
            ?? usableResourceText(entry.uri, MCP_RESOURCE_NAME_MAX_CHARS);
          if (!name) continue;
          seen.add(entry.uri);
          const title = usableResourceText(entry.title, MCP_RESOURCE_NAME_MAX_CHARS);
          const description = usableResourceText(
            entry.description,
            MCP_RESOURCE_DESCRIPTION_MAX_CHARS,
          );
          const mimeType = usableResourceText(entry.mimeType, MCP_RESOURCE_NAME_MAX_CHARS);
          const size = typeof entry.size === "number"
            && Number.isSafeInteger(entry.size)
            && entry.size >= 0
            ? entry.size
            : undefined;
          resources.push({
            uri: entry.uri,
            name,
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
            ...(mimeType ? { mimeType } : {}),
            ...(size !== undefined ? { size } : {}),
            ...(isHostFetchRefusedUri(entry.uri) ? { hostFetchRefused: true } : {}),
          });
        }
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
        if (!cursor || resources.length >= MCP_RESOURCE_MAX_PER_SERVER) break;
      }
      this.state.resources = resources;
      const notCatalogued = published - resources.length;
      log.info(
        `${this.config.id} discovered ${resources.length} resource(s)`
          + `${notCatalogued > 0
            ? ` (${notCatalogued} of ${published} published not catalogued: unusable, duplicate,`
              + ` or past the ${MCP_RESOURCE_MAX_PER_SERVER} per-server limit)`
            : ""}`,
      );
    } catch (err) {
      log.warn(
        `${this.config.id} resources/list discovery failed (non-fatal): ${errorMessage(err)}`,
      );
    }
  }

  /**
   * Discover the URI TEMPLATES a server declares (`resources/templates/list`).
   *
   * Same two-key gate as `resources/list` — advertised AND governance-approved — and
   * gated on the same `resources` capability, because that is the capability the user
   * actually approved. A separate capability for templates would ask them a question
   * they have already answered.
   *
   * Every field validated here, same as resources. The one that is NOT like resources:
   * `uriTemplate` is checked with the TEMPLATE predicate, which refuses every RFC 6570
   * operator beyond plain `{var}`. A server publishing `{+path}` gets its template
   * dropped rather than offered, because reserved expansion would not percent-encode
   * what the user types into it.
   */
  private async discoverResourceTemplates(): Promise<void> {
    if (!(await this.capabilityAdvertised("resources"))) return;
    if (
      !this.governance.validateRequestCapability(
        this.config.id,
        "resources/templates/list",
        {},
      ).valid
    ) {
      return;
    }
    try {
      const templates: McpResourceTemplateSummary[] = [];
      const seen = new Set<string>();
      let published = 0;
      let cursor: string | undefined;
      for (let page = 0; page < MCP_RESOURCE_MAX_PAGES; page++) {
        const result = await this.sendRequest<McpResourceTemplatesListResult>(
          "resources/templates/list",
          cursor ? { cursor } : {},
          HANDSHAKE_TIMEOUT_MS,
        );
        const entries = Array.isArray(result.resourceTemplates) ? result.resourceTemplates : [];
        published += entries.length;
        for (const entry of entries) {
          if (templates.length >= MCP_RESOURCE_MAX_PER_SERVER) break;
          if (!entry || typeof entry !== "object") continue;
          if (!isUsableResourceUriTemplate(entry.uriTemplate)) continue;
          if (seen.has(entry.uriTemplate)) continue;
          const name = usableResourceText(entry.name, MCP_RESOURCE_NAME_MAX_CHARS)
            ?? usableResourceText(entry.uriTemplate, MCP_RESOURCE_NAME_MAX_CHARS);
          if (!name) continue;
          seen.add(entry.uriTemplate);
          const title = usableResourceText(entry.title, MCP_RESOURCE_NAME_MAX_CHARS);
          const description = usableResourceText(
            entry.description,
            MCP_RESOURCE_DESCRIPTION_MAX_CHARS,
          );
          const mimeType = usableResourceText(entry.mimeType, MCP_RESOURCE_NAME_MAX_CHARS);
          templates.push({
            uriTemplate: entry.uriTemplate,
            name,
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
            ...(mimeType ? { mimeType } : {}),
            // Derived ONCE, here, so no consumer re-parses the template to build a form.
            // The expansion re-scans instead of reading this list, but both go through
            // the one grammar in the bounds module — a second parser is what would let a
            // form and an expansion disagree about what the template asks for.
            variables: resourceTemplateVariables(entry.uriTemplate),
            // Set from the TEMPLATE, and it is a fact rather than a guess: the literal
            // part is fixed at discovery, so if the scheme is literally `https:` then
            // every expansion of it is too, and the read will refuse. Without this the
            // picker offers the row, the user fills a form, and the refusal arrives
            // afterwards blaming the server for a host-side rule.
            //
            // A template whose SCHEME is itself a variable (`{s}://host/{p}`) is not
            // flagged, because it genuinely is not known until expansion — which is why
            // the read re-derives the refusal rather than trusting this flag.
            ...(isHostFetchRefusedUri(entry.uriTemplate) ? { hostFetchRefused: true } : {}),
          });
        }
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
        if (!cursor || templates.length >= MCP_RESOURCE_MAX_PER_SERVER) break;
      }
      this.state.resourceTemplates = templates;
      const notCatalogued = published - templates.length;
      log.info(
        `${this.config.id} discovered ${templates.length} resource template(s)`
          + `${notCatalogued > 0
            ? ` (${notCatalogued} of ${published} published not catalogued: unusable,`
              + ` duplicate, or past the ${MCP_RESOURCE_MAX_PER_SERVER} per-server limit)`
            : ""}`,
      );
    } catch (err) {
      // Non-fatal and SEPARATE from `resources/list`: a server may support one and not
      // the other, and a template failure must not cost the user their plain resources.
      log.warn(
        `${this.config.id} resources/templates/list discovery failed (non-fatal): `
          + `${errorMessage(err)}`,
      );
    }
  }

  /**
   * Expand a declared URI TEMPLATE with user-supplied values and read the result.
   *
   * The gate is on the TEMPLATE, matched exactly against what this client listed — not
   * on the expanded URI. That is the whole reason this method exists instead of the
   * renderer expanding and calling `readDeclaredResource`: an expanded URI was never in
   * the listed set, so accepting one would mean pattern-matching an arbitrary URI back
   * against a template, and a matcher for `file:///{path}` accepts
   * `file:///../../etc/passwd`. Exact-matching the pattern and expanding here is the
   * version of that check that cannot be got wrong.
   *
   * `expandResourceUriTemplate` percent-encodes every value and re-validates the result
   * with the ordinary URI predicate, so by the time the read happens the URI is
   * indistinguishable from a listed one — including for the `https:` refusal, which is
   * re-derived here rather than inherited, because the template's literal scheme is not
   * necessarily the expansion's.
   */
  async readDeclaredResourceTemplate(
    uriTemplate: string,
    values: ReadonlyMap<string, string>,
  ): Promise<{
    blocks: Array<{ uri?: string; mimeType?: string; text?: string; omittedKind?: string }>;
    droppedBlocks: number;
    truncated: boolean;
    /** The URI the host produced, for the audit row and the attachment header. */
    uri: string;
  }> {
    if (!(await this.capabilityAdvertised("resources"))) {
      throw new Error("[mcp-client] server did not advertise resources");
    }
    const declared = this.state.resourceTemplates?.find(
      (template) => template.uriTemplate === uriTemplate,
    );
    if (!declared) {
      throw new Error("[mcp-client] server did not declare this resource template");
    }
    const uri = expandResourceUriTemplate(uriTemplate, values);
    if (!uri) {
      throw new Error("[mcp-client] template expansion produced no usable uri");
    }
    if (isHostFetchRefusedUri(uri)) {
      throw new Error("[mcp-client] host does not fetch this resource scheme");
    }
    const read = await this.readResourceUri(uri);
    return { ...read, uri };
  }

  /**
   * Read one declared resource (`resources/read`).
   *
   * Named apart from {@link readResource}, which serves the MCP-Apps `ui://`
   * extension: same JSON-RPC method, different surface, different containment
   * rules. Collapsing them would let an app-scheme URI be read through the
   * core-capability gate or vice versa.
   *
   * Three gates before anything leaves the host: the capability was advertised, the
   * URI is one this client actually LISTED (so this cannot be used as a general fetch
   * primitive against the server URI space), and the URI is not one the host refuses
   * to fetch. Governance checks the capability again inside `sendRequest`, which is
   * the single enforcement point for every method.
   *
   * Returns text blocks only. A binary blob becomes an explicit placeholder: a server
   * must not be able to make the host quietly omit part of what it returned, and
   * undecoded bytes must never reach the model as if they were text.
   */
  async readDeclaredResource(uri: string): Promise<{
    blocks: Array<{ uri?: string; mimeType?: string; text?: string; omittedKind?: string }>;
    droppedBlocks: number;
    /** True when the block cap or the character budget clipped the read. */
    truncated: boolean;
  }> {
    if (!(await this.capabilityAdvertised("resources"))) {
      throw new Error("[mcp-client] server did not advertise resources");
    }
    const declared = this.state.resources?.find((resource) => resource.uri === uri);
    if (!declared) {
      throw new Error("[mcp-client] server did not declare this resource");
    }
    if (declared.hostFetchRefused) {
      throw new Error("[mcp-client] host does not fetch this resource scheme");
    }
    return this.readResourceUri(uri);
  }

  /**
   * The `resources/read` round trip and its bounds, shared by both declared paths.
   *
   * Extracted so the block cap, the character budget and the blob placeholder have ONE
   * implementation: a template read that carried its own copy would be the place a
   * bound silently stops applying, and this is the boundary where an unbounded server
   * response is supposed to stop. The GATES stay with each caller, because they differ —
   * one matches a listed URI, the other matches a listed template and expands it.
   */
  private async readResourceUri(uri: string): Promise<{
    blocks: Array<{ uri?: string; mimeType?: string; text?: string; omittedKind?: string }>;
    droppedBlocks: number;
    truncated: boolean;
  }> {
    const result = await this.sendRequest<McpResourcesReadResult>("resources/read", { uri });
    const returned = Array.isArray(result.contents) ? result.contents : [];
    const kept = returned.slice(0, MCP_RESOURCE_MAX_BLOCKS);
    // The character budget is spent HERE, at the boundary, not by a later
    // renderer: an unbounded text block should never be carried across the host in
    // the first place. Spent across blocks rather than per block, so a server
    // cannot multiply the budget by splitting one document into many.
    let charBudget = MCP_RESOURCE_MAX_CHARS;
    let truncated = returned.length > kept.length;
    const blocks = kept.map((content) => {
      const blockUri = usableResourceText(content.uri, MCP_RESOURCE_URI_MAX_CHARS);
      const mimeType = usableResourceText(content.mimeType, MCP_RESOURCE_NAME_MAX_CHARS);
      if (typeof content.text === "string") {
        const text = content.text.slice(0, Math.max(0, charBudget));
        if (text.length < content.text.length) truncated = true;
        charBudget -= text.length;
        return {
          ...(blockUri ? { uri: blockUri } : {}),
          ...(mimeType ? { mimeType } : {}),
          text,
        };
      }
      return {
        ...(blockUri ? { uri: blockUri } : {}),
        ...(mimeType ? { mimeType } : {}),
        omittedKind: typeof content.blob === "string" ? "binary" : "unknown",
      };
    });
    return { blocks, droppedBlocks: returned.length - kept.length, truncated };
  }

  /**
   * Fetch one server-declared prompt (`prompts/get`).
   *
   * Prompts are a USER-controlled primitive: this runs only from an explicit
   * user selection, never from the model. The request is gated by the same
   * per-request capability check as every other call (`prompts` must be both
   * advertised and approved), and the prompt must be one the server actually
   * declared at discovery — a name the host never saw is refused rather than
   * forwarded.
   */
  async getPrompt(
    name: string,
    args: Record<string, string>,
  ): Promise<{
    description?: string;
    blocks: Array<{ role: string; type: string; text?: string }>;
    /** Message blocks the host refused to carry past its cap. */
    droppedBlocks: number;
  }> {
    if (!(await this.capabilityAdvertised("prompts"))) {
      throw new Error(`[mcp-client] server '${this.config.id}' did not advertise prompts`);
    }
    const declared = this.state.prompts?.some((prompt) => prompt.name === name);
    if (!declared) {
      throw new Error(`[mcp-client] server '${this.config.id}' did not declare prompt '${name}'`);
    }
    const result = await this.sendRequest<McpPromptGetResult>("prompts/get", {
      name,
      ...(Object.keys(args).length > 0 ? { arguments: args } : {}),
    });
    // Sliced BEFORE mapping: `renderMcpPrompt`'s block cap applies to the mapped
    // array, so a server returning a huge `messages` array would already have paid
    // for the allocation by then. The clip is reported EXPLICITLY rather than left
    // for the renderer to infer from the array length — inferring it made the count
    // depend on this slice over-reading by exactly one, which is the kind of
    // arithmetic a later simplification silently breaks.
    const returnedBlocks = Array.isArray(result.messages) ? result.messages : [];
    const messages = returnedBlocks.slice(0, MCP_PROMPT_MAX_BLOCKS);
    const droppedBlocks = returnedBlocks.length - messages.length;
    const blocks = messages.map((message) => ({
      role: typeof message.role === "string" ? message.role : "user",
      type: typeof message.content?.type === "string" ? message.content.type : "text",
      ...(typeof message.content?.text === "string" ? { text: message.content.text } : {}),
    }));
    return {
      ...(typeof result.description === "string" ? { description: result.description } : {}),
      blocks,
      droppedBlocks,
    };
  }

  /** 서버 연결 해제 + 도구 제거 */
  async disconnect(): Promise<void> {
    this.stopHealthCheck();
    this.rejectAllPending(t("be_mcpClient.serverDisconnected"));
    this.clearRegisteredToolOverrides();

    // ToolRegistry에서 도구 제거 + 디스커버리 산출물 정리
    this.clearDiscoveredSurfaces();

    // transport 종료
    await this.closeTransport();

    this.state.status = "disconnected";
    this.state.lastError = undefined;
    log.info(`${this.config.id} disconnected`);
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
      // `x-mcp-header` mirroring (final spec, HTTP only): the server designated
      // these argument values for HTTP-header duty at discovery; the transport
      // MUST carry them on the POST or a conformant server rejects with -32020.
      const annotations = this.paramHeaderAnnotations.get(name);
      let sendOpts: McpSendOptions | undefined =
        annotations !== undefined
          ? { extraHeaders: extractParamHeaders(annotations, args) }
          : undefined;
      let headerRetryDone = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let result: McpToolCallResult;
        try {
          result = await this.sendRequest<McpToolCallResult>("tools/call", params, timeoutMs, sendOpts);
        } catch (err) {
          // Spec client behavior on HeaderMismatch when we mirrored
          // `Mcp-Param-*` headers: the tool's inputSchema may have changed —
          // refresh `tools/list` (annotations re-validated), rebuild the
          // mirrors, and retry ONCE. A second -32020 propagates.
          if (
            !headerRetryDone &&
            err instanceof McpRpcError &&
            err.code === RPC_HEADER_MISMATCH &&
            sendOpts?.extraHeaders !== undefined
          ) {
            headerRetryDone = true;
            await this.refreshTools();
            const refreshed = this.paramHeaderAnnotations.get(name);
            sendOpts =
              refreshed !== undefined
                ? { extraHeaders: extractParamHeaders(refreshed, args) }
                : undefined;
            continue;
          }
          throw err;
        }

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
          `[mcp-client] '${this.config.id}' requires a client capability the host did not advertise for tool '${name}' (-32021): ${err.message}`,
        );
      }
      if (err instanceof McpRpcError && err.code === RPC_UNSUPPORTED_PROTOCOL_VERSION) {
        throw new Error(
          `[mcp-client] '${this.config.id}' does not support protocol ${MCP_PROTOCOL_VERSION} for tool '${name}' (-32022): ${err.message}`,
        );
      }
      const message = errorMessage(err);
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
  private async renderToolResult(
    result: McpToolCallResult,
  ): Promise<{ text: string; uiPayload?: McpUiPayload }> {
    const content = result.content ?? [];
    if (result.isError) {
      throw new Error(content.map((c) => c.text ?? JSON.stringify(c)).join("\n"));
    }
    const text = content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
    // MCP Apps permission gate (§3.7): ignore `_meta.ui` unless the server's
    // CURRENT advertisement includes the ui extension. Security gate — fails
    // closed on a stale-and-unrefreshable snapshot (§6a.2).
    const uiMeta = (await this.capabilityAdvertised("appsUi", { securityGate: true }))
      ? result._meta?.ui
      : undefined;
    let uiPayload: McpUiPayload | undefined;
    // Fail-closed at EXTRACTION, mirroring the plugin arm (`plugin-runtime-delegate`),
    // which drops a malformed `_meta.ui` here rather than carrying it forward.
    //
    // The external arm used to carry any non-empty string through. The card then mounted,
    // installed its partition policy, minted nothing, and failed at `readResource` with a
    // message about schemes that a user reading it has no way to connect to the server's
    // declaration. Checking the same predicate the read will apply anyway turns that into
    // no card at all — which is what a server publishing an unusable `resourceUri` should
    // get, and matches what the plugin arm has always done.
    //
    // Only the CARD is dropped: `text` is returned regardless, so a tool result is never
    // withheld from the model because its optional UI declaration was malformed.
    if (isMcpAppUiUri(uiMeta?.resourceUri)) {
      uiPayload = {
        serverId: this.config.id,
        resourceUri: uiMeta.resourceUri,
        slot: (uiMeta.slot as McpUiPayload["slot"]) ?? "chat",
        height: uiMeta.height,
        title: uiMeta.title,
      };
    } else if (uiMeta?.resourceUri) {
      log.warn(
        `${this.config.id} dropped a tool result's ui card: `
          + `resourceUri is not a usable ui:// resource`,
      );
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
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
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
   *
   * The scheme is ENFORCED here, and this is the gate that was missing. `resources/read`
   * is one wire method serving two host paths: {@link readDeclaredResource}, gated on the
   * listed set, and this one, which serves the MCP-Apps extension. The renderer chooses
   * the URI on this path, and nothing in MAIN checked it
   * — the `ui://` restriction lived only in the renderer's bridge handler, which is the
   * side the threat model assumes can be compromised. Governance could not close it
   * either: it sees one method and cannot tell the two callers apart, so a non-`ui:` URI
   * fell through to requiring `resources`, which any resource-publishing server has.
   *
   * So a compromised renderer could read ANY URI from ANY connected external server by
   * naming it here. Refusing before the request is the whole fix, and it belongs in this
   * method because this method's contract — stated in the line above since it was
   * written — is that it fetches a `ui://` resource.
   */
  async readResource(uri: string): Promise<McpUiResourceRead> {
    if (!isMcpAppUiUri(uri)) {
      throw new Error("[mcp-client] the MCP-Apps read path serves ui:// resources only");
    }
    if (this.state.status !== "connected" || !this.transport?.isAlive()) {
      throw new Error(`[mcp-client] ${t("be_mcpClient.serverNotConnected", { id: this.config.id })}`);
    }

    interface McpResourceReadResult {
      contents: Array<{
        type?: string;
        text?: string;
        blob?: string;
        uri?: string;
        mimeType?: string;
        /** MCP Apps: the resource's own security metadata (csp / permissions). */
        _meta?: { ui?: McpUiResourceMeta };
      }>;
    }

    const result = await this.sendRequest<McpResourceReadResult>("resources/read", { uri });
    const textPart = result.contents.find((c) => c.text !== undefined);
    if (!textPart?.text) {
      throw new Error(`[mcp-client] ${t("be_mcpClient.resourceReadNoText", { uri })}`);
    }

    // §3.7 permission gate — same rule as tool `_meta.ui`: ignore the ui
    // extension unless the server's CURRENT advertisement includes it.
    // Security gate — fails closed on a stale-and-unrefreshable snapshot,
    // so an un-advertised server cannot open its own CSP (§6a.2).
    const meta = (await this.capabilityAdvertised("appsUi", { securityGate: true }))
      ? textPart._meta?.ui
      : undefined;

    return { html: textPart.text, csp: meta?.csp, permissions: meta?.permissions };
  }

  // ─── JSON-RPC Transport ─────────────────────────────

  // ─── subscriptions/listen (§6a.3) ────────────────────

  /** The `listChanged` kinds the CURRENT snapshot advertises. */
  private advertisedListChangedFilter(): Record<string, boolean> {
    const capabilities = this.capabilitySnapshot?.discover.capabilities;
    const filter: Record<string, boolean> = {};
    if (capabilities?.tools?.listChanged) filter.toolsListChanged = true;
    if (capabilities?.prompts?.listChanged) filter.promptsListChanged = true;
    if (capabilities?.resources?.listChanged) filter.resourcesListChanged = true;
    return filter;
  }

  /**
   * Open the ONE long-lived notification stream (§6a.3), opting into exactly
   * the kinds the server advertises. The request is unbounded (no timers); its
   * settle means the stream ended — re-open with capped backoff while still
   * connected. A `-32601` marks the server as not implementing listen (an
   * advertisement without a channel): stop trying, snapshot-expiry refreshes
   * still bound staleness.
   */
  private openListenStream(): void {
    if (this.mode !== "final" || this.listenUnsupported) return;
    const filter = this.advertisedListChangedFilter();
    if (Object.keys(filter).length === 0) return;
    void this.sendRequest("subscriptions/listen", { notifications: filter })
      .then(() => this.scheduleListenReopen())
      .catch((err: unknown) => {
        if (err instanceof McpRpcError && err.code === RPC_METHOD_NOT_FOUND) {
          this.listenUnsupported = true;
          log.warn(
            `${this.config.id} advertises listChanged but does not implement subscriptions/listen`,
          );
          return;
        }
        this.scheduleListenReopen();
      });
  }

  private scheduleListenReopen(): void {
    // Also bail when the transport is gone: teardown rejections settle the
    // listen promise DURING disconnect (at its close await), and a timer armed
    // there would outlive the clear in clearDiscoveredSurfaces.
    if (this.state.status !== "connected" || !this.transport?.isAlive() || this.listenReopenTimer) {
      return;
    }
    const delay = this.listenBackoffMs;
    this.listenBackoffMs = Math.min(this.listenBackoffMs * 2, LISTEN_BACKOFF_MAX_MS);
    this.listenReopenTimer = setTimeout(() => {
      this.listenReopenTimer = null;
      if (this.state.status === "connected") this.openListenStream();
    }, delay);
    this.listenReopenTimer.unref?.();
  }

  // ─── Capability Snapshot (§6a.2) ─────────────────────

  /** The snapshot's effective TTL: the server's own `ttlMs`, clamped. */
  private snapshotTtlMs(): number {
    const raw = this.capabilitySnapshot?.discover.ttlMs;
    // Absent/malformed ttlMs (non-conformant server) → max clamp: no thrash,
    // and the snapshot still refreshes daily rather than living forever.
    const ttl = typeof raw === "number" && Number.isFinite(raw) ? raw : SNAPSHOT_TTL_MAX_MS;
    return Math.min(Math.max(ttl, SNAPSHOT_TTL_MIN_MS), SNAPSHOT_TTL_MAX_MS);
  }

  private snapshotExpired(): boolean {
    if (!this.capabilitySnapshot) return true;
    return Date.now() - this.capabilitySnapshot.fetchedAt > this.snapshotTtlMs();
  }

  /** Single-flight `server/discover` re-issue; concurrent reads share one. */
  private refreshCapabilitySnapshot(): Promise<void> {
    if (this.snapshotRefresh) return this.snapshotRefresh;
    const refresh = (async () => {
      const discover = await this.sendRequest<McpDiscoverResult>(
        "server/discover",
        {},
        HANDSHAKE_TIMEOUT_MS,
      );
      this.capabilitySnapshot = { discover, fetchedAt: Date.now() };
      this.state.instructions =
        typeof discover.instructions === "string" ? discover.instructions : undefined;
    })();
    this.snapshotRefresh = refresh.finally(() => {
      this.snapshotRefresh = null;
    });
    return this.snapshotRefresh;
  }

  /**
   * Whether the server currently advertises `kind` (§6a.2). On an expired
   * snapshot this refreshes single-flight first. Refresh FAILURE splits by
   * consumer: an availability read keeps serving the stale snapshot (a fetch
   * hiccup must not disable working surfaces); the Apps `_meta.ui` honor gate
   * passes `securityGate` and fails CLOSED instead — it decides whether
   * server-authored UI is honored, so a stale-and-unrefreshable claim is not
   * good enough. Legacy servers never advertise these surfaces.
   */
  private async capabilityAdvertised(
    kind: "appsUi" | "prompts" | "resources",
    opts?: { securityGate?: boolean },
  ): Promise<boolean> {
    if (this.mode === "legacy") return false;
    if (this.snapshotExpired()) {
      try {
        await this.refreshCapabilitySnapshot();
      } catch (err) {
        if (opts?.securityGate) {
          log.warn(
            `${this.config.id} capability snapshot refresh failed — failing the Apps gate closed: %s`,
            err,
          );
          return false;
        }
        log.warn(`${this.config.id} capability snapshot refresh failed — serving stale: %s`, err);
      }
    }
    const capabilities = this.capabilitySnapshot?.discover.capabilities;
    if (!capabilities) return false;
    switch (kind) {
      case "appsUi":
        return capabilities.extensions?.[MCP_APPS_UI_EXTENSION] !== undefined;
      case "prompts":
        return capabilities.prompts !== undefined;
      case "resources":
        // The CORE `resources` capability, not the MCP-Apps `ui://` extension —
        // different surfaces with different containment rules.
        return capabilities.resources !== undefined;
    }
  }

  /**
   * `x-mcp-header` conformance (final spec, Streamable HTTP only): validate
   * each discovered tool's annotations, keep the valid annotation sets for
   * per-call header mirroring, and EXCLUDE a tool whose annotations violate
   * any constraint — the spec's required failure isolation (one malformed tool
   * must not block the rest). Non-HTTP transports MAY ignore the extension;
   * we do, and legacy-era servers predate it entirely.
   */
  private applyParamHeaderConformance(tools: McpToolSchema[]): McpToolSchema[] {
    this.paramHeaderAnnotations.clear();
    if (this.transport?.kind !== "http" || this.mode !== "final") return tools;
    const kept: McpToolSchema[] = [];
    for (const tool of tools) {
      const outcome = collectParamHeaderAnnotations(tool.inputSchema);
      if (outcome.reason !== undefined) {
        log.warn(
          `${this.config.id} tool '${tool.name}' rejected (x-mcp-header): ${outcome.reason}`,
        );
        continue;
      }
      if (outcome.annotations.length > 0) {
        this.paramHeaderAnnotations.set(tool.name, outcome.annotations);
      }
      kept.push(tool);
    }
    return kept;
  }

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

  private sendRequest<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
    sendOpts?: McpSendOptions,
  ): Promise<T> {
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

      // `subscriptions/listen` is the one deliberately-UNBOUNDED request
      // (§6a.3): its "response" only arrives when the notification stream ends,
      // so it carries no timers and its transport stream is non-fatal on drop.
      const unbounded = method === "subscriptions/listen";
      const timer = unbounded
        ? null
        : setTimeout(() => {
            this.pendingRequests.delete(id);
            reject(
              new Error(
                `[mcp-client] ${t("be_mcpClient.requestTimeout", { timeout: String(timeout), method })}`,
              ),
            );
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
      const effectiveSendOpts: McpSendOptions | undefined = unbounded
        ? { ...sendOpts, nonFatalStream: true }
        : sendOpts;
      transport.send(request, effectiveSendOpts).catch((err: Error) => {
        // send 실패 → pending 정리 후 reject
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
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
      // Id-less inbound = a server NOTIFICATION (stdio push / SSE
      // request-scoped event). These were previously dropped wholesale, which
      // made every advertised `listChanged` capability and every
      // `notifications/progress` unobservable.
      if (typeof response.method === "string") {
        this.handleNotification(response.method, response.params);
      }
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
    if (pending.timer) clearTimeout(pending.timer);

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

  /**
   * Server-notification dispatch. Only notifications with a live meaning here
   * are acted on; the rest are logged at debug so a dropped kind is diagnosable
   * (the previous behavior was a silent wholesale drop).
   */
  private handleNotification(method: string, _params?: Record<string, unknown>): void {
    switch (method) {
      case "notifications/progress":
        // A progress tick is proof of life for whatever is pending. The SSE
        // chunk path already resets per-request activity timers for HTTP;
        // this covers stdio, where nothing else does.
        this.resetPendingTimers();
        return;
      case "notifications/tools/list_changed":
        this.scheduleToolsRefresh();
        return;
      case "notifications/subscriptions/acknowledged":
        // The server accepted the listen filter — the stream is live; reset
        // the re-open backoff so a later drop recovers quickly.
        this.listenBackoffMs = LISTEN_BACKOFF_START_MS;
        return;
      case "notifications/prompts/list_changed":
        void this.discoverPrompts().catch((err) => {
          log.warn(`${this.config.id} prompts refresh after list_changed failed: %s`, err);
        });
        return;
      case "notifications/resources/list_changed":
        void this.discoverResources()
          .then(() => this.discoverResourceTemplates())
          .catch((err) => {
            log.warn(`${this.config.id} resources refresh after list_changed failed: %s`, err);
          });
        return;
      default:
        log.debug(`${this.config.id} unhandled server notification '${method}'`);
    }
  }

  /**
   * Debounced `tools/list` re-fetch after `notifications/tools/list_changed`.
   * Debounce absorbs notification bursts; the guard keeps one refresh in
   * flight. A refresh failure keeps the PREVIOUS registration (the notification
   * is advisory — a fetch hiccup must not tear down working tools).
   */
  private scheduleToolsRefresh(): void {
    if (this.toolsRefreshTimer) return;
    this.toolsRefreshTimer = setTimeout(() => {
      this.toolsRefreshTimer = null;
      if (this.toolsRefreshRunning) {
        // A burst landed during a running refresh — go again after it.
        this.scheduleToolsRefresh();
        return;
      }
      this.toolsRefreshRunning = true;
      void this.refreshTools()
        .catch((err) => {
          log.warn(`${this.config.id} tools refresh after list_changed failed: %s`, err);
        })
        .finally(() => {
          this.toolsRefreshRunning = false;
        });
    }, TOOLS_REFRESH_DEBOUNCE_MS);
    this.toolsRefreshTimer.unref?.();
  }

  private async refreshTools(): Promise<void> {
    if (this.state.status !== "connected") return;
    const toolsResult = await this.sendRequest<McpToolsListResult>(
      "tools/list",
      {},
      HANDSHAKE_TIMEOUT_MS,
    );
    const tools = this.applyParamHeaderConformance(toolsResult.tools ?? []);

    // Validate against the registry MINUS this server's own registrations —
    // otherwise the refresh would collide with itself on every unchanged name.
    const ownNames = new Set(this.state.registeredTools);
    const existingToolNames = new Set(
      this.toolRegistry
        .listAll()
        .map((tool) => tool.name)
        .filter((name) => !ownNames.has(name)),
    );
    const validation = this.governance.validateToolRegistration(
      this.config.id,
      tools,
      existingToolNames,
    );
    if (!validation.valid) {
      throw new Error(
        `[mcp-client] ${t("be_mcpClient.toolRegistrationValidationFailed", { layer: String(validation.layer), reason: validation.reason })}`,
      );
    }

    // Swap: registerTools rolls its own batch back on a partial failure, so the
    // worst post-validation outcome is an empty (never half-updated) set.
    this.clearRegisteredToolOverrides();
    this.toolRegistry.unregisterByMcp(this.config.id);
    this.state.registeredTools = [];
    this.registerTools(tools);
    log.info(`${this.config.id} tools refreshed: ${this.state.registeredTools.length} registered`);
  }

  /**
   * Drop everything discovery produced. Called by BOTH teardown paths, because a
   * catalogue that outlives its connection is worse than an empty one: every
   * consumer keeps offering names and URIs whose call can only fail, and the
   * failure surfaces far from the cause. `handleTransportClose` used to clear the
   * tools and leave prompts and resources behind.
   */
  private clearDiscoveredSurfaces(): void {
    if (this.toolsRefreshTimer) {
      clearTimeout(this.toolsRefreshTimer);
      this.toolsRefreshTimer = null;
    }
    // The capability snapshot describes THIS connection's server; a torn-down
    // connection has no advertisement (reconnect re-discovers).
    this.capabilitySnapshot = null;
    if (this.listenReopenTimer) {
      clearTimeout(this.listenReopenTimer);
      this.listenReopenTimer = null;
    }
    this.listenBackoffMs = LISTEN_BACKOFF_START_MS;
    this.listenUnsupported = false;
    this.toolRegistry.unregisterByMcp(this.config.id);
    this.state.registeredTools = [];
    this.state.prompts = undefined;
    this.state.resources = undefined;
    this.state.resourceTemplates = undefined;
    this.state.instructions = undefined;
  }

  private handleTransportClose(reason: string): void {
    if (this.state.status === "disconnected") return; // normal shutdown

    this.state.status = "error";
    this.state.lastError = reason;
    this.rejectAllPending(reason);
    this.clearRegisteredToolOverrides();
    this.clearDiscoveredSurfaces();
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
      if (pending.timer) clearTimeout(pending.timer);
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
      // The unbounded listen request has no timers to reset — by design it
      // outlives every window.
      if (pending.timer === null) continue;
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
      log.warn(`${this.config.id} health check failed: transport inactive`);
      this.handleTransportClose(t("be_mcpClient.healthCheckTransportInactive"));
      return;
    }

    // No active probe on ANY transport. `ping` was removed from the protocol in
    // the final `2026-07-28` revision, and it was already redundant here: stdio
    // detects death via the child `exit` event, http via `send()` failure /
    // SSE-stream termination. The `isAlive()` check above is the whole check.
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
   * ASRT wrap. Drives both the per-command cleanup on close
   * (Linux bwrap mount teardown) AND the reviewer's genuine-capability signal
   * via {@link markMcpServerWrapped}. Stays false on the plain-spawn path so an
   * unwrapped server never reports `asrt` to the reviewer (no-leak invariant).
   */
  private wrappedThroughAsrt = false;
  /**
   * One-shot guard for the ASRT cleanup that fires on definitive child
   * termination (unexpected crash, OS kill, or close after a spawn error). Ensures
   * `unmarkMcpServerWrapped` + `cleanupAsrtSandboxAfterCommand` run EXACTLY
   * ONCE per wrapped worker lifetime regardless of exit cause (worker-egress
   * Unexpected child death previously bypassed cleanup,
   * violating the no-leak invariant and leaking the bwrap ref-count).
   */
  private asrtCleanupRan = false;
  private wrappedOwner: McpWrappedOwner | null = null;
  private sandboxHomeCleanup: (() => void) | null = null;

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

    // ASRT stdio worker wrap — gate DEFAULT-OFF. When the OS-tool sandbox is active,
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
        if (this.wrappedOwner !== null) {
          unmarkMcpServerWrapped(this.config.id, this.wrappedOwner);
          this.wrappedOwner = null;
        }
        throw err instanceof Error ? err : new Error(String(err));
      }
    }

    assertManagedChildProcessAdmissionOpen(`mcp:${this.config.id}`);
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
   * Spawn the stdio worker WRAPPED by ASRT. The filesystem
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
          "ASRT 0.0.73 cannot apply per-server filesystem.allowRead/allowWrite " +
          "grants per exec; only denyRead/denyWrite are supported. Keep MCP " +
          "stdio fail-closed until a Windows session-grant/control-channel " +
          "design lands.",
      );
    }

    const sandboxHome = createSandboxProcessHome();

    // FAIL-CLOSED filesystem jail (deny-by-default A.a): the host populates
    // `sandboxRoot` at connect time. If it is somehow still absent (e.g. a
    // direct StdioTransport construction in a test), grant NO writable path at
    // all — NEVER cwd / NEVER the real HOME / NEVER any pre-existing dir. The
    // fresh process HOME is the only host-created writable compatibility path.
    const sandboxRoot = this.config.sandboxRoot;
    const allowWrite = [sandboxHome.path, ...(sandboxRoot ? [sandboxRoot] : [])];
    // Runtime dirs the worker legitimately needs to READ to start (its own jail
    // root + the system temp dir). HOME is NOT re-allowed for read.
    const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
    const allowRead = [
      sandboxHome.path,
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
    // denyWrite is likewise per-command and replaces the shared boot array.
    // Restate the centralized persistence-vector SOT so an authorized MCP
    // sandboxRoot cannot write shell rc files, credential dirs, LaunchAgents, or
    // cron-like re-exec hooks if a future config broadens allowWrite.
    const denyWrite = getDefaultSensitiveWriteDenyPaths();

    // Assemble the command string DEFENSIVELY: shell-quote the resolved binary
    // and every arg so a path with spaces / metacharacters cannot mis-split or
    // inject a second command. ASRT runs this string under a POSIX shell.
    const cmdline = [spawnCommand.command, ...spawnCommand.args]
      .map((part) => shellQuote(part))
      .join(" ");

    let wrapped = false;
    try {
      const { argv, env } = await wrapWorkerCommand(cmdline, {
        filesystem: { allowWrite, allowRead, denyRead, denyWrite },
      });
      wrapped = true;

      const [cmd, ...args] = argv;
      if (cmd === undefined) {
        throw new Error("[mcp-client] ASRT returned an empty argv for the MCP worker wrap");
      }

      this.wrappedThroughAsrt = true;
      this.sandboxHomeCleanup = sandboxHome.cleanup;
      this.wrappedOwner = markMcpServerWrapped(this.config.id);

      assertManagedChildProcessAdmissionOpen(`mcp:${this.config.id}:asrt`);
      this.process = spawn(cmd, args, {
        // stdin pipe MUST stay writable for JSON-RPC Content-Length framing.
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        env: this.buildWrappedStdioEnv(baseEnv, env, { ...sandboxHome.env }),
      });

      trackManagedChildProcess(this.process, { label: `mcp:${this.config.id}:asrt` });
      this.setupProcessHandlers();
    } catch (err) {
      if (this.wrappedThroughAsrt) {
        this.runAsrtCleanupOnce();
        this.cleanupSandboxHome();
      } else {
        if (wrapped) void cleanupAsrtSandboxAfterCommand();
        sandboxHome.cleanup();
      }
      throw err;
    }
  }

  /**
   * Compose the WRAPPED worker's env per platform (the 3b
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
    sandboxHomeEnv: Record<string, string>,
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
    return { ...baseEnv, ...proxyOverlay, ...sandboxHomeEnv };
  }

  /**
   * Release the per-command ASRT state exactly ONCE after the wrapped worker
   * has definitively exited or closed. Shutdown intent alone must not release
   * confinement while a TERM-ignoring child is still alive.
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
    if (this.wrappedOwner !== null) {
      unmarkMcpServerWrapped(this.config.id, this.wrappedOwner);
      this.wrappedOwner = null;
    }
    void cleanupAsrtSandboxAfterCommand();
  }

  private cleanupSandboxHome(): void {
    this.sandboxHomeCleanup?.();
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
    // Capture the process reference BEFORE nulling `this.process` so the
    // SIGKILL fallback timer can still reach it. Without this, `close()` used
    // to null the field synchronously and the 3-second timer would dereference
    // `this.process?.kill("SIGKILL")` as a no-op.
    const proc = this.process;
    this.process = null;
    if (!proc) return;
    try {
      proc.stdin?.end();
    } catch {
      // A broken stdin must not suppress process termination below.
    }
    const forceKillTimer = terminateChildProcess(proc, 3_000);
    const clearForceKill = (): void => clearTimeout(forceKillTimer);
    proc.once("exit", clearForceKill);
    proc.once("close", clearForceKill);
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
      log.error(`${this.config.id} stdout processing error: %s`, err);
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
      log.warn(`${this.config.id} process exited: code=${code}, signal=${signal}`);
      // Fire ASRT cleanup on ANY child termination,
      // including unexpected crashes/kills. The idempotent one-shot helper ensures
      // exit and the later close event do not double-run the cleanup.
      this.runAsrtCleanupOnce();
      this.cleanupSandboxHome();
      if (!this.closedExternally) {
        this.closeHandler?.(t("be_mcpClient.processExitedUnexpectedly"));
      }
    });

    this.process.on("error", (err) => {
      log.error(`${this.config.id} process error: %s`, err.message);
      // `error` is not definitive termination: signal or IPC delivery can fail
      // while the child remains alive. `exit`/`close` retain cleanup ownership.
      this.closeHandler?.(t("be_mcpClient.processError", { message: err.message }));
    });

    // Node emits `close` after `exit` once stdio has closed. A transient
    // Windows lock can make the first HOME removal fail; the cleanup helper
    // deliberately remains retryable until deletion succeeds.
    this.process.on("close", () => {
      this.runAsrtCleanupOnce();
      this.cleanupSandboxHome();
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
        log.warn(`${this.config.id} JSON parse failed: %s`, messageStr.slice(0, 200));
      }
    }
  }
}

// ─── Streamable HTTP Transport ───────────────────────

/**
 * Implements the MCP Streamable HTTP transport (final `2026-07-28` revision —
 * stateless, per-request metadata headers; introduced in `2025-03-26`).
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
  /** Server-minted legacy session id (`Mcp-Session-Id`); null outside the dual-era lane. */
  private sessionId: string | null = null;
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

  async send(message: JsonRpcMessage, opts?: McpSendOptions): Promise<void> {
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

    // Request-metadata headers (final `2026-07-28` Streamable HTTP): the
    // standard trio is derived FROM the message body so header and body can
    // never disagree (a mismatch is a server-side -32020 rejection), and the
    // caller's `Mcp-Param-{Name}` mirrors ride the same request. Stamped LAST
    // so an admin-supplied header can never desynchronize them from the body.
    for (const [k, v] of Object.entries(deriveStandardHeaders(message))) {
      headers[k] = v;
    }
    for (const [k, v] of Object.entries(opts?.extraHeaders ?? {})) {
      headers[k] = v;
    }
    // Dual-era session echo: a pre-final (2025-03-26..2025-11-25) server may
    // mint a session on initialize and require it on every later request. Echo
    // whatever the server minted; a final-spec server never mints one (and per
    // spec ignores a stray echo), so this stays inert outside the legacy lane.
    if (this.sessionId !== null) {
      headers["mcp-session-id"] = this.sessionId;
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
      const reason = errorMessage(err);
      throw new Error(`${t("be_mcpClient.httpFetchFailed", { reason })}`);
    }

    // Response headers received — cancel the initial-response timeout.
    clearTimeout(timeoutId);

    // Capture a legacy server's minted session for the echo above. Only ever
    // set by pre-final servers; the final revision removed sessions entirely.
    const mintedSession = response.headers.get("mcp-session-id");
    if (mintedSession !== null && mintedSession.length > 0) {
      this.sessionId = mintedSession;
    }

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
      // Final-spec backward compat: a MODERN server also answers with 4xx for
      // UnsupportedProtocolVersion / HeaderMismatch / unknown method — carrying
      // a JSON-RPC error body. Route a parseable, id-bearing error through the
      // normal response path so the pending request rejects with its REAL code
      // (and the connect probe can tell "modern error" from "legacy server").
      const rpcError = parseJsonRpcErrorBody(body);
      if (rpcError !== null && rpcError.id !== undefined && rpcError.id !== null) {
        this.messageHandler?.(rpcError);
        return;
      }
      // Scrub obvious secret material before surfacing server error bodies.
      throw new McpHttpStatusError(
        response.status,
        scrubSecrets(body),
        rpcError !== null,
      );
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
      if (opts?.nonFatalStream && "id" in message) {
        // Long-lived listen stream (§6a.3): drop/end is EXPECTED (proxies,
        // idle timeouts) and must not kill the transport. Whatever ends the
        // stream, settle THIS request with a synthetic error so the client's
        // re-open logic runs; every notification the stream carried has
        // already flowed through `onMessage`.
        void this.consumeSse(response, controller)
          .catch((err) => {
            log.info(`${this.config.id} listen stream error (non-fatal): %s`, err);
          })
          .finally(() => {
            this.messageHandler?.({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: RPC_LISTEN_STREAM_ENDED, message: "listen stream ended" },
            });
          });
        return;
      }
      // Fire-and-forget stream reader — messages arrive asynchronously
      // through the normal `onMessage` path, matching stdio semantics.
      void this.consumeSse(response, controller).catch((err) => {
        log.warn(`${this.config.id} SSE read error: %s`, err);
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
        log.warn(`${this.config.id} SSE JSON parse failed: %s`, payload.slice(0, 200));
    }
  }
}

// ─── Helpers ─────────────────────────────────────────

/** Case-insensitive presence check for an `authorization` header. */
function hasAuthorization(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
}

/**
 * Strip likely secret material from error bodies before surfacing them in logs or
 * UI, then bound the length — this variant is for a short UI/error surface, not a
 * full log line.
 *
 * Re-exported from `shared/dlp.ts` rather than implemented here: a caller wanting a
 * bounded error string should not have to import a transport module to get one, and
 * two copies of "scrub then slice" would drift on the slice. The name is kept
 * because every existing MCP call site uses it.
 */
export const scrubSecrets = scrubShortError;

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

/**
 * stdio spawn-command resolution for MCP servers — one caller
 * (`connectStdio` below), no other consumer.
 *
 * A stdio server config's `command` sometimes arrives as an inline `uvx
 * <package>` invocation (from marketplace manifests copy-pasted from upstream
 * MCP server docs). `uvx` is not guaranteed to be on PATH inside the packaged
 * app, so this rewrites it to LVIS's bundled `uv` binary via `uv tool run`,
 * which is equivalent but does not depend on an ambient install.
 */
export interface StdioSpawnCommand {
  command: string;
  args: string[];
}

export function resolveStdioSpawnCommand(command: string, args: string[] = []): StdioSpawnCommand {
  const uvxInlineArgs = parseUvxCommand(command);
  if (!uvxInlineArgs) {
    return { command, args };
  }
  return {
    command: resolveBundledUvBinaryPath(),
    args: ["tool", "run", ...uvxInlineArgs, ...args],
  };
}

function parseUvxCommand(command: string): string[] | null {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const executable = parts[0];
  if (executable !== "uvx" && executable !== "uvx.exe") return null;
  return parts.slice(1);
}

/**
 * Streamable HTTP request-metadata headers (final `2026-07-28` spec).
 *
 * The transport mirrors selected JSON-RPC body fields into HTTP headers so
 * intermediaries can route without parsing the body. A conformant server
 * REJECTS a POST whose required headers are missing or do not match the body
 * (`-32020` HeaderMismatch), so these are not optional decoration:
 *
 *  - `MCP-Protocol-Version` — MUST equal the body's
 *    `_meta["io.modelcontextprotocol/protocolVersion"]`. Derived FROM the body
 *    here so the two can never disagree. Legacy-era requests carry no `_meta`
 *    protocol version and therefore no header (the header postdates the legacy
 *    era we fall back to).
 *  - `Mcp-Method` — the JSON-RPC `method`, on every request.
 *  - `Mcp-Name` — `params.name` (`tools/call`, `prompts/get`) or `params.uri`
 *    (`resources/read`), Base64-sentinel-encoded when not header-safe.
 *  - `Mcp-Param-{Name}` — tool parameters the SERVER designated via the
 *    `x-mcp-header` schema extension. Clients on this transport MUST mirror
 *    them and MUST reject tool definitions whose annotations violate the
 *    constraints (excluding just that tool from `tools/list`).
 *
 * Header names here are lowercase: HTTP field names are case-insensitive and
 * the transport's header map is lowercase-normalized to prevent case-collision
 * duplicates.
 *
 * Names/values are pre-validated+encoded below; used only by this file's
 * Streamable-HTTP request path, no other consumer.
 */

/** RFC 9110 `token` / `1*tchar` — the only shape a header name may take. */
const TCHAR_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Methods whose `Mcp-Name` source field is defined by the spec. */
const NAME_SOURCE: Record<string, "name" | "uri"> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
};

const SENTINEL_PREFIX = "=?base64?";
const SENTINEL_SUFFIX = "?=";

/**
 * Encode one header value per the spec's Value Encoding rules: pass plain
 * ASCII through; Base64-sentinel everything that is not safely representable
 * (non-ASCII, control chars, leading/trailing whitespace) — and any plain
 * value that itself matches the sentinel pattern, to avoid ambiguity.
 */
export function encodeMcpHeaderValue(value: string): string {
  const headerSafe =
    /^[\x21-\x7e]([\x20\x21-\x7e\x09]*[\x21-\x7e])?$/.test(value) && !/[\r\n]/.test(value);
  const sentinelShaped = value.startsWith(SENTINEL_PREFIX) && value.endsWith(SENTINEL_SUFFIX);
  if (headerSafe && !sentinelShaped) return value;
  return `${SENTINEL_PREFIX}${Buffer.from(value, "utf8").toString("base64")}${SENTINEL_SUFFIX}`;
}

/**
 * Derive the standard request-metadata headers from one outbound JSON-RPC
 * message. Pure body → header projection; returns an empty object for messages
 * with no `method` (never sent by this client).
 */
export function deriveStandardHeaders(message: object): Record<string, string> {
  const headers: Record<string, string> = {};
  const method = (message as { method?: unknown }).method;
  if (typeof method !== "string" || method.length === 0) return headers;
  headers["mcp-method"] = method;

  const rawParams = (message as { params?: unknown }).params;
  const params =
    rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
      ? (rawParams as Record<string, unknown>)
      : undefined;

  const meta = params?._meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const version = (meta as Record<string, unknown>)[META_PROTOCOL_VERSION];
    if (typeof version === "string" && version.length > 0) {
      headers["mcp-protocol-version"] = version;
    }
  }

  const nameField = NAME_SOURCE[method];
  if (nameField !== undefined) {
    const raw = params?.[nameField];
    if (typeof raw === "string" && raw.length > 0) {
      headers["mcp-name"] = encodeMcpHeaderValue(raw);
    }
  }
  return headers;
}

interface SchemaNode {
  [key: string]: unknown;
}

/**
 * One validated `x-mcp-header` annotation: the designated header-name part and
 * the exact `properties`-chain path of the annotated parameter.
 */
export interface McpParamHeaderAnnotation {
  headerName: string;
  path: string[];
}

/** Keywords whose subtrees may not carry a reachable `x-mcp-header`. */
const NON_CHAIN_KEYWORDS = [
  "items",
  "prefixItems",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$defs",
  "definitions",
  "additionalProperties",
  "patternProperties",
] as const;

/**
 * Validate a tool `inputSchema`'s `x-mcp-header` annotations and collect the
 * valid ones. Returns the annotations on success, or a rejection reason —
 * per spec a Streamable-HTTP client MUST exclude a tool whose annotations
 * violate ANY constraint (empty/malformed name, duplicate, non-primitive or
 * `number` type, or an annotation not statically reachable via a chain of
 * `properties` keys).
 */
export function collectParamHeaderAnnotations(
  inputSchema: SchemaNode,
): { annotations: McpParamHeaderAnnotation[]; reason?: undefined } | { annotations?: undefined; reason: string } {
  const annotations: McpParamHeaderAnnotation[] = [];
  const seen = new Set<string>();

  const walkChain = (node: SchemaNode, path: string[]): string | null => {
    const annotation = node["x-mcp-header"];
    if (annotation !== undefined) {
      if (typeof annotation !== "string" || annotation.length === 0 || !TCHAR_RE.test(annotation)) {
        return `invalid x-mcp-header name at ${path.join(".") || "(root)"}`;
      }
      if (path.length === 0) {
        return "x-mcp-header on the schema root is not a parameter annotation";
      }
      const type = node.type;
      if (type !== "string" && type !== "integer" && type !== "boolean") {
        return `x-mcp-header '${annotation}' on non-primitive/number type '${String(type)}'`;
      }
      const key = annotation.toLowerCase();
      if (seen.has(key)) {
        return `duplicate x-mcp-header name '${annotation}' (case-insensitive)`;
      }
      seen.add(key);
      annotations.push({ headerName: annotation, path: [...path] });
    }
    const properties = node.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [prop, child] of Object.entries(properties as Record<string, unknown>)) {
        if (child && typeof child === "object" && !Array.isArray(child)) {
          const err = walkChain(child as SchemaNode, [...path, prop]);
          if (err) return err;
        }
      }
    }
    return null;
  };

  // Any `x-mcp-header` OUTSIDE a properties-only chain (inside array,
  // composition, conditional, or $ref-style subtrees) invalidates the tool.
  const scanOffChain = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(scanOffChain);
    const node = value as SchemaNode;
    for (const keyword of NON_CHAIN_KEYWORDS) {
      if (keyword in node && hasAnnotationAnywhere(node[keyword])) return true;
    }
    const properties = node.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      return Object.values(properties as Record<string, unknown>).some(scanOffChain);
    }
    return false;
  };
  const hasAnnotationAnywhere = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(hasAnnotationAnywhere);
    const node = value as SchemaNode;
    if ("x-mcp-header" in node) return true;
    return Object.values(node).some(hasAnnotationAnywhere);
  };

  if (scanOffChain(inputSchema)) {
    return { reason: "x-mcp-header annotation outside a properties-only chain" };
  }
  const err = walkChain(inputSchema, []);
  if (err) return { reason: err };
  return { annotations };
}

/** JavaScript safe-integer bound the spec imposes on mirrored integer values. */
const MAX_SAFE = 9_007_199_254_740_991;

/**
 * Extract `Mcp-Param-{Name}` headers from one call's arguments, per the
 * previously validated annotations. Missing and `null` values omit the header
 * (the server MUST NOT expect it then). Values are type-converted and
 * sentinel-encoded.
 */
export function extractParamHeaders(
  annotations: readonly McpParamHeaderAnnotation[],
  args: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { headerName, path } of annotations) {
    let cursor: unknown = args;
    for (const key of path) {
      if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (cursor === undefined || cursor === null) continue;
    let text: string;
    if (typeof cursor === "string") {
      text = cursor;
    } else if (typeof cursor === "boolean") {
      text = cursor ? "true" : "false";
    } else if (typeof cursor === "number" && Number.isInteger(cursor) && Math.abs(cursor) <= MAX_SAFE) {
      text = String(cursor);
    } else {
      // Not a mirrorable value (float, object, unsafe integer) — omit rather
      // than guess; the schema said integer/string/boolean, so a mismatched
      // runtime value is the caller's schema violation, not a header concern.
      continue;
    }
    headers[`mcp-param-${headerName.toLowerCase()}`] = encodeMcpHeaderValue(text);
  }
  return headers;
}
