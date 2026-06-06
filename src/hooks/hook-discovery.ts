/**
 * Permission policy — Layer 6 hook discovery + trust lockfile.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 6
 * "Boot-time hash check + explicit trust registration".
 *
 * Discovers individual `pre-*.sh`, `post-*.sh`, `perm-*.sh` files under
 * `~/.config/lvis/hooks/`. Computes sha256 hashes and compares against
 * `~/.config/lvis/hooks/.lockfile.json` to surface the boot-time trust diff:
 *
 *   - **fresh install** (no lockfile, hooks present) → all hooks treated
 *     as `new`.
 *   - **post-install change** → hooks whose hash drifted from the
 *     lockfile show up as `changed`.
 *   - **new hook added** → hashes that aren't in the lockfile show up
 *     as `new`.
 *   - **hook removed** → entries in the lockfile that no longer exist
 *     on disk show up as `removed`.
 *
 * On explicit trust (`/permission hooks accept <name>`) → lockfile rewritten
 * with the current hashes. On reject/quarantine → the offending file is moved
 * to a `.disabled/` subfolder so it won't run on subsequent boots.
 *
 * **Atomic cutover (CLAUDE.md No-Fallback):** if `~/.config/lvis/hooks/`
 * does not exist, boot creates an empty directory and emits no warn —
 * v1 user-decision is "ship empty" (spec §11 v2.1). No lockfile bootstrap.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve as pathResolve } from "node:path";
import { createHash } from "node:crypto";
import { withFileLock } from "../lib/with-file-lock.js";
import { createLogger } from "../lib/logger.js";
import type { ScriptHookType } from "./script-hook-types.js";

const log = createLogger("hook-discovery");

export interface DiscoveredHook {
  /** Absolute path to the .sh file. */
  path: string;
  /** Filename relative to the hooks directory. */
  fileName: string;
  /** Parsed hook type from filename prefix. */
  hookType: ScriptHookType;
  /** sha256 of file contents (hex). */
  sha256: string;
  /** Bytes (for diagnostics). */
  size: number;
  /**
   * Optional tool-name matcher (#811 hooks-on-mcp-calls). Parsed from a
   * `# lvis-hook-matcher: <glob>` frontmatter line; when present the hook runs
   * ONLY for tool calls whose name matches the glob (e.g. `mcp_*` for every MCP
   * tool, `mcp_hr_*` for one server). Absent ⇒ runs for every tool (unchanged).
   */
  matcher?: string;
}

export type LockfileTrustState = "new" | "changed" | "trusted" | "removed";

export interface LockfileEntry {
  fileName: string;
  sha256: string;
  /** ISO timestamp when first accepted by user. */
  acceptedAt: string;
}

export interface LockfileShape {
  /** Schema version — bump when shape changes. */
  schemaVersion: 1;
  /** Last update timestamp. */
  updatedAt: string;
  /** Per-hook trusted entries. */
  hooks: LockfileEntry[];
}

export interface HookDiff {
  hook: DiscoveredHook;
  state: LockfileTrustState;
  /** Last-known hash from lockfile (only set for `changed` / `removed`). */
  previousSha256?: string;
}

/**
 * Default hooks directory. Per spec §3 Layer 6 v1 the directory lives
 * outside `~/.lvis/` so a compromised LVIS process cannot mutate it.
 */
export function defaultHooksDir(): string {
  return pathResolve(homedir(), ".config", "lvis", "hooks");
}

/** Default lockfile path inside the hooks directory. */
export function defaultLockfilePath(): string {
  return pathResolve(defaultHooksDir(), ".lockfile.json");
}

/**
 * Default disabled subfolder. Hooks rejected by the trust-registration
 * workflow are relocated here so they survive on disk for inspection but do
 * not run.
 */
export function defaultDisabledDir(): string {
  return pathResolve(defaultHooksDir(), ".disabled");
}

/**
 * Ensure the hooks directory exists with mode 0o700. v1 boot calls this
 * unconditionally — the directory is the supply-chain root and must be
 * present before discovery runs.
 */
