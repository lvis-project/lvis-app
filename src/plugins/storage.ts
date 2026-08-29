/**
 * Sandboxed filesystem implementation for `PluginHostApi.storage`.
 *
 * Every method resolves paths against the plugin's `pluginDataDir` and refuses
 * any operation whose resolved target escapes that root. Symlinks are
 * resolved with `realpath` *before* the containment check so a symlink
 * inside the data dir cannot smuggle a write outside it.
 *
 * Path validation is fully async — it uses `fs.promises.realpath` and
 * `fs.promises.lstat` rather than the sync equivalents so heavy plugin I/O
 * does not block the Node.js event loop.
 *
 * Plugins should consume this via `context.hostApi.storage` rather than
 * importing `node:fs` directly — this is the framework boundary for
 * plugin-owned data.
 */
import { safeStorage } from "electron";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isPathWithin,
  resolvePluginStoragePath,
  type PluginStorageRejectionLog,
} from "./plugin-storage-containment.js";
import {
  PluginStorageEncryptionUnavailableError,
  PluginStorageError,
  type PluginStorage,
} from "./types.js";
import { instrumentEffectsByPath } from "../permissions/hostapi-effect-recorder.js";

// Storage-namespace permission bits (CLAUDE.md §Storage Namespace per Feature):
// plugin data directories are 0o700 and files 0o600, so a plugin's persisted
// data — including encrypted secret/token blobs — is never group/world-readable.
// The same rule the host's other main-process stores enforce (auth-partition
// store, python-runtime). POSIX-meaningful; a no-op on Windows. Mode is honoured
// only when the entry is CREATED (an existing file/dir keeps its mode), which is
// why every create site sets it — the first write pins the restrictive mode.
const PLUGIN_DIR_MODE = 0o700;
const PLUGIN_FILE_MODE = 0o600;

/**
 * Sink invoked when a storage operation is REFUSED by the containment guards.
 * Declared alongside the lexical guard it is passed to, and re-exported here
 * because this module is where callers already reach for it.
 */
export type { PluginStorageRejectionLog };

/**
 * Audit transport a rejection sink writes to. Deliberately narrower than the
 * runtime's general `(level, message, data)` audit callback — level is always
 * `"error"` — so any caller can hand its existing audit callback over
 * unchanged (a wider parameter type is assignable to a narrower one).
 */
export type PluginStorageAuditLog = (
  level: "error",
  event: string,
  data: Record<string, unknown>,
) => void;

/**
 * SINGLE AUTHORITY for the audit record a plugin-storage containment refusal
 * produces.
 *
 * Every production `createPluginStorage` wiring builds its sink here, so the
 * host-plugin path (`hostApi.storage`) and the plugin-webview bridge path
 * (`bridge.storage.get/set` → `PluginRuntime.getPluginStorage`) emit the SAME
 * event name and the SAME meta for the same refusal. Before this existed the
 * two wirings disagreed: the host path hand-rolled a `[plugin:<id>]
 * storage_<msg>` line and the webview path passed no sink at all, so a symlink
 * escape refused on behalf of a webview left no trace anywhere (the IPC
 * handler's catch only replies to the caller).
 *
 * `level` is fixed to `"error"` — a refused containment check is a rejected
 * sandbox escape, matching the runtime's other `plugin_*_rejected` events. The
 * emit is wrapped so a failing audit transport can never convert a refusal
 * into a different throw: `createPluginStorage` still rejects the operation.
 */
export function createPluginStorageAuditSink(
  pluginId: string,
  auditLog: PluginStorageAuditLog,
): PluginStorageRejectionLog {
  return (message, meta) => {
    try {
      auditLog("error", "plugin_storage_path_rejected", {
        // Spread meta FIRST so the authoritative fields below always win, even
        // if a future call site puts a `pluginId`/`reason` key in its meta.
        ...(meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}),
        pluginId,
        reason: message,
      });
    } catch {
      /* audit must never break the refusal it is reporting */
    }
  };
}

