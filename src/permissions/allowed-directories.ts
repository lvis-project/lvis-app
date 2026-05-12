/**
 * Layer 1 path policy — allowed directories module.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 1.
 *
 * Setting (~/.lvis/settings.json):
 * ```jsonc
 * {
 *   "permissions": {
 *     "additionalDirectories": ["~/workspace/lvis"]
 *   }
 * }
 * ```
 *
 * Default at runtime: `process.cwd()` ∪ `~/.lvis/` MINUS Layer 0 deny
 * paths (Layer 0 always wins; ~/.lvis/secrets is denied even if the
 * caller's allowed list contains ~/.lvis/).
 *
 * Frozen-canonical contract: callers MUST pre-canonicalize the input
 * path via `canonicalizePathForMatch` from `./sensitive-paths.js` and
 * then `caseFoldForMatch` for darwin/win32 case-insensitive prefix
 * compare. This module performs ONLY string prefix logic — never calls
 * `realpath` again (closes TOCTOU race).
 */
import { homedir } from "node:os";
import { resolve as pathResolve, sep as pathSep } from "node:path";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "./sensitive-paths.js";

/**
 * Directory addition pre-flight result.
 *
 * `ok: true` ⇒ caller may persist the directory to settings.
 * `ok: false` ⇒ caller MUST surface `reason` to the user (Layer 0
 * sensitive directory, root, or empty input).
 *
 * Even an `ok: true` result may carry `adjacencyWarnings[]` (e.g.
 * `.env`, `.git`, `.ssh`, `credentials`, `node_modules/.cache` adjacent)
 * which the renderer SHOULD render as a red banner with explicit opt-in.
 */
export type ValidateDirectoryResult =
  | { ok: true; canonicalPath: string; adjacencyWarnings: string[] }
  | { ok: false; reason: string; adjacencyWarnings: string[] };

const ADJACENCY_WARNING_BASENAMES = [
  ".env",
  ".git",
  ".ssh",
  "credentials",
] as const;

const ADJACENCY_WARNING_NESTED = [
  "node_modules/.cache",
] as const;

function normalizePolicySeparators(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Compute the host-default allow-list at boot.
 *
 * Default = `process.cwd()` ∪ `homedir()/.lvis` MINUS Layer 0 deny paths.
 * Returns canonicalized + case-folded entries ready to be passed to
 * {@link isPathAllowed}.
 */
export function computeDefaultAllowedDirectories(cwd: string = process.cwd()): string[] {
  return computeDefaultAllowedDirectoryEntries(cwd, true);
}

/**
 * Runtime filesystem roots for native tools. Unlike the Layer 1 matching
 * scope, these keep the OS canonical case so `realpath`-based sandbox checks
 * can validate the same directories without lowercasing path segments.
 */
export function computeDefaultRuntimeAllowedDirectories(cwd: string = process.cwd()): string[] {
  return computeDefaultAllowedDirectoryEntries(cwd, false);
}

function computeDefaultAllowedDirectoryEntries(cwd: string, foldCase: boolean): string[] {
  const candidates = [cwd, pathResolve(homedir(), ".lvis")];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const canonical = canonicalizePathForMatch(raw);
    const folded = caseFoldForMatch(canonical);
    const value = foldCase ? folded : canonical;
    if (isFilesystemRootPath(folded)) continue;
    // Layer 0 always wins — if a default candidate is itself sensitive,
    // skip it (the more-specific deny patterns inside still hard-block
    // any leaf access, so excluding the default is mostly hygiene).
    if (isSensitivePath(folded)) continue;
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(value);
  }
  return out;
}

/**
 * Sanitize a user-provided allow-list (e.g. from
 * `permissions.additionalDirectories` in settings.json).
 *
 * - Resolves `~` to `homedir()`.
 * - Canonicalizes via {@link canonicalizePathForMatch} + case-fold.
 * - Drops any entry that hits Layer 0 (sensitive path).
 * - De-duplicates.
 *
 * NOTE: this DOES NOT include the host defaults. Callers should
 * `[...computeDefaultAllowedDirectories(), ...sanitizeAllowedDirectories(...)]`
 * to assemble the final scope.
 */
export function sanitizeAllowedDirectories(input: readonly string[] | undefined): string[] {
  return sanitizeAllowedDirectoryEntries(input, true);
}

