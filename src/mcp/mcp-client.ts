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
const log = createLogger("mcp-client");

// ─── JSON-RPC 2.0 Types ──────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ─── MCP Protocol Types ──────────────────────────────

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

interface McpToolsListResult {
  tools: McpToolSchema[];
}

interface McpToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  /** MCP Apps spec §3.2 — optional UI extension metadata. */
  _meta?: {
    ui?: {
      resourceUri?: string;
      slot?: string;
      height?: number;
      title?: string;
    };
    [key: string]: unknown;
  };
}

// ─── Constants ────────────────────────────────────────

const MCP_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000; // initialize / tools/list 핸드셰이크용
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const MAX_BUFFERED_RESPONSES = 128;

// ─── Transport Strategy ──────────────────────────────

/**
 * Minimal transport contract shared by stdio + HTTP.
 * - `send` writes a JSON-RPC request/notification.
 * - Incoming messages are delivered via `onMessage`.
 * - `close` must resolve all pending requests as rejected.
 * - `isAlive` lets the health check poll without caring about the transport.
 */
interface McpTransport {
  readonly kind: "stdio" | "http";
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
  timeoutMs: number;
  method: string;
}

export class McpClient {
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  /** 응답이 pending 등록 전에 도착한 경우를 위한 버퍼 (race condition 대응) */
  private readonly bufferedResponses = new Map<number, JsonRpcResponse>();
  private healthTimer: NodeJS.Timeout | null = null;
  private transport: McpTransport | null = null;

  readonly state: McpServerState;

  constructor(
    private readonly config: McpServerConfig,
    private readonly governance: McpGovernance,
    private readonly toolRegistry: ToolRegistry,
    private readonly permissionManager?: PermissionManager,
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
      throw new Error(`[mcp-client] 거버넌스 검증 실패 (Layer ${validation.layer}): ${validation.reason}`);
    }

    if (this.config.transport !== "stdio" && this.config.transport !== "http") {
      throw new Error(
        `[mcp-client] 현재 지원되는 transport: stdio, http. 설정: ${this.config.transport}`,
      );
    }

    this.state.status = "connecting";

    try {
      this.transport = this.config.transport === "stdio"
        ? new StdioTransport(this.config as McpStdioServerConfig)
        : new HttpTransport(this.config as McpHttpServerConfig);

      this.transport.onMessage((msg) => this.handleResponse(msg));
      this.transport.onClose((reason) => this.handleTransportClose(reason));
      // Streaming transports call this on every incoming chunk — reset
      // per-request timers so long streaming responses don't hit timeout.
      this.transport.onActivity?.(() => this.resetPendingTimers());

      await this.transport.open();

      // 핸드셰이크: initialize
      const initResult = await this.sendRequest<McpInitializeResult>("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "lvis-app", version: "0.1.0" },
      }, HANDSHAKE_TIMEOUT_MS);

      log.info(
        { protocol: initResult.protocolVersion, server: `${initResult.serverInfo.name}@${initResult.serverInfo.version}` },
        `${this.config.id} 초기화 완료`,
      );

      // 핸드셰이크: initialized notification
      await this.sendNotification("notifications/initialized", {});

