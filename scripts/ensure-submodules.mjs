#!/usr/bin/env node
/**
 * Guard: ensure git submodules (e.g. packages/plugin-sdk) are populated AND
 * built so the host can import `@lvis/plugin-sdk/keys` at runtime.
 *
 * Fresh `git clone` without `--recurse-submodules` leaves submodule directories
 * empty — breaks TypeScript resolution (TS2307). `--recurse-submodules` populates
 * source but `dist/` still needs a separate build, and `@lvis/plugin-sdk/keys`
 * resolves to `packages/plugin-sdk/dist/keys.js` which won't exist until that
 * build runs. Without it the Electron main process throws at startup:
 *   Cannot find module '@lvis/plugin-sdk/keys'
 *
 * This script:
 *   1. Initializes empty submodules via `git submodule update --init --recursive`
 *   2. For each submodule that has a `package.json` and no `dist/` yet, runs
 *      `npm install --no-audit --no-fund && npm run build`
 *
 * Safe to run multiple times: no-ops when dist already exists and submodules
 * are populated. Not a git checkout (tarball install) → exits 0.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const gitMarker = join(repoRoot, ".git");
if (!existsSync(gitMarker)) {
  // Not a git checkout (e.g. installed as tarball) — nothing to do.
  process.exit(0);
}

const gitmodules = join(repoRoot, ".gitmodules");
if (!existsSync(gitmodules)) {
  process.exit(0);
}

// Minimal parse: list submodule paths.
const content = readFileSync(gitmodules, "utf8");
const paths = [...content.matchAll(/^\s*path\s*=\s*(.+)$/gm)].map((m) =>
  m[1].trim(),
);

const empty = paths.filter((p) => {
  const full = join(repoRoot, p);
  try {
    if (!existsSync(full)) return true;
    const entries = readdirSync(full);
    return entries.length === 0;
  } catch {
    return true;
  }
});

if (empty.length > 0) {
  console.log(
    `[ensure-submodules] empty submodules detected: ${empty.join(", ")}`,
  );
  console.log(
    "[ensure-submodules] running: git submodule update --init --recursive",
  );
  try {
    execSync("git submodule update --init --recursive", {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } catch (err) {
    console.error(
      "[ensure-submodules] failed to initialize submodules. Please run manually:\n" +
        "  git submodule update --init --recursive",
    );
    process.exit(1);
  }
}

// Step 2: build any submodule that has a package.json but no dist/.
// Fresh clones (even with --recurse-submodules) ship source only; the host's
// runtime import of `@lvis/plugin-sdk/keys` needs the compiled JS. Idempotent:
// if `dist/` already exists we trust it (users can `npm run clean` to force).
for (const p of paths) {
  const full = join(repoRoot, p);
  const pkgJson = join(full, "package.json");
  const distDir = join(full, "dist");
  if (!existsSync(pkgJson)) continue;
  if (existsSync(distDir)) continue;

  console.log(`[ensure-submodules] building submodule: ${p}`);
  try {
    execSync("npm install --no-audit --no-fund --loglevel=error", {
      cwd: full,
      stdio: "inherit",
    });
    execSync("npm run build", {
      cwd: full,
      stdio: "inherit",
    });
  } catch (err) {
    console.error(
      `[ensure-submodules] failed to build submodule ${p}. Please run manually:\n` +
        `  cd ${p} && npm install && npm run build`,
    );
    process.exit(1);
  }
}
