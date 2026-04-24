/**
 * Audit Service — 데이터 플레인 분리 (claw-code telemetry 크레이트 패턴)
 *
 * 기존 audit-logger.ts의 sync write를 비동기 큐로 분리하여,
 * 디스크 I/O 장애가 도구 실행을 블록하지 않도록 한다.
 *
 * append-only NDJSON, 50MB rotation.
 * AuditLogger를 대체하지 않음 — 비동기 큐 + 회전 기능을 추가하는 별도 서비스.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AuditEvent {
  timestamp: string;
  sessionId: string;
  type: "tool_call" | "permission_decision" | "bash_validation" | "compact" | "error";
  payload: Record<string, unknown>;
}

export interface AuditServiceOptions {
  /** 기본 ~/.lvis/audit */
  baseDir?: string;
  /** 기본 50MB */
  maxFileSize?: number;
  /** 기본 10,000 */
  queueMaxSize?: number;
}

export class AuditService {
  private readonly baseDir: string;
  private readonly queue: AuditEvent[] = [];
  private writeLoop: NodeJS.Timeout | null = null;
  private readonly currentFile: string;

  constructor(private readonly opts: AuditServiceOptions = {}) {
    this.baseDir = opts.baseDir ?? join(homedir(), ".lvis", "audit");
    this.currentFile = join(this.baseDir, "audit.ndjson");
  }

  async start(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    this.writeLoop = setInterval(() => {
      void this._flush();
    }, 1000);
    this.writeLoop.unref?.();
  }

  async stop(): Promise<void> {
    if (this.writeLoop) clearInterval(this.writeLoop);
    await this._flush();
  }

  /**
   * 비동기 — 즉시 반환, 백그라운드 flush.
   * 디스크 실패가 도구 실행을 차단하지 않음.
   */
  log(event: AuditEvent): void {
    if (this.queue.length >= (this.opts.queueMaxSize ?? 10_000)) {
      this.queue.shift();
    }
    this.queue.push(event);
  }

  private async _flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    const lines = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
    try {
      await fs.appendFile(this.currentFile, lines, "utf-8");
      await this._maybeRotate();
    } catch (err) {
      // 디스크 실패는 console에만 — 도구 실행 차단 금지
      console.error("[audit] flush failed:", err);
    }
  }

  private async _maybeRotate(): Promise<void> {
    const stat = await fs.stat(this.currentFile).catch(() => null);
    if (!stat) return;
    const maxSize = this.opts.maxFileSize ?? 50 * 1024 * 1024;
    if (stat.size < maxSize) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.rename(this.currentFile, join(this.baseDir, `audit-${ts}.ndjson`));
  }
}
