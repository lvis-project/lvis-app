#!/usr/bin/env node
/**
 * Build LVIS desktop installers for the requested native platform.
 *
 * The script intentionally keeps platform selection explicit. Native desktop
 * installers depend on OS-specific signing, native dependency rebuilds, and
 * target tooling, so the three-platform release path is the CI OS matrix.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const TARGETS = {
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
    "  --mac            Build macOS DMG + ZIP",
    "  --linux          Build Linux AppImage + DEB + RPM",
    "  --win            Build Windows NSIS + ZIP",
    "",
    "Options:",
    "  --publish <mode> Publish mode for electron-builder (default: never)",
    "  --skip-build     Package the existing dist/ output",
    "  --skip-code-sign Produce an unsigned internal build",
    "  --dir            Build unpacked app directories instead of installers",
  ].join("\n");
}

function parseArgs(argv) {
  const selected = new Set();
  let publish = "never";
  let skipBuild = false;
  let skipCodeSign = false;
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
  const config = TARGETS[target];
  if (!config) throw new Error(`Unknown target: ${target}`);
  if (process.platform !== config.platform) {
    throw new Error(
      `${target} installers must be built on ${config.platform}; current platform is ${process.platform}. ` +
        "Use .github/workflows/build-installers.yml for the macOS/Linux/Windows matrix.",
    );
  }
}

function builderArgsFor(target, publish, dirOnly) {
  const config = TARGETS[target];
  const args = ["electron-builder", config.flag];
  if (dirOnly) {
    args.push("--dir");
  } else {
    args.push(...config.installerTargets);
  }
  args.push(`--publish=${publish}`);
  return args;
}

async function main() {
  const { selected, publish, skipBuild, skipCodeSign, dirOnly } = parseArgs(process.argv.slice(2));
  for (const target of selected) {
    assertNativeTarget(target);
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
    env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    process.stdout.write("[installer] --skip-code-sign: CSC_IDENTITY_AUTO_DISCOVERY=false\n");
  }

  for (const target of selected) {
    run("bunx", builderArgsFor(target, publish, dirOnly), { env });
  }

  process.stdout.write("[installer] done. Artifacts in release/\n");
}

main().catch((err) => {
  process.stderr.write(`[installer] FAILED: ${err.message}\n`);
  process.exit(1);
});