      // 도구 목록 요청
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
          `[mcp-client] 도구 등록 검증 실패 (Layer ${toolValidation.layer}): ${toolValidation.reason}`,
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
    this.rejectAllPending("서버 연결 해제");
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
      throw new Error(`[mcp-client] 서버 '${this.config.id}'가 연결되지 않았습니다.`);
    }

    const approval = this.governance.getApproval(this.config.id);
    const timeoutMs = approval?.connectionTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    try {
      const result = await this.sendRequest<McpToolCallResult>(
        "tools/call",
        { name, arguments: args },
        timeoutMs,
      );

      // 결과를 문자열로 변환
      if (result.isError) {
        const errorText = result.content
          .map((c) => c.text ?? JSON.stringify(c))
          .join("\n");
        throw new Error(errorText);
      }

      const text = result.content
        .map((c) => c.text ?? JSON.stringify(c))
        .join("\n");

      // MCP Apps spec §3.2 — detect UI extension in _meta.ui
      const uiMeta = result._meta?.ui;
      let uiPayload: McpUiPayload | undefined;
      if (uiMeta?.resourceUri) {
        uiPayload = {
          serverId: this.config.id,
          resourceUri: uiMeta.resourceUri,
          slot: (uiMeta.slot as McpUiPayload["slot"]) ?? "chat",
          height: uiMeta.height,
          title: uiMeta.title,
        };
      }

      return { text, uiPayload };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[mcp-client] 도구 호출 실패 (${this.config.id}/${name}): ${message}`);
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
      throw new Error(`[mcp-client] 서버 '${this.config.id}'가 연결되지 않았습니다.`);
    }

    interface McpResourceReadResult {
      contents: Array<{ type?: string; text?: string; blob?: string; uri?: string; mimeType?: string }>;
    }

    const result = await this.sendRequest<McpResourceReadResult>("resources/read", { uri });
    const textPart = result.contents.find((c) => c.text !== undefined);
    if (!textPart?.text) {
      throw new Error(`[mcp-client] resources/read '${uri}': 텍스트 콘텐츠 없음`);
    }
    return textPart.text;
  }

  // ─── JSON-RPC Transport ─────────────────────────────

  private sendRequest<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const transport = this.transport;
      if (!transport || !transport.isAlive()) {
        reject(new Error(`[mcp-client] transport가 활성 상태가 아닙니다.`));
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
            `[mcp-client] 동시 요청 제한 초과 (${maxConcurrentRequests}): ${method}`,
          ),
        );
        return;
      }

      const id = this.nextRequestId++;
      const timeout = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`[mcp-client] 요청 타임아웃 (${timeout}ms): ${method}`));
      }, timeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        timeoutMs: timeout,
        method,
      });

      // Race condition 대응: 이미 버퍼에 응답이 도착해 있으면 즉시 처리
      const buffered = this.bufferedResponses.get(id);
      if (buffered) {
        this.bufferedResponses.delete(id);
        this.handleResponse(buffered);
        return;
      }

      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
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
        new Error(`JSON-RPC 오류 [${response.error.code}]: ${response.error.message}`),
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
   * flowing. Each timer gets a fresh `timeoutMs` window from "now".
   */
  private resetPendingTimers(): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      const method = pending.method;
      const timeoutMs = pending.timeoutMs;
      const newTimer = setTimeout(() => {
        this.pendingRequests.delete(id);
        pending.reject(
          new Error(`[mcp-client] 요청 타임아웃 (${timeoutMs}ms): ${method}`),
        );
      }, timeoutMs);
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
      this.handleTransportClose("health check: transport 비활성");
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

  constructor(private readonly config: McpStdioServerConfig) {}

  onMessage(handler: (msg: JsonRpcResponse) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  async open(): Promise<void> {
    if (!this.config.command) {
      throw new Error(`[mcp-client] stdio transport에 command가 필요합니다.`);
    }
    const spawnCommand = resolveStdioSpawnCommand(this.config.command, this.config.args ?? []);

    // §691 PR-A4 D9: MCP stdio spawn path. The "mcp" registry slot is
    // pre-populated in boot.ts with the active OS runner so capability
    // reporting (getSandboxRunner("mcp")) reflects the OS isolation level.
    // Full sandbox adoption for MCP (wrapping this spawn via SandboxRunner.spawn())
    // requires SandboxedProcess to expose a writable stdin channel for
    // JSON-RPC Content-Length framing — tracked as a follow-up in #691.
    // The LVIS_SANDBOX_ENABLED gate below logs runner availability so boot
    // telemetry captures the sandbox status without blocking MCP startup.
    if (process.env.LVIS_SANDBOX_ENABLED === "1") {
      const { getSandboxRunner } = await import("../permissions/sandbox-runner.js");
      const runner = getSandboxRunner("mcp") ?? getSandboxRunner(process.platform);
      if (runner) {
        // Runner available — full adoption pending stdin stream support.
        // Capability is already reflected in detectSandboxCapability() SOT.
        // eslint-disable-next-line no-console
        console.debug("[mcp-client] LVIS_SANDBOX_ENABLED: MCP runner available (full adoption pending stdin support)");
      }
    }
    this.process = spawn(spawnCommand.command, spawnCommand.args, {
      stdio: ["pipe", "pipe", "pipe"],
      // Windows: 콘솔 창 생성 방지 (창이 뜨면 stdout 파이프 동작이 달라짐)
      windowsHide: true,
      env: {
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
      },
    });

    this.setupProcessHandlers();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.process?.stdin?.writable) {
      throw new Error(`[mcp-client] stdin이 쓰기 불가 상태입니다.`);
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
        // MEDIUM-4: scrub secrets before logging stderr output from MCP child processes
        log.warn(`${this.config.id} stderr: %s`, scrubSecrets(text));
      }
    });

    this.process.on("exit", (code, signal) => {
      log.warn(`${this.config.id} 프로세스 종료: code=${code}, signal=${signal}`);
      if (!this.closedExternally) {
        this.closeHandler?.("프로세스가 예기치 않게 종료되었습니다.");
      }
    });

    this.process.on("error", (err) => {
      log.error(`${this.config.id} 프로세스 오류: %s`, err.message);
      this.closeHandler?.(`프로세스 오류: ${err.message}`);
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
    // HIGH-1: normalize all header names to lowercase to prevent case-collision
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
      throw new Error(`http transport fetch 실패: ${reason}`);
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
      throw new Error(`http transport JSON 파싱 실패: ${(err as Error).message}`);
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
