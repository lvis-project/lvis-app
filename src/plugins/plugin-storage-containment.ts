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
 * Whether `target` is `root` or lies beneath it, resolving both sides first.
 *
 * The sibling of {@link isPathWithin} for callers that hold raw filesystem
 * input rather than an already-normalised absolute path. `resolve` collapses
 * `.`/`..` and anchors a relative argument to `process.cwd()`; the containment
 * question is then the same one, asked the same way.
 *
 * WHY THIS SHAPE AND NOT `path.relative`. Seven call sites across plugins,
 * agents, skills and the python runtime each carried the identical two-liner
 * `relative(a, b)` + `!rel.startsWith("..")`. That form answers NO for a
 * directory whose own name begins with two dots — `relative("/a", "/a/..foo")`
 * is `"..foo"`, and `startsWith("..")` reads that as an escape — so a
 * legitimately contained path was refused. The prefix form has no such blind
 * spot.
 *
 * CASE IS COMPARED EXACTLY, on every platform. `path.win32.relative` folds
 * case, so on Windows this is strictly stricter than the form it replaces: it
 * can only ever refuse a path the old form admitted, never the reverse. Every
 * caller derives its candidate from the root it checks against (`resolve(root,
 * …)`, `join(root, …)`, or `realpath` applied to both), so the two sides carry
 * the same casing by construction and no caller loses a path it used to keep.
 */
export function isResolvedPathWithin(root: string, target: string): boolean {
  return isPathWithin(resolve(root), resolve(target));
}

/**
 * Join `segments` under `storageRoot` and refuse anything that leaves it.
 *
 * Lexical only, and callers that go on to touch the disk must follow it with
 * the realpath walk — see the module header for why the split is deliberate
 * rather than an omission.
 */
/**
 * The path a plugin asked for, in the plugin's own vocabulary.
 *
 * `join` normalises to the HOST separator, so one `read("../escape.bin")`
 * reports `../escape.bin` on POSIX and `..\\escape.bin` on Win32. Storage paths are
 * relative, `/`-separated segments in the public contract, and `attemptedPath`
 * is a diagnostic a plugin may branch on — it must not tell the plugin which
 * host it happened to land on. Only the reported string is folded back; the
 * containment decision above is made on the joined host path.
 */
function reportedPath(rel: string): string {
  return rel.split(sep).join("/");
}

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
    throw new PluginStorageError("absolute paths are not allowed", pluginId, reportedPath(rel));
  }
  const target = resolve(storageRoot, rel);
  if (!isPathWithin(storageRoot, target)) {
    log?.(`storage: rejected escape attempt`, { rel, resolved: target });
    throw new PluginStorageError("path escapes plugin storage root", pluginId, reportedPath(rel));
  }
  return target;
}
