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
} from "./types.js";
import type { McpGovernance } from "./mcp-governance.js";
import type { ToolRegistry } from "../tools/registry.js";
import { mcpToolToTool } from "./mcp-tool-adapter.js";
import {
  NetworkGuardError,
  ensurePublicHttpUrl,
  validateHttpUrl,
} from "../core/network-guard.js";

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
}

// ─── Constants ────────────────────────────────────────

const MCP_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;

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
}

export class McpClient {
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
  >();
  private healthTimer: NodeJS.Timeout | null = null;
  private transport: McpTransport | null = null;

  readonly state: McpServerState;

  constructor(
    private readonly config: McpServerConfig,
    private readonly governance: McpGovernance,
    private readonly toolRegistry: ToolRegistry,
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

      await this.transport.open();

      // 핸드셰이크: initialize
      const initResult = await this.sendRequest<McpInitializeResult>("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "lvis-app", version: "0.1.0" },
      });

      console.log(
        `[mcp-client] ${this.config.id} 초기화 완료:`,
        `protocol=${initResult.protocolVersion}`,
        `server=${initResult.serverInfo.name}@${initResult.serverInfo.version}`,
      );

      // 핸드셰이크: initialized notification
      await this.sendNotification("notifications/initialized", {});

      // 도구 목록 요청
      const toolsResult = await this.sendRequest<McpToolsListResult>("tools/list", {});
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

      console.log(
        `[mcp-client] ${this.config.id} 연결 완료: ${this.state.registeredTools.length}개 도구 등록`,
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

    // ToolRegistry에서 도구 제거
    this.toolRegistry.unregisterByMcp(this.config.id);
    this.state.registeredTools = [];

    // transport 종료
    await this.closeTransport();

    this.state.status = "disconnected";
    this.state.lastError = undefined;
    console.log(`[mcp-client] ${this.config.id} 연결 해제 완료`);
  }

  // ─── Tool Execution ─────────────────────────────────

  /** MCP 도구 호출 — ToolExecutor에서 사용 */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
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

      return result.content
        .map((c) => c.text ?? JSON.stringify(c))
        .join("\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[mcp-client] 도구 호출 실패 (${this.config.id}/${name}): ${message}`);
    }
  }

  /** 서버 상태 조회 */
  getState(): McpServerState {
    return { ...this.state };
  }

  // ─── JSON-RPC Transport ─────────────────────────────

  private sendRequest<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const transport = this.transport;
      if (!transport || !transport.isAlive()) {
        reject(new Error(`[mcp-client] transport가 활성 상태가 아닙니다.`));
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
      });

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
      // 서버 발 notification — 현재는 무시
      return;
    }

    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;

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
  }

  // ─── Tool Registration ──────────────────────────────

  private registerTools(tools: McpToolSchema[]): void {
    const serverId = this.config.id;

    for (const tool of tools) {
      const namespacedName = this.governance.applyToolNamespace(serverId, tool.name);
      this.toolRegistry.register(
        mcpToolToTool(serverId, namespacedName, tool, (toolName, args) =>
          this.callTool(toolName, args),
        ),
      );
      this.state.registeredTools.push(namespacedName);
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
      console.warn(`[mcp-client] ${this.config.id} health check 실패: transport 비활성`);
      this.handleTransportClose("health check: transport 비활성");
      return;
    }

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
  private inputBuffer = "";
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

    this.process = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        // C2 fix: 최소 환경변수만 허용 — API 키 유출 방지 (Least Privilege)
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        NODE_ENV: process.env.NODE_ENV,
        ...this.config.env, // 관리자 승인 환경변수만
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
    if (!this.process) return;
    try {
      this.process.stdin?.end();
      this.process.kill("SIGTERM");
      // SIGTERM 후 3초 내 종료 안 되면 SIGKILL
      const forceKillTimer = setTimeout(() => {
        try {
          this.process?.kill("SIGKILL");
        } catch {
          // 이미 종료됨
        }
      }, 3000);
      this.process.once("exit", () => clearTimeout(forceKillTimer));
    } catch {
      // 이미 종료됨
    }
    this.process = null;
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
        console.error(`[mcp-client] ${this.config.id} stdout 처리 오류:`, err);
      }
    });

    this.process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        console.warn(`[mcp-client] ${this.config.id} stderr:`, text);
      }
    });

    this.process.on("exit", (code, signal) => {
      console.warn(`[mcp-client] ${this.config.id} 프로세스 종료: code=${code}, signal=${signal}`);
      if (!this.closedExternally) {
        this.closeHandler?.("프로세스가 예기치 않게 종료되었습니다.");
      }
    });

    this.process.on("error", (err) => {
      console.error(`[mcp-client] ${this.config.id} 프로세스 오류:`, err.message);
      this.closeHandler?.(`프로세스 오류: ${err.message}`);
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.inputBuffer += chunk.toString("utf-8");
    this.parseMessages();
  }

  private parseMessages(): void {
    // Content-Length 기반 메시지 파싱 (LSP/MCP 표준)
    while (true) {
      const headerEnd = this.inputBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const headerBlock = this.inputBuffer.slice(0, headerEnd);
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

      const messageStr = this.inputBuffer.slice(messageStart, messageEnd);
      this.inputBuffer = this.inputBuffer.slice(messageEnd);

      try {
        const parsed = JSON.parse(messageStr) as JsonRpcResponse;
        this.messageHandler?.(parsed);
      } catch {
        console.warn(`[mcp-client] ${this.config.id} JSON 파싱 실패:`, messageStr.slice(0, 200));
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
 * SSRF control: URL is validated with `ensurePublicHttpUrl` at `open` time
 * unless `allowPrivateNetworks: true`. Each request still goes through
 * `validateHttpUrl` syntactic check; DNS rebinding to a private IP during
 * the session is possible but is out of scope for this transport (the
 * redirect-aware hop-by-hop validator is for followRedirect:true flows,
 * which this transport does not use).
 */
class HttpTransport implements McpTransport {
  readonly kind = "http" as const;
  private alive = false;
  private messageHandler: ((msg: JsonRpcResponse) => void) | null = null;
  private closeHandler: ((reason: string) => void) | null = null;
  /** Tracks in-flight SSE AbortControllers so `close` can cancel them. */
  private readonly inflight = new Set<AbortController>();

  constructor(private readonly config: McpHttpServerConfig) {}

  onMessage(handler: (msg: JsonRpcResponse) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
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

    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Streamable HTTP servers may return either JSON or SSE.
      accept: "application/json, text/event-stream",
      ...this.config.headers,
    };
    if (this.config.apiKey && !headers["authorization"] && !headers["Authorization"]) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (err) {
      this.inflight.delete(controller);
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`http transport fetch 실패: ${reason}`);
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
      throw new Error(`http transport HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
      // Fire-and-forget stream reader — messages arrive asynchronously
      // through the normal `onMessage` path, matching stdio semantics.
      void this.consumeSse(response, controller).catch((err) => {
        console.warn(`[mcp-client] ${this.config.id} SSE 읽기 오류:`, err);
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
      // Flush any trailing event without a closing blank line.
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
      console.warn(`[mcp-client] ${this.config.id} SSE JSON 파싱 실패:`, payload.slice(0, 200));
    }
  }
}

// ─── Helpers ─────────────────────────────────────────

function indexOfAny(haystack: string, needles: string[]): number {
  let earliest = -1;
  for (const needle of needles) {
    const idx = haystack.indexOf(needle);
    if (idx === -1) continue;
    if (earliest === -1 || idx < earliest) earliest = idx;
  }
  return earliest;
}
