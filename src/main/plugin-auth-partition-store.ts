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
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
 * `partitions` is the full map of pluginId → set of partition strings.
 * Converts Set values to sorted arrays for stable output.
 */
export async function writePersistedPluginAuthPartitions(
  partitions: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<void> {
  const path = filePath();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const data: PartitionsFile = { partitions: {} };
  for (const [pluginId, set] of partitions) {
    data.partitions[pluginId] = [...set].sort();
  }

  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
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
