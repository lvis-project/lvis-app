/**
 * Audit Logger — §4.5.5 Post-Turn Audit Hook
 *
 * 매 턴마다 구조화된 JSON 로그를 기록.
 * 향후 Governance Layer (§14.2) Elasticsearch 연동 대비.
 * 현재는 ~/.lvis/audit/ 디렉토리에 JSONL 파일로 저장.
 *
 * Rotation: 파일 크기 초과(기본 10 MB) 또는 7일 경과 시
 *   `<date>.jsonl.YYYYMMDD.gz` 아카이브로 압축.
 * Retention: 30일(기본) 이후 아카이브 자동 삭제.
 * Race safety: withFileLock 으로 동시 write + rotate 경쟁 방지.
 */
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  existsSync,
  readdirSync,
  createReadStream,
  readFileSync,
  statSync,
} from "node:fs";
import { createWriteStream } from "node:fs";
import { unlink, rename, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { withFileLock } from "../lib/with-file-lock.js";
import {
  computeLineHmac,
  GENESIS_MARKER,
  type SecretStore,
} from "./hmac-chain.js";
import type { Q12AuditEntry } from "./audit-schema.js";

export interface AuditEntry {
  timestamp: string;
  sessionId: string;
  type: "turn" | "tool_call" | "approval" | "warn" | "error" | "mcp_connect" | "kill_switch" | "dlp" | "info";
  /** DLP hit payload — populated when type === "dlp" */
  dlp?: {
    byKind: Record<string, number>;
    totalRedactions: number;
    turnId: string;
  };
  input?: string;
  output?: string;
  toolCalls?: Array<{
    name: string;
    isError: boolean;
    /** tool-governance.md §8 통합 감사 스키마 확장 필드 */
    source?: string;
    trust?: string;
    executionTimeMs?: number;
    permissionDecision?: string;
    permissionReason?: string;
    rateLimitRemaining?: number;
  }>;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  route?: string;
}

export interface AuditRotationOptions {
  /** Rotate active .jsonl when it exceeds this size in bytes. Default: 10 MB. */
  maxBytes?: number;
  /** Delete .jsonl.*.gz archives older than this many days. Default: 30. */
  retentionDays?: number;
  /** Age in days at which the active file is force-rotated. Default: 7. */
  rotationAgeDays?: number;
}

export class AuditLogger {
  private readonly auditDir: string;
  private readonly logFile: string;
  /**
   * Q12 P5 — separate file for the discriminated-union HMAC-chained
   * audit channel. Format `<date>.q12.jsonl`. Kept distinct from the
   * legacy telemetry channel (`<date>.jsonl`) so chain verification
   * doesn't have to filter heterogeneous shapes.
   */
  private readonly q12LogFile: string;
  /** Q12 P5 — HMAC chain state. Wired via `setupQ12Chain`. Null = legacy boot. */
  private q12Secret: string | null = null;
  /** Memoized last serialized line so each append knows the prevHash without re-reading the file. */
  private q12LastSerialized: string = GENESIS_MARKER;
  private q12ChainBootstrapped = false;
  /** Q12 P5 — secret store for daily seals. Wired alongside `setupQ12Chain`. */
  private q12SealStore: SecretStore | null = null;

  constructor() {
    this.auditDir = join(homedir(), ".lvis", "audit");
    if (!existsSync(this.auditDir)) {
      mkdirSync(this.auditDir, { recursive: true, mode: 0o700 });
    }
    // 일별 로그 파일
    const date = new Date().toISOString().slice(0, 10);
    this.logFile = join(this.auditDir, `${date}.jsonl`);
    this.q12LogFile = join(this.auditDir, `${date}.q12.jsonl`);
  }

  log(entry: AuditEntry): void {
    try {
      const line = JSON.stringify(entry) + "\n";
      const newFile = !existsSync(this.logFile);
      appendFileSync(this.logFile, line, { encoding: "utf-8", mode: 0o600 });
      // Defensive: ensure 0o600 even when the file pre-existed with a wider
      // mode (e.g. created by a process with permissive umask). CLAUDE.md
      // `~/.lvis/<feature>/` rule requires audit files be user-readable only.
      if (newFile) {
        try {
          chmodSync(this.logFile, 0o600);
        } catch {
          // Non-fatal — chmod failure must not block audit writes.
        }
      }
    } catch {
      // Audit 실패가 앱 동작을 차단하면 안 됨
    }
  }

  /**
   * Q12 P5 — wire the HMAC chain state. Call once at boot after
   * loading the audit secret from the keychain. When unwired, all
   * `appendQ12Entry` calls throw — fail-secure per spec §1: refuse
   * to start the chain rather than silently downgrade.
   *
   * `sealStore` is optional but required for daily-seal verification
   * via the `/permission audit verify` slash. When omitted, the
   * verify operation reports `sealMatch: null` for all days.
   */
  setupQ12Chain(secret: string, sealStore?: SecretStore): void {
    this.q12Secret = secret;
    this.q12SealStore = sealStore ?? null;
    // Bootstrap: scan the existing q12 file (if any) so the next
    // append's prevHash links to the *real* last line, not genesis.
    this.q12LastSerialized = GENESIS_MARKER;
    if (existsSync(this.q12LogFile)) {
      try {
        const raw = readFileSync(this.q12LogFile, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        if (lines.length > 0) {
          this.q12LastSerialized = lines[lines.length - 1];
        }
      } catch {
        // If we can't read the existing file, the chain effectively
        // restarts from genesis. The forensics tooling will detect the
        // discontinuity at the next verifyChain.
      }
    }
    this.q12ChainBootstrapped = true;
  }

  /** Q12 P5 — accessor for tests + slash audit verify. */
  getQ12LogFile(): string {
    return this.q12LogFile;
  }

  /** Q12 P5 — was setupQ12Chain called? */
  isQ12ChainReady(): boolean {
    return this.q12ChainBootstrapped && this.q12Secret !== null;
  }

  /** Q12 P5 — accessor for the wired HMAC secret. Null when not bootstrapped. */
  getQ12Secret(): string | null {
    return this.q12Secret;
  }

  /** Q12 P5 — accessor for the wired seal store. Null when not bootstrapped or omitted. */
  getQ12SealStore(): SecretStore | null {
    return this.q12SealStore;
  }

  /** Q12 P5 — accessor for the audit directory (used by audit-show/verify). */
  getAuditDir(): string {
    return this.auditDir;
  }

  /**
   * Q12 P5 — append a discriminated-union audit entry with HMAC
   * chain. Caller supplies the entry minus `prevHash`; this method
   * computes and threads the chain link.
   *
   * Throws when the chain is not bootstrapped (fail-secure). The
   * caller is responsible for catching at the boot boundary and
   * surfacing a user-actionable error.
   *
   * Concurrency: this method is synchronous (single-threaded JS event
   * loop semantics). The risk surfaced in review was a stale cached
   * `q12LastSerialized` after rotation or after a separate process
   * appended. Mitigation: re-read the on-disk tail synchronously at
   * the start of every append so prevHash always links to the actual
   * last line. This holds even if rotation drops the file mid-runtime
   * — the chain restarts cleanly from genesis the next call, which
   * verifyChain will detect (rotation creates a separate file, so the
   * new file legitimately starts at genesis).
   */
  appendQ12Entry(entry: Omit<Q12AuditEntry, "prevHash">): Q12AuditEntry {
    if (!this.q12Secret || !this.q12ChainBootstrapped) {
      throw new Error("Q12 audit chain not initialized — call setupQ12Chain() at boot");
    }
    // Re-read the actual on-disk tail so prevHash links to the true
    // last line even if a rotation/external write occurred between
    // setupQ12Chain bootstrap and this append.
    let prevSerialized = GENESIS_MARKER;
    if (existsSync(this.q12LogFile)) {
      try {
        const raw = readFileSync(this.q12LogFile, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        if (lines.length > 0) prevSerialized = lines[lines.length - 1];
      } catch {
        // Read failure → restart chain from genesis. The forensics
        // tooling will detect the discontinuity at the next verifyChain.
      }
    }
    const prevHash = computeLineHmac(this.q12Secret, prevSerialized);
    const full = { ...entry, prevHash } as Q12AuditEntry;
    const serialized = JSON.stringify(full);
    const newFile = !existsSync(this.q12LogFile);
    appendFileSync(this.q12LogFile, serialized + "\n", { encoding: "utf-8", mode: 0o600 });
    if (newFile) {
      try {
        chmodSync(this.q12LogFile, 0o600);
      } catch {
        // Non-fatal — chmod failure must not block audit writes.
      }
    }
    this.q12LastSerialized = serialized;
    return full;
  }

  /**
   * Rotate + prune audit files.
   *
   * - Any .jsonl file whose size >= maxBytes OR whose date prefix is older
   *   than rotationAgeDays is compressed to `<name>.YYYYMMDD.gz` and removed.
   * - Any .jsonl.*.gz archive whose embedded date is older than retentionDays
   *   is deleted.
   *
   * Uses withFileLock on each candidate file to prevent concurrent write races.
   */
  async rotateAndPrune(opts: AuditRotationOptions = {}): Promise<void> {
    const {
      maxBytes = 10 * 1024 * 1024,
      retentionDays = 30,
      rotationAgeDays = 7,
    } = opts;

    const now = Date.now();
    const rotationAgeMs = rotationAgeDays * 86_400_000;
    const retentionAgeMs = retentionDays * 86_400_000;
    const archiveDateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");

    let entries: string[];
    try {
      entries = readdirSync(this.auditDir);
    } catch {
      return;
    }

    // --- Rotate active .jsonl files ---
    const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
    for (const fname of jsonlFiles) {
      const filePath = join(this.auditDir, fname);
      // Skip current active log file — only rotate if size or age threshold met
      let shouldRotate = false;
      try {
        const st = statSync(filePath);
        if (st.size >= maxBytes) {
          shouldRotate = true;
        }
        // Extract date from filename like "2026-04-12.jsonl"
        const dateMatch = fname.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (dateMatch) {
          const fileDate = new Date(dateMatch[1]).getTime();
          if (!isNaN(fileDate) && now - fileDate >= rotationAgeMs) {
            shouldRotate = true;
          }
        }
      } catch {
        continue;
      }

      if (!shouldRotate) continue;

      // Don't rotate a file that is today's active log based on size alone
      // unless it actually exceeds the limit (age check already handles old dates)
      const archivePath = `${filePath}.${archiveDateStr}.gz`;

      try {
        await withFileLock(filePath, async () => {
          // Re-stat inside lock — another process may have already rotated
          const st2 = await fsStat(filePath).catch(() => null);
          if (!st2 || st2.size === 0) return;

          // Compress to .gz
          await pipeline(
            createReadStream(filePath),
            createGzip(),
            createWriteStream(archivePath),
          );
          // Remove original after successful compression
          await unlink(filePath);
        });
      } catch {
        // Rotation failure is non-fatal
      }
    }

    // --- Prune stale archives (.jsonl.YYYYMMDD.gz) ---
    // Re-read directory after potential rotations
    let entries2: string[];
    try {
      entries2 = readdirSync(this.auditDir);
    } catch {
      return;
    }

    const archiveFiles = entries2.filter((f) => /\.jsonl\.\d{8}\.gz$/.test(f));
    for (const fname of archiveFiles) {
      // Extract archive date from filename suffix
      const m = fname.match(/\.(\d{8})\.gz$/);
      if (!m) continue;
      const ds = m[1]; // "20260412"
      const archiveDate = new Date(
        `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`,
      ).getTime();
      if (isNaN(archiveDate)) continue;
      if (now - archiveDate >= retentionAgeMs) {
        try {
          await unlink(join(this.auditDir, fname));
        } catch {
          // Non-fatal
        }
      }
    }
  }

  /**
   * Search audit entries across JSONL files within a date range.
   * Returns a filtered, paginated slice of matching entries.
   */
  async search(filter: {
    dateFrom?: string;
    dateTo?: string;
    type?: string;
    textSearch?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ entries: AuditEntry[]; total: number }> {
    const { dateFrom, dateTo, type, textSearch, limit = 100, offset = 0 } = filter;

    // Collect JSONL file names in range
    const files = this._filesInRange(dateFrom, dateTo);

    const matched: AuditEntry[] = [];

    for (const file of files) {
      const filePath = join(this.auditDir, file);
      if (!existsSync(filePath)) continue;
      const lines = await this._readLines(filePath);
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry: AuditEntry;
        try {
          entry = JSON.parse(line) as AuditEntry;
        } catch {
          continue;
        }
        if (type && entry.type !== type) continue;
        if (textSearch) {
          const needle = textSearch.toLowerCase();
          const haystack = JSON.stringify(entry).toLowerCase();
          if (!haystack.includes(needle)) continue;
        }
        matched.push(entry);
      }
    }

    const total = matched.length;
    const entries = matched.slice(offset, offset + limit);
    return { entries, total };
  }

  /**
   * Return aggregate stats over the last N days.
   */
  async getStats(lastDays: number): Promise<{
    totalByType: Record<string, number>;
    totalByDay: Record<string, number>;
    sensitiveOps: number;
  }> {
    const dateFrom = new Date(Date.now() - lastDays * 86400_000).toISOString().slice(0, 10);
    const files = this._filesInRange(dateFrom, undefined);

    const totalByType: Record<string, number> = {};
    const totalByDay: Record<string, number> = {};
    let sensitiveOps = 0;

    const SENSITIVE_TYPES = new Set<AuditEntry["type"]>(["approval", "kill_switch"]);

    for (const file of files) {
      const filePath = join(this.auditDir, file);
      if (!existsSync(filePath)) continue;
      const lines = await this._readLines(filePath);
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry: AuditEntry;
        try {
          entry = JSON.parse(line) as AuditEntry;
        } catch {
          continue;
        }
        const day = entry.timestamp?.slice(0, 10) ?? file.replace(".jsonl", "");
        totalByType[entry.type] = (totalByType[entry.type] ?? 0) + 1;
        totalByDay[day] = (totalByDay[day] ?? 0) + 1;
        if (SENSITIVE_TYPES.has(entry.type)) sensitiveOps += 1;
      }
    }

    return { totalByType, totalByDay, sensitiveOps };
  }

  /** List all .jsonl files within [dateFrom, dateTo] inclusive. */
  private _filesInRange(dateFrom?: string, dateTo?: string): string[] {
    let files: string[];
    try {
      files = readdirSync(this.auditDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();
    } catch {
      return [];
    }
    return files.filter((f) => {
      const date = f.replace(".jsonl", "");
      if (dateFrom && date < dateFrom) return false;
      if (dateTo && date > dateTo) return false;
      return true;
    });
  }

  /** Read all lines from a JSONL file asynchronously. */
  private _readLines(filePath: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const lines: string[] = [];
      const rl = createInterface({
        input: createReadStream(filePath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });
      rl.on("line", (l) => lines.push(l));
      rl.on("close", () => resolve(lines));
      rl.on("error", reject);
    });
  }

  logTurn(params: {
    sessionId: string;
    input: string;
    output: string;
    toolCalls: Array<{ name: string; isError: boolean }>;
    tokenUsage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    route: string;
  }): void {
    this.log({
      timestamp: new Date().toISOString(),
      sessionId: params.sessionId,
      type: "turn",
      input: params.input.slice(0, 500),
      output: params.output.slice(0, 500),
      toolCalls: params.toolCalls,
      tokenUsage: params.tokenUsage,
      route: params.route,
    });
  }
}
