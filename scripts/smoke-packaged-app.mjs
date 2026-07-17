#!/usr/bin/env node
/**
 * Launch-smoke the packaged app produced by electron-builder.
 *
 * This intentionally runs the unpacked binary under release/ instead of the
 * dev Electron launcher. It catches production-only dependency pruning errors
 * such as ERR_MODULE_NOT_FOUND before installers are uploaded.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareElectronLaunchArgs,
  prepareElectronLaunchEnv,
} from "./lib/electron-launch-options.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_OUTPUT_CHARS = 64_000;
const MODULE_LOAD_FAILURE =
  /(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find package|Cannot find module)/i;

const WINDOWS_NSIS_PER_MACHINE_MARKER_FILENAME =
  ".lvis-nsis-per-machine-v1";
const WINDOWS_PROTOCOL_CLEANUP_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$rootPath = 'Software\\Classes\\lvis'",
  "$commandPath = 'Software\\Classes\\lvis\\shell\\open\\command'",
  "function Remove-RegistryValueIfEquals([string]$path, [string]$name, [string]$expected, [System.StringComparison]$comparison) {",
  "  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, $true)",
  "  if ($null -eq $key) { return }",
  "  try {",
  "    if (-not (@($key.GetValueNames()) -contains $name)) { return }",
  "    if ($key.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String) { return }",
  "    $value = [string]$key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "    if ([string]::Equals($value, $expected, $comparison)) { $key.DeleteValue($name, $false) }",
  "  } finally { $key.Dispose() }",
  "}",
  "function Remove-EmptyRegistryKey([string]$path) {",
  "  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, $false)",
  "  if ($null -eq $key) { return }",
  "  $empty = $false",
  "  try {",
  "    $empty = @($key.GetValueNames()).Count -eq 0 -and @($key.GetSubKeyNames()).Count -eq 0",
  "  } finally { $key.Dispose() }",
  "  if ($empty) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($path, $false) }",
  "}",
  "$rootKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($rootPath, $false)",
  "if ($null -eq $rootKey) { throw 'expected win-unpacked HKCU lvis protocol root is missing' }",
  "$rootKey.Dispose()",
  "$commandKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($commandPath, $false)",
  "if ($null -eq $commandKey) { throw 'lvis protocol root exists without an owned command' }",
  "try {",
  "  $commandKind = $commandKey.GetValueKind('')",
  "  $command = [string]$commandKey.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "} finally { $commandKey.Dispose() }",
  "if ($commandKind -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'refusing to remove a non-owned lvis protocol command kind' }",
  "$expectedCommand = '\"' + $env:LVIS_PROTOCOL_OWNER_EXE + '\" \"%1\"'",
  "if (-not [string]::Equals($command, $expectedCommand, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'refusing to remove a non-owned lvis protocol command' }",
  "$expectedIcon = '\"' + $env:LVIS_PROTOCOL_OWNER_EXE + '\",0'",
  "Remove-RegistryValueIfEquals $commandPath '' $expectedCommand ([System.StringComparison]::OrdinalIgnoreCase)",
  "Remove-RegistryValueIfEquals 'Software\\Classes\\lvis\\DefaultIcon' '' $expectedIcon ([System.StringComparison]::OrdinalIgnoreCase)",
  "Remove-RegistryValueIfEquals $rootPath 'URL Protocol' '' ([System.StringComparison]::Ordinal)",
  "Remove-RegistryValueIfEquals $rootPath '' 'URL:lvis' ([System.StringComparison]::Ordinal)",
  "foreach ($path in @(",
  "  $commandPath,",
  "  'Software\\Classes\\lvis\\shell\\open',",
  "  'Software\\Classes\\lvis\\shell',",
  "  'Software\\Classes\\lvis\\DefaultIcon',",
  "  $rootPath",
  ")) { Remove-EmptyRegistryKey $path }",
].join("\n");

const TARGET_PLATFORM = {
  mac: "darwin",
  linux: "linux",
  win: "win32",
};

function usage() {
  return [
    "Usage: node scripts/smoke-packaged-app.mjs --target <mac|linux|win|current> [options]",
    "",
    "Options:",
    "  --release-dir <path>   electron-builder output directory (default: release)",
    "  --timeout-ms <number>  launch window before treating a still-running app as healthy",
  ].join("\n");
}

function parseArgs(argv) {
  let target = null;
  let releaseDir = resolve(root, "release");
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--target") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--target requires mac, linux, or win");
      target = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
      continue;
    }
    if (arg === "--release-dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--release-dir requires a path");
      releaseDir = resolve(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--release-dir=")) {
      releaseDir = resolve(arg.slice("--release-dir=".length));
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout-ms requires a positive number");
      timeoutMs = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      const value = Number(arg.slice("--timeout-ms=".length));
      if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout-ms requires a positive number");
      timeoutMs = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  if (target === "current") {
    target = Object.entries(TARGET_PLATFORM).find(([, platform]) => platform === process.platform)?.[0] ?? null;
  }
  if (!target || !TARGET_PLATFORM[target]) {
    throw new Error(`--target is required and must be one of: ${[...Object.keys(TARGET_PLATFORM), "current"].join(", ")}`);
  }

  return { target, releaseDir, timeoutMs };
}

function walkFiles(dir, depth = 0, maxDepth = 7) {
  if (depth > maxDepth) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(fullPath, depth + 1, maxDepth));
    } else if (entry.isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

function canExecute(file) {
  if (process.platform === "win32") return true;
  try {
    return (statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function pickBest(paths, preferredNeedles) {
  return [...paths].sort((a, b) => {
    const aScore = preferredNeedles.reduce((score, needle, idx) => score + (a.includes(needle) ? 100 - idx : 0), 0);
    const bScore = preferredNeedles.reduce((score, needle, idx) => score + (b.includes(needle) ? 100 - idx : 0), 0);
    return bScore - aScore || a.length - b.length || a.localeCompare(b);
  })[0] ?? null;
}

function findPackagedExecutable(target, releaseDir) {
  if (!existsSync(releaseDir)) {
    throw new Error(`release directory not found: ${releaseDir}`);
  }

  const files = walkFiles(releaseDir);
  if (target === "mac") {
    const matches = files.filter((file) =>
      file.endsWith(`${sep}Contents${sep}MacOS${sep}LVIS`) &&
      file.includes(`.app${sep}`) &&
      canExecute(file)
    );
    return pickBest(matches, [`mac-arm64${sep}`, `${sep}LVIS.app${sep}`]);
  }

  if (target === "linux") {
    const executableNames = new Set(["LVIS", "lvis", "lvis-app"]);
    const matches = files.filter((file) =>
      file.split(sep).some((part) => part === "linux-unpacked" || /^linux-.+-unpacked$/u.test(part)) &&
      executableNames.has(basename(file)) &&
      canExecute(file)
    );
    return pickBest(matches, [
      `linux-${process.arch}-unpacked${sep}LVIS`,
      `linux-${process.arch}-unpacked${sep}lvis`,
      `linux-${process.arch}-unpacked${sep}lvis-app`,
      `linux-unpacked${sep}LVIS`,
      `linux-unpacked${sep}lvis`,
      `linux-unpacked${sep}lvis-app`,
    ]);
  }

  const matches = files.filter((file) =>
    file.includes(`win-unpacked${sep}`) &&
    basename(file).toLowerCase() === "lvis.exe"
  );
  return pickBest(matches, [`win-unpacked${sep}LVIS.exe`]);
}

function resourcesDirForExecutable(target, executable) {
  if (target === "mac") {
    return join(dirname(dirname(executable)), "Resources");
  }
  return join(dirname(executable), "resources");
}

function assertPackagedFootprint(target, executable) {
  const asarPath = join(resourcesDirForExecutable(target, executable), "app.asar");
  if (!existsSync(asarPath)) {
    throw new Error(`packaged app.asar missing: ${asarPath}`);
  }

  const script = resolve(root, "scripts", "check-package-footprint.mjs");
  const result = spawnSync(process.execPath, [script, asarPath], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`packaged footprint check failed for ${asarPath}:\n${output}`);
  }
  process.stdout.write(`[packaged-smoke] app.asar footprint passed: ${asarPath}\n`);
}

function smokeArgs(platform, env) {
  const args = [`--user-data-dir=${env.LVIS_USER_DATA_DIR}`];
  if (platform === "linux") {
    // GitHub's Linux runner needs a virtual display and often lacks a usable
    // Chromium sandbox. The smoke is about packaged app startup and dependency
    // pruning, so keep the launch environment deterministic.
    args.push("--disable-gpu", "--no-sandbox");
  }
  if (platform === "win32") {
    return prepareElectronLaunchArgs(args, env, {
      profileName: "LVIS",
      platform,
    });
  }
  return [...new Set(args)];
}

function appendOutput(current, chunk) {
  const next = current + chunk.toString("utf8");
  return next.length > MAX_OUTPUT_CHARS ? next.slice(next.length - MAX_OUTPUT_CHARS) : next;
}

function removeTempDirBestEffort(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`[packaged-smoke] warning: could not remove temp dir ${dir}: ${err.message}\n`);
  }
}

function assertSeededMarkdownDir(homeDir, subdir) {
  const target = join(homeDir, subdir);
  if (!existsSync(target)) {
    throw new Error(`LVIS_HOME seed missing directory: ${target}`);
  }
  const markdownFiles = readdirSync(target).filter((entry) => entry.toLowerCase().endsWith(".md"));
  if (markdownFiles.length === 0) {
    throw new Error(`LVIS_HOME seed directory has no markdown files: ${target}`);
  }
}

function expectedSeededMarkdownFiles() {
  const files = ["AGENTS.md"];
  for (const subdir of ["agents", "skills", "prompts"]) {
    for (const entry of readdirSync(join(root, "resources", subdir))) {
      if (entry.toLowerCase().endsWith(".md")) {
        files.push(join(subdir, entry));
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function assertPackagedFirstLaunchSeed(homeDir) {
  const agents = join(homeDir, "AGENTS.md");
  if (!existsSync(agents)) {
    throw new Error(`LVIS_HOME seed missing AGENTS.md: ${agents}`);
  }
  const agentsContent = readFileSync(agents, "utf8");
  if (!agentsContent.includes("LVIS")) {
    throw new Error(`LVIS_HOME seed AGENTS.md does not look like LVIS guidance: ${agents}`);
  }
  assertSeededMarkdownDir(homeDir, "agents");
  assertSeededMarkdownDir(homeDir, "skills");
  assertSeededMarkdownDir(homeDir, "prompts");
  for (const rel of expectedSeededMarkdownFiles()) {
    const target = join(homeDir, rel);
    if (!existsSync(target)) {
      throw new Error(`LVIS_HOME seed missing bundled file: ${target}`);
    }
  }
}

/**
 * #1499 E2 — assert the production log file sink actually wrote a file. A
 * PACKAGED app has no console, so `~/.lvis/logs/lvis-<date>.log` is the ONLY
 * readable log a diagnostics bundle / support engineer can rely on. If boot did
 * not attach the SonicBoom sink (the PR #684 ERR_MODULE_NOT_FOUND regression
 * class, or a broken `shouldEnableFileLogSink` gate), no file appears here.
 */
