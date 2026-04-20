/**
 * MCP Manager — §9.5 Multi-Server Lifecycle
 *
 * 여러 MCP 서버 연결을 관리:
 * - loadFromConfig(): MCP 서버 설정 로드
 * - connectAll(): 승인된 서버 일괄 연결
 * - disconnectAll(): 전체 종료
 * - killSwitch(serverId): 즉시 연결 해제 + 도구 제거 (§10.1)
 * - getConfigs(): 저장된 서버 설정 목록 반환
 * - addConfig(config): 설정 파일에 서버 추가 + 연결 시도
 * - removeConfig(id): 설정 파일에서 서버 제거 + 연결 해제
 *
 * 설정 위치: ~/.lvis/mcp-servers.json
 */
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { McpServerConfig, McpServerState } from "./types.js";
import { McpGovernance } from "./mcp-governance.js";
import { McpClient } from "./mcp-client.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionManager } from "../permissions/permission-manager.js";
import type { AuditLogger } from "../audit/audit-logger.js";

const DEFAULT_CONFIG_PATH = join(homedir(), ".lvis", "mcp-servers.json");

export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly configPath: string;
  /** Serialises all config read-modify-write ops to prevent TOCTOU races */
  private configOpLock: Promise<void> = Promise.resolve();

  private withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
    const op = this.configOpLock.then(fn);
    this.configOpLock = op.then(
      () => undefined,
      () => undefined,
    );
    return op;
  }

  constructor(
    private readonly governance: McpGovernance,
    private readonly toolRegistry: ToolRegistry,
    configPath?: string,
    private readonly permissionManager?: PermissionManager,
    private readonly auditLogger?: AuditLogger,
  ) {
    this.configPath = configPath ?? DEFAULT_CONFIG_PATH;
  }

  // ─── Config Loading ─────────────────────────────────

  /** MCP 서버 설정 파일에서 설정 로드 */
  async loadFromConfig(): Promise<McpServerConfig[]> {
    if (!existsSync(this.configPath)) {
      console.log("[mcp-manager] MCP 서버 설정 파일 없음:", this.configPath);
      return [];
    }

    try {
      const raw = await readFile(this.configPath, "utf-8");
      const parsed = JSON.parse(raw) as { servers?: McpServerConfig[] };
      const servers = parsed.servers ?? [];
      console.log(`[mcp-manager] ${servers.length}개 MCP 서버 설정 로드`);
      return servers;
    } catch (err) {
      console.error("[mcp-manager] 설정 파일 파싱 실패:", err);
      return [];
    }
  }

  // ─── Connection Management ──────────────────────────

  /** 설정된 모든 승인 서버에 연결 */
  async connectAll(): Promise<{ connected: string[]; failed: Array<{ id: string; error: string }> }> {
    const configs = await this.loadFromConfig();
    const connected: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const config of configs) {
      try {
        await this.connectServer(config);
        connected.push(config.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ id: config.id, error: message });
        console.warn(`[mcp-manager] 서버 연결 실패 (${config.id}):`, message);
      }
    }

    console.log(
      `[mcp-manager] 연결 결과: ${connected.length}개 성공, ${failed.length}개 실패`,
    );
    return { connected, failed };
  }

  /** 단일 서버 연결 */
  async connectServer(config: McpServerConfig): Promise<void> {
    // 이미 연결된 서버는 건너뛰기
    const existing = this.clients.get(config.id);
    if (existing && existing.getState().status === "connected") {
      console.log(`[mcp-manager] ${config.id}: 이미 연결됨 — 건너뛰기`);
      return;
    }

    // 기존 에러/연결 해제 상태면 정리 후 재연결
    if (existing) {
      await existing.disconnect();
      this.clients.delete(config.id);
    }

    const client = new McpClient(
      config,
      this.governance,
      this.toolRegistry,
      this.permissionManager,
    );
    this.clients.set(config.id, client);
    try {
      await client.connect();
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: "mcp-manager",
        type: "mcp_connect",
        input: JSON.stringify({ serverId: config.id, transport: config.transport }),
        output: JSON.stringify({
          status: client.getState().status,
          registeredTools: client.getState().registeredTools,
        }),
      });
    } catch (err) {
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: "mcp-manager",
        type: "mcp_connect",
        input: JSON.stringify({ serverId: config.id, transport: config.transport }),
        output: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** 모든 서버 연결 해제 */
  async disconnectAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [id, client] of this.clients) {
      promises.push(
        client.disconnect().catch((err) => {
          console.error(`[mcp-manager] ${id} 종료 실패:`, err);
        }),
      );
    }
    await Promise.all(promises);
    this.clients.clear();
    console.log("[mcp-manager] 모든 MCP 서버 연결 해제 완료");
  }

  // ─── Kill Switch (§10.1) ────────────────────────────

  /**
   * 즉시 연결 해제 + 도구 제거.
   * 진행 중인 요청은 에러로 reject됨.
   */
  async killSwitch(serverId: string): Promise<void> {
    console.warn(`[mcp-manager] Kill Switch 실행: ${serverId}`);

    const client = this.clients.get(serverId);
    if (client) {
      await client.disconnect();
      this.clients.delete(serverId);
    }

    // 안전장치: ToolRegistry에서도 직접 제거 (중복 호출이지만 확실히 정리)
    this.toolRegistry.unregisterByMcp(serverId);
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: "mcp-manager",
      type: "kill_switch",
      input: JSON.stringify({ serverId }),
    });

    console.warn(`[mcp-manager] Kill Switch 완료: ${serverId} — 모든 도구 해제됨`);
  }

  // ─── Query ──────────────────────────────────────────

  /** 전체 서버 상태 조회 */
  listServers(): McpServerState[] {
    return Array.from(this.clients.values()).map((c) => c.getState());
  }

  /** 특정 서버 상태 조회 */
  getServerState(serverId: string): McpServerState | undefined {
    return this.clients.get(serverId)?.getState();
  }

  // ─── Config Mutation ────────────────────────────────

  /** 설정 파일의 현재 서버 목록 반환 (apiKey / headers / env / args 제거된 안전 뷰) */
  async getConfigs(): Promise<McpServerConfig[]> {
    const configs = await this.loadFromConfig();
    // Strip secrets before returning to renderer — none of these must cross the IPC boundary:
    // - apiKey: shared secret on all transport types
    // - headers: may contain Authorization: Bearer tokens (http/sse/websocket)
    // - env: may contain SECRET_TOKEN=... (stdio)
    // - args: may contain --api-key=secret or ["--token", "value"] (stdio)
    return configs.map((c) => {
      const safe = { ...c } as McpServerConfig & {
        apiKey?: string;
        headers?: Record<string, string>;
        env?: Record<string, string>;
        args?: string[];
      };
      delete safe.apiKey;
      delete safe.headers;
      delete safe.env;
      delete safe.args;
      return safe as McpServerConfig;
    });
  }

  /**
   * 설정 파일에 서버 추가 + 연결 시도.
   * 이미 동일 id가 있으면 에러. write-lock으로 동시 추가 시 TOCTOU 방지.
   */
  async addConfig(config: McpServerConfig): Promise<{ connected: boolean; warning?: string }> {
    // Runtime payload validation (IPC cast is type-only, disappears at runtime)
    if (!config?.id || typeof config.id !== "string") {
      throw new Error("[mcp-manager] 유효하지 않은 서버 id");
    }
    const validTransports = ["stdio", "http"] as const;
    if (!validTransports.includes(config.transport as (typeof validTransports)[number])) {
      throw new Error(`[mcp-manager] 유효하지 않은 transport: ${String(config.transport)}`);
    }
    if (config.transport === "stdio" && !(config as { command?: string }).command?.trim()) {
      throw new Error("[mcp-manager] stdio 서버는 command 필드가 필요합니다.");
    }
    if (config.transport === "http" && !(config as { url?: string }).url?.trim()) {
      throw new Error("[mcp-manager] http 서버는 url 필드가 필요합니다.");
    }

    // Normalize id: trim whitespace, reject empty
    const normalizedId = config.id.trim();
    if (!normalizedId) {
      throw new Error("[mcp-manager] 서버 id가 비어있거나 공백만 포함할 수 없습니다.");
    }
    const normalizedConfig = { ...config, id: normalizedId } as McpServerConfig;

    return this.withConfigLock(async () => {
      const validation = this.governance.validateServer(normalizedConfig);
      if (!validation.valid) {
        throw new Error(
          `[mcp-manager] 거버넌스 검증 실패 (Layer ${validation.layer}): ${validation.reason}`,
        );
      }
      const existing = await this.loadFromConfig();
      if (existing.some((s) => s.id === normalizedId)) {
        throw new Error(`[mcp-manager] 서버 id '${normalizedId}'가 이미 존재합니다.`);
      }
      const updated = [...existing, normalizedConfig];
      await this.saveConfigs(updated);
      // 연결 시도 (실패해도 config 저장은 유지)
      try {
        await this.connectServer(normalizedConfig);
        return { connected: true };
      } catch (err) {
        const warning = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp-manager] 서버 추가 후 연결 실패 (${normalizedId}):`, err);
        return { connected: false, warning };
      }
    });
  }

  /**
   * 설정 파일에서 서버 제거 + 연결 해제.
   * 존재하지 않아도 에러 없이 처리. write-lock으로 동시 제거 시 TOCTOU 방지.
   */
  async removeConfig(serverId: string): Promise<void> {
    return this.withConfigLock(async () => {
      const existing = await this.loadFromConfig();
      const updated = existing.filter((s) => s.id !== serverId);
      await this.saveConfigs(updated);
      // 연결 해제 (이미 끊겨있으면 무시)
      const client = this.clients.get(serverId);
      if (client) {
        await client.disconnect().catch((e) =>
          console.warn(`[mcp-manager] removeConfig disconnect 실패 (${serverId}):`, e),
        );
        this.clients.delete(serverId);
      }
      this.toolRegistry.unregisterByMcp(serverId);
    });
  }

  /** configPath 에 서버 목록을 원자적으로 저장 (temp file → rename) */
  private async saveConfigs(configs: McpServerConfig[]): Promise<void> {
    const dir = dirname(this.configPath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${this.configPath}.tmp`;
    const bakPath = `${this.configPath}.bak`;
    try {
      await writeFile(tmpPath, JSON.stringify({ servers: configs }, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      try {
        await rename(tmpPath, this.configPath);
      } catch (renameErr) {
        // Windows: rename() throws EEXIST when destination already exists (unlike POSIX which overwrites).
        // Use backup-swap to avoid data loss: preserve live config as .bak before replacing.
        if ((renameErr as NodeJS.ErrnoException).code === "EEXIST") {
          await rename(this.configPath, bakPath);   // preserve live config
          try {
            await rename(tmpPath, this.configPath); // place new config
            await unlink(bakPath).catch(() => {});  // best-effort cleanup of backup
          } catch (retryErr) {
            // Restore backup — original config is still safe
            await rename(bakPath, this.configPath).catch(() => {});
            throw retryErr;
          }
        } else {
          throw renameErr;
        }
      }
    } catch (e) {
      // Best-effort cleanup of stale .tmp on any failure
      try { await unlink(tmpPath); } catch { /* ignore */ }
      throw e;
    }
  }

  /** 특정 서버의 도구 호출 — ToolExecutor에서 사용 */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`[mcp-manager] 서버 '${serverId}'가 존재하지 않습니다.`);
    }
    return client.callTool(toolName, args);
  }

  /** 연결된 서버 수 */
  get connectedCount(): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.getState().status === "connected") count++;
    }
    return count;
  }
}
