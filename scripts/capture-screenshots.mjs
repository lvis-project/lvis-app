#!/usr/bin/env node
// Standalone runner for the docs-site screenshot capture harness
// (test/screenshots/capture.spec.ts). Not wired into package.json scripts
// (out of the strict scope for this change) — invoke directly:
//
//   node scripts/capture-screenshots.mjs               # full matrix
//   node scripts/capture-screenshots.mjs --grep chat    # filter by key substring
//   node scripts/capture-screenshots.mjs --skip-build   # reuse an existing dist/
//
// Env:
//   LVIS_DEMO_ACTIVATION_CODE  — optional; only needed for scenarios that
//                                require demo-gated vendor login (none in the
//                                current matrix — see test/screenshots/README.md).
//
// Requires `bun install` to have been run in this worktree already (this
// script does not install dependencies).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const configPath = resolve(repoRoot, "test/screenshots/playwright.config.ts");
const mainEntry = resolve(repoRoot, "dist/src/main/main.js");

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const passthroughArgs = args.filter((a) => a !== "--skip-build");

function run(cmd, cmdArgs, opts = {}) {
  console.log(`[capture-screenshots] $ ${cmd} ${cmdArgs.join(" ")}`);
  const result = spawnSync(cmd, cmdArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (result.status !== 0) {
    console.error(`[capture-screenshots] "${cmd} ${cmdArgs.join(" ")}" failed (exit=${result.status})`);
    process.exit(result.status ?? 1);
  }
}

if (!skipBuild || !existsSync(mainEntry)) {
  console.log("[capture-screenshots] building app (dist/src/main/main.js missing or --skip-build not set)");
  run("bun", ["run", "build"]);
} else {
  console.log("[capture-screenshots] --skip-build set and dist/src/main/main.js exists — reusing existing build");
}

console.log("[capture-screenshots] running Playwright capture harness");
run("bunx", ["playwright", "test", "--config", configPath, ...passthroughArgs]);
