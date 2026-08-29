



import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  existsSync,
  openSync,
  readdirSync,
  createReadStream,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { createWriteStream } from "node:fs";
import { chmod, open as openFile, unlink, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:process";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { withFileLock } from "../lib/with-file-lock.js";
import { localDateKey, localDayRange, shiftLocalDateKey } from "../shared/local-date.js";
import {
  computeDailySeal,
  computeLineHmac,
  GENESIS_MARKER,
  sealKeyName,
  verifyChainLine,
  verifyEntryHmac,
  type SecretStore,
} from "./hmac-chain.js";
import type { PermissionAuditEntry, PermissionAuditEntryInput } from "./audit-schema.js";
import { lvisHome } from "../shared/lvis-home.js";
import {
  normalizeSubscriptionUsageTelemetry,
  type SubscriptionUsageTelemetry,
} from "../shared/subscription-runtime.js";
import {
  iterateJsonlLines,
  iterateJsonlLinesFromFd,
  withAuditSnapshotLock,
} from "./jsonl-reader.js";

const MAX_PERMISSION_AUDIT_LINE_BYTES = 1024 * 1024;

function fsyncDirectorySync(dir: string): void {
  if (platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function copyOpenFileSync(sourceFd: number, destinationFd: number, size: number): void {
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < size) {
    const bytesRead = readSync(
      sourceFd,
      chunk,
      0,
      Math.min(chunk.length, size - position),
      position,
    );
    if (bytesRead === 0) {
      throw new Error("permission audit archive source ended unexpectedly");
    }
    let written = 0;
    while (written < bytesRead) {
      const bytesWritten = writeSync(
        destinationFd,
        chunk,
        written,
        bytesRead - written,
      );
      if (bytesWritten === 0) {
        throw new Error("permission audit archive write made no progress");
      }
      written += bytesWritten;
    }
    position += bytesRead;
  }
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function publishOpenFileArchiveSync(
  sourceFd: number,
  size: number,
  archivePath: string,
  auditDir: string,
  noFollow: number,
): void {
  const stagedPath = `${archivePath}.${randomUUID()}.tmp`;
  let stagedFd: number | undefined;
  let operationError: unknown;
  try {
    stagedFd = openSync(
      stagedPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    copyOpenFileSync(sourceFd, stagedFd, size);
    fsyncSync(stagedFd);
    closeSync(stagedFd);
    stagedFd = undefined;

    // A hard-link publishes the fully-synced inode atomically without the
    // overwrite semantics of rename(2). Existing forensic evidence therefore
    // fails closed with EEXIST instead of being replaced.
    try {
      linkSync(stagedPath, archivePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("permission audit archive already exists");
      }
      throw error;
    }
    unlinkSync(stagedPath);
    // Persist both publication of the final name and removal of the staging
    // name before the caller truncates the canonical descriptor.
    fsyncDirectorySync(auditDir);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (stagedFd !== undefined) {
      try {
        closeSync(stagedFd);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      unlinkSync(stagedPath);
    } catch (error) {
      if (!isMissingFileError(error)) cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, ...cleanupErrors],
          "permission audit archive publication and cleanup both failed",
        );
      }
      throw cleanupErrors[0];
    }
  }
}

function readLastNonEmptyLineSync(filePath: string): string {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return GENESIS_MARKER;
    throw err;
  }
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return GENESIS_MARKER;
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
          if (lineLen > MAX_PERMISSION_AUDIT_LINE_BYTES) {
            throw new Error("permission audit line exceeds the maximum size");
          }
          const line = Buffer.allocUnsafe(lineLen);
          readSync(fd, line, 0, lineLen, lineStart);
          return line.toString("utf-8");
        }
      }
      start = position;
    }

    if (end > MAX_PERMISSION_AUDIT_LINE_BYTES) {
      throw new Error("permission audit line exceeds the maximum size");
    }
    const line = Buffer.allocUnsafe(end);
    readSync(fd, line, 0, end, 0);
    return line.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

function findLastCompleteJsonlBoundarySync(fd: number, size: number): number {
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let cursor = size;
  while (cursor > 0) {
    const readLen = Math.min(chunk.length, cursor);
    const position = cursor - readLen;
    const bytesRead = readSync(fd, chunk, 0, readLen, position);
    for (let index = bytesRead - 1; index >= 0; index -= 1) {
      if (chunk[index] === 0x0a) return position + index + 1;
    }
    cursor = position;
  }
  return 0;
}

function readLastCompleteLineSync(fd: number, boundary: number): string {
  if (boundary === 0) return GENESIS_MARKER;
  const one = Buffer.allocUnsafe(1);
  let end = boundary;
  while (end > 0) {
    readSync(fd, one, 0, 1, end - 1);
    if (one[0] !== 0x0a && one[0] !== 0x0d) break;
    end -= 1;
  }
  if (end === 0) return GENESIS_MARKER;
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let cursor = end;
  while (cursor > 0) {
    const readLen = Math.min(chunk.length, cursor);
    const position = cursor - readLen;
    const bytesRead = readSync(fd, chunk, 0, readLen, position);
    for (let index = bytesRead - 1; index >= 0; index -= 1) {
      if (chunk[index] !== 0x0a) continue;
      const lineStart = position + index + 1;
      const lineLength = end - lineStart;
      if (lineLength > MAX_PERMISSION_AUDIT_LINE_BYTES) {
        throw new Error("permission audit line exceeds the maximum size");
      }
      const line = Buffer.allocUnsafe(lineLength);
      readSync(fd, line, 0, lineLength, lineStart);
      return line.toString("utf-8");
    }
    cursor = position;
  }
  if (end > MAX_PERMISSION_AUDIT_LINE_BYTES) {
    throw new Error("permission audit line exceeds the maximum size");
  }
  const line = Buffer.allocUnsafe(end);
  readSync(fd, line, 0, end, 0);
  return line.toString("utf-8");
}