export function ensureHooksDirectory(dir: string = defaultHooksDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function hookTypeFromName(fileName: string): ScriptHookType | null {
  const lower = fileName.toLowerCase();
  if (extname(lower) !== ".sh") return null;
  if (lower.startsWith("pre-")) return "pre";
  if (lower.startsWith("post-")) return "post";
  if (lower.startsWith("perm-")) return "perm";
  return null;
}

/** Parse the optional `# lvis-hook-matcher: <glob>` frontmatter directive. */
function parseMatcher(buf: Buffer): string | undefined {
  // Only scan the first 1KB (the directive must be in the header comment block).
  const head = buf.subarray(0, 1024).toString("utf-8");
  const m = head.match(/^#\s*lvis-hook-matcher:\s*(\S+)\s*$/m);
  return m ? m[1] : undefined;
}

function sha256OfFile(path: string): { sha256: string; size: number; matcher?: string } {
  const buf = readFileSync(path);
  return {
    sha256: createHash("sha256").update(buf).digest("hex"),
    size: buf.byteLength,
    matcher: parseMatcher(buf),
  };
}

/**
 * Does a hook apply to a tool call? A hook with no matcher applies to every tool
 * (unchanged behavior); a hook with a matcher applies only when the glob matches
 * the tool name. Glob: `*` → any run of chars, `?` → one char; anchored.
 */
export function hookMatchesTool(matcher: string | undefined, toolName: string): boolean {
  if (!matcher) return true;
  const regex = new RegExp(
    "^" +
      matcher
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return regex.test(toolName);
}

/**
 * Discover all valid hook scripts under `dir`. Files that don't match
 * the `pre-* | post-* | perm-*` naming convention are silently
 * skipped (they may be README, .gitignore, the lockfile itself, etc.).
 *
 * The `.disabled/` subfolder is NEVER walked.
 */
export function discoverHooks(dir: string = defaultHooksDir()): DiscoveredHook[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    log.warn("hook-discovery: failed to read dir %s: %s", dir, (err as Error).message);
    return [];
  }
  const out: DiscoveredHook[] = [];
  for (const fileName of entries) {
    if (fileName.startsWith(".")) continue; // skip dotfiles + .disabled/.lockfile
    const path = join(dir, fileName);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const hookType = hookTypeFromName(fileName);
    if (!hookType) continue;
    let h: { sha256: string; size: number; matcher?: string };
    try {
      h = sha256OfFile(path);
    } catch (err) {
      log.warn("hook-discovery: hash failed for %s: %s", path, (err as Error).message);
      continue;
    }
    out.push({ path, fileName, hookType, sha256: h.sha256, size: h.size, matcher: h.matcher });
  }
  // Stable order — alphabetical by fileName so list/review surfaces show
  // the same order every time.
  out.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return out;
}

/**
 * Read the lockfile. Missing file → null (treat all hooks as "new").
 * Malformed → null + warn (atomic cutover: do NOT silently allow).
 */
export function readLockfile(path: string = defaultLockfilePath()): LockfileShape | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as LockfileShape;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.hooks)) {
      log.warn("hook-discovery: lockfile schema mismatch at %s — treating as missing", path);
      return null;
    }
    return parsed;
  } catch (err) {
    log.warn("hook-discovery: lockfile read failed %s: %s", path, (err as Error).message);
    return null;
  }
}

/**
 * Diff discovered hooks against the lockfile. The `removed` state is
 * informational — entries the lockfile knew about but are no longer on
 * disk. Caller may surface this in a review surface for transparency but does
 * NOT need user action (the file is already gone).
 */
export function diffAgainstLockfile(
  discovered: DiscoveredHook[],
  lockfile: LockfileShape | null,
): HookDiff[] {
  const out: HookDiff[] = [];
  const known = new Map<string, LockfileEntry>();
  if (lockfile) {
    for (const e of lockfile.hooks) known.set(e.fileName, e);
  }
  for (const hook of discovered) {
    const prev = known.get(hook.fileName);
    if (!prev) {
      out.push({ hook, state: "new" });
      continue;
    }
    if (prev.sha256 !== hook.sha256) {
      out.push({ hook, state: "changed", previousSha256: prev.sha256 });
      continue;
    }
    out.push({ hook, state: "trusted" });
  }
  // Removed entries — present in lockfile but not on disk.
  const seen = new Set(discovered.map((d) => d.fileName));
  if (lockfile) {
    for (const e of lockfile.hooks) {
      if (!seen.has(e.fileName)) {
        out.push({
          // Synthetic DiscoveredHook for symmetry — caller treats `state="removed"` as informational.
          hook: {
            path: "",
            fileName: e.fileName,
            hookType: hookTypeFromName(e.fileName) ?? "pre",
            sha256: e.sha256,
            size: 0,
          },
          state: "removed",
          previousSha256: e.sha256,
        });
      }
    }
  }
  return out;
}

/**
 * Persist a new lockfile reflecting the *current* set of trusted hooks.
 * Atomic write under `withFileLock` so concurrent boots don't corrupt.
 *
 * `acceptedHooks` is the subset of discovered hooks explicitly trusted by
 * user-keyboard command. Untrusted hooks should NOT appear here; the caller
 * should have already moved them to `.disabled/`.
 */
export async function persistLockfile(
  acceptedHooks: DiscoveredHook[],
  lockfilePath: string = defaultLockfilePath(),
  previousAcceptedAt?: Map<string, string>,
): Promise<LockfileShape> {
  const now = new Date().toISOString();
  const next: LockfileShape = {
    schemaVersion: 1,
    updatedAt: now,
    hooks: acceptedHooks.map((h) => ({
      fileName: h.fileName,
      sha256: h.sha256,
      acceptedAt: previousAcceptedAt?.get(h.fileName) ?? now,
    })),
  };
  await withFileLock(lockfilePath, async () => {
    mkdirSync(dirname(lockfilePath), { recursive: true, mode: 0o700 });
    writeFileSync(lockfilePath, JSON.stringify(next, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  });
  return next;
}

/**
 * Move a rejected hook into the `.disabled/` subfolder. Idempotent —
 * if the destination already exists (user previously rejected then
 * re-rejected the same name) appends a timestamp suffix so we keep
 * forensic copies.
 */
export function disableHook(
  hook: DiscoveredHook,
  disabledDir: string = defaultDisabledDir(),
): string {
  mkdirSync(disabledDir, { recursive: true, mode: 0o700 });
  let dest = join(disabledDir, hook.fileName);
  if (existsSync(dest)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    dest = join(disabledDir, `${hook.fileName}.${ts}`);
  }
  renameSync(hook.path, dest);
  return dest;
}

/**
 * Convenience: build a fileName→acceptedAt map from a lockfile so
 * subsequent persist calls preserve the original `acceptedAt` for
 * trusted-and-still-trusted hooks.
 */
export function buildAcceptedAtMap(lockfile: LockfileShape | null): Map<string, string> {
  const out = new Map<string, string>();
  if (lockfile) {
    for (const e of lockfile.hooks) out.set(e.fileName, e.acceptedAt);
  }
  return out;
}
