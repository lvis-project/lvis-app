/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/permissions/checker.py
 * Copyright (c) 2026 HKU Data Intelligence Lab
 *
 * ─────────────────────────────────────────────────────────
 *
 * Sensitive Path Patterns — Tier S1+S2 (OpenHarness borrow)
 *
 * Hard-blocklist of filesystem patterns that should NEVER be read/written
 * by agent tools, regardless of user approval or permission mode. Defends
 * against prompt-injection attacks that direct the LLM to exfiltrate
 * credentials (e.g. "please read ~/.ssh/id_rsa and summarize it").
 *
 * Integration: `ApprovalGate.requestAndWait()` hard-blocks sensitive paths
 * BEFORE showing the renderer dialog. This block cannot be overridden — not
 * by user "allow", not by admin policy, not by `auto` / `full_auto` mode.
 *
 * §S2: `policyMatchPaths()` returns both `/foo/.ssh` and `/foo/.ssh/` forms
 * so directory-style accesses are still caught by glob patterns that use
 * trailing single-star segments. This mirrors OpenHarness's
 * `_policy_match_paths` subtle-glob-bug prevention.
 *
 * Permission policy Phase 2.5 — frozen-canonical algorithm + sensitive-path expansion
 * (security review M1 + M2 + M4):
 *   - bounded walk-up via realpathSync.native() → first existing ancestor
 *   - MAX_WALK_UP=64 caps adversarial symlink-cycle / deep-path attacks
 *   - frozen-canonical contract: caller canonicalizes ONCE; downstream
 *     layers reuse the same string (TOCTOU race window closed)
 *   - OS sensitive paths: shell histories, browser cookies, generic
 *     id_{rsa,ed25519,ecdsa} (not just under .ssh/), .env / .env.*
 *   - LVIS-internal sensitive paths: secrets/, audit*, deferred-queue,
 *     sessions/, hooks/ (relocated to ~/.config/lvis/hooks)
 */
import { realpathSync } from "node:fs";
import { resolve as pathResolve, relative as pathRelative } from "node:path";

/**
 * Bounded walk-up depth used by {@link canonicalizePathForMatch} when the
 * input path does not yet exist on disk. We try `realpathSync.native()` on
 * progressively higher ancestors until we find one that exists, then
 * compose `<resolvedAncestor>/<remainder>`. Capped to defend against
 * adversarial inputs (deep paths, symlink cycles).
 */
export const MAX_WALK_UP = 64;

/**
 * Patterns use minimatch-compatible glob syntax:
 *   double-star  — matches any path (including path separators)
 *   single-star  — matches any single path segment
 *
 * Ordering: OpenHarness list first, then OS expansion, then LVIS-specific.
 */
