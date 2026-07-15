import { app } from "electron";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  openSync,
  readFileSync,
  readdirSync,
  constants as fsConstants,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";
import { lvisHome } from "../shared/lvis-home.js";
import * as atomicFile from "../lib/atomic-file.js";

export interface LvisHomeDocUpgradeMarker {
  sourcePath: string;
  markerPath: string;
}

const UPGRADE_MARKER_DOC_DIRS = ["", "skills", "prompts"] as const;

interface SeedOneOptions {
  upgradePolicy: "marker" | "seed-only";
  replaceableHashesResource?: string;
}

/**
 * Seed user-facing reference docs into `~/.lvis/` on first launch.
 *
 * Currently seeds:
 *   - AGENTS.md — LVIS system reference for LLMs running inside the host
 *   - agents/*.md — initial sub-agent profile examples (executor,
 *     researcher, planner, explorer) for the `agent_spawn` tool
 *   - skills/*.md — built-in skills (report-writing, meeting-minutes,
 *     email-polish, decision-record, data-summary) for the `skill_load`
 *     tool. Shipping skills as files (not inline TS) lets users edit
 *     each prompt to match their team's tone/format.
 *   - prompts/*.md — built-in main-agent persona prompts. The composer
 *     selects one persona per turn; agents and skills stay on their own
 *     dynamic tool paths.
 *
 * Behavior:
 *   - If `~/.lvis/<path>` does not exist → copy from packaged resources.
 *   - AGENTS.md replaces byte-identical known packaged copies in place.
 *     User-edited AGENTS.md, skills/*.md, and prompts/*.md instead offer
 *     divergent packaged updates as `~/.lvis/<path>.new` for review.
 *   - agents/*.md are seed-only. Shared agent operating guidance belongs in
 *     AGENTS.md; updating packaged agent profiles must not create a new
 *     apparent user agent such as `agents/executor.md.new`.
 *
 * User edits are never overwritten. In-place AGENTS.md replacement is gated by
 * an exact SHA-256 allowlist of previously shipped packaged bytes.
 *
 * Non-fatal — failures log and continue. Boot must not block on doc seeding.
 */
export function seedLvisHomeDocs(): { seeded: string[]; upgraded: string[] } {
  const result = { seeded: [] as string[], upgraded: [] as string[] };
  const home = lvisHome();

  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  } catch (err) {
    console.warn("[seed-lvis-home-docs] failed to ensure home dir:", err);
    return result;
  }

  seedOne(home, "AGENTS.md", result, {
    upgradePolicy: "marker",
    replaceableHashesResource: "AGENTS.md.replaceable-sha256",
  });
  seedDir(home, "agents", result, { upgradePolicy: "seed-only" });
  seedDir(home, "skills", result, { upgradePolicy: "marker" });
  seedDir(home, "prompts", result, { upgradePolicy: "marker" });
  return result;
}

export function listLvisHomeDocUpgradeMarkers(home = lvisHome()): LvisHomeDocUpgradeMarker[] {
  const markers: LvisHomeDocUpgradeMarker[] = [];
  for (const subdir of UPGRADE_MARKER_DOC_DIRS) {
    const dir = subdir.length > 0 ? join(home, subdir) : home;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const entry of entries) {
      if (!isUpgradeMarkerName(entry)) continue;
      const markerPath = subdir.length > 0 ? join(subdir, entry) : entry;
      markers.push({
        markerPath,
        sourcePath: sourcePathForUpgradeMarker(markerPath),
      });
    }
  }
  return markers.sort((a, b) => a.markerPath.localeCompare(b.markerPath));
}

function isUpgradeMarkerName(name: string): boolean {
  const markerIndex = name.indexOf(".md.new");
  if (markerIndex === -1) return false;
  const suffix = name.slice(markerIndex + ".md.new".length);
  return suffix === "" || suffix.startsWith(".");
}

function sourcePathForUpgradeMarker(markerPath: string): string {
  const markerIndex = markerPath.indexOf(".new");
  return markerIndex === -1 ? markerPath : markerPath.slice(0, markerIndex);
}

