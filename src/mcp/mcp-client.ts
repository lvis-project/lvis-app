/**
 * MCP Client — §9.5 stdio Transport
 *
 * JSON-RPC 2.0 over stdin/stdout를 통한 MCP 서버 연결.
 * 프로토콜 핸드셰이크:
 *   1. spawn subprocess (command + args)
 *   2. → initialize (client capabilities)
 *   3. ← ServerCapabilities response
 *   4. → notifications/initialized
 *   5. → tools/list
 *   6. ← tool schemas
 *   7. → tools/call (runtime)
 *
 * 안전 원칙:
 * - MCP 서버 crash가 호스트 앱을 crash하지 않음 (프로세스 격리)
 * - 모든 연결/호출은 McpGovernance를 통해 사전 검증
 * - 도구는 mcp_{prefix}_{name} 네임스페이스로 ToolRegistry에 등록
 */
import { spawn, type ChildProcess } from "node:child_process";
import type {
  McpServerConfig,
  McpServerState,
  McpToolSchema,
} from "./types.js";
import type { McpGovernance } from "./mcp-governance.js";
import type { ToolRegistry } from "../tools/registry.js";
import { mcpToolToTool } from "./mcp-tool-adapter.js";

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

export class McpClient {
  private process: ChildProcess | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
  >();
  private inputBuffer = "";
  private healthTimer: NodeJS.Timeout | null = null;

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

    if (this.config.transport !== "stdio") {
      throw new Error(`[mcp-client] 현재 stdio transport만 지원합니다. 설정: ${this.config.transport}`);
    }
    if (!this.config.command) {
      throw new Error(`[mcp-client] stdio transport에 command가 필요합니다.`);
    }

    this.state.status = "connecting";

    try {
      // subprocess 시작
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
      this.sendNotification("notifications/initialized", {});

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
      // 프로세스 정리
      this.killProcess();
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

    // 프로세스 종료
    this.killProcess();

    this.state.status = "disconnected";
    this.state.lastError = undefined;
    console.log(`[mcp-client] ${this.config.id} 연결 해제 완료`);
  }

  // ─── Tool Execution ─────────────────────────────────

  /** MCP 도구 호출 — ToolExecutor에서 사용 */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (this.state.status !== "connected" || !this.process) {
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
      if (!this.process?.stdin?.writable) {
        reject(new Error(`[mcp-client] stdin이 쓰기 불가 상태입니다.`));
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
      this.writeMessage(request);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) return;
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.writeMessage(notification);
  }

  private writeMessage(message: JsonRpcRequest | JsonRpcNotification): void {
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
    try {
      this.process?.stdin?.write(header + json);
    } catch {
      // stdin write 실패 — 프로세스가 종료된 경우
    }
  }

  // ─── Message Parsing ────────────────────────────────

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
        this.handleResponse(parsed);
      } catch {
        console.warn(`[mcp-client] ${this.config.id} JSON 파싱 실패:`, messageStr.slice(0, 200));
      }
    }
  }

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

  // ─── Process Management ─────────────────────────────

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
      this.handleProcessExit();
    });

    this.process.on("error", (err) => {
      console.error(`[mcp-client] ${this.config.id} 프로세스 오류:`, err.message);
      this.state.status = "error";
      this.state.lastError = err.message;
      this.rejectAllPending(`프로세스 오류: ${err.message}`);
    });
  }

  private handleProcessExit(): void {
    if (this.state.status === "disconnected") return; // 정상 종료

    this.state.status = "error";
    this.state.lastError = "프로세스가 예기치 않게 종료되었습니다.";
    this.rejectAllPending("프로세스 종료");
    this.toolRegistry.unregisterByMcp(this.config.id);
    this.state.registeredTools = [];
    this.stopHealthCheck();
  }

  private killProcess(): void {
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

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
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
    if (!this.process || this.process.exitCode !== null) {
      console.warn(`[mcp-client] ${this.config.id} health check 실패: 프로세스 종료됨`);
      this.handleProcessExit();
      return;
    }

    // ping 요청 (응답 없어도 프로세스 생존 확인이 목적)
    this.sendRequest("ping", {}, 5000).catch(() => {
      // ping 미지원 서버도 있으므로 무시 (프로세스 생존은 exit 이벤트로 감지)
    });
  }
}
