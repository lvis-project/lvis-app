/**
 * Production log file sink — file-destination management + rotation/retention
 * for the pino application logger (see {@link file:./logger.ts}).
 *
 * Why this exists: pino ships to stdout/stderr only (logger.ts). A PACKAGED
 * app has no console, so production has no readable log. This sink writes the
 * same pino output to `~/.lvis/logs/lvis-<YYYY-MM-DD>.log` so a diagnostics
 * bundle (E2, #1499) and a support engineer have a real file to read.
 *
 * Transport choice: NO pino worker transport. Worker transports resolve a
 * separate worker entry file, which breaks inside a packaged `app.asar` (the
 * PR #684 `ERR_MODULE_NOT_FOUND` regression class). Instead this uses
 * {@link SonicBoom} directly — in-process, sync-capable, packaging-safe.
 * `sonic-boom` is already installed as a pino transitive dependency.
 *
 * Rotation strategy:
 *  - DATE files: filename carries `<YYYY-MM-DD>`, so a fresh app launch on a
 *    new day writes a new file (matches the AuditLogger daily-file convention).
 *  - SIZE guard: an in-process byte counter (SonicBoom writes are async-batched,
 *    so the on-disk size lags) rolls to a `<date>.<seq>.log` file once the
 *    active file crosses {@link LOG_MAX_BYTES}.
 *  - RETENTION: at init the `logs/` directory is scanned and any
 *    `lvis-<date>[.seq].log` older than {@link LOG_RETENTION_DAYS} is deleted.
 *
 * Directory / file mode follows the `~/.lvis/<feature>/` contract (0o700 dir,
 * 0o600 file). SonicBoom opens a raw path (not JSON) and is wired at boot before
 * the async openFeatureNamespace handle is convenient, so the same mode bits are
 * enforced here synchronously via mkdir(mode)+chmod (POSIX; no-op on Windows,
 * matching the feature-namespace helper's own Windows behaviour).
 *
 * Secrets: this sink only DUPLICATES existing pino output to a file — it adds
 * no new log content. Security-auditable events remain the AuditLogger's
 * exclusive domain and are untouched here.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
// Named import: sonic-boom's default-export typing resolves to a namespace,
// not the constructor (a known quirk in its bundled .d.ts). The named
// `SonicBoom` binds the class at type level and — because sonic-boom's CJS
// `module.exports` also exposes `.SonicBoom` (verified at runtime) — the same
// name is a valid runtime constructor under esModuleInterop.
import { SonicBoom } from "sonic-boom";
import { lvisHome } from "../shared/lvis-home.js";

/**
 * Retention window (days) for `~/.lvis/logs/` files. Single source of truth.
 * A later E2 change will make this configurable via `diagnostics.logRetentionDays`
 * (master plan §2(d)); until then this constant is the SOT and the default.
 */
export const LOG_RETENTION_DAYS = 7;

/**
 * Per-file size ceiling (bytes) before the active log rolls to a new sequence
 * file `lvis-<date>.<seq>.log`. 10 MB mirrors the AuditLogger default so disk
 * pressure behaves consistently across both log families.
 */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** `2026-07-05` — the UTC date component used in the log filename. */
function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Base name (no sequence) for a given date: `lvis-<date>.log`. */
function baseFileName(dateStr: string): string {
  return `lvis-${dateStr}.log`;
}

/** Sequenced name: `lvis-<date>.<seq>.log` (seq >= 1); seq 0 → base name. */
function seqFileName(dateStr: string, seq: number): string {
  return seq <= 0 ? baseFileName(dateStr) : `lvis-${dateStr}.${seq}.log`;
}

/**
 * Parse the embedded date from a log filename, or `null` if it is not a
 * recognised `lvis-<YYYY-MM-DD>[.seq].log` file. Used by retention cleanup.
 */
export function parseLogFileDate(fileName: string): string | null {
  const m = fileName.match(/^lvis-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.log$/);
  return m ? m[1] : null;
}

/**
 * Ensure `dir` exists with 0o700. Uses the same mode contract as
 * `openFeatureNamespace` but synchronously — the file sink is wired at boot
 * before the async namespace handle is convenient, and SonicBoom opens a raw
 * path (not JSON) so the namespace's async writeJson helpers do not apply.
 * Mode bits are POSIX-only; `fs` ignores them on Windows.
 */
function ensureLogDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    /* best effort — a pre-existing dir on a chmod-forbidding host must not block boot */
  }
}

/**
 * Delete `lvis-<date>[.seq].log` files whose embedded date is older than
 * `retentionDays`. Missing directory / unreadable entries are non-fatal —
 * retention must never break boot. Returns the list of deleted file names
 * (for test assertions).
 */
export function pruneOldLogs(dir: string, retentionDays: number, now: number = Date.now()): string[] {
  const deleted: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return deleted;
  }
  const cutoffMs = retentionDays * 86_400_000;
  for (const fname of entries) {
    const dateStr = parseLogFileDate(fname);
    if (!dateStr) continue;
    const fileMs = new Date(dateStr).getTime();
    if (isNaN(fileMs)) continue;
    if (now - fileMs >= cutoffMs) {
      try {
        unlinkSync(join(dir, fname));
        deleted.push(fname);
      } catch {
        /* non-fatal — a locked/removed file must not break retention */
      }
    }
  }
  return deleted;
}

