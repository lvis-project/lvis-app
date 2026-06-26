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
import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { PluginStorageError, type PluginStorage } from "./types.js";
import { instrumentEffectsByPath } from "../permissions/hostapi-effect-recorder.js";

export { PluginStorageError } from "./types.js";

/**
 * Build a sandboxed `PluginStorage` instance pinned to `pluginDataDir`.
 *
 * The root is canonicalised via `realpathSync` once at construction; all
 * subsequent path checks compare against the canonical form. Callers must
 * have created `pluginDataDir` before calling this.
 */
export function createPluginStorage(
  pluginId: string,
  pluginDataDir: string,
  log?: (message: string, meta?: unknown) => void,
): PluginStorage {
  // Construction-time canonicalisation is intentionally sync: it runs once
  // per plugin during boot and the result is reused on every subsequent
  // operation, so it does not contribute to the hot-path event-loop pressure
  // the per-call guard() check addresses.
  const canonicalRoot = realpathSync(pluginDataDir);

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
    // Stop when probe equals the lexical root or we've climbed to the
    // filesystem root (dirname returns the same path when at /).
    // Bound the loop to avoid pathological recursion.
    for (let depth = 0; depth < 4096; depth++) {
      try {
        const real = await realpath(probe);
        if (real !== canonicalRoot && !real.startsWith(canonicalRoot + sep)) {
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
    if (typeof rel !== "string") {
      throw new PluginStorageError("path must be a string", pluginId, String(rel));
    }
    // Refuse absolute paths outright — plugins should think in relative terms.
    if (isAbsolute(rel)) {
      throw new PluginStorageError("absolute paths are not allowed", pluginId, rel);
    }
    const target = resolve(canonicalRoot, rel);
    if (target !== canonicalRoot && !target.startsWith(canonicalRoot + sep)) {
      log?.(`storage: rejected escape attempt`, { rel, resolved: target });
      throw new PluginStorageError("path escapes plugin storage root", pluginId, rel);
    }
    // Lexical containment passed; now verify symlinks don't smuggle the
    // target outside the root. Walks up from `target` until it finds an
    // existing entry and realpath-checks it.
    await realpathContainmentCheck(target);
    return target;
  }

  /**
   * Sync variant for the `resolve(...)` PluginStorage method only — that
   * method's signature returns `string` (not `Promise<string>`) for ergonomic
   * reasons. Callers of `resolve()` are expected to use the returned path
   * inside a subsequent async storage call (which re-runs the async guard),
   * so the sync variant intentionally omits the realpath check; the async
   * call that follows will catch any symlink escapes.
   */
  function guardLexicalOnly(rel: string): string {
    if (typeof rel !== "string") {
      throw new PluginStorageError("path must be a string", pluginId, String(rel));
    }
    if (isAbsolute(rel)) {
      throw new PluginStorageError("absolute paths are not allowed", pluginId, rel);
    }
    const target = resolve(canonicalRoot, rel);
    if (target !== canonicalRoot && !target.startsWith(canonicalRoot + sep)) {
      log?.(`storage: rejected escape attempt`, { rel, resolved: target });
      throw new PluginStorageError("path escapes plugin storage root", pluginId, rel);
    }
    return target;
  }

  async function ensureParent(absPath: string): Promise<void> {
    await mkdir(dirname(absPath), { recursive: true });
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
  // (rather than per-method) covers EVERY storage instance uniformly — the four
  // `createPluginStorage` call-sites and any future storage method.
  return instrumentEffectsByPath(
    {
      resolve: (...segments) => guardLexicalOnly(segments.length === 0 ? "." : join(...segments)),

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
          await writeFile(target, data, encoding ?? "utf-8");
        } else {
          await writeFile(target, data);
        }
      },

      async writeJson<T>(rel: string, value: T, indent = 2): Promise<void> {
        const target = await guard(rel);
        await ensureParent(target);
        await writeFile(target, JSON.stringify(value, null, indent), "utf-8");
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
        await mkdir(target, { recursive: true });
      },
    } satisfies PluginStorage,
    "storage",
  );
}