function seedOne(
  home: string,
  filename: string,
  result: { seeded: string[]; upgraded: string[] },
  options: SeedOneOptions,
): void {
  const packagedSource = resolvePackagedResource(filename);
  if (packagedSource === null) {
    console.warn(`[seed-lvis-home-docs] packaged ${filename} not found — skipping`);
    return;
  }

  // Read the packaged template ONCE at the top so subsequent comparisons
  // and writes work against an in-memory snapshot. This eliminates the
  // existsSync→readFileSync sequence CodeQL flags as `js/file-system-race`
  // (the rule fires on any read-then-read pattern in a try block, even
  // when the second read targets a stable packaged resource). The
  // packaged file ships with the installer and does not mutate between
  // launches, so one read is also the most efficient shape.
  let packagedBuf: Buffer;
  try {
    packagedBuf = readFileSync(packagedSource);
  } catch (err) {
    console.warn(`[seed-lvis-home-docs] failed to read packaged ${filename}:`, err);
    return;
  }

  const target = join(home, filename);
  const upgradeTarget = join(home, `${filename}.new`);
  const replaceableHashes = options.replaceableHashesResource
    ? readReplaceableHashes(options.replaceableHashesResource)
    : new Set<string>();

  if (!existsSync(target)) {
    try {
      // COPYFILE_EXCL closes the TOCTOU window between existsSync and the
      // write: if another process (concurrent boot from a second app
      // instance, background sync agent) lands a file in the gap, this
      // throws EEXIST and we honor their write rather than clobbering it.
      copyFileSync(packagedSource, target, fsConstants.COPYFILE_EXCL);
      enforceUserFileMode(target);
      result.seeded.push(filename);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
      console.warn(`[seed-lvis-home-docs] failed to seed ${filename}:`, err);
    }
    return;
  }

  if (options.upgradePolicy === "seed-only") return;

  // User has an existing copy. Compare to the packaged snapshot; write a
  // .new sibling only when the packaged content differs and the current bytes
  // are not a known packaged predecessor. We read the
  // target directly instead of statSync→readFileSync so CodeQL doesn't
  // flag the stat-then-read pair as `js/file-system-race`. Buffer.equals
  // performs the length check internally, so the stat shortcut had no
  // semantic value anyway.
  try {
    const currentBuf = readRegularFileNoFollow(target);
    if (currentBuf !== null) {
      if (currentBuf.equals(packagedBuf)) return;

      const currentHash = sha256(currentBuf);
      if (
        replaceableHashes.has(currentHash) &&
        replaceKnownPackagedCopy(target, packagedBuf, currentHash)
      ) {
        result.upgraded.push(filename);
        return;
      }
    }

    // If a previous `.new` is sitting unmerged, do not clobber it. Compare:
    //   - identical to the latest packaged content → no-op (already offered)
    //   - different → land a timestamped sibling so neither the user's
    //     review work nor the newer upgrade signal is lost.
    // try-read-catch-ENOENT instead of existsSync+readFileSync keeps the
    // check and read atomic.
    let existingUpgradeBuf: Buffer | null = null;
    try {
      existingUpgradeBuf = readFileSync(upgradeTarget);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (existingUpgradeBuf !== null) {
      if (existingUpgradeBuf.equals(packagedBuf)) return;
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const datedTarget = join(home, `${filename}.new.${ts}`);
      copyFileSync(packagedSource, datedTarget);
      enforceUserFileMode(datedTarget);
      result.upgraded.push(filename);
      return;
    }

    copyFileSync(packagedSource, upgradeTarget);
    enforceUserFileMode(upgradeTarget);
    result.upgraded.push(filename);
  } catch (err) {
    console.warn(`[seed-lvis-home-docs] failed to compare ${filename}:`, err);
  }
}

function readReplaceableHashes(resourceName: string): Set<string> {
  const resource = resolvePackagedResource(resourceName);
  if (resource === null) return new Set();

  try {
    const lines = readFileSync(resource, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => /^[a-f0-9]{64}$/.test(line));
    return new Set(lines);
  } catch (err) {
    console.warn("[seed-lvis-home-docs] failed to read replaceable hash list:", err);
    return new Set();
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Refuse symlinks and non-files before hashing a user-owned target. */
function readRegularFileNoFollow(target: string): Buffer | null {
  let fd: number | null = null;
  try {
    // lstat rejects an existing symlink on every platform, including Windows
    // where O_NOFOLLOW may be unavailable. O_NOFOLLOW then closes the
    // lstat→open swap window on platforms that provide it.
    if (!lstatSync(target).isFile()) return null;
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    fd = openSync(target, fsConstants.O_RDONLY | noFollow);
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Replace a prior packaged copy through the shared atomic-file primitive.
 * The successor is staged and fsynced first; immediately before rename, the
 * target must still be a regular file with the same allowlisted hash. A false
 * precondition or pre-commit failure leaves the original path intact and the
 * caller falls back to the non-clobbering `.new` path.
 */
function replaceKnownPackagedCopy(
  target: string,
  packagedBuf: Buffer,
  expectedHash: string,
): boolean {
  try {
    return atomicFile.replaceUtf8FileAtomicSyncIf(
      target,
      packagedBuf.toString("utf8"),
      () => {
        const latest = readRegularFileNoFollow(target);
        return latest !== null && sha256(latest) === expectedHash;
      },
      0o600,
    );
  } catch (err) {
    if ((err as { committed?: boolean }).committed === true) return true;
    console.warn("[seed-lvis-home-docs] failed to replace known packaged copy:", err);
    return false;
  }
}

/**
 * Storage-namespace rule: files under `~/.lvis/` are 0o600 (user-only).
 * On Windows chmod is effectively a no-op — wrap so the seed continues to
 * succeed there instead of treating the platform mismatch as a fatal error.
 */
function enforceUserFileMode(target: string): void {
  try {
    chmodSync(target, 0o600);
  } catch {
    // Windows / non-POSIX filesystem — best effort only.
  }
}

/**
 * Seed every `*.md` file from a packaged resource subdirectory into the
 * matching `~/.lvis/<subdir>/` location. The caller chooses whether existing
 * divergent user files get a non-clobbering `.new` marker or stay seed-only.
 */
function seedDir(
  home: string,
  subdir: string,
  result: { seeded: string[]; upgraded: string[] },
  options: SeedOneOptions,
): void {
  const packagedDir = resolvePackagedResource(subdir);
  if (packagedDir === null) {
    // No packaged templates for this subdir — fine for early dev tree, just skip.
    return;
  }

  const targetDir = join(home, subdir);
  try {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    console.warn(`[seed-lvis-home-docs] failed to ensure dir ${subdir}:`, err);
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(packagedDir);
  } catch (err) {
    console.warn(`[seed-lvis-home-docs] failed to scan ${subdir}:`, err);
    return;
  }

  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    seedOne(home, join(subdir, entry), result, options);
  }
}

function resolvePackagedResource(name: string): string | null {
  // Packaged app: process.resourcesPath points to `.../<App>.app/Contents/Resources`
  // on macOS or `.../resources` on Windows/Linux. extraResources entries land here.
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, name);
    return existsSync(packaged) ? packaged : null;
  }

  // Dev / vitest mode: repo's `resources/` directory.
  //
  // Anchor on THIS MODULE's own location and walk up to the first ancestor
  // that actually contains a `resources/skills` directory. This is fully
  // cwd-independent — it must NOT use `process.cwd()` (ensureWorkspaceCwd()
  // chdir()s the main process to `~/.lvis/workspace` before boot, so a
  // cwd-based join points at the nonexistent `~/.lvis/workspace/resources/`
  // and silently skips seeding) — and it must NOT use `app.getAppPath()`:
  // under `bun run start` the launcher runs `electron dist/src/main/main.js`
  // (a script-file arg), so getAppPath() resolves to the SCRIPT directory
  // `dist/src/main`, whose `resources/` does not exist.
  //
  // The module dir is `dist/src/main` in the esbuild bundle (climb 3 to the
  // repo root) and `src/main` under vitest (climb 2); the walk-up reaches the
  // repo root in both shapes without hardcoding a climb count.
  const root = packagedResourceRoot();
  if (root === null) return null;
  const dev = join(root, "resources", name);
  return existsSync(dev) ? dev : null;
}

/**
 * Walk up from this module's own directory to the first ancestor containing a
 * `resources/skills` directory, and return that ancestor (the repo root in
 * dev/vitest). Resolved once per process — the layout is fixed at build time.
 *
 * This is the resolution itself, not a guess-chain: if no ancestor carries a
 * `resources/` tree, there is no packaged-resource root to seed from and we
 * return null so the caller skips (genuine absence, not a papered-over bug).
 */
let cachedResourceRoot: string | null | undefined;
function packagedResourceRoot(): string | null {
  // Explicit override anchor: lets the unit test (and any out-of-tree
  // packaging layout) point the resolver at a known root WITHOUT mutating
  // process.cwd() or the module location. Not cached — the test sets a fresh
  // fixtures root per case via `beforeEach`.
  const override = process.env.LVIS_RESOURCE_ROOT?.trim();
  if (override) {
    return existsSync(join(override, "resources", "skills")) ? override : null;
  }

  if (cachedResourceRoot !== undefined) return cachedResourceRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  const fsRoot = parsePath(dir).root;
  for (;;) {
    if (existsSync(join(dir, "resources", "skills"))) {
      cachedResourceRoot = dir;
      return dir;
    }
    if (dir === fsRoot) break;
    dir = dirname(dir);
  }
  cachedResourceRoot = null;
  return null;
}