/**
 * Plugin install privilege-escalation audit (#1098). Emitted when a marketplace
 * install escalates the actor user → it-admin because the catalog installPolicy
 * is "admin". Typed (replaces an ad-hoc `JSON.stringify` blob in `input`) so
 * forensics can identify, from a single audit row: the catalog policy that drove
 * the escalation, the escalation source (`location`), and the EXACT catalog
 * snapshot used (`catalogSnapshotHash`) — the last closes the TOCTOU audit gap
 * where the audited policy and the installed artifact could otherwise diverge.
 */
export interface PluginInstallEscalationAudit {
  event: "plugin-install-escalation";
  pluginId: string;
  catalogPolicy: "admin";
  actorOriginal: "user";
  actorEscalated: "it-admin";
  /** Internal call site that performed the escalation (e.g. "marketplace.install"). */
  location: string;
  /** sha256 over the canonical catalog item that drove escalation AND the install — pins the exact snapshot. */
  catalogSnapshotHash: string;
}

export interface AuditEntry {
  timestamp: string;
  sessionId: string;
  type: "turn" | "tool_call" | "approval" | "warn" | "error" | "mcp_connect" | "mcp_apikey_set" | "kill_switch" | "dlp" | "info" | "diagnostics-export";
  /** DLP hit payload — populated when type === "dlp" */
  dlp?: {
    byKind: Record<string, number>;
    totalRedactions: number;
    turnId: string;
  };
  /** Plugin install privilege-escalation payload (#1098) — populated for install-escalation events. */
  pluginInstall?: PluginInstallEscalationAudit;
  input?: string;
  output?: string;
  toolCalls?: Array<{
    name: string;
    isError: boolean;

    source?: string;
    trust?: string;
    executionTimeMs?: number;
    /** Host tool-use correlation, when an execution pipeline supplied one. */
    toolUseId?: string;
    /**
     * Public-safe host shell substrate selected for the invocation. This
     * deliberately excludes tool arguments, paths, permits, and approval
     * integrity material.
     */
    executionPlan?: import("../permissions/host-shell-execution-plan.js").HostShellExecutionPlanAuditProjection;

    permissionDecision?: string;
    permissionReason?: string;
    rateLimitRemaining?: number;
    /** How the tool execution ended — `"ok"` on success, `"ceiling"` when the
     *  executor's global timeout fired, `"user-abort"` when caller cancelled
     *  via abortSignal, `"error"` for any other failure. Distinguishes
     *  policy-enforced cap from user cancellation in post-incident analysis. */
    terminationReason?: "ok" | "ceiling" | "user-abort" | "error" | "indeterminate";
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
  /** Non-billable subscription telemetry, persisted separately from API usage. */
  subscriptionUsage?: SubscriptionUsageTelemetry[];
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

export interface AuditSearchFilter {
  dateFrom?: string;
  dateTo?: string;
  type?: string;
  textSearch?: string;
  limit?: number;
  offset?: number;
}

/**
 * Boot-time OS-sandbox activation telemetry. ONE record per boot, written to the
 * DEDICATED `<date>.sandbox-gate.jsonl` channel (mirrors the channel-separation
 * convention of `*.permission-shadow.jsonl` / `*.sandbox.jsonl`). This lets the
 * real-world sandbox activation success / degrade / abort / skip rates be
 * monitored before the Linux/Windows `osToolSandbox` default is flipped on (the
 * staged rollout — see settings-store DEFAULT_SETTINGS). Plain JSONL, NOT the
 * HMAC-chained audit-grade channel.
 */
export interface SandboxGateAuditEntry {
  /** ISO 8601 — stamped by {@link AuditLogger.logSandboxGate}. */
  timestamp: string;
  type: "sandbox_gate";
  /** `process.platform` at boot. */
  platform: NodeJS.Platform;
  /**
   * Which on-signal drove the gate decision:
   *   - `explicit-env`     — `LVIS_SANDBOX_ENABLED=1` (deliberate, fail-closed).
   *   - `default-settings` — the `osToolSandbox` setting / shipped default.
   *   - `off`              — neither signal on (gate off → skip).
   */
  onSignal: "explicit-env" | "default-settings" | "off";
  /** Terminal gate outcome — mirrors decideSandboxGate's action. */
  outcome: "activate" | "degrade" | "abort" | "skip";
  /**
   * Stable machine reason from `decideSandboxGate` (SandboxGateReason). Absent
   * on the gate-off skip path, which short-circuits before a decision is computed.
   */
  reason?: string;
}

export interface AuditRotationOptions {
  /** Rotate active .jsonl when it exceeds this size in bytes. Default: 10 MB. */
  maxBytes?: number;
  /** Delete .jsonl.*.gz archives older than this many days. Default: 30. */
  retentionDays?: number;
  /** Age in days at which the active file is force-rotated. Default: 7. */
  rotationAgeDays?: number;
}

export interface AuditLoggerOptions {
  /** Maximum queued/in-flight writes per plain channel before that channel drops telemetry. */
  maxPendingWrites?: number;
  /** Maximum serialized bytes retained by each plain-channel writer queue. */
  maxPendingBytes?: number;
  /** Injectable UTC clock for deterministic epoch-rollover tests. */
  now?: () => Date;
}

export interface AuditWriterStats {
  pendingWrites: number;
  pendingBytes: number;
  droppedWrites: number;
  acceptingWrites: boolean;
}

const DEFAULT_MAX_PENDING_WRITES = 1_024;
const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

/** Length of the `YYYY-MM-DD` prefix every partition file name starts with. */
const UTC_DATE_KEY_LENGTH = 10;

/** The UTC civil day `YYYY-MM-DD` that partitions entries written at `date`. */
function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, UTC_DATE_KEY_LENGTH);
}

