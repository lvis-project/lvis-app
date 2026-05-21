#!/usr/bin/env node
/**
 * Smoke-test the Windows NSIS setup.exe, not just win-unpacked/LVIS.exe.
 *
 * The packaged-app smoke catches missing runtime files in win-unpacked. This
 * script covers the installer path: silent install, launch installed app,
 * silent uninstall while preserving user data, and an opt-in destructive
 * uninstall pass for CI runners.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const WINDOWS_SAFE_GPU_FLAGS = [
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-gpu-compositing",
];
const SANDBOX_BYPASS_FLAG = "--no-sandbox";
const MAX_OUTPUT_CHARS = 16_000;
const DESTRUCTIVE_SMOKE_ENV = "LVIS_ALLOW_DESTRUCTIVE_UNINSTALL_SMOKE";

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
      `  --destructive-user-data-smoke  Also verify full uninstall deletes LVIS user-data paths (or set ${DESTRUCTIVE_SMOKE_ENV}=1)`,
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
    destructiveUserDataSmoke: process.env[DESTRUCTIVE_SMOKE_ENV] === "1",
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
    if (arg === "--destructive-user-data-smoke") {
      options.destructiveUserDataSmoke = true;
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
  if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
    throw new Error("package.json name is required for NSIS one-click install path");
  }
  return join(localAppData, "Programs", packageJson.name);
}

function appendOutput(current, chunk) {
  const next = current + chunk.toString("utf8");
  return next.length > MAX_OUTPUT_CHARS ? next.slice(next.length - MAX_OUTPUT_CHARS) : next;
}

function removeTempDirBestEffort(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`[windows-installer-smoke] warning: could not remove temp dir ${dir}: ${err.message}\n`);
  }
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

async function waitForFileRemoved(file, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!existsSync(file)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`timed out waiting for file removal: ${file}`);
}

async function waitForPathRemoved(file, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!existsSync(file)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`timed out waiting for path removal: ${file}`);
}

function userDataTargets() {
  const { USERPROFILE, APPDATA, LOCALAPPDATA } = process.env;
  if (!USERPROFILE) throw new Error("USERPROFILE is not set");
  if (!APPDATA) throw new Error("APPDATA is not set");
  if (!LOCALAPPDATA) throw new Error("LOCALAPPDATA is not set");
  return [
    join(USERPROFILE, ".lvis"),
    join(APPDATA, "LVIS"),
    join(LOCALAPPDATA, "LVIS"),
  ];
}

function isDisposableGitHubActionsWindowsRunner() {
  return process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_OS === "Windows";
}

function assertNoExistingUserDataTargets() {
  const existing = userDataTargets().filter((target) => existsSync(target));
  if (existing.length > 0 && isDisposableGitHubActionsWindowsRunner()) {
    process.stdout.write(
      [
        `[windows-installer-smoke] ${DESTRUCTIVE_SMOKE_ENV}=1 on disposable GitHub Windows runner;`,
        " existing LVIS user data paths will be included in full uninstall smoke:",
        ...existing.map((target) => `[windows-installer-smoke] - ${target}`),
        "",
      ].join("\n"),
    );
    return;
  }
  if (existing.length > 0) {
    throw new Error(
      [
        `${DESTRUCTIVE_SMOKE_ENV}=1 would delete existing LVIS user data paths:`,
        ...existing.map((target) => `- ${target}`),
        "Run this destructive smoke only in a disposable Windows runner.",
      ].join("\n"),
    );
  }
}

function createUserDataSentinels() {
  for (const target of userDataTargets()) {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "nsis-smoke-sentinel.txt"), "LVIS Windows uninstall smoke\n", "utf8");
  }
}

function assertUserDataTargetsExist() {
  const missing = userDataTargets().filter((target) => !existsSync(target));
  if (missing.length > 0) {
    throw new Error(`KEEP_APP_DATA uninstall removed user data unexpectedly: ${missing.join(", ")}`);
  }
}

function assertUserDataTargetsRemoved() {
  const remaining = userDataTargets().filter((target) => existsSync(target));
  if (remaining.length > 0) {
    throw new Error(`full uninstall left user data behind: ${remaining.join(", ")}`);
  }
}

async function startInstalledApp(executable, timeoutMs) {
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
      const child = spawn(executable, [...new Set(args)], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        cleanupListeners();
        process.stdout.write(`[windows-installer-smoke] app stayed up for ${timeoutMs}ms; launch smoke passed\n`);
        resolvePromise({
          child,
          stop() {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGTERM");
              setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
            }
            removeTempDirBestEffort(userDataDir);
          },
        });
      }, timeoutMs);

      const cleanupListeners = () => {
        clearTimeout(timer);
        child.stdout?.removeAllListeners("data");
        child.stderr?.removeAllListeners("data");
        child.removeAllListeners("error");
        child.removeAllListeners("exit");
      };

      child.stdout?.on("data", (chunk) => {
        output = appendOutput(output, chunk);
      });
      child.stderr?.on("data", (chunk) => {
        output = appendOutput(output, chunk);
      });
      child.on("error", (error) => {
        cleanupListeners();
        removeTempDirBestEffort(userDataDir);
        reject(error);
      });
      child.on("exit", (code, signal) => {
        cleanupListeners();
        removeTempDirBestEffort(userDataDir);
        reject(new Error(`installed app exited early with code=${code} signal=${signal ?? "none"}\n${output}`));
      });
    });
  } catch (err) {
    removeTempDirBestEffort(userDataDir);
    throw err;
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

async function installAndWait(installer, installedExe, timeoutMs) {
  await runProcess(installer, ["/S", "/currentuser"], { timeoutMs });
  await waitForFile(installedExe, 30_000);
  process.stdout.write(`[windows-installer-smoke] installed executable found: ${installedExe}\n`);
}

async function uninstallAndVerify(uninstaller, args, { installDir, installedExe, timeoutMs }) {
  await runProcess(uninstaller, args, { timeoutMs });
  await waitForFileRemoved(installedExe, 30_000);
  await waitForPathRemoved(installDir, 30_000);
  process.stdout.write(`[windows-installer-smoke] uninstall removed install dir: ${installDir}\n`);
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

  if (options.destructiveUserDataSmoke) {
    assertNoExistingUserDataTargets();
    createUserDataSentinels();
  }

  await installAndWait(installer, installedExe, options.installTimeoutMs);

  let runningApp = null;
  try {
    runningApp = await startInstalledApp(installedExe, options.launchTimeoutMs);
  } finally {
    const uninstaller = findUninstaller(installDir);
    try {
      await uninstallAndVerify(uninstaller, ["/S", "/KEEP_APP_DATA"], {
        installDir,
        installedExe,
        timeoutMs: options.uninstallTimeoutMs,
      });
    } finally {
      runningApp?.stop();
    }
  }

  if (!options.destructiveUserDataSmoke) return;

  assertUserDataTargetsExist();
  await installAndWait(installer, installedExe, options.installTimeoutMs);
  const uninstaller = findUninstaller(installDir);
  await uninstallAndVerify(uninstaller, ["/S"], {
    installDir,
    installedExe,
    timeoutMs: options.uninstallTimeoutMs,
  });
  assertUserDataTargetsRemoved();
  process.stdout.write("[windows-installer-smoke] full uninstall removed LVIS user data paths\n");
}

main().catch((error) => {
  if (process.env[DESTRUCTIVE_SMOKE_ENV] !== "1") {
    try {
      for (const target of userDataTargets()) {
        const sentinel = join(target, "nsis-smoke-sentinel.txt");
        if (existsSync(sentinel)) rmSync(target, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup only. The original failure is the useful signal.
    }
  }
  process.stderr.write(`[windows-installer-smoke] FAILED: ${error.message}\n`);
  process.exit(1);
});