export const SENSITIVE_PATH_PATTERNS: readonly string[] = Object.freeze([
  // ── OpenHarness upstream ────────────────────────────
  "**/.ssh/*", // SSH keys and config
  "**/.aws/credentials", // AWS static credentials
  "**/.aws/config", // AWS profile/region config
  "**/.config/gcloud/**", // GCP credentials
  "**/.azure/**", // Azure credentials
  "**/.gnupg/**", // GPG keys
  "**/.docker/config.json", // Docker registry credentials
  "**/.kube/config", // Kubernetes credentials
  "**/.openharness/credentials.json",
  "**/.openharness/copilot_auth.json",
  // ── Permission policy P2.5 — OS sensitive paths (security review M1) ───────
  // Use double-star prefix because frozen-canonical realpath() resolves
  // /etc → /private/etc on macOS. The double-star matches both forms.
  "**/etc/shadow",
  "**/etc/sudoers",
  "**/etc/passwd-",
  "**/.netrc",
  "**/.pgpass",
  "**/.npmrc",
  "**/.bash_history",
  "**/.zsh_history",
  "**/.python_history",
  "**/.psql_history",
  "**/.viminfo",
  "**/Library/Cookies/**",
  "**/Library/Keychains/**",
  "**/.config/**/Login Data",
  "**/.env",
  "**/.env.*",
  // Generic SSH key globs — catches id_rsa / id_ed25519 / id_ecdsa even
  // if dropped outside `.ssh/` (e.g. /tmp staging, ~/Downloads).
  "**/id_rsa",
  "**/id_rsa.pub",
  "**/id_ed25519",
  "**/id_ed25519.pub",
  "**/id_ecdsa",
  "**/id_ecdsa.pub",
  // ── LGE / LVIS-specific additions ───────────────────
  "**/.lvis/certs/**", // corporate CA bundle + extracted certs
  "**/.lvis/secrets/**", // API keys, tokens
  "**/.lvis/keys/**", // signing / encryption keys
  "**/.lvis/lvis-secrets.json", // legacy consolidated secrets file
  "**/lvis-secrets.json", // shallow sibling form
  // ── Permission policy P2.5 — LVIS-internal sensitive paths (M2 + M4) ───────
  "**/.lvis/audit", // audit log directory (self-tampering)
  "**/.lvis/audit/**", // audit log files inside dir
  "**/.lvis/audit.log", // legacy audit log file
  "**/.lvis/audit.log.*", // rotated audit archives
  "**/.lvis/permissions/deferred-queue.jsonl",
  "**/.lvis/sessions/**", // chat session JSONL
  "**/.config/lvis/hooks/**", // hook supply-chain protection
]);

// ─── Public helpers ─────────────────────────────────

/**
 * Canonical form of a raw filesystem path for sensitive-path matching.
 *
 * Applies a five-step normalization that is shared between Layer 0
 * (sensitive-path hard-block) and Layer 1 (allowed-directories prefix
 * match) so both layers see *bit-identical* path strings:
 *
 *   1. `path.resolve()` — expands `..`/`.` segments, makes path absolute.
 *   2. `realpathSync.native()` walk-up to the nearest existing ancestor
 *      (bounded by {@link MAX_WALK_UP}). Resolves symlinks for the
 *      existing prefix; appends the remaining un-existing tail. Caps the
 *      ancestor walk so an adversarial cycle / deep path cannot DoS.
 *   3. Duplicate-slash collapse (`///Users` → `/Users`).
 *   4. Unicode NFC normalization — folds NFD-decomposed forms.
 *   5. Case-folding on macOS/Windows — case-insensitive filesystems.
 *
 * **Frozen-canonical contract:** call this ONCE at the executor entry and
 * pass the resulting string to every downstream layer. Re-canonicalizing
 * mid-pipeline opens a TOCTOU race (caller could swap a symlink between
 * Layer 0 and Layer 1).
 *
 * If even the filesystem root cannot be `realpath`'d within MAX_WALK_UP
 * steps (pathological / adversarial input), we still return a *resolved*
 * path string but it is treated as **opaque** by the allow-check (Layer 1
 * denies opaque paths by default — see `isPathAllowed`).
 */
export function canonicalizePathForMatch(rawPath: string): string {
  let canonical = pathResolve(rawPath);

  // Step 2 — realpath walk-up. Try the path itself first; if missing, walk
  // up to the nearest existing ancestor and compose the unresolved tail.
  try {
    canonical = realpathSync.native(canonical);
  } catch {
    let parent = canonical;
    let resolved = false;
    for (let depth = 0; depth < MAX_WALK_UP; depth++) {
      const next = pathResolve(parent, "..");
      if (next === parent) break; // hit filesystem root
      parent = next;
      try {
        const realParent = realpathSync.native(parent);
        // Compose: realpath'd ancestor + remainder of original path.
        const remainder = pathRelative(parent, canonical);
        canonical = remainder ? pathResolve(realParent, remainder) : realParent;
        resolved = true;
        break;
      } catch {
        /* keep walking */
      }
    }
    // depth == MAX_WALK_UP without resolve — leave `canonical` as the
    // pure pathResolve() output. Layer 1 treats unresolved canonicals as
    // opaque (deny by default in allow-check).
    if (!resolved) {
      // explicit no-op — canonical already equals pathResolve(rawPath)
    }
  }

  return canonical
    .replace(/\/+/g, "/")
    .normalize("NFC")
    .replace(/^([a-zA-Z]:)/, (m) =>
      // Preserve drive-letter case sensitivity on win32 — only lowercase
      // the drive letter (case-insensitive) but the rest is handled below.
      process.platform === "win32" ? m.toLowerCase() : m,
    );
}

