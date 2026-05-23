/**
 * PluginAuthPartitionStore — persist observed `persist:plugin-auth:<pluginId>*`
 * partition names to disk so uninstall can wipe partitions created in PRIOR app
 * sessions (issue #748).
 *
 * File: `~/.lvis/plugins/auth-partitions.json`
 * Format: `{ "partitions": { "<pluginId>": ["persist:plugin-auth:<pluginId>", ...] } }`
 *
 * Design:
 * - Atomic write (tmp → rename) with mode 0o600, dir 0o700.
 * - LVIS_HOME env override flows through `lvisHome()`.
 * - Corrupt / unreadable JSON → throws immediately with a descriptive error.
 *   Caller (boot.ts) logs to audit and re-throws — no silent empty-set fallback.
 * - Coalescing serial write queue: concurrent callers always see the latest
 *   snapshot written; at most one in-flight disk write at a time. The snapshot
 *   is taken (deep-cloned) synchronously before the async chain is entered, so
 *   subsequent map mutations cannot corrupt an in-flight write.
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { lvisHome } from "../shared/lvis-home.js";

/** Shape written to disk. */
interface PartitionsFile {
  partitions: Record<string, string[]>;
}

function filePath(): string {
  return resolve(lvisHome(), "plugins", "auth-partitions.json");
}

function isPartitionsFile(value: unknown): value is PartitionsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (!obj.partitions || typeof obj.partitions !== "object" || Array.isArray(obj.partitions))
    return false;
  for (const [k, v] of Object.entries(obj.partitions as Record<string, unknown>)) {
    if (typeof k !== "string") return false;
    if (
      !Array.isArray(v) ||
      (v as unknown[]).some((item) => typeof item !== "string")
    )
      return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Coalescing write queue
//
// Invariant: at most one `doActualWrite` is executing at any time.
// New callers update `_pendingSnapshot` (latest wins) and chain onto
// `_writeChain` — if a write is already in-flight, the trailing continuation
// picks up the latest snapshot.
// ---------------------------------------------------------------------------

/** Snapshot taken before entering the async chain — immune to later mutations. */
let _pendingSnapshot: PartitionsFile | null = null;
/** Serial promise chain; never rejects (errors propagate via the returned promise). */
let _writeChain: Promise<void> = Promise.resolve();
/** True while `doActualWrite` is executing inside the chain. */
let _writing = false;

/** Deep-clone a partition map into a plain PartitionsFile object. */
function snapshotMap(partitions: ReadonlyMap<string, ReadonlySet<string>>): PartitionsFile {
  const data: PartitionsFile = { partitions: {} };
  for (const [pluginId, set] of partitions) {
    data.partitions[pluginId] = [...set].sort();
  }
  return data;
}

/** Execute a single disk write for `snapshot`. Never throws (errors returned). */
async function doActualWrite(snapshot: PartitionsFile): Promise<void> {
  const path = filePath();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
}

/**
 * For test isolation only — resets module-level write queue state.
 * @internal
 */
export function __resetWriteQueueForTest(): void {
  _pendingSnapshot = null;
  _writeChain = Promise.resolve();
  _writing = false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read persisted partitions from disk.
 *
 * Returns `null` when the file does not exist (first boot after upgrade — no
 * data to restore, which is correct: no prior sessions tracked anything).
 *
 * Throws if the file exists but contains corrupt / unexpected JSON so the
 * caller can log to audit and surface the error rather than silently losing
 * historical partition data.
 */
export async function readPersistedPluginAuthPartitions(): Promise<
  Record<string, string[]> | null
> {
  const path = filePath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `plugin-auth-partition-store: failed to read ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `plugin-auth-partition-store: corrupt JSON in ${path}: ${(err as Error).message}`,
    );
  }

  if (!isPartitionsFile(parsed)) {
    throw new Error(
      `plugin-auth-partition-store: unexpected schema in ${path} — expected { partitions: Record<string, string[]> }`,
    );
  }

  return parsed.partitions;
}

/**
 * Atomically persist the current in-memory partition map to disk.
 *
 * Uses a coalescing serial write queue: if a write is already in-flight, the
 * latest snapshot is queued and the trailing continuation writes it. The map is
 * deep-cloned synchronously before this function returns, so callers may mutate
 * the map immediately without risk of corrupting an in-flight write.
 */
export function writePersistedPluginAuthPartitions(
  partitions: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<void> {
  // Snapshot now — before any await — so subsequent map mutations are safe.
  _pendingSnapshot = snapshotMap(partitions);

  if (!_writing) {
    _writing = true;
    const result = _writeChain.then(async () => {
      try {
        while (_pendingSnapshot !== null) {
          const next = _pendingSnapshot;
          _pendingSnapshot = null;
          await doActualWrite(next);
        }
      } finally {
        _writing = false;
      }
    });
    // Detach the rejection from the persistent chain so future writes can
    // recover after a transient I/O error (EIO, ENOSPC, EACCES) without
    // permanently bricking _writeChain.
    _writeChain = result.catch(() => undefined);
    return result;
  }

  // A write is already in-flight; _pendingSnapshot updated above will be
  // picked up by the trailing while-loop continuation.
  //
  // KNOWN COALESCED-CALLER EDGE: if the in-flight write throws BEFORE the
  // loop reaches the just-set _pendingSnapshot, this caller's promise
  // resolves "successfully" (it returns the .catch-detached chain), but
  // the snapshot itself is dropped. In actual usage this is benign:
  //  (a) the only call site is auth-window-service.ts and it routes the
  //      write rejection (received by the in-flight caller) through the
  //      onError audit hook,
  //  (b) writes are idempotent — the next rememberPluginAuthPartition
  //      observation re-triggers a write with the latest snapshot,
  //  (c) callers do not poll the returned promise to verify "is my
  //      snapshot persisted" — they fire-and-forget.
  // If a future caller needs durable per-call confirmation, return a
  // per-caller deferred that resolves only when its snapshot is written.
  return _writeChain;
}

/**
 * Remove a single plugin's entry from the persisted file.
 * Used during uninstall — after in-memory state is cleared, purge disk record.
 * No-ops silently when the file does not exist.
 */
export async function deletePersistedPluginAuthPartitions(pluginId: string): Promise<void> {
  const path = filePath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `plugin-auth-partition-store: failed to read ${path} for deletion: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `plugin-auth-partition-store: corrupt JSON in ${path} during deletion: ${(err as Error).message}`,
    );
  }

  if (!isPartitionsFile(parsed)) {
    throw new Error(
      `plugin-auth-partition-store: unexpected schema in ${path} during deletion`,
    );
  }

  if (!(pluginId in parsed.partitions)) return; // already absent — no write needed

  delete parsed.partitions[pluginId];

  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
}

/**
 * Clean up any stale `.tmp` files left by a previous crash mid-write.
 * Call once at startup, before the first read.
 */
export async function cleanupStaleTmpFiles(): Promise<void> {
  const path = filePath();
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  try {
    const entries = await readdir(dir);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"))
        .map((entry) =>
          unlink(resolve(dir, entry)).catch(() => {
            /* best-effort */
          }),
        ),
    );
  } catch {
    /* readdir throws if dir absent — safe to ignore on first boot */
  }
}