function assertProductionLogFile(homeDir) {
  const logsDir = join(homeDir, "logs");
  if (!existsSync(logsDir)) {
    throw new Error(`production log sink did not create logs dir: ${logsDir}`);
  }
  const logFiles = readdirSync(logsDir).filter((f) => /^lvis-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/.test(f));
  if (logFiles.length === 0) {
    throw new Error(`production log sink created no lvis-<date>.log file in ${logsDir}`);
  }
  const nonEmpty = logFiles.some((f) => {
    try {
      return statSync(join(logsDir, f)).size > 0;
    } catch {
      return false;
    }
  });
  if (!nonEmpty) {
    throw new Error(`production log file(s) are all empty in ${logsDir}`);
  }
}

function prepareUpgradeProbe(homeDir) {
  const rel = join("skills", "report-writing.md");
  const target = join(homeDir, rel);
  const upgradeTarget = `${target}.new`;
  const packagedContent = readFileSync(target, "utf8");
  const userContent = `${packagedContent}\n\nUSER CUSTOMIZATION FROM PACKAGED SMOKE\n`;
  writeFileSync(target, userContent, "utf8");
  rmSync(upgradeTarget, { force: true });
  return { rel, target, upgradeTarget, packagedContent, userContent };
}

function assertUpgradeProbe(probe) {
  const current = readFileSync(probe.target, "utf8");
  if (current !== probe.userContent) {
    throw new Error(`LVIS_HOME upgrade overwrote user-edited file: ${probe.target}`);
  }
  if (!existsSync(probe.upgradeTarget)) {
    throw new Error(`LVIS_HOME upgrade did not create .new marker for ${probe.rel}`);
  }
  const offered = readFileSync(probe.upgradeTarget, "utf8");
  if (offered !== probe.packagedContent) {
    throw new Error(`LVIS_HOME upgrade .new marker does not match packaged content: ${probe.upgradeTarget}`);
  }
}

