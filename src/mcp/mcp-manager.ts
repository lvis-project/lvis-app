/**
 * MCP Manager — §9.5 Multi-Server Lifecycle
 *
 * 여러 MCP 서버 연결을 관리:
 * - loadFromConfig(): MCP 서버 설정 로드
 * - connectAll(): 승인된 서버 일괄 연결
 * - disconnectAll(): 전체 종료
 * - killSwitch(serverId): 즉시 연결 해제 + 도구 제거 (§10.1)
 * - getConfigs(): 저장된 서버 설정 목록 반환 (renderer-safe DTO)
 * - addConfig(config): 설정 파일에 서버 추가 + 연결 시도
 * - removeConfig(id): 설정 파일에서 서버 제거 + 연결 해제
 *
 * 설정 위치: ~/.lvis/mcp/servers.json. 같은 ~/.lvis/mcp/ 아래에
 * marketplace install 도 들어간다 (~/.lvis/mcp/<slug>/).
 */
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { McpServerConfig, McpServerConfigDto, McpServerState, McpUiPayload } from "./types.js";
import { McpGovernance } from "./mcp-governance.js";
import { McpClient } from "./mcp-client.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionManager } from "../permissions/permission-manager.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import { withFileLock } from "../lib/with-file-lock.js";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
const log = createLogger("mcp-manager");

const DEFAULT_CONFIG_PATH = join(lvisHome(), "mcp", "servers.json");

