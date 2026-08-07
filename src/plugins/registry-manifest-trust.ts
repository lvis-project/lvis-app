/**
 * Single authority for "resolve a registry entry's `manifestPath` and decide
 * whether it may be trusted".
 *
 * `validateRegistryEntry` (registry.ts) validates `manifestPath` only as
 * `typeof === "string" && length > 0` — no containment, no normalization. A
 * crafted `"../../etc/passwd"` survives the read path intact, so every
 * consumer of the field is the sole decider for its own call. That is why this
 * predicate exists rather than being folded into registry validation.
 *
 * The anchor is `pluginsRoot`, which is the SAME directory as
 * `dirname(registryPath)` by construction — `resolvePluginPaths` sets
 * `registryPath: resolve(pluginsRoot, "registry.json")`. Callers holding only
 * the registry path may pass its dirname.
 *
 * WHY RESOLVE AND CHECK ARE ONE FUNCTION
 * --------------------------------------
 * The predicate this replaces short-circuited to `true` for any RELATIVE
 * input (`if (!isAbsolute(manifestPath)) return true;`). That was safe only
 * because its single call site happened to resolve to absolute first. Anyone
 * calling it with the raw registry field would have trusted
 * `"../../etc/passwd"` outright. Resolving inside the authority makes that
 * branch unreachable rather than merely unused.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";

/**
 * Containment via `path.relative` — empty/`.`/`..`-prefixed/absolute means the
 * candidate is outside `parent`.
 */
function isPathContained(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  if (rel === "" || rel === ".") return false;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * Resolve a registry-recorded `manifestPath` against `pluginsRoot` and return
 * the absolute path iff it is contained under the root once symlinks are
 * resolved on BOTH sides. Returns `null` for anything that escapes, and for a
 * path that cannot be realpath'd (a dangling entry is not trustworthy).
 *
 * Symlink resolution is what makes this stronger than a lexical check: an
 * entry may name a path that is lexically inside the root but links out.
 */
export function resolveTrustedRegistryManifestPath(
  rawManifestPath: string,
  pluginsRoot: string,
): string | null {
  const absolute = isAbsolute(rawManifestPath)
    ? rawManifestPath
    : resolve(pluginsRoot, rawManifestPath);
  let realManifest: string;
  let realRoot: string;
  try {
    realManifest = realpathSync(absolute);
    realRoot = realpathSync(pluginsRoot);
  } catch {
    return null;
  }
  return isPathContained(realRoot, realManifest) ? absolute : null;
}

/**
 * Boolean form, kept for call sites that already hold an absolute path and
 * only need the verdict. Prefer {@link resolveTrustedRegistryManifestPath} —
 * it cannot be handed an unresolved relative path by mistake.
 */
export function isTrustedRegistryManifestPath(
  manifestPath: string,
  pluginsRoot: string,
): boolean {
  return resolveTrustedRegistryManifestPath(manifestPath, pluginsRoot) !== null;
}