async function runPackagedAppOnce(executable, timeoutMs, env, label) {
  const args = smokeArgs(process.platform, env);
  process.stdout.write(`[packaged-smoke] launching ${label}: ${executable} ${args.join(" ")}\n`);

  return await new Promise((resolvePromise, reject) => {
    let output = "";
    let timedOut = false;
    let killTimer = null;
    const child = spawn(executable, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      output = appendOutput(output, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output = appendOutput(output, chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);

      if (MODULE_LOAD_FAILURE.test(output)) {
        reject(new Error(`packaged app emitted module load failure:\n${output}`));
        return;
      }
      if (timedOut) {
        process.stdout.write(`[packaged-smoke] app stayed up for ${timeoutMs}ms (${label})\n`);
        resolvePromise();
        return;
      }
      if (code === 0) {
        process.stdout.write(`[packaged-smoke] app exited cleanly (${label})\n`);
        resolvePromise();
        return;
      }
      reject(new Error(`packaged app exited early with code=${code} signal=${signal ?? "none"}:\n${output}`));
    });
  });
}

function assertWindowsPerMachineMarkerAbsent(executable) {
  if (process.platform !== "win32") return;

  const markerPath = join(
    dirname(executable),
    WINDOWS_NSIS_PER_MACHINE_MARKER_FILENAME,
  );
  const marker = lstatSync(markerPath, { throwIfNoEntry: false });
  if (marker !== undefined) {
    throw new Error(
      "win-unpacked must not contain the NSIS per-machine marker before launch",
    );
  }
}