/**
 * The instant an audit row was written, as epoch milliseconds (`NaN` when the
 * row carries no parseable time). Reads span every `.jsonl` partition in the
 * audit directory, which holds two schemas: telemetry rows stamp
 * `AuditEntry.timestamp`, the HMAC-chained permission rows stamp
 * `AuditCommon.ts`. Both name the one instant the row was written; this reads
 * whichever field the row's schema uses.
 */
function entryInstant(entry: AuditEntry): number {
  const row = entry as { timestamp?: unknown; ts?: unknown };
  const raw = row.timestamp ?? row.ts;
  return typeof raw === "string" ? Date.parse(raw) : Number.NaN;
}

/**
 * `start <= at < end` with either bound open. An unparseable instant (`NaN`)
 * fails every comparison, so it never satisfies a bound that was set.
 */
function instantWithin(at: number, start?: Date, end?: Date): boolean {
  if (start !== undefined && !(at >= start.getTime())) return false;
  if (end !== undefined && !(at < end.getTime())) return false;
  return true;
}

function archiveDateStampFromFileName(fileName: string): string | undefined {
  const match = /\.jsonl\.(\d{8})(?:\d{9})?(?:\.[0-9a-f-]{36})?\.gz$/i.exec(fileName);
  return match?.[1];
}

interface PlainWriterState {
  tail: Promise<void>;
  pendingWrites: number;
  pendingBytes: number;
}

export class AuditLogger {
  private readonly auditDir: string;
  /**
   * Permission policy — separate file for the discriminated-union HMAC-chained
   * audit channel. Format `<date>.permission-audit.jsonl`. Kept distinct from the
   * telemetry channel (`<date>.jsonl`) so chain verification
   * doesn't have to filter heterogeneous shapes.
   */
  private permissionAuditLogFile: string;
  private permissionAuditDate: string;

  /** Permission policy — HMAC chain state. Wired via `setupPermissionAuditChain`. Null = uninitialized chain. */
  private permissionAuditSecret: string | null = null;
  private permissionAuditChainBootstrapped = false;
  /** Permission policy — secret store for daily seals. Wired alongside `setupPermissionAuditChain`. */
  private permissionAuditSealStore: SecretStore | null = null;
  private readonly plainWriters = new Map<string, PlainWriterState>();
  private droppedPlainWrites = 0;
  private acceptingPlainWrites = true;
  private readonly maxPendingWrites: number;
  private readonly maxPendingBytes: number;
  private readonly hardenedPlainFiles = new Set<string>();
  private readonly now: () => Date;
  private permissionAuditEpochTransition: Promise<void> | null = null;
  private permissionAuditAppendTail: Promise<void> = Promise.resolve();
  private permissionAuditAppendActive = 0;

  constructor(auditDirOverride?: string, options: AuditLoggerOptions = {}) {
    this.auditDir = auditDirOverride ?? join(lvisHome(), "audit");
    if (!existsSync(this.auditDir)) {
      mkdirSync(this.auditDir, { recursive: true, mode: 0o700 });
    }


    this.now = options.now ?? (() => new Date());
    const date = this.currentUtcDate();
    this.permissionAuditDate = date;
    this.permissionAuditLogFile = join(this.auditDir, `${date}.permission-audit.jsonl`);
    this.maxPendingWrites = normalizePositiveInteger(
      options.maxPendingWrites,
      DEFAULT_MAX_PENDING_WRITES,
    );
    this.maxPendingBytes = normalizePositiveInteger(
      options.maxPendingBytes,
      DEFAULT_MAX_PENDING_BYTES,
    );
  }

  private currentUtcDate(): string {
    return utcDateKey(this.now());
  }

  private telemetryPath(date = this.currentUtcDate()): string {
    return join(this.auditDir, `${date}.jsonl`);
  }


  private permissionShadowPath(date = this.currentUtcDate()): string {
    return join(this.auditDir, `${date}.permission-shadow.jsonl`);
  }

  private sandboxGatePath(date = this.currentUtcDate()): string {
    return join(this.auditDir, `${date}.sandbox-gate.jsonl`);
  }

  private permissionAuditPath(date: string): string {
    return join(this.auditDir, `${date}.permission-audit.jsonl`);
  }

  /**
   * Synchronous preflight rollover for the normal long-running-process case:
   * the new UTC day has no rows yet. A pre-existing non-empty epoch must be
   * re-verified asynchronously by append/setup and is rejected here.
   */
  private ensurePermissionAuditEpochForPreflight(): void {
    if (this.permissionAuditAppendActive > 0) {
      throw new Error("permission audit append is already in progress");
    }
    const date = this.currentUtcDate();
    if (date === this.permissionAuditDate) return;
    const nextPath = this.permissionAuditPath(date);
    const nextTail = readLastNonEmptyLineSync(nextPath);
    const nextSeal = this.permissionAuditSealStore?.read(sealKeyName(date), 4 * 1024) ?? null;
    if (nextTail !== GENESIS_MARKER || nextSeal !== null) {
      throw new Error("permission audit UTC epoch requires chain re-verification");
    }
    this.permissionAuditDate = date;
    this.permissionAuditLogFile = nextPath;
  }

