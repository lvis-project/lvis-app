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
 * Where a {@link SensitiveEntry}'s segments hang off.
 *
 *   - `lvis-home` — below the LVIS home root (`~/.lvis` unless `LVIS_HOME`).
 *   - `home`      — below the real user home (`os.homedir()`).
 *   - `root`      — below the filesystem root (`/etc/…`).
 *
 * The host-tool guard is anchor-INSENSITIVE by design: it matches a
 * canonicalized absolute path with an anchor-free `**\/` prefix, so a
 * credential store dropped outside the user's home (a copied `.ssh` under
 * `/tmp`, a second `HOME` in a container mount) is still caught. The anchor
 * exists for the OS sandbox floor, which needs a LITERAL absolute path because
 * bwrap/seatbelt cannot glob.
 */
type SensitiveAnchor = "lvis-home" | "home" | "root";

/**
 * One row of the sensitive-path hard-blocklist — the single authority for
 * "which filesystem paths are secret".
 *
 * TWO enforcement points consume this table and neither may restate it:
 *   - the in-process host-tool guard, via the glob projection baked into
 *     {@link SENSITIVE_PATH_PATTERNS} below (anchor-free `**` patterns, because
 *     the host guard matches an already-canonicalized absolute path); and
 *   - the OS sandbox read/write deny floor, via
 *     `getDefaultSensitiveReadDenyPaths` in `src/permissions/asrt-sandbox.ts`
 *     (literal absolute paths resolved at CALL time, because bwrap/seatbelt
 *     cannot glob and `LVIS_HOME` / `HOME` can move between calls).
 *
 * Those two shapes are why the table stores segments rather than strings: each
 * side projects the same rows into the form its enforcement point can consume.
 * Adding a row here denies the path on BOTH surfaces; there is no second list
 * to mirror it into.
 *
 * What is NOT in this table, and why:
 *   - patterns with a wildcard in the middle or a wildcard basename
 *     (`**\/.env.*`, `**\/id_rsa`, `**\/.config/**\/Login Data`) have no literal
 *     absolute form, so they stay host-guard-only in
 *     {@link SENSITIVE_PATH_PATTERNS}. This is the glob-vs-literal constraint
 *     the sandbox module documents, and it is the ONLY legitimate reason for a
 *     path to be secret on one surface and not the other.
 *   - `~/Library/Cookies` and `~/Library/Keychains` are a deliberate sandbox
 *     exclusion (encrypted-at-rest, outside ASRT's filesystem threat model) and
 *     stay host-guard-only for that recorded reason.
 */