/**
 * Resolve the pinned data root, turning an absent one into the SAME refusal the
 * per-operation guard raises. Without this the two orderings diverged: a root
 * that vanished after construction produced a classified `PluginStorageError`
 * with an audit record, while a root already absent at construction produced a
 * raw `ENOENT` from `realpathSync` — unclassified, unaudited, and carrying a
 * message about a path rather than about a plugin.
 */
function canonicaliseDataRoot(
  pluginId: string,
  pluginDataDir: string,
  log?: PluginStorageRejectionLog,
): string {
  try {
    return realpathSync(pluginDataDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    log?.(`storage: rejected operation against an absent data root`, {
      target: pluginDataDir,
      root: pluginDataDir,
    });
    throw new PluginStorageError(
      "plugin data root is absent — refusing to recreate it",
      pluginId,
      pluginDataDir,
    );
  }
}

/**
 * Build a sandboxed `PluginStorage` instance pinned to `pluginDataDir`.
 *
 * The root is canonicalised via `realpathSync` once at construction; all
 * subsequent path checks compare against the canonical form.
 *
 * `pluginDataDir` NOT EXISTING is a supported outcome, not a caller error.
 * `ensurePluginDataDir` creates it at load, and `getPluginStorage` deliberately
 * only RESOLVES it per request — during an install swap the plugin root is
 * renamed aside for the length of two renames, and a handle built in that
 * window must be refused rather than served out of a directory this call
 * invented. So an absent root raises the same classified, audited
 * {@link PluginStorageError} the per-operation guard raises for a root that
 * vanishes AFTER construction. Both orderings look identical to the caller.
 *
 * `log` receives every containment refusal. Production callers MUST pass
 * {@link createPluginStorageAuditSink} — omitting it silently discards the
 * sandbox-escape trail. It stays optional only for unit tests and the
 * test-only noop HostApi, which have no audit transport.
 */
export function createPluginStorage(
  pluginId: string,
  pluginDataDir: string,
  log?: PluginStorageRejectionLog,
): PluginStorage {
  // Construction-time canonicalisation is intentionally sync: it runs once
  // per plugin during boot and the result is reused on every subsequent
  // operation, so it does not contribute to the hot-path event-loop pressure
  // the per-call guard() check addresses.
  const canonicalRoot = canonicaliseDataRoot(pluginId, pluginDataDir, log);

  /**
   * Climb up the path until we hit an existing entry, then realpath it and
   * confirm it stays inside `canonicalRoot`. This catches the case where the
   * lexical target itself doesn't exist yet (writes/mkdir creating new
   * entries) but its closest existing ancestor IS a symlink pointing outside
   * the root, *and* the case where the target itself is a symlink (reads).
   *
   * Without this, a plugin could plant a symlink inside `pluginDataDir` and
   * then read/write through it to escape the sandbox — `path.resolve` is
   * purely lexical and never follows symlinks.
   *
   * Async-only: hot-path filesystem syscalls (`realpath`, `lstat`) run on
   * the libuv thread pool so heavy plugin I/O does not stall the main loop.
   */
  async function realpathContainmentCheck(target: string): Promise<void> {
    let probe = target;
    // Set when the climb passes THROUGH the data root because the root itself
    // is not on disk. It changes what the first out-of-root ancestor means: not
    // "something inside the root points outside it" (a sandbox escape, audited
    // as one) but "the root is gone" — which is what an install swap looks like
    // from in here, since it renames the plugin root aside for the length of
    // two renames before carrying `data/` back in. Reporting that as a symlink
    // escape put a security event in the audit log for a directory that was
    // merely mid-move, and told whoever read it to look for a planted link
    // that does not exist.
    let dataRootAbsent = false;
    // Stop when probe equals the lexical root or we've climbed to the
    // filesystem root (dirname returns the same path when at /).
    // Bound the loop to avoid pathological recursion.
    for (let depth = 0; depth < 4096; depth++) {
      try {
        const real = await realpath(probe);
        if (!isPathWithin(canonicalRoot, real)) {
          if (dataRootAbsent) {
            log?.(`storage: rejected operation against an absent data root`, {
              target,
              root: canonicalRoot,
            });
            throw new PluginStorageError(
              "plugin data root is absent — refusing to recreate it",
              pluginId,
              target,
            );
          }
          log?.(`storage: rejected symlink escape`, { target, probe, real });
          throw new PluginStorageError("symlink escapes plugin storage root", pluginId, target);
        }
        return;
      } catch (err) {
        if (err instanceof PluginStorageError) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          // Distinguish two ENOENT shapes:
          //   1. probe doesn't exist at all  → climb to parent (safe).
          //   2. probe IS a (broken) symlink → realpath fails because its
          //      *target* is missing, but the symlink itself exists. Treat
          //      this as an escape attempt: we cannot confirm where the
          //      symlink would resolve, and a malicious plugin could plant
          //      one whose target gets created later out of band.
          try {
            const stats = await lstat(probe);
            if (stats.isSymbolicLink()) {
              log?.(`storage: rejected dangling symlink`, { target, probe });
              throw new PluginStorageError(
                "dangling symlink rejected (target unverifiable)",
                pluginId,
                target,
              );
            }
            // probe exists but isn't a symlink (e.g. ENOTDIR through a file
            // ancestor): climb to parent to find a directory ancestor we can
            // realpath-validate.
          } catch (lstatErr) {
            if (lstatErr instanceof PluginStorageError) throw lstatErr;
            if ((lstatErr as NodeJS.ErrnoException).code !== "ENOENT") throw lstatErr;
            // probe doesn't exist at all — fall through to parent climb.
          }
          if (probe === canonicalRoot) dataRootAbsent = true;
          const parent = dirname(probe);
          if (parent === probe) {
            // Climbed past the filesystem root without finding any existing
            // ancestor. The lexical resolve already confirmed containment,
            // so accept; nothing on disk to validate.
            return;
          }
          probe = parent;
          continue;
        }
        throw err;
      }
    }
    // Loop exhausted without resolving. Fail closed rather than fall through
    // and silently skip the containment check.
    throw new PluginStorageError(
      "containment check exceeded max depth (4096) without resolving",
      pluginId,
      target,
    );
  }

  async function guard(rel: string): Promise<string> {
    const target = resolvePluginStoragePath(pluginId, canonicalRoot, [rel], log);
    // Lexical containment passed; now verify symlinks don't smuggle the
    // target outside the root. Walks up from `target` until it finds an
    // existing entry and realpath-checks it.
    await realpathContainmentCheck(target);
    return target;
  }

  async function ensureParent(absPath: string): Promise<void> {
    await mkdir(dirname(absPath), { recursive: true, mode: PLUGIN_DIR_MODE });
  }

  // Effect ledger (observability) — PluginStorage is the PRIMARY host-mediated
  // plugin persistence path. Its methods are NOT instrumented one-by-one here;
  // instead the whole object is wrapped by {@link instrumentEffectsByPath} below,
  // which records each method's host-observed effect (looked up by its
  // `storage.<method>` PATH in the classification SOT) on the ambient
  // per-invocation ledger BEFORE the op runs (a no-op outside an invocation
  // scope). A read records the ABSENCE of a mutation (positive read evidence);
  // the write variants flip `hasMutatingEffect`. Without this, a plugin tool
  // that mutates ONLY via storage would be recorded `hostObservable:true,
  // hasMutatingEffect:false` — a confirmed host-observed read, a fail-open seed
  // for the future read-recognition gate. Wrapping at this construction boundary
  // (rather than per-method) covers EVERY storage instance uniformly — the two
  // production `createPluginStorage` call-sites (boot host-api-factory and
  // PluginRuntime.getPluginStorage), the test-only noop HostApi, and any
  // future storage method.
  const raw: PluginStorage = {
    // Lexical only, deliberately: `resolve()` returns `string`, not a promise,
    // and its result is expected to be fed back into an async storage call that
    // re-runs the full guard — realpath included.
    resolve: (...segments) => resolvePluginStoragePath(pluginId, canonicalRoot, segments, log),

    async read(rel) {
      const target = await guard(rel);
      return readFile(target);
    },

    async readText(rel, encoding = "utf-8") {
      const target = await guard(rel);
      return readFile(target, encoding);
    },

    async readJson<T = unknown>(rel: string): Promise<T | null> {
      const target = await guard(rel);
      try {
        const text = await readFile(target, "utf-8");
        return JSON.parse(text) as T;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    async write(rel, data, encoding) {
      const target = await guard(rel);
      await ensureParent(target);
      if (typeof data === "string") {
        await writeFile(target, data, { encoding: encoding ?? "utf-8", mode: PLUGIN_FILE_MODE });
      } else {
        await writeFile(target, data, { mode: PLUGIN_FILE_MODE });
      }
    },

    async writeJson<T>(rel: string, value: T, indent = 2): Promise<void> {
      const target = await guard(rel);
      await ensureParent(target);
      await writeFile(target, JSON.stringify(value, null, indent), {
        encoding: "utf-8",
        mode: PLUGIN_FILE_MODE,
      });
    },

    async rm(rel, options) {
      const target = await guard(rel);
      await rm(target, { recursive: options?.recursive ?? false, force: true });
    },

    async list(rel = ".") {
      const target = await guard(rel);
      try {
        return await readdir(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    },

    async exists(rel) {
      const target = await guard(rel);
      try {
        await stat(target);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
    },

    async mkdir(rel) {
      const target = await guard(rel);
      await mkdir(target, { recursive: true, mode: PLUGIN_DIR_MODE });
    },

    // ─── Encrypted-at-rest variants (Electron safeStorage) ─────────────────
    // Ciphertext is written through the SAME sandboxed `guard()` machinery as
    // every plaintext method, so absolute-path / lexical `..` / symlink-escape
    // rejection applies identically. Intended for dynamically-acquired plugin
    // secrets/tokens (OAuth/MSAL caches) — the plugin's own encrypted store,
    // distinct from host-provisioned `hostApi.getSecret` config secrets.
    //
    // FAIL-CLOSED, No-Fallback: when OS encryption is unavailable (safeStorage
    // reports false, or electron `safeStorage` is unreachable) both methods
    // throw {@link PluginStorageEncryptionUnavailableError} — the encrypted
    // variants NEVER read or write plaintext. The availability check runs AFTER
    // `guard()` so a path-escape attempt still surfaces as a PluginStorageError
    // (path rejection wins over the encryption check), and BEFORE any disk write
    // so an unavailable-encryption call leaves no file behind.
    async writeEncrypted(rel, plaintext) {
      if (typeof plaintext !== "string") {
        throw new PluginStorageError(
          "writeEncrypted requires string plaintext",
          pluginId,
          String(rel),
        );
      }
      const target = await guard(rel);
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
        throw new PluginStorageEncryptionUnavailableError(pluginId);
      }
      const ciphertext = safeStorage.encryptString(plaintext);
      await ensureParent(target);
      // 0o600 — the ciphertext is a secret blob; keep it owner-only at rest.
      await writeFile(target, ciphertext, { mode: PLUGIN_FILE_MODE });
    },

    async readEncrypted(rel) {
      const target = await guard(rel);
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
        throw new PluginStorageEncryptionUnavailableError(pluginId);
      }
      // Raw ciphertext bytes; readFile throws ENOENT for a missing file, matching
      // readText's contract.
      const ciphertext = await readFile(target);
      return safeStorage.decryptString(Buffer.from(ciphertext));
    },
  };
  return instrumentEffectsByPath(raw, "storage");
}
