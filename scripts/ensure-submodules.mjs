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
 *   3. Syncs the freshly built `dist/` into `node_modules/<pkg-name>/dist/` if
 *      a real-directory copy already exists there. On Windows with
 *      `--install-links=true`, npm snapshots the submodule source (empty dist)
 *      into node_modules before this script runs, so the runtime import
 *      `@lvis/plugin-sdk/keys` resolves to a stale copy without step 3.
 *      On macOS without `--install-links`, node_modules/@lvis/plugin-sdk is a
 *      symlink — we detect that and skip (the symlink sees fresh dist for
 *      free).
 *
 * Safe to run multiple times: no-ops when dist already exists and submodules
 * are populated. Not a git checkout (tarball install) → exits 0.
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
const built = [];
for (const p of paths) {
  const full = join(repoRoot, p);
  const pkgJson = join(full, "package.json");
  const distDir = join(full, "dist");
  if (!existsSync(pkgJson)) continue;
  if (existsSync(distDir)) {
    built.push(p);
    continue;
  }

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
    built.push(p);
  } catch (err) {
    console.error(
      `[ensure-submodules] failed to build submodule ${p}. Please run manually:\n` +
        `  cd ${p} && npm install && npm run build`,
    );
    process.exit(1);
  }
}

// Step 3: on Windows (--install-links=true) the submodule was copied into
// node_modules BEFORE this script built its dist. Detect a real-directory
// copy and sync dist/ into it. Skip symlinks (macOS default) — the symlink
// already sees the freshly built dist.
for (const p of paths) {
  const full = join(repoRoot, p);
  const pkgJson = join(full, "package.json");
  const submoduleDist = join(full, "dist");
  if (!existsSync(pkgJson)) continue;
  if (!existsSync(submoduleDist)) continue;

  // Read package name — the node_modules path uses `name`, not the submodule
  // directory basename (e.g. `packages/plugin-sdk` → `@lvis/plugin-sdk`).
  let name;
  try {
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
    name = typeof pkg.name === "string" ? pkg.name : null;
  } catch {
    continue;
  }
  if (!name) continue;

  const hostPkgDir = join(repoRoot, "node_modules", ...name.split("/"));
  if (!existsSync(hostPkgDir)) continue;

  // Skip if it's a symlink — the link already points at the live submodule
  // source, so the freshly built dist/ is visible without copy.
  try {
    const st = lstatSync(hostPkgDir);
    if (st.isSymbolicLink()) continue;
  } catch {
    continue;
  }

  const hostDist = join(hostPkgDir, "dist");
  console.log(`[ensure-submodules] syncing ${p}/dist → node_modules/${name}/dist`);
  try {
    rmSync(hostDist, { recursive: true, force: true });
    cpSync(submoduleDist, hostDist, { recursive: true });
  } catch (err) {
    console.error(
      `[ensure-submodules] failed to sync ${name}: ${(err instanceof Error ? err.message : String(err))}`,
    );
    process.exit(1);
  }
}
