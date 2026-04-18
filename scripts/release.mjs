#!/usr/bin/env node
/**
 * Production release builder.
 *
 * Steps:
 *   1. Read + patch-bump version in package.json
 *   2. bun run build (or npm fallback)
 *   3. Sign each bundled plugin's manifest (scripts/sign-manifest.mjs)
 *   4. electron-builder --publish=never → artifacts under ./release/
 *
 * Usage:  node scripts/release.mjs
 *
 * Credentials (signing certs, GH_TOKEN, etc.) must come from the environment
 * — never checked in. See docs/references/production-release-checklist.md.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pkgPath = resolve(root, "package.json");

function run(cmd, args, opts = {}) {
  console.log(`[release] $ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with code ${r.status}`);
  }
}

function bumpPatch(version) {
  const [maj, min, patch] = version.split(".").map((n) => parseInt(n, 10));
  if ([maj, min, patch].some(Number.isNaN)) {
    throw new Error(`Cannot parse version: ${version}`);
  }
  return `${maj}.${min}.${patch + 1}`;
}

async function main() {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const oldVersion = pkg.version;
  const newVersion = process.env.LVIS_RELEASE_VERSION ?? bumpPatch(oldVersion);
  console.log(`[release] version: ${oldVersion} → ${newVersion}`);
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

  const useBun = process.env.LVIS_USE_NPM !== "1" && existsSync(resolve(root, "bun.lockb"));
  run(useBun ? "bun" : "npm", ["run", useBun ? "build" : "build:npm"]);

  const signKey = process.env.LVIS_PUBLISHER_PRIVATE_KEY_PATH;
  if (signKey) {
    const pluginManifests = [
      "../lvis-plugin-pageindex/plugin.json",
      "../lvis-plugin-meeting/plugin.json",
      "../lvis-plugin-email/plugin.json",
      "../lvis-plugin-calendar/plugin.json",
    ];
    for (const rel of pluginManifests) {
      const abs = resolve(root, rel);
      if (!existsSync(abs)) continue;
      run("node", ["scripts/sign-manifest.mjs", abs]);
    }
  } else {
    console.warn("[release] LVIS_PUBLISHER_PRIVATE_KEY_PATH not set — skipping plugin signing");
  }

  run("npx", ["electron-builder", "--publish=never"]);

  console.log(`[release] done. Artifacts in release/  (version ${newVersion})`);
}

main().catch((err) => {
  console.error("[release] FAILED:", err);
  process.exit(1);
});