/**
 * Runtime filesystem roots for native tools. Applies the same validation as
 * {@link sanitizeAllowedDirectories} but preserves canonical OS case.
 */
export function sanitizeRuntimeAllowedDirectories(input: readonly string[] | undefined): string[] {
  return sanitizeAllowedDirectoryEntries(input, false);
}

function sanitizeAllowedDirectoryEntries(
  input: readonly string[] | undefined,
  foldCase: boolean,
): string[] {
  if (!input || input.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const expanded = expandHomeTilde(raw);
    if (isFilesystemRootPath(expanded)) continue;
    const canonical = canonicalizePathForMatch(expanded);
    const folded = caseFoldForMatch(canonical);
    const value = foldCase ? folded : canonical;
    if (isFilesystemRootPath(folded)) continue;
    if (isSensitivePath(folded)) continue;
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(value);
  }
  return out;
}

/**
 * Layer 1 prefix check.
 *
 * `canonicalPath` MUST already be canonicalized + case-folded by the
 * caller (frozen-canonical contract). `scope.directories` MUST come from
 * {@link sanitizeAllowedDirectories} or {@link computeDefaultAllowedDirectories}.
 *
 * Returns `true` iff `canonicalPath === dir` OR `canonicalPath` starts
 * with `dir + "/"` (segment-aligned). Pure string compare — no realpath.
 *
 * ALWAYS returns `false` for empty input (deny-by-default).
 */
export function isPathAllowed(
  canonicalPath: string,
  scope: { directories: readonly string[] },
): boolean {
  if (!canonicalPath) return false;
  if (!scope.directories || scope.directories.length === 0) return false;
  for (const dir of scope.directories) {
    if (!dir) continue;
    if (canonicalPath === dir) return true;
    // Use forward-slash separator since canonicalizePathForMatch
    // already collapsed duplicates and uses POSIX form internally.
    const sep = "/";
    if (canonicalPath.startsWith(dir + sep)) return true;
    // Edge case: directories may end with the platform separator on
    // win32 — accept either form.
    if (pathSep !== sep && canonicalPath.startsWith(dir + pathSep)) return true;
  }
  return false;
}

/**
 * Pick the **leaf-parent** of `canonicalPath` for the
 * "auto-suggest add directory" UX (§3 Layer 1 M3 strengthening).
 *
 * Spec rule: NEVER suggest the broadest common-prefix (`~/Documents/`).
 * ALWAYS suggest the immediate parent of the requested file
 * (`~/Documents/old-project/notes/today/`).
 *
 * Returns `null` if the leaf parent is already covered by `currentAllowed`,
 * or if the parent is a Layer 0 sensitive directory, or if `canonicalPath`
 * has no parent (filesystem root).
 *
 * @param canonicalPath leaf path (already canonicalized + case-folded).
 * @param currentAllowed scope from settings (already canonicalized).
 */
export function pickClosestParent(
  canonicalPath: string,
  currentAllowed: readonly string[],
): string | null {
  if (!canonicalPath) return null;
  const parent = caseFoldForMatch(canonicalizePathForMatch(pathResolve(canonicalPath, "..")));
  if (parent === canonicalPath) return null; // already at root
  if (isSensitivePath(parent)) return null;
  if (isPathAllowed(canonicalPath, { directories: currentAllowed })) return null;
  if (isPathAllowed(parent, { directories: currentAllowed })) return null;
  return parent;
}

/**
 * Pre-flight check before persisting a directory to
 * `additionalDirectories`. Surfaces three classes of problem:
 *
 * 1. Hard reject: empty / sensitive / filesystem root → `ok: false`.
 * 2. Soft warn: directory contains adjacent `.env` / `.git` / `.ssh` /
 *    `credentials` / `node_modules/.cache` → `ok: true` + warnings.
 *
 * Renderer is expected to render warnings as a red banner with an
 * explicit "I understand" checkbox before enabling the persist button.
 *
 * NOTE: this only inspects the directory PATH itself. It does NOT do a
 * filesystem walk to count files — tree-size preview (§3 Layer 1 M3
 * point 4) is a separate pass at the renderer layer.
 */
