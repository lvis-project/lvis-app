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
 */

/**
 * Patterns use minimatch-compatible glob syntax:
 *   double-star  — matches any path (including path separators)
 *   single-star  — matches any single path segment
 *
 * Ordering: OpenHarness list first, then LGE-specific additions.
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
  // ── LGE / LVIS-specific additions ───────────────────
  "**/.lvis/certs/**", // corporate CA bundle + extracted certs
  "**/.lvis/secrets/**", // API keys, tokens
  "**/.lvis/keys/**", // signing / encryption keys
  "**/.lvis/lvis-secrets.json", // legacy consolidated secrets file
  "**/lvis-secrets.json", // shallow sibling form
]);

// ─── Public helpers ─────────────────────────────────

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
 */
function globMatch(path: string, pattern: string): boolean {
  const regexSource = globToRegExp(pattern);
  const re = new RegExp("^" + regexSource + "$");
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
