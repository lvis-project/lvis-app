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
import { randomBytes } from "node:crypto";
import { chmodSync, constants, promises as fs, linkSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { platform } from "node:process";
import { lvisHome } from "../../shared/lvis-home.js";
import { createLogger } from "../../lib/logger.js";
import {
  RENAME_FILE_LOCK_CODES,
  BACKGROUND_ATTEMPTS,
  transientFsLockDelayMs,
} from "../../lib/transient-fs-lock-retry.js";
import { sleep } from "../../shared/abortable-deadline.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "../../lib/atomic-file.js";

/**
 * Create `dir` with 0o700 and best-effort `chmod` it back to 0o700 in case
 * it pre-existed with a wider mode (e.g. created under a permissive umask).
 * The chmod failure is swallowed — a pre-existing dir on a host that forbids
 * chmod must not block the write.
 */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await fs.chmod(dir, PRIVATE_DIR_MODE);
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
 * Read + JSON-parse `filePath` for a store that validates its own records.
 *
 * Unlike {@link readJsonFile}, the failure modes are kept apart because they
 * mean different things to a store:
 *
 *   - missing file (ENOENT): the store has never been written — `empty()`.
 *   - unparseable JSON: the file is damaged. It is moved aside as
 *     `<file>.corrupt-<timestamp>.bak` and `empty()` is returned, so the
 *     store keeps working and the bytes are kept for inspection. Silently
 *     treating a damaged file as empty would overwrite the evidence on the
 *     next write; throwing would take the whole feature down with it.
 *   - any other read error (EACCES, EISDIR, …): propagated. A permission
 *     problem must not masquerade as an empty store.
 *
 * `hydrate` receives the parsed value as `unknown` and owns the shape check
 * — dropping tampered records, repairing counters — since that is per store.
 */
export async function readJsonFileOrEmpty<T>(
  filePath: string,
  empty: () => T,
  hydrate: (parsed: unknown) => T,
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const backup = `${filePath}.corrupt-${Date.now()}.bak`;
    log.warn(`corrupt JSON in ${filePath}; moved to ${backup}, starting empty`);
    await fs.rename(filePath, backup);
    return empty();
  }
  return hydrate(parsed);
}

/**
 * fsync the directory that now holds the renamed entry.
 *
 * `rename` orders the replacement but does not make the new directory entry
 * durable; without this the file survives a process crash and not a power cut,
 * which is the half of the promise the docstring below used to make and the
 * code did not keep.
 *
 * Skipped entirely on Windows, where a directory cannot be opened for fsync at
 * all — the same line {@link ../../lib/atomic-file} draws, rather than opening
 * it and sorting the resulting errno into "expected" and "not".
 */
async function syncDirectoryEntry(dir: string): Promise<void> {
  if (platform === "win32") return;
  const handle = await fs.open(dir, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * `rename` the staged file onto its target, retrying only the Windows
 * transient-lock codes ({@link RENAME_FILE_LOCK_CODES}: EPERM/EACCES/EBUSY —
 * another process, a scanner or a plugin webview, holding the target open) on
 * the same delay curve and code set the synchronous sibling
 * {@link ../../lib/atomic-file}.replaceStagedFile uses. Both draw that policy
 * from {@link ../../lib/transient-fs-lock-retry} so the async and sync rename
 * ladders cannot drift. The async budget ({@link BACKGROUND_ATTEMPTS}) is the
 * larger one: nothing blocks the caller while these sleeps run.
 *
 * EEXIST is deliberately NOT retried and NOT recovered here. For a
 * file-onto-file rename it is unreachable — Node maps `rename` to
 * `MoveFileExW(…, MOVEFILE_REPLACE_EXISTING)` on Win32, which replaces an
 * existing regular-file target rather than failing — which is exactly why
 * {@link RENAME_FILE_LOCK_CODES} omits it (see the note in
 * transient-fs-lock-retry). The bespoke config/tarball writers that this helper
 * replaced carried an `EEXIST` rm-then-rename dance for that unreachable case;
 * it is dropped rather than ported, and the reachable case those writers missed
 * — a scanner-held lock — is what this retry actually covers. On macOS/Linux
 * these codes never surface for this path, so the loop renames once and returns.
 */
async function renameStagedFile(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable =
        platform === "win32" &&
        code !== undefined &&
        RENAME_FILE_LOCK_CODES.has(code) &&
        attempt < BACKGROUND_ATTEMPTS;
      if (!retryable) throw err;
      await sleep(transientFsLockDelayMs(attempt));
    }
  }
}

/**
 * Atomically write arbitrary `body` to `filePath`, enforcing 0o700 on the
 * parent directory and 0o600 on the file.
 *
 * The staging file is named with 16 random bytes and created with
 * `O_CREAT|O_EXCL`. Both halves matter and this helper had neither:
 *
 *   - A FIXED `${filePath}.tmp` is a name an attacker can predict, so a symlink
 *     planted there ahead of time is followed by the write and then renamed over
 *     the target, leaving the live path pointing wherever the attacker chose.
 *     `O_EXCL` refuses to open anything that already exists, symlink included.
 *   - A fixed name is also SHARED. Two writers to `~/.lvis/routine/routines.json`
 *     staged into one file and then both renamed it; the surviving target could
 *     hold either one's bytes or a splice of both. Since work-board-store and
 *     routines-store both route here, that was two live stores.
 *
 * The staged bytes are fsynced before the rename and the parent directory after
 * it, so the durability the callers' own comments claim is the durability they
 * get. An uncommitted staging file is removed on every failure path. The rename
 * itself is retried on the Windows transient-lock codes (see
 * {@link renameStagedFile}) so a scanner briefly holding the target open does
 * not turn a routine overwrite into a hard failure.
 *
 * No `chmod` after the rename: `O_EXCL` guarantees the staging file is newly
 * created, so the 0o600 passed to `open` is the mode that lands, and `rename`
 * carries that inode's mode onto the target regardless of what the target's
 * mode was. The old defensive chmod was covering for `fs.writeFile`, which
 * ignores `mode` when the file it opens already exists.
 *
 * Mode is POSIX-only: on Windows `fs` does not map it onto an ACL, so what
 * keeps `~/.lvis` owner-only there is the DACL applied at boot, not this call.
 */