  private async ensurePermissionAuditEpochForAppend(): Promise<void> {
    if (this.permissionAuditEpochTransition) {
      await this.permissionAuditEpochTransition;
    }
    const date = this.currentUtcDate();
    if (date === this.permissionAuditDate) return;
    const secret = this.permissionAuditSecret;
    if (!secret) throw new Error("permission audit chain not initialized");
    const sealStore = this.permissionAuditSealStore ?? undefined;
    const transition = (async () => {
      this.permissionAuditDate = date;
      this.permissionAuditLogFile = this.permissionAuditPath(date);
      await this.setupPermissionAuditChain(secret, sealStore);
    })();
    this.permissionAuditEpochTransition = transition;
    try {
      await transition;
    } finally {
      // Every contender awaits the one published transition before it can
      // create another, so the owner can clear the slot unconditionally.
      this.permissionAuditEpochTransition = null;
    }
  }

  log(entry: AuditEntry): void {
    try {
      const line = JSON.stringify(entry) + "\n";
      this.enqueuePlainWrite(this.telemetryPath(), line);
    } catch {
      // Audit failures must not block app behavior.
    }
  }

  /**
   * Permission policy — append one record to the DEDICATED shadow
   * reconciliation channel (`<date>.permission-shadow.jsonl`), kept separate
   * from the canonical telemetry channel so per-invocation shadow volume never
   * evicts real telemetry. Same plain-JSONL shape + 0o600 hardening as
   * {@link log}; this is NOT the HMAC-chained audit-grade channel. Failures are
   * swallowed — shadow logging must never break a tool invocation.
   */
  logShadow(entry: AuditEntry): void {
    try {
      const line = JSON.stringify(entry) + "\n";
      this.enqueuePlainWrite(this.permissionShadowPath(), line);
    } catch {
      // Shadow logging must never break a tool invocation.
    }
  }

  /** Permission policy — accessor for the dedicated shadow channel file (tests). */
  getPermissionShadowLogFile(): string {
    return this.permissionShadowPath();
  }

  /**
   * Append the ONE-per-boot OS-sandbox activation telemetry record to the
   * dedicated `<date>.sandbox-gate.jsonl` channel. The caller (boot's sandbox
   * gate) passes the resolved `{ platform, onSignal, outcome, reason }`; this
   * method stamps `timestamp` + the `type` discriminant so the shape is
   * controlled centrally. Same plain-JSONL + 0o600 hardening as {@link log};
   * failures are swallowed — activation telemetry must never break boot (it runs
   * on the abort path immediately before boot re-throws the fail-closed error).
   */
  logSandboxGate(event: Omit<SandboxGateAuditEntry, "timestamp" | "type">): void {
    try {
      const entry: SandboxGateAuditEntry = {
        timestamp: this.now().toISOString(),
        type: "sandbox_gate",
        ...event,
      };
      const line = JSON.stringify(entry) + "\n";
      this.enqueuePlainWrite(this.sandboxGatePath(), line);
    } catch {
      // Activation telemetry must never break boot.
    }
  }

  /** Wait until every plain-channel write accepted before this call has settled. */
  async flush(): Promise<void> {
    const tails = [...this.plainWriters.values()].map((writer) => writer.tail);
    await Promise.all(tails);
  }

  /** Stop accepting plain telemetry and drain the bounded writer queue. */
  async close(): Promise<void> {
    this.acceptingPlainWrites = false;
    await this.flush();
  }

  /** Queue state exposed for deterministic saturation and shutdown tests. */
  getWriterStats(): AuditWriterStats {
    let pendingWrites = 0;
    let pendingBytes = 0;
    for (const writer of this.plainWriters.values()) {
      pendingWrites += writer.pendingWrites;
      pendingBytes += writer.pendingBytes;
    }
    return {
      pendingWrites,
      pendingBytes,
      droppedWrites: this.droppedPlainWrites,
      acceptingWrites: this.acceptingPlainWrites,
    };
  }

  private enqueuePlainWrite(filePath: string, line: string): void {
    const bytes = Buffer.byteLength(line, "utf-8");
    if (!this.acceptingPlainWrites) {
      this.droppedPlainWrites += 1;
      return;
    }
    let writer = this.plainWriters.get(filePath);
    if (!writer) {
      writer = { tail: Promise.resolve(), pendingWrites: 0, pendingBytes: 0 };
      this.plainWriters.set(filePath, writer);
    }
    if (
      writer.pendingWrites >= this.maxPendingWrites ||
      bytes > this.maxPendingBytes - writer.pendingBytes
    ) {
      this.droppedPlainWrites += 1;
      return;
    }

    writer.pendingWrites += 1;
    writer.pendingBytes += bytes;
    const write = writer.tail.then(() => this.appendPlainLine(filePath, line));
    writer.tail = write
      .catch(() => {
        this.droppedPlainWrites += 1;
      })
      .finally(() => {
        writer.pendingWrites -= 1;
        writer.pendingBytes -= bytes;
      });
  }

