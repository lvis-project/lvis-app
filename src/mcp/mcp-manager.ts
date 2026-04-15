/**
 * MCP Manager — §9.5 Multi-Server Lifecycle
 *
 * 여러 MCP 서버 연결을 관리:
 * - loadFromConfig(): MCP 서버 설정 로드
 * - connectAll(): 승인된 서버 일괄 연결
 * - disconnectAll(): 전체 종료
 * - killSwitch(serverId): 즉시 연결 해제 + 도구 제거 (§10.1)
 *
 * 설정 위치: ~/.lvis/mcp-servers.json
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { McpServerConfig, McpServerState } from "./types.js";
import { McpGovernance } from "./mcp-governance.js";
import { McpClient } from "./mcp-client.js";
import type { ToolRegistry } from "../tools/registry.js";

const DEFAULT_CONFIG_PATH = join(homedir(), ".lvis", "mcp-servers.json");

export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly configPath: string;

  constructor(
    private readonly governance: McpGovernance,
    private readonly toolRegistry: ToolRegistry,
    configPath?: string,
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

    const client = new McpClient(config, this.governance, this.toolRegistry);
    this.clients.set(config.id, client);
    await client.connect();
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
