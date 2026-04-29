/**
 * Sandboxed filesystem implementation for `PluginHostApi.storage`.
 *
 * Every method resolves paths against the plugin's `pluginDataDir` and refuses
 * any operation whose resolved target escapes that root. Symlinks are
 * resolved with `realpathSync` *before* the containment check so a symlink
 * inside the data dir cannot smuggle a write outside it.
 *
 * Plugins should consume this via `context.hostApi.storage` rather than
 * importing `node:fs` directly — this is the framework boundary for
 * plugin-owned data.
 */
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { PluginStorage } from "./types.js";

class PluginStorageError extends Error {
  constructor(
    message: string,
    public readonly pluginId: string,
    public readonly attemptedPath: string,
  ) {
    super(`[plugin-storage:${pluginId}] ${message}: ${attemptedPath}`);
    this.name = "PluginStorageError";
  }
}

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
   */
  function realpathContainmentCheck(target: string): void {
    let probe = target;
    // Stop when probe equals the lexical root or we've climbed to the
    // filesystem root (dirname returns the same path when at /).
    // Bound the loop to avoid pathological recursion.
    for (let i = 0; i < 4096; i++) {
      try {
        const real = realpathSync(probe);
        if (real !== canonicalRoot && !real.startsWith(canonicalRoot + sep)) {
          log?.(`storage: rejected symlink escape`, { target, probe, real });
          throw new PluginStorageError("symlink escapes plugin storage root", pluginId, target);
        }
        return;
      } catch (err) {
        if (err instanceof PluginStorageError) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          const parent = dirname(probe);
          if (parent === probe) {
            // Climbed past the filesystem root without finding an existing
            // ancestor; nothing to validate, the lexical resolve already
            // confirmed containment.
            return;
          }
          probe = parent;
          continue;
        }
        throw err;
      }
    }
  }

  function guard(rel: string): string {
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
    realpathContainmentCheck(target);
    return target;
  }

  async function ensureParent(absPath: string): Promise<void> {
    await mkdir(dirname(absPath), { recursive: true });
  }

  return {
    resolve: (...segments) => guard(segments.length === 0 ? "." : join(...segments)),

    async read(rel) {
      const target = guard(rel);
      return readFile(target);
    },

    async readText(rel, encoding = "utf-8") {
      const target = guard(rel);
      return readFile(target, encoding);
    },

    async readJson<T = unknown>(rel: string): Promise<T | null> {
      const target = guard(rel);
      try {
        const text = await readFile(target, "utf-8");
        return JSON.parse(text) as T;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    async write(rel, data, encoding) {
      const target = guard(rel);
      await ensureParent(target);
      if (typeof data === "string") {
        await writeFile(target, data, encoding ?? "utf-8");
      } else {
        await writeFile(target, data);
      }
    },

    async writeJson<T>(rel: string, value: T, indent = 2): Promise<void> {
      const target = guard(rel);
      await ensureParent(target);
      await writeFile(target, JSON.stringify(value, null, indent), "utf-8");
    },

    async rm(rel, options) {
      const target = guard(rel);
      await rm(target, { recursive: options?.recursive ?? false, force: true });
    },

    async list(rel = ".") {
      const target = guard(rel);
      try {
        return await readdir(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    },

    async exists(rel) {
      const target = guard(rel);
      try {
        await stat(target);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
    },

    async mkdir(rel) {
      const target = guard(rel);
      await mkdir(target, { recursive: true });
    },
  };
}
