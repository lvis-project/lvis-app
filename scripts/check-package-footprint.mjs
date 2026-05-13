#!/usr/bin/env node
/**
 * Fail-closed package footprint audit for unpacked Electron builds.
 *
 * The production app should contain compiled LVIS assets plus production
 * runtime dependencies. Root source/docs/tests and dependency source maps or
 * docs add package size and cold-start I/O without helping runtime behavior.
 */

import * as asar from "@electron/asar";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const fallbackAppAsar = resolve(root, "release", "linux-arm64-unpacked", "resources", "app.asar");
const maxAppAsarMb = Number(process.env.LVIS_MAX_APP_ASAR_MB ?? "100");

function fail(message, samples = []) {
  process.stderr.write(`[package-footprint] ERROR: ${message}\n`);
  for (const sample of samples.slice(0, 20)) {
    process.stderr.write(`  - ${sample}\n`);
  }
  process.exit(1);
}

function collectAppAsarCandidates() {
  const releaseDir = resolve(root, "release");
  if (!existsSync(releaseDir)) return [];

  const candidates = [];
  for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const releaseChildDir = resolve(releaseDir, entry.name);
    const unpackedAppAsar = resolve(releaseChildDir, "resources", "app.asar");
    if (existsSync(unpackedAppAsar)) candidates.push(unpackedAppAsar);

    for (const child of readdirSync(releaseChildDir, { withFileTypes: true })) {
      if (!child.isDirectory() || !child.name.endsWith(".app")) continue;
      const macAppAsar = resolve(releaseChildDir, child.name, "Contents", "Resources", "app.asar");
      if (existsSync(macAppAsar)) candidates.push(macAppAsar);
    }
  }

  return [...new Set(candidates)];
}

function isCurrentPlatformCandidate(candidate) {
  const normalized = candidate.replaceAll("\\", "/");
  if (process.platform === "darwin") {
    return /\/[^/]+\.app\/Contents\/Resources\/app\.asar$/.test(normalized);
  }
  if (process.platform === "win32") {
    return /\/win-unpacked\/resources\/app\.asar$/.test(normalized);
  }
  if (process.platform === "linux") {
    return /\/linux-.+-unpacked\/resources\/app\.asar$/.test(normalized);
  }
  return false;
}

function defaultAppAsarPath() {
  const candidates = collectAppAsarCandidates();
  const platformCandidates = candidates.filter(isCurrentPlatformCandidate);
  if (platformCandidates.length === 1) return platformCandidates[0];
  if (platformCandidates.length > 1) {
    fail("multiple current-platform app.asar candidates found; pass the target path explicitly", platformCandidates);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    fail("multiple app.asar candidates found; pass the target path explicitly", candidates);
  }
  return fallbackAppAsar;
}

function normalizeAsarEntry(entry) {
  const normalized = entry.replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function asarList(archivePath) {
  try {
    return asar.listPackage(archivePath).map(normalizeAsarEntry).filter(Boolean);
  } catch (err) {
    fail(`failed to list app.asar: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isMacAppPackage() {
  return basename(appOutDir) === "Contents" && basename(dirname(appOutDir)).endsWith(".app");
}

function isLinuxUnpackedPackage() {
  return /^linux-.+-unpacked$/.test(basename(appOutDir));
}

function validateMacElectronLocales() {
  const localeResourcesDir = resolve(
    appOutDir,
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Resources",
  );
  if (!existsSync(localeResourcesDir)) {
    fail(`Electron framework locale resources directory missing: ${localeResourcesDir}`);
  }

  const expectedLocales = new Set(["en.lproj", "ko.lproj"]);
  const localeDirs = readdirSync(localeResourcesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".lproj"))
    .map((entry) => entry.name);
  const missingLocales = [...expectedLocales].filter(
    (entry) => !existsSync(resolve(localeResourcesDir, entry, "locale.pak")),
  );
  if (missingLocales.length > 0) fail("required Electron locale bundles missing", missingLocales);
  const unexpectedLocales = localeDirs.filter((entry) => !expectedLocales.has(entry));
  if (unexpectedLocales.length > 0) fail("unexpected Electron locale bundles leaked into package", unexpectedLocales);
  return localeDirs.length;
}

function validatePakElectronLocales() {
  const localesDir = resolve(appOutDir, "locales");
  if (!existsSync(localesDir)) fail(`Electron locales directory missing: ${localesDir}`);
  const expectedLocales = new Set(["en-US.pak", "ko.pak"]);
  const localeFiles = readdirSync(localesDir).filter((entry) => entry.endsWith(".pak"));
  const missingLocales = [...expectedLocales].filter((entry) => !localeFiles.includes(entry));
  if (missingLocales.length > 0) fail("required Electron locale files missing", missingLocales);
  const unexpectedLocales = localeFiles.filter((entry) => !expectedLocales.has(entry));
  if (unexpectedLocales.length > 0) fail("unexpected Electron locale files leaked into package", unexpectedLocales);
  return localeFiles.length;
}

const appAsar = process.argv[2] ? resolve(root, process.argv[2]) : defaultAppAsarPath();
const resourcesDir = dirname(appAsar);
const appOutDir = dirname(resourcesDir);

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

const localeCount = isMacAppPackage() ? validateMacElectronLocales() : validatePakElectronLocales();

if (isLinuxUnpackedPackage()) {
  const linuxGpuRuntimeFiles = [
    "libEGL.so",
    "libGLESv2.so",
    "libvk_swiftshader.so",
    "libvulkan.so.1",
    "vk_swiftshader_icd.json",
  ];
  const leakedGpuFiles = linuxGpuRuntimeFiles.filter((entry) => existsSync(resolve(appOutDir, entry)));
  if (leakedGpuFiles.length > 0) fail("Linux GPU runtime files leaked into package", leakedGpuFiles);
}

process.stdout.write(
  [
    `[package-footprint] OK`,
    `app.asar=${appAsarMb.toFixed(1)} MB`,
    `entries=${entries.length}`,
    `uvTarget=${uvTargets[0]}`,
    `locales=${localeCount}`,
  ].join(" ") + "\n",
);