/**
 * Choose the sequence number for today's active file: the highest existing
 * sequence for `dateStr` whose file is still under `maxBytes`, else the next
 * fresh sequence. On a fresh day this returns the base file (seq 0) unless it
 * is already at/over the ceiling.
 */
function resolveActiveSeq(dir: string, dateStr: string, maxBytes: number): number {
  let highest = 0;
  try {
    for (const fname of readdirSync(dir)) {
      const fileDate = parseLogFileDate(fname);
      if (fileDate !== dateStr) continue;
      const m = fname.match(/^lvis-\d{4}-\d{2}-\d{2}\.(\d+)\.log$/);
      const seq = m ? parseInt(m[1], 10) : 0;
      if (seq > highest) highest = seq;
    }
  } catch {
    return 0;
  }
  // If the highest-seq file is already at/over the ceiling, advance one.
  const activePath = join(dir, seqFileName(dateStr, highest));
  try {
    if (existsSync(activePath) && statSync(activePath).size >= maxBytes) {
      return highest + 1;
    }
  } catch {
    /* stat failure — fall through and reuse highest */
  }
  return highest;
}

export interface LogFileSinkOptions {
  /** Log directory. Defaults to `~/.lvis/logs/` via {@link lvisHome}. */
  dir?: string;
  /** Retention window in days. Defaults to {@link LOG_RETENTION_DAYS}. */
  retentionDays?: number;
  /** Per-file byte ceiling. Defaults to {@link LOG_MAX_BYTES}. */
  maxBytes?: number;
}

/**
 * A file destination for pino: a SonicBoom writer that self-rolls on size and
 * carries a `write(chunk)` method compatible with `pino.multistream`. Created
 * by {@link createLogFileSink}; wired into the logger's mutable file stream by
 * {@link file:./logger.ts}'s `initFileLogSink`.
 */
export interface LogFileSink {
  /** Write one already-serialized log line (pino passes the formatted string). */
  write(chunk: string): void;
  /** Flush + close the underlying destination (called on shutdown). */
  destroy(): void;
  /** Absolute path to the currently-active log file (for diagnostics/tests). */
  readonly currentFile: string;
}

/**
 * Create the file sink: ensure the log directory (0o700), prune old files,
 * open a SonicBoom destination on today's active file (0o600), and return a
 * write handle that transparently rolls to a new sequence file when the active
 * file crosses `maxBytes`.
 *
 * Throws only on an unrecoverable directory-creation failure; callers at boot
 * wrap this so a log-sink failure never bricks the app (logging is best-effort).
 */
export function createLogFileSink(options: LogFileSinkOptions = {}): LogFileSink {
  const dir = options.dir ?? join(lvisHome(), "logs");
  const retentionDays = options.retentionDays ?? LOG_RETENTION_DAYS;
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;

  ensureLogDir(dir);
  pruneOldLogs(dir, retentionDays);

  const dateStr = todayDateStr();
  let seq = resolveActiveSeq(dir, dateStr, maxBytes);
  let currentFile = join(dir, seqFileName(dateStr, seq));

  /**
   * Bytes accounted for the active file. Seeded from the on-disk size at open
   * (a resumed same-day file may already hold data) and incremented by each
   * chunk's byte length. In-process accounting is used INSTEAD of `statSync`
   * because SonicBoom writes are async-batched (`sync:false`) — the on-disk
   * size lags the buffered writes, so a stat-based guard would never trip until
   * a flush landed. The counter is exact for the roll decision.
   */
  let activeBytes = 0;

  const openBoom = (filePath: string): SonicBoom => {
    // mkdir:false — we already ensured the dir. sync:false — async batched
    // writes (pino default) keep the hot path off the event loop; a final
    // destroy() flush on shutdown drains the buffer.
    const boom = new SonicBoom({ dest: filePath, mkdir: false, sync: false });
    // Tighten mode to 0o600 once the fd exists (POSIX; no-op on Windows).
    try {
      chmodSync(filePath, FILE_MODE);
    } catch {
      /* file mode may already be correct, or Windows — ignore */
    }
    return boom;
  };

  /** Seed activeBytes from any bytes already on disk for the current file. */
  const seedActiveBytes = (): void => {
    try {
      activeBytes = existsSync(currentFile) ? statSync(currentFile).size : 0;
    } catch {
      activeBytes = 0;
    }
  };

  let boom = openBoom(currentFile);
  seedActiveBytes();

  const roll = (): void => {
    seq += 1;
    const next = join(dir, seqFileName(dateStr, seq));
    const old = boom;
    currentFile = next;
    boom = openBoom(next);
    activeBytes = 0;
    // Flush + close the previous destination after the new one is live so no
    // window drops lines.
    try {
      old.end();
    } catch {
      /* best effort */
    }
  };

  return {
    get currentFile(): string {
      return currentFile;
    },
    write(chunk: string): void {
      try {
        boom.write(chunk);
      } catch {
        // A write failure (disk full, fd closed) must never throw into the
        // logging call site — logging is best-effort.
        return;
      }
      activeBytes += Buffer.byteLength(chunk, "utf-8");
      if (activeBytes >= maxBytes) {
        roll();
      }
    },
    destroy(): void {
      try {
        boom.end();
      } catch {
        /* best effort flush on shutdown */
      }
    },
  };
}
