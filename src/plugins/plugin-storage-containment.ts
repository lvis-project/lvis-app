/**
 * The lexical half of plugin-storage containment, in a module a plugin child
 * process can import.
 *
 * WHY IT IS ITS OWN MODULE. `storage.ts` imports `electron` for `safeStorage`,
 * so a plugin running in its own plain Node process cannot import it — and
 * `storage.resolve()` is answered IN the child
 * (`docs/blueprints/plugin-process-isolation.md` §3.1): it is a pure lexical
 * join under `pluginDataDir`, which the child already holds, and a round trip
 * would buy nothing. Without a shared module the child would need its own copy
 * of the traversal rejection, and two copies are free to disagree about what
 * escapes the root — the one thing this particular rule cannot afford.
 *
 * WHAT THE CHILD'S ANSWER IS NOT. It is not the security decision. Every method
 * that actually touches the disk re-runs the host's async guard, which adds the
 * `realpath` walk this module deliberately omits — a symlink planted inside the
 * root is caught there, at the syscall, not here. The child's copy exists so
 * `resolve()` returns the same STRING the host would; containment is enforced
 * where the bytes move.
 *
 * The host canonicalises its root with `realpathSync` at construction and the
 * child holds the un-canonicalised `pluginDataDir`, so the two can differ when
 * the data dir is itself reached through a symlink. That difference is visible
 * in the returned string and harmless: the plugin feeds it straight back into a
 * storage call, which re-guards against the canonical root.
 */
import { isAbsolute, join, resolve, sep } from "node:path";
import { PluginStorageError } from "./public-contract.js";

/**
 * Sink invoked when a storage path is REFUSED by the containment guards.
 * `message` names the refusal; `meta` carries the offending paths.
 */
export type PluginStorageRejectionLog = (message: string, meta?: unknown) => void;

/**
 * Whether `target` is `root` or lies beneath it.
 *
 * Both are expected already ABSOLUTE and lexically normalised; this asks only
 * the containment question and resolves nothing, because the two callers
 * normalise differently — one canonicalises with `realpath` first, the other
 * cannot because the path need not exist yet.
 *
 * The `+ sep` is the whole point and is why this is shared rather than written
 * again at each site: a bare `startsWith(root)` accepts `/data-evil` for a root
 * of `/data`, and this repository already carries several hand-written copies of
 * the same three-line predicate. Adding another would make it several plus one.
 */
export function isPathWithin(root: string, target: string): boolean {
  if (target === root) return true;
  // A root that ALREADY ends in a separator would otherwise be given a second
  // one and match nothing — `/data/` would reject `/data/x`, and on Windows a
  // drive root is exactly that shape (`C:\\`), so `C:\\foo` would read as
  // outside `C:\\`. In a containment check a false negative refuses a
  // legitimate path, which is how this surfaces: not as an escape, but as a
  // plugin whose own directory looks foreign to it.
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(rootWithSep);
}

/**
 * Join `segments` under `storageRoot` and refuse anything that leaves it.
 *
 * Lexical only, and callers that go on to touch the disk must follow it with
 * the realpath walk — see the module header for why the split is deliberate
 * rather than an omission.
 */
export function resolvePluginStoragePath(
  pluginId: string,
  storageRoot: string,
  segments: readonly unknown[],
  log?: PluginStorageRejectionLog,
): string {
  for (const segment of segments) {
    // Checked before `join`, which throws a bare `TypeError` naming the
    // argument index — a diagnostic that says nothing about which plugin or
    // which path, and that a plugin author cannot branch on.
    if (typeof segment !== "string") {
      throw new PluginStorageError("path must be a string", pluginId, String(segment));
    }
  }
  const rel = segments.length === 0 ? "." : join(...(segments as string[]));
  // Refuse absolute paths outright — plugins should think in relative terms.
  if (isAbsolute(rel)) {
    throw new PluginStorageError("absolute paths are not allowed", pluginId, rel);
  }
  const target = resolve(storageRoot, rel);
  if (!isPathWithin(storageRoot, target)) {
    log?.(`storage: rejected escape attempt`, { rel, resolved: target });
    throw new PluginStorageError("path escapes plugin storage root", pluginId, rel);
  }
  return target;
}
