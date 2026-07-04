




import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
const log = createLogger("audit");

export interface AuditEvent {
  timestamp: string;
  sessionId: string;
  type: "tool_call" | "permission_decision" | "bash_validation" | "compact" | "error";
  payload: Record<string, unknown>;
}

export interface AuditServiceOptions {

  baseDir?: string;

  maxFileSize?: number;

  queueMaxSize?: number;
}

export class AuditService {
  private readonly baseDir: string;
  private readonly queue: AuditEvent[] = [];
  private writeLoop: NodeJS.Timeout | null = null;
  private readonly currentFile: string;

  constructor(private readonly opts: AuditServiceOptions = {}) {
    this.baseDir = opts.baseDir ?? join(lvisHome(), "audit");
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

      log.error({ err }, "flush failed");
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