export function validateDirectoryAddition(rawPath: string): ValidateDirectoryResult {
  const adjacencyWarnings: string[] = [];
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return { ok: false, reason: "directory path is empty", adjacencyWarnings };
  }
  const expanded = expandHomeTilde(rawPath.trim());
  if (isFilesystemRootPath(expanded)) {
    return { ok: false, reason: "filesystem root is not allowed", adjacencyWarnings };
  }
  const canonical = canonicalizePathForMatch(expanded);
  const folded = caseFoldForMatch(canonical);

  // Reject filesystem root.
  if (isFilesystemRootPath(folded)) {
    return { ok: false, reason: "filesystem root is not allowed", adjacencyWarnings };
  }
  // Reject Layer 0 sensitive paths.
  const sensitive = isSensitivePath(folded);
  if (sensitive) {
    return {
      ok: false,
      reason: `path matches sensitive pattern '${sensitive}'`,
      adjacencyWarnings,
    };
  }

  // Adjacency hints — pure string heuristics on the basename / path
  // segments. We don't `readdir` the target; that is a renderer concern
  // (preview) and would also be a TOCTOU surface.
  const lowerFolded = normalizePolicySeparators(folded).toLowerCase();
  for (const basename of ADJACENCY_WARNING_BASENAMES) {
    if (
      lowerFolded.endsWith("/" + basename) ||
      lowerFolded.includes("/" + basename + "/")
    ) {
      adjacencyWarnings.push(
        `path contains '${basename}' segment — secrets may be exposed if added`,
      );
    }
  }
  for (const nested of ADJACENCY_WARNING_NESTED) {
    if (lowerFolded.includes("/" + nested.toLowerCase())) {
      adjacencyWarnings.push(
        `path contains '${nested}' — large cache directory, may impact performance`,
      );
    }
  }

  return { ok: true, canonicalPath: folded, adjacencyWarnings };
}

export function isFilesystemRootPath(foldedPath: string): boolean {
  const normalized = normalizePolicySeparators(foldedPath);
  if (normalized === "/") return true;

  const trimmed = normalized.replace(/\/+$/g, "");
  if (/^[a-z]:$/i.test(trimmed)) return true;
  if (/^\/\/[?.]\/[a-z]:$/i.test(trimmed)) return true;
  if (/^\/\/[?.]\/unc\/[^/]+\/[^/]+$/i.test(trimmed)) return true;
  if (/^\/\/[?.]\/volume\{[^/]+}(?:\/|$)/i.test(normalized)) return true;
  if (/^\/\/[?.]\/globalroot\/device\//i.test(normalized)) return true;
  return /^\/\/(?![?.]\/)[^/]+\/[^/]+$/i.test(trimmed);
}

/**
 * Assemble the live allow-list scope from defaults + user
 * additions, with Layer 0 sensitive paths filtered out.
 *
 * This is the canonical entry point used by the executor to construct
 * the `scope` argument to {@link isPathAllowed}. Order: defaults first,
 * then user additions (to keep the leaf-parent computation
 * deterministic).
 */
export function buildAllowedScope(
  userAdditions: readonly string[] | undefined,
): { directories: string[] } {
  const defaults = computeDefaultAllowedDirectories();
  const sanitized = sanitizeAllowedDirectories(userAdditions);
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const dir of [...defaults, ...sanitized]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    directories.push(dir);
  }
  return { directories };
}

/**
 * Assemble runtime filesystem roots for native tool sandbox checks. This is
 * intentionally separate from {@link buildAllowedScope}: Layer 1 matching uses
 * case-folded strings, while native tools need canonical OS paths.
 */
export function buildRuntimeAllowedDirectories(
  userAdditions: readonly string[] | undefined,
): string[] {
  const defaults = computeDefaultRuntimeAllowedDirectories();
  const sanitized = sanitizeRuntimeAllowedDirectories(userAdditions);
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const dir of [...defaults, ...sanitized]) {
    const folded = caseFoldForMatch(canonicalizePathForMatch(dir));
    if (seen.has(folded)) continue;
    seen.add(folded);
    directories.push(dir);
  }
  return directories;
}

// ─── helpers ─────────────────────────────────────────

/**
 * Resolve a leading `~` to `homedir()`. Pass-through for everything
 * else. Does not handle `~user` style (Posix only); unsupported by
 * design — spec scope is "current user's home only".
 */
function expandHomeTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return pathResolve(homedir(), p.slice(2));
  return p;
}