  private async appendPlainLine(filePath: string, line: string): Promise<void> {
    await withFileLock(filePath, async () => {
      const handle = await openFile(
        filePath,
        fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT,
        0o600,
      );
      try {
        if (!this.hardenedPlainFiles.has(filePath)) {
          try {
            await handle.chmod(0o600);
            this.hardenedPlainFiles.add(filePath);
          } catch {
            // Best-effort hardening: creation already requested mode 0o600.
            // Retry chmod on the next accepted write instead of caching failure.
          }
        }
        await handle.writeFile(line, { encoding: "utf-8" });
      } finally {
        await handle.close();
      }
    });
  }

  /** Accessor for the dedicated sandbox-gate telemetry channel file (tests). */
  getSandboxGateLogFile(): string {
    return this.sandboxGatePath();
  }

  /**
   * Permission policy — probe whether the dedicated shadow channel can be
   * appended to. {@link logShadow} swallows write failures (observability must
   * never break a tool call), so a silently-undeliverable shadow dataset is
   * otherwise undetectable. A construction-time caller (the ToolExecutor) uses
   * this to surface a ONE-TIME warning when the reconciliation dataset would be
   * silently empty. Checks W_OK on the existing channel file, falling back to the
   * audit directory when the file has not been created yet. Returns `false` on
   * any access error rather than throwing — a probe must never break a caller.
   */
  isShadowChannelWritable(): boolean {
    try {
      const shadowLogFile = this.permissionShadowPath();
      const probeTarget = existsSync(shadowLogFile)
        ? shadowLogFile
        : this.auditDir;
      accessSync(probeTarget, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Permission policy — wire the HMAC chain state. Call once at boot after
   * loading the audit secret from the keychain. When unwired, all
   * `appendPermissionAuditEntry` calls throw — fail-secure per spec §1: refuse
   * to start the chain rather than silently downgrade.
   *
   * `sealStore` is optional for fresh self-authenticated chains, but required
   * to migrate a historical tail that predates `entryHash`. It also backs
   * daily-seal verification via `/permission audit verify`.
   */
  async setupPermissionAuditChain(secret: string, sealStore?: SecretStore): Promise<void> {
    this.permissionAuditDate = this.currentUtcDate();
    this.permissionAuditLogFile = this.permissionAuditPath(this.permissionAuditDate);
    // A failed re-bootstrap must never inherit a prior ready state.
    this.permissionAuditSecret = null;
    this.permissionAuditSealStore = null;
    this.permissionAuditChainBootstrapped = false;
    let previousSerialized = GENESIS_MARKER;
    let penultimateSerialized = GENESIS_MARKER;
    let lastRowSelfAuthenticated = false;
    let lineIndex = 0;
    let authenticatedRowsStarted = false;
    await withFileLock(this.permissionAuditLogFile, async () => {
      const noFollow = platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
      // One descriptor spans verification AND publication. Re-resolving the
      // pathname after the bytes were authenticated is the time-of-check /
      // time-of-use gap: a local process that replaces the active file in
      // between would otherwise have its bytes archived as if verified.
      let fd: number | undefined;
      try {
        fd = openSync(
          this.permissionAuditLogFile,
          fsConstants.O_RDWR | fsConstants.O_CREAT | noFollow,
          0o600,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      try {
        // Bytes [0, verifiedSize) of the open descriptor: what the loop below
        // authenticates and what any archival below publishes, byte for byte.
        let verifiedSize = 0;
        if (fd !== undefined) {
          const { size } = fstatSync(fd);
          verifiedSize = size;
          if (size > 0) {
            const lastByte = Buffer.allocUnsafe(1);
            readSync(fd, lastByte, 0, 1, size - 1);
            if (lastByte[0] !== 0x0a) {
              const boundary = findLastCompleteJsonlBoundarySync(fd, size);
              const completeTail = readLastCompleteLineSync(fd, boundary);
              const storedSeal = sealStore?.read(
                sealKeyName(this.permissionAuditDate),
                4 * 1024,
              ) ?? null;
              const expectedSeal = completeTail === GENESIS_MARKER
                ? null
                : computeDailySeal(secret, completeTail);
              if (!sealStore || storedSeal !== expectedSeal) {
                throw new Error("permission audit chain has an unterminated tail");
              }
              const archivePath = join(
                this.auditDir,
                `${this.permissionAuditDate}.permission-audit.torn-unverified-${size}-${this.now().getTime()}.jsonl`,
              );
              publishOpenFileArchiveSync(
                fd,
                size,
                archivePath,
                this.auditDir,
                noFollow,
              );
              ftruncateSync(fd, boundary);
              fsyncSync(fd);
              verifiedSize = boundary;
            }
          }
          for await (const line of iterateJsonlLinesFromFd(
            fd,
            verifiedSize,
            MAX_PERMISSION_AUDIT_LINE_BYTES,
          )) {
            if (line.length === 0) continue;
            if (Buffer.byteLength(line, "utf-8") > MAX_PERMISSION_AUDIT_LINE_BYTES) {
              throw new Error(
                `permission audit chain invalid at line ${lineIndex + 1}: line-too-large`,
              );
            }
            const verification = verifyChainLine(
              secret,
              line,
              previousSerialized,
              authenticatedRowsStarted,
            );
            if (!verification.ok) {
              throw new Error(
                `permission audit chain invalid at line ${lineIndex + 1}: ${verification.reason}`,
              );
            }
            penultimateSerialized = previousSerialized;
            lastRowSelfAuthenticated = verification.selfAuthenticated;
            authenticatedRowsStarted ||= verification.selfAuthenticated;
            previousSerialized = line;
            lineIndex += 1;
            if (lineIndex % 1_024 === 0) {
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          }
        }
        const sealName = sealKeyName(this.permissionAuditDate);
        const storedSeal = sealStore?.read(sealName, 4 * 1024) ?? null;
        if (previousSerialized === GENESIS_MARKER) {
          if (storedSeal !== null) {
            throw new Error("permission audit seal exists for an empty active file");
          }
        } else if (!authenticatedRowsStarted) {
          const computedSeal = computeDailySeal(secret, previousSerialized);
          if (storedSeal !== null) {
            if (storedSeal !== computedSeal) {
              throw new Error("permission audit active-tail seal mismatch");
            }
          } else {
            // Never trust-on-first-use a mutable legacy tail. Preserve it as
            // unverified evidence and begin a fresh self-authenticated epoch.
            if (fd === undefined) {
              throw new Error("permission audit legacy tail lost its open descriptor");
            }
            const archivePath = join(
              this.auditDir,
              `${this.permissionAuditDate}.permission-audit.legacy-unverified-${computedSeal.slice(0, 12)}.jsonl`,
            );
            // Publish the verified inode through its own descriptor and empty
            // it in place. Renaming the pathname instead would archive whatever
            // file happens to answer to that name now, and an existing archive
            // fails closed on the hard link rather than being overwritten.
            publishOpenFileArchiveSync(
              fd,
              verifiedSize,
              archivePath,
              this.auditDir,
              noFollow,
            );
            try { chmodSync(archivePath, 0o600); } catch { /* best effort */ }
            ftruncateSync(fd, 0);
            fsyncSync(fd);
            // The fresh epoch may only begin on the file that was just emptied.
            // A non-empty active name means something replaced it during
            // archival: refuse to start a chain over unauthenticated bytes.
            if (statSync(this.permissionAuditLogFile).size !== 0) {
              throw new Error(
                "permission audit active file was replaced during legacy archival",
              );
            }
            previousSerialized = GENESIS_MARKER;
            penultimateSerialized = GENESIS_MARKER;
            lastRowSelfAuthenticated = false;
            lineIndex = 0;
          }
        } else if (sealStore) {
          const computedSeal = computeDailySeal(secret, previousSerialized);
          if (storedSeal !== computedSeal) {
            const predecessorSeal = penultimateSerialized === GENESIS_MARKER
              ? null
              : computeDailySeal(secret, penultimateSerialized);
            const interruptedCommit =
              lastRowSelfAuthenticated && storedSeal === predecessorSeal;
            if (!interruptedCommit) {
              throw new Error("permission audit active-tail seal mismatch");
            }
            // The row is fsynced/self-authenticated and the stored checkpoint
            // names its exact predecessor: finish the interrupted seal commit.
            sealStore.write(sealName, computedSeal);
          }
        }
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    });
    this.permissionAuditSecret = secret;
    this.permissionAuditSealStore = sealStore ?? null;
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
    this.ensurePermissionAuditEpochForPreflight();
    const secret = this.permissionAuditSecret!;
    const tail = readLastNonEmptyLineSync(this.permissionAuditLogFile);
    if (this.permissionAuditSealStore) {
      const sealName = sealKeyName(this.permissionAuditDate);
      const storedSeal = this.permissionAuditSealStore.read(sealName, 4 * 1024);
      if (tail === GENESIS_MARKER) {
        if (storedSeal !== null) {
          throw new Error("permission audit seal does not match the empty active file");
        }
      } else {
        if (storedSeal !== computeDailySeal(secret, tail)) {
          throw new Error("permission audit active-tail seal mismatch");
        }
      }
    } else if (tail !== GENESIS_MARKER && !verifyEntryHmac(secret, tail)) {
      throw new Error("permission audit active tail is not self-authenticated");
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
  appendPermissionAuditEntry(entry: PermissionAuditEntryInput): Promise<PermissionAuditEntry> {
    this.permissionAuditAppendActive += 1;
    const operation = this.permissionAuditAppendTail.then(
      () => this.appendPermissionAuditEntrySerialized(entry),
    );
    this.permissionAuditAppendTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async appendPermissionAuditEntrySerialized(
    entry: PermissionAuditEntryInput,
  ): Promise<PermissionAuditEntry> {
    try {
      await this.ensurePermissionAuditEpochForAppend();
      if (!this.permissionAuditSecret || !this.permissionAuditChainBootstrapped) {
        throw new Error("permission audit chain not initialized — call setupPermissionAuditChain() at boot");
      }
      const secret = this.permissionAuditSecret;
      const epoch = {
        date: this.permissionAuditDate,
        path: this.permissionAuditLogFile,
        sealStore: this.permissionAuditSealStore,
      } as const;
      return await withFileLock(epoch.path, async () => {
        const lastSerialized = readLastNonEmptyLineSync(epoch.path);
        const sealStore = epoch.sealStore;
        const sealName = sealKeyName(epoch.date);
        if (sealStore) {
          const storedSeal = sealStore.read(sealName, 4 * 1024);
          if (lastSerialized === GENESIS_MARKER) {
            if (storedSeal !== null) {
              throw new Error("permission audit seal does not match the empty active file");
            }
          } else {
            const currentSeal = computeDailySeal(secret, lastSerialized);
            if (storedSeal !== currentSeal) {
              throw new Error("permission audit active-tail seal mismatch before append");
            }
          }
        }
        if (
          lastSerialized !== GENESIS_MARKER
          && !verifyEntryHmac(secret, lastSerialized)
          && !sealStore
        ) {
          throw new Error("permission audit active tail is not self-authenticated");
        }
        const prevHash = computeLineHmac(secret, lastSerialized);
        const linked = { ...entry, prevHash };
        const full = {
          ...linked,
          entryHash: computeLineHmac(secret, JSON.stringify(linked)),
        } as PermissionAuditEntry;
        const serialized = JSON.stringify(full);
        if (Buffer.byteLength(serialized, "utf-8") > MAX_PERMISSION_AUDIT_LINE_BYTES) {
          throw new Error("permission audit entry exceeds the maximum size");
        }
        const auditFd = openSync(epoch.path, "a", 0o600);
        try {
          writeFileSync(auditFd, serialized + "\n", { encoding: "utf-8" });
          // The external seal must never name a row that exists only in the OS
          // page cache. Persist the row first; setup can then safely finish a
          // seal commit interrupted between these two durable writes.
          fsyncSync(auditFd);
        } finally {
          closeSync(auditFd);
        }
        try {
          chmodSync(epoch.path, 0o600);
        } catch {
          // Non-fatal — chmod failure must not block audit writes.
        }
        if (sealStore) {
          try {
            sealStore.write(sealName, computeDailySeal(secret, serialized));
          } catch (err) {
            this.permissionAuditChainBootstrapped = false;
            this.permissionAuditSecret = null;
            throw err;
          }
        }
        return full;
      });
    } finally {
      this.permissionAuditAppendActive -= 1;
    }
  }

  /**
   * Rotate + prune audit files.
   *
   * - Any .jsonl file whose size >= maxBytes OR whose date prefix is older
   *   than rotationAgeDays is compressed to a collision-safe timestamp/UUID gzip archive and removed.
   * - Any .jsonl.*.gz archive whose embedded date is older than retentionDays
   *   is deleted.
   *
   * Uses withFileLock on each candidate file to prevent concurrent write races.
   */
  async rotateAndPrune(opts: AuditRotationOptions = {}): Promise<void> {
    await withAuditSnapshotLock(this.auditDir, async () => this.rotateAndPruneUnlocked(opts));
  }

  private async rotateAndPruneUnlocked(opts: AuditRotationOptions): Promise<void> {
    await this.flush();
    const {
      maxBytes = 10 * 1024 * 1024,
      retentionDays = 30,
      rotationAgeDays = 7,
    } = opts;

    const currentTime = this.now();
    const now = currentTime.getTime();
    const rotationAgeMs = rotationAgeDays * 86_400_000;
    const retentionAgeMs = retentionDays * 86_400_000;
    const archiveDateStamp = currentTime.toISOString().replace(/\D/g, "");

    let entries: string[];
    try {
      entries = readdirSync(this.auditDir);
    } catch {
      return;
    }

    // --- Rotate .jsonl logs (plain daily logs + HMAC-chained channels) ---
    // Plain daily logs `YYYY-MM-DD.jsonl` rotate on size OR age. The HMAC-chained
    // channels (`<date>.permission-audit.jsonl`, `<date>.sandbox.jsonl`) are
    // append-only, prevHash-linked tamper-evident chains: they must NEVER be
    // SIZE-rotated (gzip+unlinking the active chain mid-day severs the prevHash
    // links), but a CLOSED prior-day chain is sealed per UTC day, so AGE-rotation
    // (archiving a file ≥ rotationAgeDays old, which is always a closed prior day)
    // is safe and keeps disk bounded.
    const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
    for (const fname of jsonlFiles) {
      const filePath = join(this.auditDir, fname);
      const isHmacChain =
        fname.endsWith(".permission-audit.jsonl") || fname.endsWith(".sandbox.jsonl");
      // Skip current active log file — only rotate if size or age threshold met
      let shouldRotate = false;
      try {
        const st = statSync(filePath);
        // Size-rotation applies to plain daily logs only — never an HMAC chain
        // (that would sever today's still-appending chain).
        if (!isHmacChain && st.size >= maxBytes) {
          shouldRotate = true;
        }
        // Age-rotation archives a CLOSED prior-day file. The leading-date match
        // covers both `<date>.jsonl` and `<date>.<channel>.jsonl`; with the
        // default 7-day age this only ever fires on a sealed prior-day chain,
        // never today's active one.
        const dateMatch = fname.match(/^(\d{4}-\d{2}-\d{2})\./);
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
      const archivePath = `${filePath}.${archiveDateStamp}.${randomUUID()}.gz`;

      try {
        await withFileLock(filePath, async () => {
          // Re-stat inside lock — another process may have already rotated
          const st2 = await fsStat(filePath).catch(() => null);
          if (!st2 || st2.size === 0) return;

          // Compress to .gz
          await pipeline(
            createReadStream(filePath),
            createGzip(),
            createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
          );
          await chmod(archivePath, 0o600);
          // Remove original after successful compression
          await unlink(filePath);
          this.hardenedPlainFiles.delete(filePath);
        });
      } catch {
        // Rotation failure is non-fatal
      }
    }

    // --- Prune stale legacy and timestamp/UUID .jsonl gzip archives ---
    // Re-read directory after potential rotations
    let entries2: string[];
    try {
      entries2 = readdirSync(this.auditDir);
    } catch {
      return;
    }

    const archiveFiles = entries2
      .map((name) => ({ name, archiveDate: archiveDateStampFromFileName(name) }))
      .filter((entry): entry is { name: string; archiveDate: string } => entry.archiveDate !== undefined);
    for (const { name: fname, archiveDate: ds } of archiveFiles) {
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
   *
   * `dateFrom` / `dateTo` are inclusive HOST-LOCAL civil days — what the
   * Audit tab's picker shows. The store stays partitioned by UTC day (see
   * `currentUtcDate`), so the local range is mapped onto the instants it
   * covers, every UTC partition that can overlap those instants is read (one
   * extra file on each side when the host is off UTC), and each entry is kept
   * or dropped by its own timestamp instant — never by comparing day strings.
   */
  async search(filter: AuditSearchFilter): Promise<{ entries: AuditEntry[]; total: number }> {
    await this.flush();
    const { dateFrom, dateTo, type, textSearch, limit = 100, offset = 0 } = filter;

    const range = localDayRange(dateFrom, dateTo);
    if (range === null) {
      throw new TypeError("audit search dateFrom/dateTo must be YYYY-MM-DD day keys");
    }
    const files = this._filesOverlapping(range.start, range.end);

    const entries: AuditEntry[] = [];
    let total = 0;
    const normalizedNeedle = textSearch?.toLowerCase();

    for (const file of files) {
      const filePath = join(this.auditDir, file);
      if (!existsSync(filePath)) continue;
      for await (const line of iterateJsonlLines(filePath)) {
        if (!line.trim()) continue;
        let entry: AuditEntry;
        try {
          entry = JSON.parse(line) as AuditEntry;
        } catch {
          continue;
        }
        if (!instantWithin(entryInstant(entry), range.start, range.end)) continue;
        if (type && entry.type !== type) continue;
        if (normalizedNeedle) {
          const haystack = JSON.stringify(entry).toLowerCase();
          if (!haystack.includes(normalizedNeedle)) continue;
        }
        if (total >= offset && entries.length < limit) {
          entries.push(entry);
        }
        total += 1;
      }
    }

    return { entries, total };
  }

  /**
   * Return aggregate stats over the last N host-local days, `totalByDay`
   * bucketed by host-local day key — the same calendar the Audit tab shows.
   */
  async getStats(lastDays: number): Promise<{
    totalByType: Record<string, number>;
    totalByDay: Record<string, number>;
    sensitiveOps: number;
  }> {
    await this.flush();
    const range = localDayRange(shiftLocalDateKey(localDateKey(this.now()), -lastDays));
    if (range === null) {
      throw new TypeError("audit stats window must start on a YYYY-MM-DD day key");
    }
    const files = this._filesOverlapping(range.start, range.end);

    const totalByType: Record<string, number> = {};
    const totalByDay: Record<string, number> = {};
    let sensitiveOps = 0;

    const SENSITIVE_TYPES = new Set<AuditEntry["type"]>(["approval", "kill_switch"]);

    for (const file of files) {
      const filePath = join(this.auditDir, file);
      if (!existsSync(filePath)) continue;
      for await (const line of iterateJsonlLines(filePath)) {
        if (!line.trim()) continue;
        let entry: AuditEntry;
        try {
          entry = JSON.parse(line) as AuditEntry;
        } catch {
          continue;
        }
        const at = entryInstant(entry);
        if (!instantWithin(at, range.start, range.end)) continue;
        const day = localDateKey(new Date(at));
        totalByType[entry.type] = (totalByType[entry.type] ?? 0) + 1;
        totalByDay[day] = (totalByDay[day] ?? 0) + 1;
        if (SENSITIVE_TYPES.has(entry.type)) sensitiveOps += 1;
      }
    }

    return { totalByType, totalByDay, sensitiveOps };
  }

  /**
   * List every `.jsonl` file whose UTC-day partition can hold an entry inside
   * the instant range `[start, end)`, oldest first. Partitions are named by
   * the UTC day of the entries they hold (`YYYY-MM-DD[.<channel>].jsonl`), so
   * the candidates run from the UTC day of `start` through the UTC day of the
   * last instant before `end`. Callers still filter each entry by its own
   * instant; this only bounds which files are opened.
   */
  private _filesOverlapping(start?: Date, end?: Date): string[] {
    let files: string[];
    try {
      files = readdirSync(this.auditDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();
    } catch {
      return [];
    }
    const firstPartition = start === undefined ? undefined : utcDateKey(start);
    const lastPartition = end === undefined ? undefined : utcDateKey(new Date(end.getTime() - 1));
    return files.filter((f) => {
      const partition = f.slice(0, UTC_DATE_KEY_LENGTH);
      if (firstPartition !== undefined && partition < firstPartition) return false;
      if (lastPartition !== undefined && partition > lastPartition) return false;
      return true;
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
    /** Non-billable subscription telemetry; sanitized again before write. */
    subscriptionUsage?: SubscriptionUsageTelemetry[];
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
    const subscriptionUsage = params.subscriptionUsage
      ?.map((segment) => normalizeSubscriptionUsageTelemetry(segment))
      .filter((segment): segment is SubscriptionUsageTelemetry => segment !== undefined);
    this.log({
      timestamp: this.now().toISOString(),
      sessionId: params.sessionId,
      type: "turn",
      input: params.input.slice(0, 500),
      output: params.output.slice(0, 500),
      toolCalls: params.toolCalls,
      tokenUsage: params.tokenUsage,
      usageByModel: params.usageByModel,
      ...(subscriptionUsage && subscriptionUsage.length > 0 ? { subscriptionUsage } : {}),
      toolExposure: params.toolExposure,
      route: params.route,
    });
  }
}