export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly configPath: string;
  private readonly configLockPath: string;
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

  private withConfigFileLock<T>(fn: () => Promise<T>): Promise<T> {
    // Use a stable sibling sentinel instead of touching configPath before lock acquisition.
    // This avoids interfering with Windows temp-file + rename replacement of configPath.
    return withFileLock(this.configLockPath, fn);
  }

  constructor(
    private readonly governance: McpGovernance,
    private readonly toolRegistry: ToolRegistry,
    configPath?: string,
    private readonly permissionManager?: PermissionManager,
    private readonly auditLogger?: AuditLogger,
  ) {
    this.configPath = configPath ?? DEFAULT_CONFIG_PATH;
    this.configLockPath = `${this.configPath}.guard`;
  }

  // ─── Config Loading ─────────────────────────────────

  /** MCP 서버 설정 파일에서 설정 로드 */
  async loadFromConfig(): Promise<McpServerConfig[]> {
    return this.withConfigFileLock(() => this.loadFromConfigUnlocked());
  }

  private async loadFromConfigUnlocked(): Promise<McpServerConfig[]> {
    const bakPath = `${this.configPath}.bak`;
    // Keep read-only fallback for legacy/operator-provided recovery files.
    // saveConfigs() no longer creates new .bak files because they can retain secrets.
    const candidatePaths = [
      ...(existsSync(this.configPath) ? [this.configPath] : []),
      ...(existsSync(bakPath) ? [bakPath] : []),
    ];

    if (candidatePaths.length === 0) {
      log.info("MCP 서버 설정 파일 없음: %s", this.configPath);
      return [];
    }

    for (const path of candidatePaths) {
      try {
        const raw = await readFile(path, "utf-8");
        if (!raw.trim()) {
          if (path === candidatePaths[candidatePaths.length - 1]) {
            return [];
          }
          log.warn(`빈 설정 파일 감지, 다음 후보로 폴백: ${path}`);
          continue;
        }
        const parsed = JSON.parse(raw) as { servers?: McpServerConfig[] };
        const servers = (parsed.servers ?? []).map((s) => {
          // transport 필드 누락 시 command 유무로 기본값 보정
          if (!s.transport) {
            (s as Record<string, unknown>).transport = (s as Record<string, unknown>).command ? "stdio" : "http";
          }
          return s;
        });
        log.info(`${servers.length}개 MCP 서버 설정 로드`);
        return servers;
      } catch (err) {
        log.error({ err }, "설정 파일 파싱 실패");
      }
    }

    return [];
  }

  // ─── Connection Management ──────────────────────────

  /** 설정된 모든 승인 서버에 연결 (병렬) */
  async connectAll(): Promise<{ connected: string[]; failed: Array<{ id: string; error: string }> }> {
    const configs = await this.loadFromConfig();

    const results = await Promise.allSettled(
      configs.map((config) => this.connectServer(config).then(() => config.id)),
    );

    const connected: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        connected.push(result.value);
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failed.push({ id: configs[i].id, error: message });
        log.warn(`서버 연결 실패 (${configs[i].id}): %s`, message);
      }
    }

    log.info(
      `연결 결과: ${connected.length}개 성공, ${failed.length}개 실패`,
    );
    return { connected, failed };
  }

  /** 단일 서버 연결 */
  async connectServer(config: McpServerConfig): Promise<void> {
    // 이미 연결된 서버는 건너뛰기
    const existing = this.clients.get(config.id);
    if (existing && existing.getState().status === "connected") {
      log.info(`${config.id}: 이미 연결됨 — 건너뛰기`);
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
      this.clients.delete(config.id);
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
          log.error(`${id} 종료 실패: %s`, err);
        }),
      );
    }
    await Promise.all(promises);
    this.clients.clear();
    log.info("모든 MCP 서버 연결 해제 완료");
  }

  // ─── Kill Switch (§10.1) ────────────────────────────

  /**
   * 즉시 연결 해제 + 도구 제거.
   * 진행 중인 요청은 에러로 reject됨.
   */
  async killSwitch(serverId: string): Promise<void> {
    log.warn(`Kill Switch 실행: ${serverId}`);

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

    log.warn(`Kill Switch 완료: ${serverId} — 모든 도구 해제됨`);
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

  // ─── MCP Apps UI Resource ────────────────────────────

  /**
   * Fetch a `ui://` resource from the given MCP server.
   * Delegates to {@link McpClient.readResource}.
   */
  async readUiResource(serverId: string, uri: string): Promise<string> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`[mcp-manager] 서버 '${serverId}'를 찾을 수 없습니다.`);
    }
    return client.readResource(uri);
  }

  // ─── Config Mutation ────────────────────────────────

  /** 설정 파일의 현재 서버 목록 반환 (renderer-safe DTO) */
  async getConfigs(): Promise<McpServerConfigDto[]> {
    const configs = await this.loadFromConfig();
    return configs.map((config) => this.toConfigDto(config));
  }

  getConfigPath(): string {
    return this.configPath;
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
      await this.withConfigFileLock(async () => {
        const validation = this.governance.validateServer(normalizedConfig);
        if (!validation.valid) {
          throw new Error(
            `[mcp-manager] 거버넌스 검증 실패 (Layer ${validation.layer}): ${validation.reason}`,
          );
        }
        const existing = await this.loadFromConfigUnlocked();
        if (existing.some((s) => s.id === normalizedId)) {
          throw new Error(`[mcp-manager] 서버 id '${normalizedId}'가 이미 존재합니다.`);
        }
        const updated = [...existing, normalizedConfig];
        await this.saveConfigs(updated);
      });
      // 연결 시도 (실패해도 config 저장은 유지)
      try {
        await this.connectServer(normalizedConfig);
        return { connected: true };
      } catch (err) {
        const warning = err instanceof Error ? err.message : String(err);
        log.warn(`서버 추가 후 연결 실패 (${normalizedId}): %s`, err);
        return { connected: false, warning };
      }
    });
  }

  /**
   * 설정 파일에서 서버 제거 + 연결 해제.
   * 존재하지 않아도 에러 없이 처리. write-lock으로 동시 제거 시 TOCTOU 방지.
   *
   * NOTE: loadFromConfigUnlocked() may surface servers from a legacy .bak file
   * even when the primary config is absent.  We therefore reason about the
   * *effective* server list rather than short-circuiting on existsSync(), so
   * that bak-only servers are also correctly removed: a new primary config is
   * written without the removed server, which takes precedence over the .bak on
   * the next load.
   */
  async removeConfig(serverId: string): Promise<void> {
    return this.withConfigLock(async () => {
      await this.withConfigFileLock(async () => {
        const existing = await this.loadFromConfigUnlocked();
        const updated = existing.filter((s) => s.id !== serverId);
        if (updated.length === existing.length) {
          // Server not present in the effective config — nothing to persist.
          return;
        }
        await this.saveConfigs(updated);
      });
      // 연결 해제 (이미 끊겨있으면 무시)
      const client = this.clients.get(serverId);
      if (client) {
        await client.disconnect().catch((e) =>
          log.warn(`removeConfig disconnect 실패 (${serverId}): %s`, e),
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
    const tmpPath = `${this.configPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify({ servers: configs }, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      try {
        await rename(tmpPath, this.configPath);
      } catch (renameErr) {
        // Windows rename() may throw EEXIST when the destination already exists.
        // Preserve the old file until the new one is successfully promoted so a
        // failed retry cannot delete both copies at once.
        if ((renameErr as NodeJS.ErrnoException).code === "EEXIST") {
          // Windows: move existing config to a unique .old path before promoting
          // the new file so the original is preserved if the retry rename fails.
          const bakPath = `${this.configPath}.${process.pid}.${randomBytes(4).toString("hex")}.old`;
          if (existsSync(this.configPath)) {
            await rename(this.configPath, bakPath);
          }
          try {
            await rename(tmpPath, this.configPath);
            // Promote succeeded — erase the backup so secrets don't linger.
            await rm(bakPath, { force: true }).catch((cleanupErr) => {
              log.warn({ err: cleanupErr, bakPath }, `saveConfigs: backup cleanup failed — ${bakPath}`);
            });
          } catch (retryErr) {
            // Restore original config from backup.
            if (existsSync(bakPath)) {
              await rename(bakPath, this.configPath).catch((restoreErr) => {
                log.error(
                  { err: restoreErr, bakPath },
                  `saveConfigs: restore failed — stale backup at ${bakPath}`,
                );
              });
            }
            throw retryErr;
          }
        } else {
          throw renameErr;
        }
      }
    } catch (e) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  private toConfigDto(config: McpServerConfig): McpServerConfigDto {
    // Secrets remain write-only across IPC:
    // - apiKey: shared secret
    // - headers: may contain bearer/session tokens
    // - env: may contain injected credentials
    // - args: may embed secrets on stdio command lines
    const { apiKey: _apiKey, headers: _headers, env: _env, args: _args, ...safe } = config;
    return safe as McpServerConfigDto;
  }

  /** 특정 서버의 도구 호출 — ToolExecutor에서 사용 */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<{ text: string; uiPayload?: McpUiPayload }> {
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
