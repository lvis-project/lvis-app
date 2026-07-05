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
 * {@link SonicBoom} directly — in-process and packaging-safe. Writes here run
 * in async-batched mode (`sync:false`), so a chunk is buffered and hits disk
 * on the next flush, not synchronously at the call site; `destroy()` drains
 * the buffer on shutdown. `sonic-boom` is a direct top-level dependency.
 *
 * Rotation strategy:
 *  - DATE files: filename carries `<YYYY-MM-DD>`, so a fresh app launch on a
 *    new day writes a new file. This midnight-boundary-by-filename scheme is
 *    intentionally the same convention the AuditLogger uses for its daily
 *    files, so both log families age and prune on the same day boundary.
 *  - SIZE guard: an in-process byte counter (SonicBoom writes are async-batched,
 *    so the on-disk size lags) rolls to a `<date>.<seq>.log` file once the
 *    active file crosses {@link LOG_MAX_BYTES}.
 *  - RETENTION: at init the `logs/` directory is scanned and any
 *    `lvis-<date>[.seq].log` older than {@link LOG_RETENTION_DAYS} is deleted.
 *
 * Directory / file mode follows the `~/.lvis/<feature>/` contract (0o700 dir,
 * 0o600 file) on POSIX. SonicBoom opens a raw path (not JSON) and is wired at
 * boot before the async openFeatureNamespace handle is convenient, so the mode
 * bits are applied here directly: the directory via mkdir(mode)+chmod, and the
 * file via SonicBoom's `mode` option, which forwards to fs.open so the file is
 * created 0o600 AT OPEN (no post-open chmod race). These bits are POSIX-only —
 * on Windows fs ignores the mode argument, and confidentiality of the log file
 * instead rests on the inherited ACL of the parent `%USERPROFILE%\.lvis` tree
 * (matching the feature-namespace helper's own Windows behaviour).
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

/**
 * Per-day sequence-file COUNT ceiling (#1499 E2 hardening). Date-in-filename
 * rotation + the {@link LOG_MAX_BYTES} size guard together let a single busy day
 * spawn unbounded `lvis-<date>.<seq>.log` files. Once a day has more than this
 * many files, the OLDEST sequences for that day are pruned so the sequence set
 * stays bounded. 20 × 10 MB = 200 MB worst case for one day. Single source of
 * truth.
 */
export const LOG_MAX_FILES_PER_DAY = 20;

/**
 * Whole-tree TOTAL byte ceiling (#1499 E2 hardening). Independent of per-day
 * count and per-file size — a defence against many small days summing to a large
 * tree. When the `logs/` dir exceeds this at init/roll, the oldest files (by
 * embedded date, then sequence) are deleted until the tree is back under the cap.
 * 200 MB. Single source of truth.
 */
export const LOG_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

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
 * A log file with its parsed sort key. Sorted ascending = oldest first (by
 * embedded date, then sequence number).
 */
interface LogFileInfo {
  name: string;
  dateStr: string;
  seq: number;
  size: number;
}

/** Parse the sequence number out of a `lvis-<date>[.seq].log` name (0 = base). */
function parseLogSeq(fileName: string): number {
  const m = fileName.match(/^lvis-\d{4}-\d{2}-\d{2}\.(\d+)\.log$/);
  return m ? parseInt(m[1], 10) : 0;
}

/** Read all `lvis-*` log files in `dir` with size + sort keys. Missing → []. */
function listLogFiles(dir: string): LogFileInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LogFileInfo[] = [];
  for (const name of entries) {
    const dateStr = parseLogFileDate(name);
    if (!dateStr) continue;
    let size = 0;
    try {
      size = statSync(join(dir, name)).size;
    } catch {
      continue;
    }
    out.push({ name, dateStr, seq: parseLogSeq(name), size });
  }
  return out;
}

/**
 * Enforce the per-day file-count ceiling ({@link LOG_MAX_FILES_PER_DAY}) and the
 * whole-tree total-byte ceiling ({@link LOG_MAX_TOTAL_BYTES}) by deleting the
 * OLDEST files first. Called at init (after retention prune) and after each roll,
 * so the tree can never grow unbounded within a single day or across days.
 *
 * NEVER deletes `keepFile` (the currently-active file) — dropping the file we
 * are about to write would sever the sink. Best-effort: unreadable/locked files
 * are skipped, and any failure is swallowed (logging must not break on cleanup).
 * Returns the list of deleted file names (for test assertions).
 */
