#!/usr/bin/env node
/**
 * Smoke-test the Windows NSIS setup.exe, not just win-unpacked/LVIS.exe.
 *
 * The packaged-app smoke catches missing runtime files in win-unpacked. This
 * script covers the installer path: silent install, launch installed app, and
 * silent uninstall while preserving user data.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const WINDOWS_SAFE_GPU_FLAGS = [
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-gpu-compositing",
];
const SANDBOX_BYPASS_FLAG = "--no-sandbox";
const MAX_OUTPUT_CHARS = 16_000;

function usage() {
  process.stdout.write(
    [
      "Usage: node scripts/smoke-windows-nsis-installer.mjs [options]",
      "",
      "Options:",
      "  --installer <path>       NSIS setup.exe path",
      "  --release-dir <path>     Release directory to search (default: release)",
      "  --install-timeout-ms <n> Silent install timeout (default: 180000)",
      "  --launch-timeout-ms <n>  App launch health window (default: 12000)",
      "  --uninstall-timeout-ms <n> Silent uninstall timeout (default: 120000)",
      "  --help                   Show this help",
    ].join("\n") + "\n",
  );
}

function parseArgs(argv) {
  const options = {
    installer: null,
    releaseDir: "release",
    installTimeoutMs: 180_000,
    launchTimeoutMs: 12_000,
    uninstallTimeoutMs: 120_000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--installer") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--installer requires a path");
      options.installer = value;
      continue;
    }
    if (arg === "--release-dir") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--release-dir requires a path");
      options.releaseDir = value;
      continue;
    }
    if (arg === "--install-timeout-ms") {
      options.installTimeoutMs = parsePositiveInt(argv[++i], "--install-timeout-ms");
      continue;
    }
    if (arg === "--launch-timeout-ms") {
      options.launchTimeoutMs = parsePositiveInt(argv[++i], "--launch-timeout-ms");
      continue;
    }
    if (arg === "--uninstall-timeout-ms") {
      options.uninstallTimeoutMs = parsePositiveInt(argv[++i], "--uninstall-timeout-ms");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parsePositiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function walkFiles(dir, depth = 0, maxDepth = 3) {
  if (depth > maxDepth || !existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(fullPath, depth + 1, maxDepth));
    } else if (entry.isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

function findInstaller(options) {
  if (options.installer) {
    const installer = resolve(options.installer);
    if (!existsSync(installer)) throw new Error(`installer not found: ${installer}`);
    return installer;
  }

  const releaseDir = resolve(options.releaseDir);
  const matches = walkFiles(releaseDir, 0, 1).filter((file) => {
    const name = basename(file).toLowerCase();
    return name.startsWith("lvis-") && name.includes("-windows-") && name.endsWith("-setup.exe");
  });
  if (matches.length === 0) {
    throw new Error(`Windows setup.exe not found in ${releaseDir}`);
  }
  if (matches.length > 1) {
    throw new Error(`multiple Windows setup.exe files found: ${matches.join(", ")}`);
  }
  return matches[0];
}

function defaultInstallDir() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is not set");
  return join(localAppData, "Programs", "LVIS");
}

function appendOutput(current, chunk) {
  const next = current + chunk.toString("utf8");
  return next.length > MAX_OUTPUT_CHARS ? next.slice(next.length - MAX_OUTPUT_CHARS) : next;
}

async function runProcess(command, args, { timeoutMs, env = process.env } = {}) {
  process.stdout.write(`[windows-installer-smoke] $ ${command} ${args.join(" ")}\n`);

  return await new Promise((resolvePromise, reject) => {
    let output = "";
    let timedOut = false;
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      output = appendOutput(output, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output = appendOutput(output, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`process timed out after ${timeoutMs}ms\n${output}`));
        return;
      }
      if (code === 0) {
        resolvePromise({ output });
        return;
      }
      reject(new Error(`process exited with code=${code} signal=${signal ?? "none"}\n${output}`));
    });
  });
}

async function waitForFile(file, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(file) && statSync(file).isFile()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`timed out waiting for file: ${file}`);
}

async function launchSmoke(executable, timeoutMs) {
  const userDataDir = mkdtempSync(join(tmpdir(), "lvis-nsis-smoke-user-data-"));
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: "1",
    LVIS_DEV_CONSOLE: "0",
    LVIS_USER_DATA_DIR: userDataDir,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const args = [
    `--user-data-dir=${userDataDir}`,
    ...WINDOWS_SAFE_GPU_FLAGS,
    SANDBOX_BYPASS_FLAG,
  ];

  try {
    return await new Promise((resolvePromise, reject) => {
      let output = "";
      let timedOut = false;
      const child = spawn(executable, [...new Set(args)], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
      }, timeoutMs);

      child.stdout?.on("data", (chunk) => {
        output = appendOutput(output, chunk);
      });
      child.stderr?.on("data", (chunk) => {
        output = appendOutput(output, chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          process.stdout.write(`[windows-installer-smoke] app stayed up for ${timeoutMs}ms; launch smoke passed\n`);
          resolvePromise();
          return;
        }
        reject(new Error(`installed app exited early with code=${code} signal=${signal ?? "none"}\n${output}`));
      });
    });
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

function findUninstaller(installDir) {
  const matches = walkFiles(installDir, 0, 1).filter((file) => {
    const name = basename(file).toLowerCase();
    return name.startsWith("uninstall") && name.endsWith(".exe");
  });
  if (matches.length === 0) throw new Error(`uninstaller not found in ${installDir}`);
  return matches[0];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (process.platform !== "win32") {
    throw new Error("Windows NSIS installer smoke requires process.platform === win32");
  }

  const installer = findInstaller(options);
  const installDir = defaultInstallDir();
  const installedExe = join(installDir, "LVIS.exe");

  if (existsSync(installedExe)) {
    throw new Error(
      `existing LVIS install found at ${installedExe}; remove it before running installer smoke`,
    );
  }

  await runProcess(installer, ["/S", "/currentuser"], { timeoutMs: options.installTimeoutMs });
  await waitForFile(installedExe, 30_000);
  process.stdout.write(`[windows-installer-smoke] installed executable found: ${installedExe}\n`);

  try {
    await launchSmoke(installedExe, options.launchTimeoutMs);
  } finally {
    const uninstaller = findUninstaller(installDir);
    await runProcess(uninstaller, ["/S", "/KEEP_APP_DATA"], { timeoutMs: options.uninstallTimeoutMs });
    if (existsSync(installedExe)) {
      throw new Error(`uninstall completed but installed executable remains: ${installedExe}`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[windows-installer-smoke] FAILED: ${error.message}\n`);
  process.exit(1);
});
