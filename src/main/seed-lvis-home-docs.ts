import { app } from "electron";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  readFileSync,
  readdirSync,
  constants as fsConstants,
} from "node:fs";
import { join } from "node:path";
import { lvisHome } from "../shared/lvis-home.js";

/**
 * Seed user-facing reference docs into `~/.lvis/` on first launch.
 *
 * Currently seeds:
 *   - AGENTS.md — LVIS system reference for LLMs running inside the host
 *   - agents/*.md — built-in sub-agent profiles (executor, researcher,
 *     planner, explorer) for the `agent_spawn` tool
 *   - skills/*.md — built-in skills (report-writing, meeting-minutes,
 *     email-polish, decision-record, data-summary) for the `skill_load`
 *     tool. Shipping skills as files (not inline TS) lets users edit
 *     each prompt to match their team's tone/format.
 *   - prompts/*.md — built-in main-agent persona prompts. The composer
 *     selects one persona per turn; agents and skills stay on their own
 *     dynamic tool paths.
 *
 * Behavior (per file):
 *   - If `~/.lvis/<path>` does not exist → copy from packaged resources.
 *   - If it exists and is byte-identical to the packaged copy → no-op.
 *   - If it exists and diverges from the packaged copy → write the packaged
 *     version alongside as `~/.lvis/<path>.new` so the user can diff and
 *     decide whether to merge upgrade content into their copy.
 *
 * The user's edits are never overwritten — they may freely customize each
 * file to inject site-specific rules. The `.new` upgrade marker is the only
 * path by which an upgrade can communicate "there is new content to consider".
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

  seedOne(home, "AGENTS.md", result);
  seedDir(home, "agents", result);
  seedDir(home, "skills", result);
  seedDir(home, "prompts", result);
  return result;
}

function seedOne(
  home: string,
  filename: string,
  result: { seeded: string[]; upgraded: string[] },
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

  // User has an existing copy. Compare to the packaged snapshot; write a
  // .new sibling only when the packaged content differs. We read the
  // target directly instead of statSync→readFileSync so CodeQL doesn't
  // flag the stat-then-read pair as `js/file-system-race`. Buffer.equals
  // performs the length check internally, so the stat shortcut had no
  // semantic value anyway.
  try {
    if (readFileSync(target).equals(packagedBuf)) return;

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
 * matching `~/.lvis/<subdir>/` location. Each file uses the same per-file
 * seed/upgrade semantics as {@link seedOne} — first-boot copy, byte-identical
 * no-op, divergent write to `.new` marker.
 */
function seedDir(
  home: string,
  subdir: string,
  result: { seeded: string[]; upgraded: string[] },
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
    seedOne(home, join(subdir, entry), result);
  }
}

function resolvePackagedResource(name: string): string | null {
  // Packaged app: process.resourcesPath points to `.../<App>.app/Contents/Resources`
  // on macOS or `.../resources` on Windows/Linux. extraResources entries land here.
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, name);
    return existsSync(packaged) ? packaged : null;
  }

  // Dev mode: repo's `resources/` directory.
  const dev = join(process.cwd(), "resources", name);
  return existsSync(dev) ? dev : null;
}