function cleanupOwnedWindowsProtocolHandler(executable) {
  if (process.platform !== "win32") return;

  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_PROTOCOL_CLEANUP_SCRIPT,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LVIS_PROTOCOL_OWNER_EXE: executable,
      },
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (result.error) {
    throw new Error(
      `packaged Windows protocol cleanup failed to start: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `packaged Windows protocol cleanup failed with status ${result.status}: ${result.stderr.trim()}`,
    );
  }
}
async function launchSmoke(executable, timeoutMs) {
  assertWindowsPerMachineMarkerAbsent(executable);
  const userDataDir = mkdtempSync(join(tmpdir(), "lvis-packaged-smoke-"));
  const lvisHomeDir = mkdtempSync(join(tmpdir(), "lvis-packaged-home-"));
  const env = prepareElectronLaunchEnv({
    ...process.env,
    ELECTRON_ENABLE_LOGGING: "1",
    LVIS_DEV_CONSOLE: "0",
    LVIS_USER_DATA_DIR: userDataDir,
    LVIS_HOME: lvisHomeDir,
  });

  try {
    await runPackagedAppOnce(executable, timeoutMs, env, "first launch");
    assertPackagedFirstLaunchSeed(lvisHomeDir);
    // #1499 E2 — production log sink must have written a real log file.
    assertProductionLogFile(lvisHomeDir);
    const probe = prepareUpgradeProbe(lvisHomeDir);
    await runPackagedAppOnce(executable, timeoutMs, env, "upgrade probe");
    assertUpgradeProbe(probe);
    process.stdout.write("[packaged-smoke] first-launch seed and upgrade .new smoke passed\n");
  } finally {
    removeTempDirBestEffort(userDataDir);
    removeTempDirBestEffort(lvisHomeDir);
    cleanupOwnedWindowsProtocolHandler(executable);
  }
}

async function runWindowsInstallerSmoke(releaseDir, timeoutMs) {
  const script = resolve(root, "scripts", "smoke-windows-nsis-installer.mjs");
  process.stdout.write("[packaged-smoke] running Windows NSIS setup smoke\n");

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      script,
      "--release-dir",
      releaseDir,
      "--launch-timeout-ms",
      String(timeoutMs),
    ], {
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`Windows NSIS setup smoke failed with code=${code} signal=${signal ?? "none"}`));
    });
  });
}

async function main() {
  const { target, releaseDir, timeoutMs } = parseArgs(process.argv.slice(2));
  const expectedPlatform = TARGET_PLATFORM[target];
  if (process.platform !== expectedPlatform) {
    throw new Error(`target ${target} must be smoke-tested on ${expectedPlatform}; current platform is ${process.platform}`);
  }

  const executable = findPackagedExecutable(target, releaseDir);
  if (!executable) {
    throw new Error(`could not find packaged executable for target=${target} under ${releaseDir}`);
  }

  assertPackagedFootprint(target, executable);
  if (target === "win") {
    await runWindowsInstallerSmoke(releaseDir, timeoutMs);
  }
  await launchSmoke(executable, timeoutMs);
}

main().catch((err) => {
  process.stderr.write(`[packaged-smoke] FAILED: ${err.message}\n`);
  process.exit(1);
});
