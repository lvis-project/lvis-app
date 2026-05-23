/**
 * Feature-namespace storage helper — single source of truth for the
 * `~/.lvis/<feature>/` permission + atomic-write contract.
 *
 * Storage Namespace per Feature (project CLAUDE.md): every host domain
 * (chat sessions, routine, onboarding, audit, …) and every plugin owns a
 * dedicated directory under `~/.lvis/`. Each owner must enforce:
 *
 *   directory mode: 0o700
 *   file mode:      0o600
 *   atomic write:   tmpfile + rename (no half-written file is ever read)
 *   read fallback:  missing / corrupt JSON returns the caller's default
 *
 * Before this helper, every namespace owner re-implemented those four
 * rules inline. A single typo (e.g. forgetting `mode: 0o700` on a new
 * feature directory) silently widened the permission boundary. Callers
 * now go through {@link openFeatureNamespace} and never touch `mkdir`
 * directly, so they cannot forget the mode bits.
 *
 * Mode bits are POSIX-only — on Windows `fs` ignores the `mode` option,
 * matching the prior per-store behaviour (the existing tests skip mode
 * assertions on `win32`).
 */
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { lvisHome } from "../../shared/lvis-home.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Create `dir` with 0o700 and best-effort `chmod` it back to 0o700 in case
 * it pre-existed with a wider mode (e.g. created under a permissive umask).
 * The chmod failure is swallowed — a pre-existing dir on a host that forbids
 * chmod must not block the write.
 */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    await fs.chmod(dir, DIR_MODE);
  } catch {
    /* best effort — pre-existing dir may already be 0o755 on some hosts */
  }
}

/**
 * Read + JSON-parse `filePath`. Any failure (missing file, permission
 * denied, corrupt JSON) returns `fallback` — this mirrors the pre-existing
 * "read-never-throws" contract every namespace store relied on. Callers that
 * need a security boundary must layer their own validation on top.
 */
export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Atomically write `value` (serialized as pretty JSON + trailing newline) to
 * `<dir>/<name>`. The directory is created 0o700; the file is written to a
 * sibling `.tmp` with 0o600 then renamed over the target so a crash mid-write
 * never leaves a half-written file for a subsequent read. A defensive `chmod`
 * tightens the final file mode if the rename target pre-existed wider.
 */
export async function writeJsonAtomic<T>(dir: string, name: string, value: T): Promise<void> {
  await ensureDir(dir);
  const target = join(dir, name);
  const tmp = `${target}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(tmp, body, { encoding: "utf-8", mode: FILE_MODE });
  await fs.rename(tmp, target);
  try {
    await fs.chmod(target, FILE_MODE);
  } catch {
    /* file mode may already be correct; ignore */
  }
}

/**
 * Atomically write arbitrary string `body` to `filePath`, enforcing 0o700 on
 * the parent directory and 0o600 on the file. Lower-level escape hatch for
 * callers that own a fully-resolved path (e.g. a store whose file path is
 * dependency-injected for tests) rather than a feature id. Composes the same
 * tmpfile + rename + chmod guarantees as {@link writeJsonAtomic}.
 */
export async function writeFileAtomicAtPath(filePath: string, body: string): Promise<void> {
  await ensureDir(dirname(filePath));
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, body, { encoding: "utf-8", mode: FILE_MODE });
  await fs.rename(tmp, filePath);
  try {
    await fs.chmod(filePath, FILE_MODE);
  } catch {
    /* file mode may already be correct; ignore */
  }
}

export interface FeatureNamespaceHandle {
  /**
   * Absolute path to the feature's `~/.lvis/<feature>/` directory. Resolved
   * lazily on every access through {@link lvisHome}, so the `LVIS_HOME` env
   * override (set per-test by e2e fixtures) is always honoured even when the
   * handle is created once at module load.
   */
  readonly dir: string;
  /** Read + parse `<dir>/<name>`; returns `fallback` on any failure. */
  readJson<T>(name: string, fallback: T): Promise<T>;
  /** Atomically write `<dir>/<name>` (0o700 dir, 0o600 file). */
  writeJson<T>(name: string, value: T): Promise<void>;
  /** Create + return `<dir>/<name>` as a 0o700 subdirectory. */
  childDir(name: string): Promise<string>;
}

/**
 * Open a handle to the `~/.lvis/<featureId>/` namespace. The directory is NOT
 * created eagerly — it is materialized (0o700) on the first `writeJson` /
 * `childDir`, so a read-only consumer never creates an empty directory.
 *
 * `featureId` is a single path segment (the domain name or plugin id). The
 * directory path is resolved through {@link lvisHome} on every operation
 * (never cached) so a module-level handle still respects a later `LVIS_HOME`
 * override — matching the lazy-resolution contract documented on `lvisHome`.
 */
export function openFeatureNamespace(featureId: string): FeatureNamespaceHandle {
  if (!featureId || featureId.includes("/") || featureId.includes("\\") || featureId.includes("..")) {
    throw new Error(`openFeatureNamespace: invalid featureId "${featureId}"`);
  }
  const resolveDir = (): string => join(lvisHome(), featureId);
  return {
    get dir(): string {
      return resolveDir();
    },
    readJson: <T>(name: string, fallback: T) => readJsonFile(join(resolveDir(), name), fallback),
    writeJson: <T>(name: string, value: T) => writeJsonAtomic(resolveDir(), name, value),
    childDir: async (name: string) => {
      const child = join(resolveDir(), name);
      await ensureDir(child);
      return child;
    },
  };
}