export function capLogTree(
  dir: string,
  opts: { maxFilesPerDay?: number; maxTotalBytes?: number; keepFile?: string } = {},
): string[] {
  const maxFilesPerDay = opts.maxFilesPerDay ?? LOG_MAX_FILES_PER_DAY;
  const maxTotalBytes = opts.maxTotalBytes ?? LOG_MAX_TOTAL_BYTES;
  const deleted: string[] = [];

  let files = listLogFiles(dir);
  // Oldest first: date ascending, then sequence ascending.
  const byAge = (a: LogFileInfo, b: LogFileInfo): number =>
    a.dateStr === b.dateStr ? a.seq - b.seq : a.dateStr < b.dateStr ? -1 : 1;

  const remove = (f: LogFileInfo): void => {
    if (opts.keepFile && join(dir, f.name) === opts.keepFile) return;
    try {
      unlinkSync(join(dir, f.name));
      deleted.push(f.name);
    } catch {
      /* locked/removed — skip, never throw */
    }
  };

  // ── Per-day count cap ── delete oldest sequences beyond the limit, per date.
  const byDay = new Map<string, LogFileInfo[]>();
  for (const f of files) {
    const list = byDay.get(f.dateStr) ?? [];
    list.push(f);
    byDay.set(f.dateStr, list);
  }
  for (const list of byDay.values()) {
    if (list.length <= maxFilesPerDay) continue;
    list.sort(byAge);
    const overflow = list.slice(0, list.length - maxFilesPerDay);
    for (const f of overflow) remove(f);
  }

  // ── Total-bytes cap ── re-scan (some may be gone) then delete oldest first.
  files = listLogFiles(dir).filter((f) => !deleted.includes(f.name));
  let total = files.reduce((s, f) => s + f.size, 0);
  if (total > maxTotalBytes) {
    files.sort(byAge);
    for (const f of files) {
      if (total <= maxTotalBytes) break;
      if (opts.keepFile && join(dir, f.name) === opts.keepFile) continue;
      const before = deleted.length;
      remove(f);
      if (deleted.length > before) total -= f.size;
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
  // Enforce the per-day count + whole-tree byte caps AFTER date-retention prune.
  capLogTree(dir);

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
    //
    // `mode: FILE_MODE` is forwarded by SonicBoom to fs.open's mode argument
    // (verified in node_modules/sonic-boom/index.js: the `mode` opt threads
    // straight into `fs.open(file, flags, mode, …)`), so the file is created
    // with 0o600 AT OPEN. This replaces a post-construction `chmodSync`, which
    // raced the async (`sync:false`) open — the fd did not yet exist, chmod
    // threw ENOENT (silently caught), and the file kept its umask default
    // (typically 0o644). Passing the mode to the constructor is atomic and
    // deterministic. POSIX-only: Windows ignores the mode bits (file security
    // there relies on the inherited %USERPROFILE% / ~/.lvis ACL).
    const boom = new SonicBoom({ dest: filePath, mkdir: false, sync: false, mode: FILE_MODE });
    // A REQUIRED 'error' listener, not defense-in-depth: SonicBoom is an
    // EventEmitter, and its own async `fs.open`/`fs.write` failures (disk
    // full, EACCES, a removed directory racing a deferred open) are reported
    // by EMITTING 'error', not by rejecting a promise or throwing into the
    // caller. The try/catch around write()/end() below only catches SYNCHRONOUS
    // throws from those calls — it cannot see an error that surfaces later on
    // a different tick from SonicBoom's internal open/write machinery. Without
    // this listener, Node treats the unhandled 'error' event as an uncaught
    // exception that crashes the process (or, under vitest, corrupts/aborts
    // the whole run) — exactly the failure mode that surfaced as a same-run
    // "Unhandled Errors" / "Uncaught Exception" ENOENT unrelated to the
    // currently-running test. Logging is best-effort (see module docstring),
    // so a destination failure here is intentionally swallowed, not rethrown.
    boom.on("error", () => {
      /* best-effort file logging — a destination failure must never crash
         the process or corrupt the console-only logging path. */
    });
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
    // After rolling, re-enforce the count/byte caps — the just-closed file may
    // have pushed the day over LOG_MAX_FILES_PER_DAY or the tree over the total
    // cap. Never delete the new active file (keepFile).
    capLogTree(dir, { keepFile: currentFile });
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
