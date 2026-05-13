#!/usr/bin/env node
/**
 * Fail-closed package footprint audit for unpacked Electron builds.
 *
 * The production app should contain compiled LVIS assets plus production
 * runtime dependencies. Root source/docs/tests and dependency source maps or
 * docs add package size and cold-start I/O without helping runtime behavior.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const fallbackAppAsar = resolve(root, "release", "linux-arm64-unpacked", "resources", "app.asar");
const maxAppAsarMb = Number(process.env.LVIS_MAX_APP_ASAR_MB ?? "100");

function defaultAppAsarPath() {
  const releaseDir = resolve(root, "release");
  if (existsSync(releaseDir)) {
    const candidates = readdirSync(releaseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^linux-.+-unpacked$/.test(entry.name))
      .map((entry) => resolve(releaseDir, entry.name, "resources", "app.asar"))
      .filter((candidate) => existsSync(candidate));
    if (candidates.length === 1) return candidates[0];
  }
  return fallbackAppAsar;
}

const appAsar = resolve(root, process.argv[2] ?? defaultAppAsarPath());
const resourcesDir = dirname(appAsar);
const appOutDir = dirname(resourcesDir);

function fail(message, samples = []) {
  process.stderr.write(`[package-footprint] ERROR: ${message}\n`);
  for (const sample of samples.slice(0, 20)) {
    process.stderr.write(`  - ${sample}\n`);
  }
  process.exit(1);
}

function asarList(archivePath) {
  const asarBin = resolve(root, "node_modules", ".bin", process.platform === "win32" ? "asar.cmd" : "asar");
  if (!existsSync(asarBin)) fail(`asar CLI not found: ${asarBin}`);
  const result = spawnSync(asarBin, ["list", archivePath], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) fail(`failed to run asar list: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`asar list exited with code ${result.status}`, [result.stderr.trim()]);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

if (!existsSync(appAsar)) fail(`app.asar not found: ${appAsar}`);

const stat = statSync(appAsar);
const appAsarMb = stat.size / 1024 / 1024;
if (appAsarMb > maxAppAsarMb) {
  fail(`app.asar is ${appAsarMb.toFixed(1)} MB, expected <= ${maxAppAsarMb} MB`);
}

const entries = asarList(appAsar);
const entrySet = new Set(entries);

const requiredEntries = [
  "/dist/src/main.js",
  "/dist/src/renderer.js",
  "/dist/src/preload.cjs",
  "/dist/scripts/electron-flags.mjs",
  "/dist/scripts/uv-targets.mjs",
  "/package.json",
];
const missingRequired = requiredEntries.filter((entry) => !entrySet.has(entry));
if (missingRequired.length > 0) fail("required runtime entries missing from app.asar", missingRequired);

const rootDevPattern = /^\/(?:\.github|\.storybook|docs|fixtures|release|resources|scripts|src|test)(?:\/|$)/;
const rootDevEntries = entries.filter((entry) => rootDevPattern.test(entry));
if (rootDevEntries.length > 0) fail("root development files leaked into app.asar", rootDevEntries);

const distDevPattern =
  /^\/dist\/.*(?:\/(?:__tests__|__probes__|tests?|fixtures)(?:\/|$)|\.(?:test|spec)\.(?:js|cjs|mjs)$)/;
const distDevEntries = entries.filter((entry) => distDevPattern.test(entry));
if (distDevEntries.length > 0) fail("compiled development artifacts leaked into app.asar", distDevEntries);

const redundantRendererSourcePattern = /^\/dist\/src\/(?:components|ui)(?:\/|$)/;
const redundantRendererSourceEntries = entries.filter((entry) => redundantRendererSourcePattern.test(entry));
if (redundantRendererSourceEntries.length > 0) {
  fail("bundled renderer source modules leaked into app.asar", redundantRendererSourceEntries);
}

const allowedDistScriptEntries = new Set([
  "/dist/scripts",
  "/dist/scripts/electron-flags.mjs",
  "/dist/scripts/uv-targets.mjs",
]);
const unexpectedDistScripts = entries.filter(
  (entry) => entry.startsWith("/dist/scripts/") && !allowedDistScriptEntries.has(entry),
);
if (unexpectedDistScripts.length > 0) fail("unexpected dist scripts leaked into app.asar", unexpectedDistScripts);

const dependencyDevPattern =
  /^\/node_modules\/(?:(?:@[^/]+\/[^/]+|[^/]+)\/(?:docs?|tests?|__tests__|examples?|benchmarks?|coverage)(?:\/|$)|.*(?:\/(?:browser-test|system-test|[^/]+-test|test-[^/]+)(?:\/|$)|\.(?:map|ts|tsx|mts|cts|md|markdown)$|\.(?:test|spec)\.(?:js|cjs|mjs)$))/;
const dependencyDevEntries = entries.filter((entry) => dependencyDevPattern.test(entry));
if (dependencyDevEntries.length > 0) {
  fail("dependency development artifacts leaked into app.asar", dependencyDevEntries);
}

const buildOnlyPackagePattern =
  /^\/node_modules\/(?:@tailwindcss|tailwindcss|postcss|lightningcss(?:-.+)?|baseline-browser-mapping|caniuse-lite)(?:\/|$)/;
const buildOnlyEntries = entries.filter((entry) => buildOnlyPackagePattern.test(entry));
if (buildOnlyEntries.length > 0) {
  fail("build-only packages leaked into app.asar", buildOnlyEntries);
}

const rendererOnlyPackagePattern =
  /^\/node_modules\/(?:@radix-ui|@azure\/msal-(?:node|common)|react|react-dom|react-day-picker|react-markdown|remark-gfm|cmdk|lucide-react|class-variance-authority|clsx|tailwind-merge|date-fns|eruda)(?:\/|$)/;
const rendererOnlyEntries = entries.filter((entry) => rendererOnlyPackagePattern.test(entry));
if (rendererOnlyEntries.length > 0) {
  fail("renderer-only packages leaked into app.asar", rendererOnlyEntries);
}

const unpackedDir = resolve(resourcesDir, "app.asar.unpacked");
const betterSqliteNativeBinding = resolve(
  unpackedDir,
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);
if (!existsSync(betterSqliteNativeBinding)) {
  fail(`better-sqlite3 native binding missing: ${betterSqliteNativeBinding}`);
}
const betterSqliteBuildSources = resolve(unpackedDir, "node_modules", "better-sqlite3", "deps");
if (existsSync(betterSqliteBuildSources)) {
  fail(`better-sqlite3 build sources leaked into app.asar.unpacked: ${betterSqliteBuildSources}`);
}

const uvDir = resolve(resourcesDir, "uv");
if (!existsSync(uvDir)) fail(`packaged uv resource missing: ${uvDir}`);
const uvTargets = readdirSync(uvDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
if (uvTargets.length !== 1) fail("packaged uv resource must contain exactly one target", uvTargets);

const uvTargetDir = resolve(uvDir, uvTargets[0]);
const uvFiles = new Set(readdirSync(uvTargetDir));
const uvBin = uvTargets[0].startsWith("win32-") ? "uv.exe" : "uv";
if (uvFiles.has(uvBin)) fail("raw packaged uv binary leaked; expected compressed archive", [...uvFiles]);
if (!uvFiles.has(`${uvBin}.gz`)) fail("compressed packaged uv binary missing", [...uvFiles]);
if (!uvFiles.has("uv.meta.json")) fail("packaged uv metadata missing", [...uvFiles]);

const localesDir = resolve(appOutDir, "locales");
if (!existsSync(localesDir)) fail(`Electron locales directory missing: ${localesDir}`);
const expectedLocales = new Set(["en-US.pak", "ko.pak"]);
const localeFiles = readdirSync(localesDir).filter((entry) => entry.endsWith(".pak"));
const missingLocales = [...expectedLocales].filter((entry) => !localeFiles.includes(entry));
if (missingLocales.length > 0) fail("required Electron locale files missing", missingLocales);
const unexpectedLocales = localeFiles.filter((entry) => !expectedLocales.has(entry));
if (unexpectedLocales.length > 0) fail("unexpected Electron locale files leaked into package", unexpectedLocales);

const linuxGpuRuntimeFiles = [
  "libEGL.so",
  "libGLESv2.so",
  "libvk_swiftshader.so",
  "libvulkan.so.1",
  "vk_swiftshader_icd.json",
];
const leakedGpuFiles = linuxGpuRuntimeFiles.filter((entry) => existsSync(resolve(appOutDir, entry)));
if (leakedGpuFiles.length > 0) fail("Linux GPU runtime files leaked into package", leakedGpuFiles);

process.stdout.write(
  [
    `[package-footprint] OK`,
    `app.asar=${appAsarMb.toFixed(1)} MB`,
    `entries=${entries.length}`,
    `uvTarget=${uvTargets[0]}`,
    `locales=${localeFiles.length}`,
  ].join(" ") + "\n",
);