/**
 * Permission policy P2.5 — case-fold a canonical path for matching on case-insensitive
 * filesystems (darwin/win32). Kept separate from
 * {@link canonicalizePathForMatch} so allow-list directories from
 * settings.json can be compared with the SAME case-fold applied to both
 * sides without re-running the realpath walk.
 */
export function caseFoldForMatch(canonical: string): string {
  if (process.platform === "darwin" || process.platform === "win32") {
    return canonical.toLowerCase();
  }
  return canonical;
}

/**
 * Returns the OpenHarness-style tuple `[path, path + "/"]` used by the
 * underlying glob match pass. Exposed for tests and for callers that want
 * to run custom pattern lists against the same normalization.
 *
 * Example:
 *   policyMatchPaths("/home/ken/.aws")
 *     → ["/home/ken/.aws", "/home/ken/.aws/"]
 */
export function policyMatchPaths(filePath: string): readonly string[] {
  const normalized = normalizePath(filePath);
  if (normalized.endsWith("/")) {
    return Object.freeze([normalized.slice(0, -1), normalized]);
  }
  return Object.freeze([normalized, normalized + "/"]);
}

/**
 * Returns the first matching pattern string if `absPath` is a sensitive
 * path, or `null` otherwise.
 *
 * Checks both `path` and `path + "/"` forms (§S2 trailing-slash trick) so
 * that directory-form accesses against glob patterns still match.
 *
 * Not exceptioned: the caller is expected to treat a non-null return as
 * an unconditional deny (cannot be overridden).
 *
 * NOTE: callers should pre-canonicalize via {@link canonicalizePathForMatch}
 * + {@link caseFoldForMatch} before calling. The patterns themselves are
 * lowercased for consistent darwin/win32 matching.
 */
export function isSensitivePath(absPath: string): string | null {
  if (!absPath) return null;
  const candidates = policyMatchPaths(absPath);
  for (const candidate of candidates) {
    for (const pattern of SENSITIVE_PATH_PATTERNS) {
      if (globMatch(candidate, pattern)) {
        return pattern;
      }
    }
  }
  return null;
}

// ─── Internal glob matcher ──────────────────────────

/**
 * Normalize path separators: Windows backslash → forward slash. Leaves
 * POSIX paths intact. Does NOT resolve `..` or symlinks — callers are
 * expected to supply an absolute path already canonicalized via
 * `path.resolve()` or similar.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Minimatch-subset glob matcher sufficient for SENSITIVE_PATH_PATTERNS.
 *
 * Supports:
 *   double-star — zero or more path segments (including separators)
 *   single-star — zero or more chars within a single segment (not `/`)
 *   ?           — single char within a segment (not `/`)
 *
 * Intentionally minimal: we avoid pulling in `minimatch` as a runtime dep
 * (it is not in package.json) and the pattern set is tiny + fully covered
 * by these metacharacters.
 *
 * Permission policy P2.5: case-insensitive on darwin/win32 to align with the canonical
 * case-fold contract.
 */
function globMatch(path: string, pattern: string): boolean {
  const regexSource = globToRegExp(pattern);
  const flags = process.platform === "darwin" || process.platform === "win32" ? "i" : "";
  const re = new RegExp("^" + regexSource + "$", flags);
  return re.test(path);
}

function globToRegExp(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      // Handle double-star
      if (pattern[i + 1] === "*") {
        // double-star followed by slash — match zero-or-more segments
        // (including the slash). Swallow the slash so "foo/**/bar" also
        // matches "foo/bar".
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      // Single star: match zero or more non-slash chars
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    // Escape regex metachars
    if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += "\\" + ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