export interface SensitiveEntry {
  /** Which root {@link segments} hangs off — see {@link SensitiveAnchor}. */
  readonly anchor: SensitiveAnchor;
  /** Path segments below the anchor. */
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
 * The sensitive-path table. Order is the projection order for
 * {@link SENSITIVE_PATH_PATTERNS}; both projections dedupe, so it carries no
 * meaning beyond which pattern string a match reports.
 */
export const SENSITIVE_PATH_ENTRIES: readonly SensitiveEntry[] = Object.freeze([
  // ── Standard credential / secret stores under the user home ──────────
  { anchor: "home", segments: [".ssh"], kind: "dir", why: "SSH private keys + config" },
  {
    anchor: "home",
    segments: [".aws"],
    kind: "dir",
    why: "AWS static credentials, profile config, and SSO token cache",
  },
  { anchor: "home", segments: [".azure"], kind: "dir", why: "Azure credentials" },
  { anchor: "home", segments: [".config", "gcloud"], kind: "dir", why: "GCP credentials" },
  {
    anchor: "home",
    segments: [".config", "gh"],
    kind: "dir",
    why: "GitHub CLI OAuth token (hosts.yml)",
  },
  {
    anchor: "home",
    segments: [".config", "git"],
    kind: "dir",
    why: "git credential config (credential.helper, stored tokens)",
  },
  { anchor: "home", segments: [".gitconfig"], kind: "file", why: "git global config (credential.helper, tokens)" },
  { anchor: "home", segments: [".git-credentials"], kind: "file", why: "plaintext git credential store" },
  { anchor: "home", segments: [".kube", "config"], kind: "file", why: "Kubernetes credentials" },
  { anchor: "home", segments: [".gnupg"], kind: "dir", why: "GPG private keyring" },
  { anchor: "home", segments: [".docker", "config.json"], kind: "file", why: "Docker registry credentials" },
  { anchor: "home", segments: [".npmrc"], kind: "file", why: "npm registry auth token" },
  { anchor: "home", segments: [".netrc"], kind: "file", why: "generic machine credentials" },
  { anchor: "home", segments: [".pgpass"], kind: "file", why: "PostgreSQL credentials" },
  // ── Shell / tool histories — routinely contain pasted secrets ────────
  { anchor: "home", segments: [".bash_history"], kind: "file", why: "shell history" },
  { anchor: "home", segments: [".zsh_history"], kind: "file", why: "shell history" },
  { anchor: "home", segments: [".python_history"], kind: "file", why: "REPL history" },
  { anchor: "home", segments: [".psql_history"], kind: "file", why: "psql history (may hold DSNs)" },
  { anchor: "home", segments: [".viminfo"], kind: "file", why: "editor history + register contents" },
  // ── LVIS hook scripts — supply-chain / re-exec protection ────────────
  {
    anchor: "home",
    segments: [".config", "lvis", "hooks"],
    kind: "dir",
    why: "hook supply-chain protection (host-executed scripts)",
  },
  // ── System account databases ─────────────────────────────────────────
  { anchor: "root", segments: ["etc", "shadow"], kind: "file", why: "system password hashes" },
  { anchor: "root", segments: ["etc", "sudoers"], kind: "file", why: "sudo policy" },
  { anchor: "root", segments: ["etc", "passwd-"], kind: "file", why: "passwd backup" },
  // ── LVIS home sensitive namespace ────────────────────────────────────
  { anchor: "lvis-home", segments: ["certs"], kind: "dir", why: "corporate CA bundle + extracted certs" },
  { anchor: "lvis-home", segments: ["secrets"], kind: "dir", why: "encrypted API keys, tokens" },
  { anchor: "lvis-home", segments: ["keys"], kind: "dir", why: "signing / encryption keys" },
  { anchor: "lvis-home", segments: ["lvis-secrets.json"], kind: "file", why: "legacy consolidated secrets file" },
  { anchor: "lvis-home", segments: ["settings.json"], kind: "file", why: "app settings + permission configuration" },
  { anchor: "lvis-home", segments: ["permissions.json"], kind: "file", why: "legacy/current permission settings file" },
  { anchor: "lvis-home", segments: ["policy.json"], kind: "file", why: "policy SOT" },
  {
    anchor: "lvis-home",
    segments: ["permissions"],
    kind: "dir",
    why: "reviewer cache, deferred queue, permission state",
  },
  { anchor: "lvis-home", segments: ["audit"], kind: "dir", why: "audit log directory (self-tampering)" },
  {
    anchor: "lvis-home",
    segments: ["audit.log"],
    kind: "file",
    rotations: true,
    why: "audit log + rotated archives",
  },
  { anchor: "lvis-home", segments: ["sessions"], kind: "dir", why: "chat session JSONL" },
  { anchor: "lvis-home", segments: ["routine"], kind: "dir", why: "routine v2 session history" },
  {
    anchor: "lvis-home",
    segments: ["plugins", "auth-partitions.json"],
    kind: "file",
    why: "plugin auth-partition state (OAuth partition mapping)",
  },
]);

/**
 * Host-tool glob projection of {@link SENSITIVE_PATH_ENTRIES}.
 *
 * Anchor-free (`**` prefix) for every anchor — see {@link SensitiveAnchor} for
 * why the host guard deliberately ignores the anchor. `lvis-home` rows keep the
 * literal `.lvis` segment in the glob because the glob cannot know where
 * `LVIS_HOME` points; a relocated LVIS home is still covered by the sandbox
 * floor, which resolves `lvisHome()` per call.
 *
 * A `dir` row needs only the `/**` form: `policyMatchPaths` also tries
 * `<path>/`, so `**\/.ssh/**` already matches the bare directory.
 */
function sensitiveEntryGlobs(): readonly string[] {
  const globs: string[] = [];
  for (const entry of SENSITIVE_PATH_ENTRIES) {
    const prefix = entry.anchor === "lvis-home" ? "**/.lvis/" : "**/";
    const base = prefix + entry.segments.join("/");
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
  // ── Projected from SENSITIVE_PATH_ENTRIES ───────────
  // The single authority the OS sandbox deny floor projects from too. Do NOT
  // hand-add a pattern here that has a literal absolute form — add a row to
  // the table instead, or the two surfaces drift.
  // Note: `**/etc/…` rows use the double-star prefix because frozen-canonical
  // realpath() resolves /etc → /private/etc on macOS; the double-star matches
  // both forms.
  ...sensitiveEntryGlobs(),
  // ── Host-guard-only: no literal absolute form (glob-vs-literal) ─────
  // bwrap/seatbelt cannot glob, so these cannot be projected onto the sandbox
  // floor. Each has a wildcard basename or a wildcard interior segment.
  "**/.config/**/Login Data", // browser credential DB, vendor dir varies
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
  "**/lvis-secrets.json", // shallow sibling form (not under the LVIS home root)
  // ── Host-guard-only: deliberate sandbox exclusion ───
  // Recorded in `getDefaultSensitiveReadDenyPaths`: encrypted-at-rest and
  // outside ASRT's filesystem threat model, so consciously not on the OS floor.
  "**/Library/Cookies/**",
  "**/Library/Keychains/**",
  // ── Electron userData dir — per-platform DEFAULT locations ──────────
  // Holds plugin OAuth session cookies/tokens (Partitions/), Cookies (SQLite),
  // and the safeStorage-encrypted lvis-secrets.json. The sandbox floor denies
  // the EXACT dir (it receives `app.getPath("userData")`, so it also covers
  // `--user-data-dir` / XDG_CONFIG_HOME / a productName rename); the host guard
  // can only pin the per-platform defaults as static globs.
  "**/Library/Application Support/LVIS/**",
  "**/AppData/Roaming/LVIS/**",
  "**/.config/LVIS/**",
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