export async function writeFileAtomicAtPath(
  filePath: string,
  body: string | Uint8Array,
): Promise<void> {
  const dir = dirname(filePath);
  await ensureDir(dir);
  const tmp = `${filePath}.${randomBytes(16).toString("hex")}.tmp`;
  try {
    const handle = await fs.open(
      tmp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      PRIVATE_FILE_MODE,
    );
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameStagedFile(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  await syncDirectoryEntry(dir);
}

/**
 * Atomically write `value` (serialized as pretty JSON + trailing newline) to
 * `<dir>/<name>`, under the contract {@link writeFileAtomicAtPath} states.
 */
export async function writeJsonAtomic<T>(dir: string, name: string, value: T): Promise<void> {
  await writeFileAtomicAtPath(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
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

const log = createLogger("feature-namespace");

/**
 * Adopt a file that predates the per-feature rule, moving it from the
 * `~/.lvis/` root into its owning feature's namespace.
 *
 * The rule (CLAUDE.md, "Storage Namespace per Feature") reserves the root for
 * CROSS-CUTTING resources — `settings.json`, `audit.log`, `secrets/` — and puts
 * everything a single domain owns under `~/.lvis/<feature>/`. Files written
 * before the rule existed sit in the root regardless, which is not merely
 * untidy: it defeats the operational property the rule buys, namely that
 * backing up or clearing one domain is `~/.lvis/<feature>/` and nothing else.
 * A domain-owned file stranded in the root is missed by both.
 *
 * Policy, matching {@link ../../boot/steps/work-board-migration}:
 *
 *   - The DESTINATION's existence is the idempotency marker. Once it exists —
 *     whether linked here, by the store's first write, or by a prior run —
 *     `linkSync` answers EEXIST and this is a no-op forever, so a store may
 *     call it on every load.
 *   - Link, then unlink. `linkSync` publishes the legacy inode under the new
 *     name in one atomic step: it cannot half-succeed, and it refuses (EEXIST)
 *     rather than clobber a destination. Because both names then refer to the
 *     SAME inode, there is no copy that could differ from the original and no
 *     window in which neither path holds the data. An earlier draft did
 *     stat-then-read-then-write-then-compare, and needed that final compare
 *     precisely BECAUSE it made a copy — every one of those steps asked the
 *     filesystem a question and then acted on an answer that could already be
 *     stale. Removal of the old name is still the point: leaving it behind
 *     would keep the root cluttered and leave two names free to diverge once
 *     the link is broken by a write.
 *   - Every failure is non-fatal. A store that cannot migrate still opens on
 *     its destination path and behaves exactly as it would for a new install.
 *
 * Synchronous on purpose. This runs once, at store construction or first load,
 * on a small JSON file, and both callers differ in async-ness — a sync helper
 * is what lets there be ONE implementation instead of an async copy and a sync
 * copy drifting apart.
 *
 * REMOVAL: this is a migration, not a compatibility layer. Delete it, and its
 * call sites, once installs predating the move are no longer supported —
 * tracked for the release after 2026-11-01.
 */
export function adoptLegacyRootFileSync(
  featureId: string,
  destinationName: string,
  legacyRootFileName: string,
): void {
  if (!featureId || featureId.includes("/") || featureId.includes("\\") || featureId.includes("..")) {
    throw new Error(`adoptLegacyRootFileSync: invalid featureId "${featureId}"`);
  }
  const home = lvisHome();
  const legacyPath = join(home, legacyRootFileName);
  const destinationPath = join(home, featureId, destinationName);
  try {
    mkdirSync(join(home, featureId), { recursive: true, mode: PRIVATE_DIR_MODE });
    linkSync(legacyPath, destinationPath);
  } catch (err) {
    // ENOENT — no legacy file, which is the steady state from the second run
    // onward. EEXIST — the destination already owns the name. Both are the
    // ordinary outcome, and neither needed a stat to discover: asking is what
    // creates the window between the answer and the act.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST") return;
    log.warn(
      `storage migration: ${legacyRootFileName} -> ${featureId}/${destinationName} could not be linked: %s`,
      (err as Error).message,
    );
    return;
  }
  try {
    // The link published the legacy INODE under the new name, so it published
    // the legacy mode with it. Restore the namespace's own file mode while the
    // two names still share the inode.
    chmodSync(destinationPath, PRIVATE_FILE_MODE);
    rmSync(legacyPath, { force: true });
    log.info(`storage migration: adopted ${legacyRootFileName} as ${featureId}/${destinationName}`);
  } catch (err) {
    // The data is already safe under the new name; only the tidying failed.
    log.warn(
      `storage migration: ${legacyRootFileName} -> ${featureId}/${destinationName} linked, but could not be tidied: %s`,
      (err as Error).message,
    );
  }
}
