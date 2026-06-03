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
  closeSync,
  mkdirSync,
  existsSync,
  openSync,
  readdirSync,
  createReadStream,
  readSync,
  statSync,
} from "node:fs";
import { createWriteStream } from "node:fs";
import { unlink, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { withFileLock } from "../lib/with-file-lock.js";
import {
  computeLineHmac,
  GENESIS_MARKER,
  type SecretStore,
} from "./hmac-chain.js";
import type { PermissionAuditEntry, PermissionAuditEntryInput } from "./audit-schema.js";
import { lvisHome } from "../shared/lvis-home.js";

function readLastNonEmptyLineSync(filePath: string): string {
  if (!existsSync(filePath)) return GENESIS_MARKER;
  const { size } = statSync(filePath);
  if (size === 0) return GENESIS_MARKER;

  const fd = openSync(filePath, "r");
  try {
    const one = Buffer.allocUnsafe(1);
    let end = size;
    while (end > 0) {
      readSync(fd, one, 0, 1, end - 1);
      if (one[0] !== 0x0a && one[0] !== 0x0d) break;
      end -= 1;
    }
    if (end === 0) return GENESIS_MARKER;

    const chunk = Buffer.allocUnsafe(64 * 1024);
    let start = end;
    while (start > 0) {
      const readLen = Math.min(chunk.length, start);
      const position = start - readLen;
      const bytesRead = readSync(fd, chunk, 0, readLen, position);
      for (let i = bytesRead - 1; i >= 0; i -= 1) {
        if (chunk[i] === 0x0a) {
          const lineStart = position + i + 1;
          const lineLen = end - lineStart;
          const line = Buffer.allocUnsafe(lineLen);
          readSync(fd, line, 0, lineLen, lineStart);
          return line.toString("utf-8");
        }
      }
      start = position;
    }

    const line = Buffer.allocUnsafe(end);
    readSync(fd, line, 0, end, 0);
    return line.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

export interface AuditEntry {
  timestamp: string;
  sessionId: string;
  type: "turn" | "tool_call" | "approval" | "warn" | "error" | "mcp_connect" | "mcp_apikey_set" | "kill_switch" | "dlp" | "info";
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
    /** How the tool execution ended — `"ok"` on success, `"ceiling"` when the
     *  executor's global timeout fired, `"user-abort"` when caller cancelled
     *  via abortSignal, `"error"` for any other failure. Distinguishes
     *  policy-enforced cap from user cancellation in post-incident analysis. */
    terminationReason?: "ok" | "ceiling" | "user-abort" | "error";
  }>;
  tokenUsage?: {
    /**
     * UsageDashboard / computeCost contract, not raw AI SDK total input:
     * Claude stores fresh input here and cache in the cache fields; OpenAI /
     * Gemini style providers keep provider prompt tokens, which include cache.
     */
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  usageByModel?: Array<{
    vendorProvider: string;
    vendorModel: string;
    tokenUsage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  }>;
  toolExposure?: {
    loadedToolCount: number;
    loadedToolSourceCounts: { builtin: number; plugin: number; mcp: number };
    deferredCatalogCount: number;
    deferredCatalogSourceCounts: { plugin: number; mcp: number };
    promotedToolNames: string[];
    loadedPluginIds: string[];
    loadedMcpServerIds: string[];
    deferredPluginIds: string[];
    deferredMcpServerIds: string[];
    toolSchemaTokens: number;
    projectedRequestInputTokens: number | null;
    deferralEligibleLoadedCount: number;
    deferredLoadedRatio: number | null;
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
   * Permission policy — separate file for the discriminated-union HMAC-chained
   * audit channel. Format `<date>.permission-audit.jsonl`. Kept distinct from the
   * telemetry channel (`<date>.jsonl`) so chain verification
   * doesn't have to filter heterogeneous shapes.
   */
  private readonly permissionAuditLogFile: string;
  /** Permission policy — HMAC chain state. Wired via `setupPermissionAuditChain`. Null = uninitialized chain. */
  private permissionAuditSecret: string | null = null;
  /** Memoized last serialized line so each append knows the prevHash without re-reading the file. */
  private permissionAuditLastSerialized: string = GENESIS_MARKER;
  private permissionAuditChainBootstrapped = false;
  /** Permission policy — secret store for daily seals. Wired alongside `setupPermissionAuditChain`. */
  private permissionAuditSealStore: SecretStore | null = null;

  constructor(auditDirOverride?: string) {
    this.auditDir = auditDirOverride ?? join(lvisHome(), "audit");
    if (!existsSync(this.auditDir)) {
      mkdirSync(this.auditDir, { recursive: true, mode: 0o700 });
    }
    // 일별 로그 파일 — UTC 기준 (issue #801). `sandbox-audit-sink.ts` 와 같은
    // `toISOString().slice(0, 10)` 컨벤션 → 두 채널이 동일 UTC midnight 에 rotate.
    const date = new Date().toISOString().slice(0, 10);
    this.logFile = join(this.auditDir, `${date}.jsonl`);
    this.permissionAuditLogFile = join(this.auditDir, `${date}.permission-audit.jsonl`);
  }

  log(entry: AuditEntry): void {
    try {
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(this.logFile, line, { encoding: "utf-8", mode: 0o600 });
      // Defensive: ensure 0o600 even when the file pre-existed with a wider
      // mode (e.g. created by a process with permissive umask). CLAUDE.md
      // `~/.lvis/<feature>/` rule requires audit files be user-readable only.
      try {
        chmodSync(this.logFile, 0o600);
      } catch {
        // Non-fatal — chmod failure must not block audit writes.
      }
    } catch {
      // Audit 실패가 앱 동작을 차단하면 안 됨
    }
  }

  /**
   * Permission policy — wire the HMAC chain state. Call once at boot after
   * loading the audit secret from the keychain. When unwired, all
   * `appendPermissionAuditEntry` calls throw — fail-secure per spec §1: refuse
   * to start the chain rather than silently downgrade.
   *
   * `sealStore` is optional but required for daily-seal verification
   * via the `/permission audit verify` slash. When omitted, the
   * verify operation reports `sealMatch: null` for all days.
   */
  setupPermissionAuditChain(secret: string, sealStore?: SecretStore): void {
    this.permissionAuditSecret = secret;
    this.permissionAuditSealStore = sealStore ?? null;
    // Bootstrap from the existing file tail so the next append links to
    // the real last line without O(n) full-file scans.
    try {
      this.permissionAuditLastSerialized = readLastNonEmptyLineSync(this.permissionAuditLogFile);
    } catch {
      // If we can't read the existing file, the chain effectively
      // restarts from genesis. The forensics tooling will detect the
      // discontinuity at the next verifyChain.
      this.permissionAuditLastSerialized = GENESIS_MARKER;
    }
    this.permissionAuditChainBootstrapped = true;
  }

  /** Permission policy — accessor for tests + slash audit verify. */
  getPermissionAuditLogFile(): string {
    return this.permissionAuditLogFile;
  }

  /** Permission policy — was setupPermissionAuditChain called? */
  isPermissionAuditChainReady(): boolean {
    return this.permissionAuditChainBootstrapped && this.permissionAuditSecret !== null;
  }

  /**
   * Permission policy — preflight used before mutating tool execution.
   * Verifies the HMAC chain is initialized and the active audit file can
   * be opened for append before side effects run.
   */
  assertPermissionAuditWritable(): void {
    if (!this.isPermissionAuditChainReady()) {
      throw new Error("permission audit chain not initialized");
    }
    const fd = openSync(this.permissionAuditLogFile, "a", 0o600);
    try {
      chmodSync(this.permissionAuditLogFile, 0o600);
    } finally {
      closeSync(fd);
    }
  }

  /** Permission policy — accessor for the wired HMAC secret. Null when not bootstrapped. */
  getPermissionAuditSecret(): string | null {
    return this.permissionAuditSecret;
  }

  /** Permission policy — accessor for the wired seal store. Null when not bootstrapped or omitted. */
  getPermissionAuditSealStore(): SecretStore | null {
    return this.permissionAuditSealStore;
  }

  /** Permission policy — accessor for the audit directory (used by audit-show/verify). */
  getAuditDir(): string {
    return this.auditDir;
  }

  /**
   * Permission policy — append a discriminated-union audit entry with HMAC
   * chain. Caller supplies the entry minus `prevHash`; this method
   * computes and threads the chain link.
   *
   * Throws when the chain is not bootstrapped (fail-secure). The
   * caller is responsible for catching at the boot boundary and
   * surfacing a user-actionable error.
   *
   * Concurrency: withFileLock serializes cross-process writers without
   * blocking the event loop in a spin wait. The locked section reads
   * only the on-disk tail so prevHash always links to the actual last
   * line without O(n) full-file scans on every append.
   */
  async appendPermissionAuditEntry(entry: PermissionAuditEntryInput): Promise<PermissionAuditEntry> {
    if (!this.permissionAuditSecret || !this.permissionAuditChainBootstrapped) {
      throw new Error("permission audit chain not initialized — call setupPermissionAuditChain() at boot");
    }
    const secret = this.permissionAuditSecret;
    return withFileLock(this.permissionAuditLogFile, async () => {
      this.permissionAuditLastSerialized = readLastNonEmptyLineSync(this.permissionAuditLogFile);
      const prevHash = computeLineHmac(secret, this.permissionAuditLastSerialized);
      const full = { ...entry, prevHash } as PermissionAuditEntry;
      const serialized = JSON.stringify(full);
      appendFileSync(this.permissionAuditLogFile, serialized + "\n", { encoding: "utf-8", mode: 0o600 });
      try {
        chmodSync(this.permissionAuditLogFile, 0o600);
      } catch {
        // Non-fatal — chmod failure must not block audit writes.
      }
      this.permissionAuditLastSerialized = serialized;
      return full;
    });
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
    usageByModel?: Array<{
      vendorProvider: string;
      vendorModel: string;
      tokenUsage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      };
    }>;
    toolExposure?: {
      loadedToolCount: number;
      loadedToolSourceCounts: { builtin: number; plugin: number; mcp: number };
      deferredCatalogCount: number;
      deferredCatalogSourceCounts: { plugin: number; mcp: number };
      promotedToolNames: string[];
      loadedPluginIds: string[];
      loadedMcpServerIds: string[];
      deferredPluginIds: string[];
      deferredMcpServerIds: string[];
      toolSchemaTokens: number;
      projectedRequestInputTokens: number | null;
      deferralEligibleLoadedCount: number;
      deferredLoadedRatio: number | null;
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
      usageByModel: params.usageByModel,
      toolExposure: params.toolExposure,
      route: params.route,
    });
  }
}
