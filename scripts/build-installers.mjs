#!/usr/bin/env node
/**
 * Build LVIS desktop installers for the requested native platform.
 *
 * The script intentionally keeps platform selection explicit. Native desktop
 * installers depend on OS-specific signing, native dependency rebuilds, and
 * target tooling, so the three-platform release path is the CI OS matrix.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { hostRuntimeAssetSummary } from "./packaged-runtime-assets.mjs";
import { installerUvTargetFor } from "./uv-targets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const uvCacheDir = resolve(root, "resources", "uv");
const uvRuntimeDir = resolve(root, "resources", "uv-runtime");
const fastOutputDir = "release-fast";

const INSTALLER_TARGETS = {
  mac: {
    platform: "darwin",
    flag: "--mac",
    installerTargets: ["dmg", "zip"],
  },
  linux: {
    platform: "linux",
    flag: "--linux",
    installerTargets: ["AppImage", "deb", "rpm"],
  },
  win: {
    platform: "win32",
    flag: "--win",
    installerTargets: ["nsis", "zip"],
  },
};

const CURRENT_TARGET_BY_PLATFORM = {
  darwin: "mac",
  linux: "linux",
  win32: "win",
};

function usage() {
  return [
    "Usage: node scripts/build-installers.mjs [target] [options]",
    "",
    "Targets:",
    "  --current        Build installers for the current OS (default)",
    "  --mac            Build macOS Apple Silicon DMG + ZIP",
    "  --linux          Build Linux AppImage + DEB + RPM",
    "  --win            Build Windows NSIS + ZIP",
    "",
    "Options:",
    "  --publish <mode> Publish mode for electron-builder (default: never)",
    "  --skip-build     Package the existing dist/ output",
    "  --skip-code-sign Produce an unsigned internal build",
    "  --skip-native-rebuild",
    "                   Trust already-rebuilt native deps and pass npmRebuild=false",
    "  --dir            Build unpacked app directories instead of installers",
    "  --fast           Internal preview build: release-fast/, store compression,",
    "                   and --skip-native-rebuild. Do not use for public release.",
  ].join("\n");
}

function parseArgs(argv) {
  const selected = new Set();
  let publish = "never";
  let skipBuild = false;
  let skipCodeSign = false;
  let skipNativeRebuild = false;
  let fast = false;
  let dirOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--current") {
      const current = CURRENT_TARGET_BY_PLATFORM[process.platform];
      if (!current) throw new Error(`Unsupported current platform: ${process.platform}`);
      selected.add(current);
      continue;
    }
    if (arg === "--mac" || arg === "--linux" || arg === "--win") {
      selected.add(arg.slice(2));
      continue;
    }
    if (arg === "--publish") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--publish requires a value");
      }
      publish = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--publish=")) {
      publish = arg.slice("--publish=".length);
      continue;
    }
    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (arg === "--skip-code-sign") {
      skipCodeSign = true;
      continue;
    }
    if (arg === "--skip-native-rebuild") {
      skipNativeRebuild = true;
      continue;
    }
    if (arg === "--fast") {
      fast = true;
      skipNativeRebuild = true;
      continue;
    }
    if (arg === "--dir") {
      dirOnly = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  if (selected.size === 0) {
    const current = CURRENT_TARGET_BY_PLATFORM[process.platform];
    if (!current) throw new Error(`Unsupported current platform: ${process.platform}`);
    selected.add(current);
  }

  return {
    selected: [...selected],
    publish,
    skipBuild,
    skipCodeSign,
    skipNativeRebuild,
    fast,
    dirOnly,
  };
}

function run(cmd, args, opts = {}) {
  process.stdout.write(`[installer] $ ${cmd} ${args.join(" ")}\n`);
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    ...opts,
  });
  if (result.error) {
    throw new Error(`${cmd} ${args.join(" ")} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with code ${result.status}`);
  }
}

function assertNativeTarget(target) {
  const config = INSTALLER_TARGETS[target];
  if (!config) throw new Error(`Unknown target: ${target}`);
  if (process.platform !== config.platform) {
    throw new Error(
      `${target} installers must be built on ${config.platform}; current platform is ${process.platform}. ` +
        "Use .github/workflows/build-installers.yml for the macOS/Linux/Windows matrix.",
    );
  }
}

function cleanUvRuntime() {
  rmSync(uvRuntimeDir, { recursive: true, force: true });
}

function prepareUvRuntime(target) {
  const uvTarget = installerUvTargetFor(target);
  run("node", ["scripts/fetch-uv.mjs", "--target", uvTarget.dir]);

  const sourceDir = resolve(uvCacheDir, uvTarget.dir);
  const sourceBin = resolve(sourceDir, uvTarget.bin);
  if (!existsSync(sourceBin)) {
    throw new Error(`uv binary missing after fetch: ${sourceBin}`);
  }

  cleanUvRuntime();
  const targetDir = resolve(uvRuntimeDir, uvTarget.dir);
  mkdirSync(targetDir, { recursive: true });
  cpSync(resolve(sourceDir, "uv.meta.json"), resolve(targetDir, "uv.meta.json"));
  writeFileSync(resolve(targetDir, `${uvTarget.bin}.gz`), gzipSync(readFileSync(sourceBin), { level: 9 }));
  assertUvRuntimePayload(target);
  process.stdout.write(`[installer] staged compressed uv runtime: ${uvTarget.dir}\n`);
}

function assertUvRuntimePayload(target) {
  const uvTarget = installerUvTargetFor(target);
  const targetDir = resolve(uvRuntimeDir, uvTarget.dir);
  if (!existsSync(targetDir)) {
    throw new Error(`staged uv runtime target missing: ${targetDir}`);
  }

  const stagedTargets = readdirSync(uvRuntimeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (stagedTargets.length !== 1 || stagedTargets[0] !== uvTarget.dir) {
    throw new Error(`staged uv runtime must contain only ${uvTarget.dir}; found ${stagedTargets.join(", ")}`);
  }

  const files = new Set(readdirSync(targetDir));
  if (files.has(uvTarget.bin)) {
    throw new Error(`raw uv binary leaked into staged runtime: ${resolve(targetDir, uvTarget.bin)}`);
  }
  if (!files.has(`${uvTarget.bin}.gz`)) {
    throw new Error(`compressed uv archive missing from staged runtime: ${resolve(targetDir, `${uvTarget.bin}.gz`)}`);
  }
  if (!files.has("uv.meta.json")) {
    throw new Error(`uv metadata missing from staged runtime: ${resolve(targetDir, "uv.meta.json")}`);
  }

  const metaPath = resolve(targetDir, "uv.meta.json");
  const compressedBin = resolve(targetDir, `${uvTarget.bin}.gz`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  if (typeof meta.binarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(meta.binarySha256)) {
    throw new Error(`uv metadata has invalid binarySha256: ${metaPath}`);
  }

  const actualBinarySha256 = sha256Hex(gunzipSync(readFileSync(compressedBin)));
  if (actualBinarySha256 !== meta.binarySha256) {
    throw new Error(
      `staged uv binary SHA mismatch: expected ${meta.binarySha256}, got ${actualBinarySha256}: ${compressedBin}`,
    );
  }
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function builderArgsFor(target, { publish, dirOnly, skipNativeRebuild, fast }) {
  const config = INSTALLER_TARGETS[target];
  const uvTarget = installerUvTargetFor(target);
  const args = ["electron-builder", config.flag];
  if (dirOnly) {
    args.push("--dir");
  } else {
    args.push(...config.installerTargets);
  }
  args.push(uvTarget.archFlag);
  args.push(`--publish=${publish}`);
  if (skipNativeRebuild) {
    args.push("-c.npmRebuild=false");
  }
  if (fast) {
    args.push("-c.compression=store", `-c.directories.output=${fastOutputDir}`);
  }
  return args;
}

function collectPackagedAppAsarCandidates(target, fast) {
  const outputRoot = resolve(root, fast ? fastOutputDir : "release");
  if (!existsSync(outputRoot)) return [];

  if (target === "mac") {
    const candidates = [];
    for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const releaseChildDir = resolve(outputRoot, entry.name);
      for (const child of readdirSync(releaseChildDir, { withFileTypes: true })) {
        if (!child.isDirectory() || !child.name.endsWith(".app")) continue;
        const appAsar = resolve(releaseChildDir, child.name, "Contents", "Resources", "app.asar");
        if (existsSync(appAsar)) candidates.push(appAsar);
      }
    }
    return candidates;
  }

  if (target === "win") {
    const appAsar = resolve(outputRoot, "win-unpacked", "resources", "app.asar");
    return existsSync(appAsar) ? [appAsar] : [];
  }

  const candidates = [];
  for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== "linux-unpacked" && !/^linux-.+-unpacked$/.test(entry.name)) continue;
    const appAsar = resolve(outputRoot, entry.name, "resources", "app.asar");
    if (existsSync(appAsar)) candidates.push(appAsar);
  }
  return candidates;
}

function checkPackageFootprint(target, fast) {
  const candidates = collectPackagedAppAsarCandidates(target, fast);
  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one packaged app.asar for ${target}; found ${candidates.length}: ${candidates.join(", ")}`,
    );
  }
  run("node", ["scripts/check-package-footprint.mjs", candidates[0]]);
}

async function main() {
  const { selected, publish, skipBuild, skipCodeSign, skipNativeRebuild, fast, dirOnly } = parseArgs(
    process.argv.slice(2),
  );
  for (const target of selected) {
    assertNativeTarget(target);
  }
  if (fast && publish !== "never") {
    throw new Error("--fast writes non-release-size artifacts and cannot be combined with --publish");
  }

  if (!skipBuild) {
    run("bun", ["run", "build"]);
  }

  const env = {
    ...process.env,
  };
  if (selected.includes("win")) {
    env.CSC_LINK = env.CSC_LINK ?? env.WIN_CSC_LINK;
    env.CSC_KEY_PASSWORD = env.CSC_KEY_PASSWORD ?? env.WIN_CSC_KEY_PASSWORD;
  }
  if (skipCodeSign) {
    delete env.CSC_LINK;
    delete env.CSC_KEY_PASSWORD;
    delete env.WIN_CSC_LINK;
    delete env.WIN_CSC_KEY_PASSWORD;
    delete env.APPLE_ID;
    delete env.APPLE_ID_PASSWORD;
    delete env.APPLE_APP_SPECIFIC_PASSWORD;
    delete env.APPLE_TEAM_ID;
    env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    process.stdout.write("[installer] --skip-code-sign: CSC_IDENTITY_AUTO_DISCOVERY=false\n");
  }
  if (skipNativeRebuild) {
    process.stdout.write("[installer] --skip-native-rebuild: electron-builder npmRebuild=false\n");
  }
  if (fast) {
    process.stdout.write(`[installer] --fast: output=${fastOutputDir}, compression=store (larger artifacts)\n`);
  }

  try {
    for (const target of selected) {
      process.stdout.write(`[installer] required runtime assets for ${target}: ${hostRuntimeAssetSummary(target)}\n`);
      prepareUvRuntime(target);
      run("bunx", builderArgsFor(target, { publish, dirOnly, skipNativeRebuild, fast }), { env });
      checkPackageFootprint(target, fast);
    }
  } finally {
    cleanUvRuntime();
  }

  process.stdout.write(`[installer] done. Artifacts in ${fast ? fastOutputDir : "release"}/\n`);
}

main().catch((err) => {
  process.stderr.write(`[installer] FAILED: ${err.message}\n`);
  process.exit(1);
});
