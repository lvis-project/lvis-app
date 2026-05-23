import { app } from "electron";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  statSync,
  readFileSync,
  readdirSync,
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

  const target = join(home, filename);
  const upgradeTarget = join(home, `${filename}.new`);

  if (!existsSync(target)) {
    try {
      copyFileSync(packagedSource, target);
      result.seeded.push(filename);
    } catch (err) {
      console.warn(`[seed-lvis-home-docs] failed to seed ${filename}:`, err);
    }
    return;
  }

  // User has an existing copy. Compare to the packaged version; write a
  // .new sibling only when the packaged content differs.
  try {
    const a = statSync(target);
    const b = statSync(packagedSource);
    if (a.size === b.size) {
      const aBuf = readFileSync(target);
      const bBuf = readFileSync(packagedSource);
      if (aBuf.equals(bBuf)) return;
    }
    copyFileSync(packagedSource, upgradeTarget);
    result.upgraded.push(filename);
  } catch (err) {
    console.warn(`[seed-lvis-home-docs] failed to compare ${filename}:`, err);
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
