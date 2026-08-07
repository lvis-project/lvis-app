/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/permissions/checker.py
 * Copyright (c) 2025 OpenHarness Contributors
 *
 * ─────────────────────────────────────────────────────────
 *
 * Sensitive Path Patterns — Tier S1+S2
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
 * Permission policy — frozen-canonical algorithm + sensitive-path expansion
 * (security review hardening):
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
import { globMatch } from "../lib/glob-matcher.js";

/**
 * Bounded walk-up depth used by {@link canonicalizePathForMatch} when the
 * input path does not yet exist on disk. We try `realpathSync.native()` on
 * progressively higher ancestors until we find one that exists, then
 * compose `<resolvedAncestor>/<remainder>`. Capped to defend against
 * adversarial inputs (deep paths, symlink cycles).
 */
export const MAX_WALK_UP = 64;

/**
 * One entry in the LVIS-home sensitive namespace — the single authority for
 * "which `<lvisHome>/…` paths are secret".
 *
 * TWO enforcement points consume this table and neither may restate it:
 *   - the in-process host-tool guard, via the glob projection baked into
 *     {@link SENSITIVE_PATH_PATTERNS} below (anchor-free `**` patterns, because
 *     the host guard matches an already-canonicalized absolute path); and
 *   - the OS sandbox read/write deny floor, via
 *     `getDefaultSensitiveReadDenyPaths` in `src/permissions/asrt-sandbox.ts`
 *     (literal absolute paths anchored on `lvisHome()` at CALL time, because
 *     bwrap/seatbelt cannot glob and `LVIS_HOME` can move between calls).
 *
 * Those two shapes are why the table stores segments rather than strings: each
 * side projects the same rows into the form its enforcement point can consume.
 * Adding a row here denies the path on BOTH surfaces; there is no second list
 * to mirror it into.
 */
export interface LvisHomeSensitiveEntry {
  /** Path segments below the LVIS home root (`~/.lvis` unless `LVIS_HOME`). */
  readonly segments: readonly string[];
  /** `dir` denies the directory and everything under it; `file` one path. */
  readonly kind: "dir" | "file";
  /**
   * Also deny `<name>.*` rotations. Host-glob only — a rotation glob has no
   * literal form, so the sandbox floor covers the base file only.
   */
  readonly rotations?: true;
  /** Why this is secret. Kept next to the row so neither side drifts alone. */
  readonly why: string;
}

/**
 * The LVIS-home sensitive namespace. Order is the projection order for
 * {@link SENSITIVE_PATH_PATTERNS}; both projections dedupe, so it carries no
 * meaning beyond which pattern string a match reports.
 */
export const LVIS_HOME_SENSITIVE_ENTRIES: readonly LvisHomeSensitiveEntry[] = Object.freeze([
  { segments: ["certs"], kind: "dir", why: "corporate CA bundle + extracted certs" },
  { segments: ["secrets"], kind: "dir", why: "encrypted API keys, tokens" },
  { segments: ["keys"], kind: "dir", why: "signing / encryption keys" },
  { segments: ["lvis-secrets.json"], kind: "file", why: "legacy consolidated secrets file" },
  { segments: ["settings.json"], kind: "file", why: "app settings + permission configuration" },
  { segments: ["permissions.json"], kind: "file", why: "legacy/current permission settings file" },
  { segments: ["policy.json"], kind: "file", why: "policy SOT" },
  {
    segments: ["permissions"],
    kind: "dir",
    why: "reviewer cache, deferred queue, permission state",
  },
  { segments: ["audit"], kind: "dir", why: "audit log directory (self-tampering)" },
  { segments: ["audit.log"], kind: "file", rotations: true, why: "audit log + rotated archives" },
  { segments: ["sessions"], kind: "dir", why: "chat session JSONL" },
  { segments: ["routine"], kind: "dir", why: "routine v2 session history" },
  {
    segments: ["plugins", "auth-partitions.json"],
    kind: "file",
    why: "plugin auth-partition state (OAuth partition mapping)",
  },
]);

/**
 * Host-tool glob projection of {@link LVIS_HOME_SENSITIVE_ENTRIES}.
 *
 * Anchor-free (`**` prefix) because the host guard matches a canonicalized
 * absolute path and `LVIS_HOME` may point anywhere. A `dir` row needs only the
 * `/**` form: `policyMatchPaths` also tries `<path>/`, so `**\/.lvis/certs/**`
 * already matches the bare directory.
 */
function lvisHomeSensitiveGlobs(): readonly string[] {
  const globs: string[] = [];
  for (const entry of LVIS_HOME_SENSITIVE_ENTRIES) {
    const base = "**/.lvis/" + entry.segments.join("/");
    globs.push(entry.kind === "dir" ? base + "/**" : base);
    if (entry.rotations) globs.push(base + ".*");
  }
  return globs;
}

/**
 * Patterns use minimatch-compatible glob syntax:
 *   double-star  — matches any path (including path separators)
 *   single-star  — matches any single path segment
 *
 * Ordering: credential store patterns first, then OS expansion, then LVIS-specific.
 */
export const SENSITIVE_PATH_PATTERNS: readonly string[] = Object.freeze([
  // ── Credential store patterns adapted from OpenHarness ─────────────
  "**/.ssh/**", // SSH keys and config
  "**/.aws/credentials", // AWS static credentials
  "**/.aws/config", // AWS profile/region config
  "**/.config/gcloud/**", // GCP credentials
  "**/.azure/**", // Azure credentials
  "**/.gnupg/**", // GPG keys
  "**/.docker/config.json", // Docker registry credentials
  "**/.kube/config", // Kubernetes credentials
  // ── Permission policy P2.5 — OS sensitive paths ───────
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
  // ── LVIS-home sensitive namespace ───────────────────
  // Projected from LVIS_HOME_SENSITIVE_ENTRIES so the host guard and the OS
  // sandbox deny floor cannot drift. Do NOT hand-add a `**/.lvis/…` pattern
  // here — add a row to the table instead.
  ...lvisHomeSensitiveGlobs(),
  "**/lvis-secrets.json", // shallow sibling form (not under the LVIS home root)
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
    .replace(/\\/g, "/")
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
 * Returns the path-policy tuple `[path, path + "/"]` used by the
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
