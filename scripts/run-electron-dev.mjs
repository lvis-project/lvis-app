#!/usr/bin/env node
// Dev runner: watches main/preload/renderer/styles and restarts Electron on main changes.
// Production entrypoint remains scripts/run-electron.mjs (via `bun run start`).
//
// Usage: node scripts/run-electron-dev.mjs [--no-plugins]
//
// Env:
//   LVIS_DEV=1 (forced)
//
// Behavior:
//   - tsc --watch for main (src -> dist/src)
//   - esbuild --watch for preload (CJS)
//   - esbuild --watch for renderer (ESM, browser)
//   - tailwindcss --watch for styles
//   - copies src/index.html once (and on change)
//   - launches electron dist/src/main.js after initial build
//   - restarts electron when dist/src/main.js changes (debounced)

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, watch, copyFileSync, mkdirSync, rmSync, cpSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

// Windows corp PC runtime flags — see scripts/run-electron.mjs for rationale.
// Flag strings come from scripts/electron-flags.mjs so the dev launcher, the
// production launcher, and main.ts's lvis:// protocol registration agree on
// the literal switch list.
import { WINDOWS_SAFE_GPU_FLAGS, SANDBOX_BYPASS_FLAG } from "./electron-flags.mjs";
const WINDOWS_SAFE_ELECTRON_FLAGS = [...WINDOWS_SAFE_GPU_FLAGS, SANDBOX_BYPASS_FLAG];

function applyWindowsSafeFlags(args) {
  const next = [...args];
  if (process.platform === "win32" && process.env.LVIS_KEEP_GPU !== "1") {
    for (const flag of WINDOWS_SAFE_ELECTRON_FLAGS) {
      if (!next.includes(flag)) next.push(flag);
    }
  }
  if (process.env.LVIS_EXTRA_ELECTRON_FLAGS) {
    const extra = process.env.LVIS_EXTRA_ELECTRON_FLAGS.split(/\s+/).filter(Boolean);
    for (const flag of extra) {
      if (!next.includes(flag)) next.push(flag);
    }
  }
  return next;
}

function ensureWindowsUserDataDir(args, env, profileName) {
  if (process.platform !== "win32") return args;
  if (args.some((arg) => arg.startsWith("--user-data-dir="))) return args;
  const appDataRoot = env.APPDATA || resolve(homedir(), "AppData", "Roaming");
  const userDataDir = env.LVIS_USER_DATA_DIR || resolve(appDataRoot, profileName);
  args.push(`--user-data-dir=${userDataDir}`);
  return args;
}

function extractUserDataDir(args) {
  const userDataArg = args.find((arg) => arg.startsWith("--user-data-dir="));
  return userDataArg ? userDataArg.slice("--user-data-dir=".length) : "";
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function cleanupStaleWindowsDevProcesses(userDataDir) {
  if (process.platform !== "win32") return;
  // Escape hatch — devs running multiple parallel `npm run dev` sessions
  // (e.g. branch comparison, side-by-side profiling) can opt out so the
  // sibling launcher / Electron isn't culled when the second invocation
  // boots. Default behaviour is unchanged.
  if (
    process.env.LVIS_DEV_NO_CLEANUP === "1" ||
    process.env.LVIS_DEV_NO_CLEANUP === "true"
  ) {
    log("electron", "stale process cleanup skipped (LVIS_DEV_NO_CLEANUP)");
    return;
  }
  const normalizedUserDataDir = String(userDataDir || "").trim();
  const pageIndexWorkspace = resolve(repoRoot, ".pageindex-workspace");
  const launcherScriptPath = resolve(repoRoot, "scripts", "run-electron-dev.mjs");
  const launcherScriptNeedle = `${basename(repoRoot)}/scripts/run-electron-dev.mjs`;
  const mainEntryPath = mainOutput;
  if (!normalizedUserDataDir) return;

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$currentPid = ${process.pid}`,
    `$userDataDir = '${escapePowerShellSingleQuoted(normalizedUserDataDir)}'`,
    `$pageIndexWorkspace = '${escapePowerShellSingleQuoted(pageIndexWorkspace)}'`,
    `$launcherScriptPath = '${escapePowerShellSingleQuoted(launcherScriptPath)}'`,
    `$launcherScriptNeedle = '${escapePowerShellSingleQuoted(launcherScriptNeedle)}'`,
    `$mainEntryPath = '${escapePowerShellSingleQuoted(mainEntryPath)}'`,
    "$killed = 0",
    "$killedPids = @()",
    // Filter Electron processes by the resolved userDataDir path (full
    // path match, not just the `Electron-LVIS-Dev` substring) so a
    // sibling repo whose profile starts with the same prefix isn't
    // culled. The hash-suffixed profile name also makes this disjoint
    // by construction, but pinning to the path is the load-bearing
    // guarantee.
    "$staleLaunchers = @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.ProcessId -ne $currentPid -and ( $_.CommandLine -like \"*$launcherScriptPath*\" -or $_.CommandLine -like \"*$launcherScriptNeedle*\" ) })",
    "foreach ($launcher in $staleLaunchers) {",
    "  taskkill /PID $launcher.ProcessId /T /F | Out-Null",
    "  $killedPids += \"node:$($launcher.ProcessId)\"",
    "}",
    "$targets = @()",
    "if ($userDataDir.Length -gt 0) {",
    "  $targets += Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" | Where-Object { $_.CommandLine -like \"*$mainEntryPath*\" -and $_.CommandLine -like \"*$userDataDir*\" }",
    "}",
    "if ($pageIndexWorkspace.Length -gt 0) {",
    "  $targets += Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*pageindex_worker.py*' -and $_.CommandLine -like \"*$pageIndexWorkspace*\" }",
    "}",
    "$targets = @($targets | Group-Object ProcessId | ForEach-Object { $_.Group[0] })",
    "foreach ($target in $targets) {",
    "  Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue",
    "  $killedPids += \"$($target.Name):$($target.ProcessId)\"",
    "}",
    "Remove-Item -LiteralPath (Join-Path $userDataDir 'lvis-tasks.db-wal') -Force -ErrorAction SilentlyContinue",
    "Remove-Item -LiteralPath (Join-Path $userDataDir 'lvis-tasks.db-shm') -Force -ErrorAction SilentlyContinue",
    "Write-Output (\"killed=\" + $killedPids.Count + \" pids=\" + ($killedPids -join ','))",
  ].join("; ");

  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    // Skip the noise when nothing was killed; otherwise log the
    // PID:name list so a dev who notices a sibling session vanish
    // can attribute it.
    if (output && !/^killed=0\b/.test(output)) {
      log("electron", `cleaned stale dev processes (${output})`);
    }
  } catch (err) {
    log("electron", `stale process cleanup skipped: ${err.message}`);
  }
}

function pruneDuplicateMainElectronProcesses(userDataDir, keepPid) {
  if (process.platform !== "win32") return;
  const normalizedUserDataDir = String(userDataDir || "").trim();
  const keep = Number(keepPid || 0);
  if (!normalizedUserDataDir || !Number.isFinite(keep) || keep <= 0) return;

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$keepPid = ${keep}`,
    `$userDataDir = '${escapePowerShellSingleQuoted(normalizedUserDataDir)}'`,
    `$mainEntryPath = '${escapePowerShellSingleQuoted(mainOutput)}'`,
    "$targets = @(Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" | Where-Object { $_.ProcessId -ne $keepPid -and $_.CommandLine -like \"*$mainEntryPath*\" -and $_.CommandLine -like \"*$userDataDir*\" })",
    "$prunedPids = @()",
    "foreach ($target in $targets) {",
    "  taskkill /PID $target.ProcessId /T /F | Out-Null",
    "  $prunedPids += $target.ProcessId",
    "}",
    "Write-Output (\"pruned=\" + $prunedPids.Count + \" pids=\" + ($prunedPids -join ','))",
  ].join("; ");

  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (output && !/^pruned=0\b/.test(output)) {
      log("electron", `pruned duplicate electron main instances (${output})`);
    }
  } catch (err) {
    log("electron", `duplicate main prune skipped: ${err.message}`);
  }
}

function applyUtf8Env(env) {
  if (!env.PYTHONIOENCODING) env.PYTHONIOENCODING = "utf-8";
  if (!env.PYTHONUTF8) env.PYTHONUTF8 = "1";
  if (!env.LANG) env.LANG = "en_US.UTF-8";
  if (!env.LC_ALL) env.LC_ALL = "en_US.UTF-8";
  return env;
}

function getBunInstallEnv() {
  const localAppData = process.env.LOCALAPPDATA || resolve(homedir(), "AppData", "Local");
  const bunRoot = resolve(localAppData, "lvis-bun");
  const bunCacheDir = resolve(bunRoot, "install", "cache");
  const bunTmpDir = resolve(bunRoot, "tmp");
  mkdirSync(bunCacheDir, { recursive: true });
  mkdirSync(bunTmpDir, { recursive: true });
  return {
    ...process.env,
    BUN_INSTALL_CACHE_DIR: bunCacheDir,
    TMP: bunTmpDir,
    TEMP: bunTmpDir,
    TMPDIR: bunTmpDir,
  };
}

function seedPluginSdk(pluginDir) {
  const sdkSrc = resolve(repoRoot, "packages/plugin-sdk");
  const sdkDest = resolve(pluginDir, "node_modules/@lvis/plugin-sdk");
  const sdkDestParent = dirname(sdkDest);
  mkdirSync(sdkDestParent, { recursive: true });
  rmSync(sdkDest, { recursive: true, force: true });
  mkdirSync(sdkDest, { recursive: true });

  const sdkPackageJson = resolve(sdkSrc, "package.json");
  const sdkDist = resolve(sdkSrc, "dist");
  const sdkSchemas = resolve(sdkSrc, "schemas");
  const sdkKeys = resolve(sdkSrc, "src/keys.ts");

  copyFileSync(sdkPackageJson, resolve(sdkDest, "package.json"));
  if (existsSync(sdkDist)) cpSync(sdkDist, resolve(sdkDest, "dist"), { recursive: true, force: true });
  if (existsSync(sdkSchemas)) cpSync(sdkSchemas, resolve(sdkDest, "schemas"), { recursive: true, force: true });
  if (existsSync(sdkKeys)) {
    mkdirSync(resolve(sdkDest, "src"), { recursive: true });
    copyFileSync(sdkKeys, resolve(sdkDest, "src/keys.ts"));
  }
}

function normalizeLinkedSubpath(packageName, subpath) {
  const normalized = String(subpath).replaceAll("\\", "/").replace(/^\.\//, "");
  return `../../../node_modules/${packageName}/${normalized}`;
}

function parseDisabledPluginIds() {
  const defaults = ["work-proactive"];
  const envRaw = process.env.LVIS_DEV_DISABLED_PLUGINS || "";
  const envItems = envRaw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return new Set([...defaults, ...envItems]);
}

function shouldSkipPluginBuild(pluginDir) {
  // Fast dev path: skip costly install/build only when artifacts are already
  // present AND source/config inputs have not changed since last build.
  if (process.env.LVIS_DEV_FORCE_PLUGIN_BUILD === "1") return false;
  const hasDeps = existsSync(resolve(pluginDir, "node_modules"));
  const distDir = resolve(pluginDir, "dist");
  if (!hasDeps || !existsSync(distDir)) return false;

  const latestDist = latestMtimeMs(distDir);
  const srcDir = resolve(pluginDir, "src");
  const workerDir = resolve(pluginDir, "worker");
  const latestInputs = Math.max(
    existsSync(srcDir) ? latestMtimeMs(srcDir) : 0,
    existsSync(workerDir) ? latestMtimeMs(workerDir) : 0,
    fileMtimeMs(resolve(pluginDir, "plugin.json")),
    fileMtimeMs(resolve(pluginDir, "package.json")),
    fileMtimeMs(resolve(pluginDir, "tsconfig.json")),
  );
  return latestDist >= latestInputs;
}

function fileMtimeMs(filePath) {
  try {
    return Number(readFileSync(filePath) ? statSync(filePath).mtimeMs : 0);
  } catch {
    return 0;
  }
}

function latestMtimeMs(dirPath) {
  let latest = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = resolve(dirPath, entry.name);
      if (entry.isDirectory()) {
        latest = Math.max(latest, latestMtimeMs(full));
      } else {
        try {
          const mtimeMs = statSync(full).mtimeMs;
          if (mtimeMs > latest) latest = mtimeMs;
        } catch {}
      }
    }
  } catch {}
  return latest;
}

function removeDirRobust(dirPath, maxRetries = 5) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = err && typeof err === "object" ? err.code : "";
      if (i === maxRetries || (code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EBUSY")) {
        throw err;
      }
      // brief backoff for file-handle release on Windows
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
    }
  }
}

const disabledPluginIds = parseDisabledPluginIds();

function seedDevPluginRegistry() {
  const workspaceRoot = resolve(repoRoot, "..");
  const devPluginsDir = resolve(repoRoot, ".lvis-dev", "plugins");
  const registryPath = resolve(devPluginsDir, "registry.json");

  mkdirSync(devPluginsDir, { recursive: true });

  const registry = { version: 1, plugins: [] };
  const pluginRepos = readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("lvis-plugin-"));

  for (const repo of pluginRepos) {
    const pluginRepoDir = resolve(workspaceRoot, repo.name);
    const manifestPath = resolve(pluginRepoDir, "plugin.json");
    const packageJsonPath = resolve(pluginRepoDir, "package.json");
    if (!existsSync(manifestPath) || !existsSync(packageJsonPath)) continue;

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      const pluginId = typeof manifest.id === "string" ? manifest.id : undefined;
      const packageName = typeof packageJson.name === "string" ? packageJson.name : undefined;
      const manifestEntry = typeof manifest.entry === "string" ? manifest.entry : undefined;
      if (!pluginId || !packageName || !manifestEntry) continue;

      const builtEntryPath = resolve(pluginRepoDir, manifestEntry);
      if (!existsSync(builtEntryPath)) {
        log("plugins", `skip unbuilt local plugin: ${repo.name}`);
        continue;
      }

      const pluginInstallDir = resolve(devPluginsDir, pluginId);
      mkdirSync(pluginInstallDir, { recursive: true });

      const rewrittenManifest = {
        ...manifest,
        entry: normalizeLinkedSubpath(packageName, manifestEntry),
        ...(Array.isArray(manifest.ui)
          ? {
              ui: manifest.ui.map((extension) => ({
                ...extension,
                ...(typeof extension.entry === "string"
                  ? { entry: normalizeLinkedSubpath(packageName, extension.entry) }
                  : {}),
                ...(typeof extension.page === "string"
                  ? { page: normalizeLinkedSubpath(packageName, extension.page) }
                  : {}),
              })),
            }
          : {}),
      };

      writeFileSync(
        resolve(pluginInstallDir, "plugin.json"),
        `${JSON.stringify(rewrittenManifest, null, 2)}\n`,
        "utf-8",
      );
      registry.plugins.push({
        id: pluginId,
        manifestPath: `${pluginId}/plugin.json`,
        enabled: !disabledPluginIds.has(pluginId),
        installedBy: manifest.installPolicy === "admin" ? "admin" : "user",
        ...(manifest.pluginAccess ? { approvedPluginAccess: manifest.pluginAccess } : {}),
      });
    } catch (err) {
      log("plugins", `skip invalid local plugin ${repo.name}: ${err.message}`);
    }
  }

  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
  return { devPluginsDir, pluginCount: registry.plugins.length };
}

function parseMsEnv(name, fallbackMs) {
  const raw = process.env[name];
  if (!raw) return fallbackMs;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallbackMs;
  return parsed;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashFile(filePath) {
  try {
    const buf = readFileSync(filePath);
    return createHash("sha1").update(buf).digest("hex");
  } catch {
    return "";
  }
}

// Dev mode wraps the Electron launch via cmd.exe /c "chcp 65001 & electron …"
// in launchElectron() below so the code-page change shares Electron's console.
// See scripts/run-electron.mjs for the detailed rationale.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
// Profile suffix mixes basename + 8-char hash of the absolute repoRoot.
// basename alone collides when two checkouts share the directory name
// (`/work/lvis-app` vs `/home/lvis-app` — not unusual in branch-compare
// or multi-clone setups), and the kill / prune logic above keys off the
// resolved userDataDir; a colliding profile would let a sibling
// launcher's cleanup pass nuke this session's Electron. Keep basename
// in the visible name so the AppData entry is still humane.
const repoRootHash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
const DEV_PROFILE_NAME = process.env.LVIS_DEV_PROFILE_NAME || `Electron-LVIS-Dev-${basename(repoRoot)}-${repoRootHash}`;
const binDir = resolve(repoRoot, "node_modules/.bin");
const mainOutput = resolve(repoRoot, "dist/src/main.js");
const htmlSrc = resolve(repoRoot, "src/index.html");
const htmlOut = resolve(repoRoot, "dist/src/index.html");

const argv = new Set(process.argv.slice(2));
const skipPlugins = argv.has("--no-plugins");
const RESTART_DELAY_MS = parseMsEnv("LVIS_DEV_RESTART_DELAY_MS", 2500);
const RESTART_FORCE_KILL_MS = parseMsEnv("LVIS_DEV_RESTART_FORCE_KILL_MS", 3000);

const children = [];
let electronProc = null;
let restartTimer = null;
let shuttingDown = false;
let restartInFlight = false;
let shutdownPromise = null;
let lastMainOutputHash = "";

function log(tag, msg) {
  process.stdout.write(`[dev:${tag}] ${msg}\n`);
}

function forceKillProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

async function stopElectronForRestart() {
  const proc = electronProc;
  if (!proc) return;
  const pid = proc.pid;
  await new Promise((resolve) => {
    let finished = false;
    let killTimer = null;
    const done = () => {
      if (finished) return;
      finished = true;
      if (killTimer) clearTimeout(killTimer);
      resolve();
    };
    proc.once("exit", done);
    killTimer = setTimeout(() => {
      log("electron", `restart timeout -> force killing process tree (pid=${pid ?? "unknown"})`);
      forceKillProcessTree(pid);
    }, RESTART_FORCE_KILL_MS);
    try {
      proc.kill("SIGTERM");
    } catch {
      done();
    }
  });
  await sleep(RESTART_DELAY_MS);
}

function resolveLocalBin(name) {
  const candidates = process.platform === "win32"
    ? [resolve(binDir, `${name}.exe`), resolve(binDir, `${name}.cmd`), resolve(binDir, name)]
    : [resolve(binDir, name)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

function spawnWatcher(tag, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, LVIS_DEV: "1" },
    shell: process.platform === "win32" && cmd.toLowerCase().endsWith(".cmd"),
    ...opts,
  });
  child.on("error", (err) => {
    log(tag, `spawn failed: ${err.message}`);
    shutdown(1);
  });
  child.on("exit", (code) => {
    if (!shuttingDown) log(tag, `watcher exited code=${code}`);
  });
  children.push(child);
  return child;
}

function runStep(tag, cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd ?? repoRoot,
      stdio: "inherit",
      env: { ...process.env, LVIS_DEV: "1" },
      shell: process.platform === "win32" && cmd.toLowerCase().endsWith(".cmd"),
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${tag} failed (exit=${code ?? "null"})`));
      }
    });
  });
}

function copyHtml() {
  try {
    mkdirSync(dirname(htmlOut), { recursive: true });
    copyFileSync(htmlSrc, htmlOut);
    log("html", "copied index.html");
  } catch (err) {
    log("html", `copy failed: ${err.message}`);
  }
}

async function stopChildProcess(proc, { forceTree = false } = {}) {
  if (!proc?.pid) return;
  if (forceTree && process.platform === "win32") {
    forceKillProcessTree(proc.pid);
    return;
  }
  await new Promise((resolve) => {
    let doneCalled = false;
    let killTimer = null;
    const done = () => {
      if (doneCalled) return;
      doneCalled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve();
    };
    proc.once("exit", done);
    killTimer = setTimeout(() => {
      forceKillProcessTree(proc.pid);
      done();
    }, RESTART_FORCE_KILL_MS);
    try {
      proc.kill("SIGTERM");
    } catch {
      done();
    }
  });
}

function launchElectron() {
  if (electronProc) return;
  const launchEnv = (() => {
    const e = applyUtf8Env({
      ...process.env,
      LVIS_DEV: "1",
      LVIS_ALLOW_LINKED_PLUGIN_ENTRY: process.env.LVIS_ALLOW_LINKED_PLUGIN_ENTRY ?? "1",
      LVIS_ENABLE_DEV_CONSOLE: process.env.LVIS_ENABLE_DEV_CONSOLE ?? "1",
      LVIS_DEV_SKIP_SIG: process.env.LVIS_DEV_SKIP_SIG ?? "1",
      // The launcher already passes --no-sandbox via WINDOWS_SAFE_ELECTRON_FLAGS
      // for the foreground dev process; mirror that into the lvis:// protocol
      // command we register so OS-launched second instances can also boot on
      // corp/VDI machines whose Chromium sandbox init fails without the flag.
      LVIS_DEV_NO_SANDBOX: process.env.LVIS_DEV_NO_SANDBOX ?? "1",
    });
    delete e.ELECTRON_RUN_AS_NODE;
    return e;
  })();
  const electronArgs = ensureWindowsUserDataDir(applyWindowsSafeFlags([mainOutput]), launchEnv, DEV_PROFILE_NAME);
  const userDataDir = extractUserDataDir(electronArgs);
  cleanupStaleWindowsDevProcesses(userDataDir);
  log("electron", `launching ${mainOutput}`);
  const env = launchEnv;
  if (process.platform === "win32") {
    electronProc = spawn(electronPath, electronArgs, {
      cwd: repoRoot,
      stdio: "inherit",
      env,
      windowsHide: false,
    });
  } else {
    electronProc = spawn(electronPath, electronArgs, {
      cwd: repoRoot,
      stdio: "inherit",
      env,
    });
  }
  if (electronProc?.pid) {
    setTimeout(() => {
      pruneDuplicateMainElectronProcesses(userDataDir, electronProc?.pid ?? 0);
    }, 5000);
  }
  electronProc.on("error", (err) => {
    log("electron", `spawn failed: ${err.message}`);
    electronProc = null;
    shutdown(1);
  });
  electronProc.on("exit", (code, signal) => {
    log("electron", `exited code=${code} signal=${signal ?? "-"}`);
    electronProc = null;
    if (!shuttingDown && !restartInFlight && signal !== "SIGTERM" && signal !== "SIGKILL") {
      // If electron exited on its own (window closed), shut down dev loop.
      shutdown(0);
    }
  });
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    void (async () => {
      restartTimer = null;
      if (shuttingDown || restartInFlight) return;
      restartInFlight = true;
      try {
        if (electronProc) {
          log("electron", `main changed -> restarting (grace=${RESTART_DELAY_MS}ms)`);
          await stopElectronForRestart();
        } else {
          await sleep(RESTART_DELAY_MS);
        }
        if (!shuttingDown) launchElectron();
      } finally {
        restartInFlight = false;
      }
    })();
  }, 400);
}

async function waitForMain(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(mainOutput)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function shutdown(code = 0) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  restartInFlight = false;
  log("dev", "shutting down");
  const activeElectron = electronProc;
  const activeChildren = children.splice(0, children.length);
  electronProc = null;
  shutdownPromise = (async () => {
    await Promise.allSettled([
      ...(activeElectron ? [stopChildProcess(activeElectron)] : []),
      ...activeChildren.map((child) => stopChildProcess(child, { forceTree: process.platform === "win32" })),
    ]);
    process.exit(code);
  })();
  return shutdownPromise;
}

process.on("SIGINT", () => {
  void shutdown(0);
});
process.on("SIGTERM", () => {
  void shutdown(0);
});
process.on("exit", () => {
  if (electronProc?.pid) forceKillProcessTree(electronProc.pid);
  for (const child of children) {
    if (child?.pid) forceKillProcessTree(child.pid);
  }
});

async function main() {
  log("dev", `LVIS_DEV=1 skipPlugins=${skipPlugins}`);

  if (!skipPlugins) {
    log("plugins", "building plugins (one-shot)");
    const pluginRoots = [
      "../lvis-plugin-pageindex",
      "../lvis-plugin-meeting",
      "../lvis-plugin-email",
      "../lvis-plugin-calendar",
      "../lvis-plugin-lge-api",
      "../lvis-plugin-work-proactive",
    ].filter((relPath) => !disabledPluginIds.has(relPath.replace("../lvis-plugin-", "")));

    const bunEnv = getBunInstallEnv();
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

    try {
      for (const relPath of pluginRoots) {
        const pluginDir = resolve(repoRoot, relPath);
        if (shouldSkipPluginBuild(pluginDir)) {
          log("plugins", `skip install+build (already prepared): ${relPath}`);
          continue;
        }
        log("plugins", `install+build: ${relPath}`);
        try {
          await runStep("plugins:install", "bun", ["install", "--cwd", pluginDir], { env: bunEnv });
          await runStep("plugins:build", "bun", ["run", "--cwd", pluginDir, "build"], { env: bunEnv });
        } catch (bunErr) {
          log("plugins", `bun failed for ${relPath}; fallback to npm (${bunErr.message})`);
          try {
            seedPluginSdk(pluginDir);
            await runStep("plugins:build:bun-retry", "bun", ["run", "--cwd", pluginDir, "build"], { env: bunEnv });
          } catch (bunRetryErr) {
            log("plugins", `bun retry failed for ${relPath}; using npm fallback (${bunRetryErr.message})`);
            await runStep("plugins:install:npm", npmCmd, ["install", "--prefix", pluginDir]);
            await runStep("plugins:build:npm", npmCmd, ["run", "--prefix", pluginDir, "build"]);
          }
        }
      }
    } catch (err) {
      log("plugins", `prepare failed: ${err.message}`);
      await shutdown(1);
      return;
    }
  }

  const { devPluginsDir, pluginCount } = seedDevPluginRegistry();
  process.env.LVIS_PLUGINS_DIR = devPluginsDir;
  log("plugins", `seeded dev registry (${pluginCount} plugins) -> ${devPluginsDir}`);

  // Initial html copy
  copyHtml();
  try {
    watch(htmlSrc, { persistent: true }, () => copyHtml());
  } catch (err) {
    log("html", `watch failed: ${err.message}`);
  }

  // Main (tsc --watch)
  spawnWatcher("main", resolveLocalBin("tsc"), ["-p", "tsconfig.json", "--watch", "--preserveWatchOutput"]);

  // Preload (esbuild --watch)
  spawnWatcher("preload", resolveLocalBin("esbuild"), [
    "src/preload.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--external:electron",
    "--outfile=dist/src/preload.js",
    "--watch=forever",
  ]);

  // Plugin webview preload (esbuild --watch, CJS)
  spawnWatcher("plugin-preload", resolveLocalBin("esbuild"), [
    "src/plugin-preload.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--external:electron",
    "--outfile=dist/src/plugin-preload.js",
    "--watch=forever",
  ]);

  // Renderer (esbuild --watch)
  spawnWatcher("renderer", resolveLocalBin("esbuild"), [
    "src/renderer.tsx",
    "--bundle",
    "--platform=browser",
    "--format=esm",
    "--outfile=dist/src/renderer.js",
    "--watch=forever",
  ]);

  // Styles (tailwind --watch)
  spawnWatcher("styles", resolveLocalBin("tailwindcss"), [
    "-i",
    "src/styles.css",
    "-o",
    "dist/src/styles.css",
    "--watch=always",
  ]);

  const ok = await waitForMain();
  if (!ok) {
    log("dev", "timed out waiting for dist/src/main.js");
    await shutdown(1);
    return;
  }

  lastMainOutputHash = hashFile(mainOutput);
  launchElectron();

  // Watch main output for rebuilds
  try {
    watch(mainOutput, { persistent: true }, () => {
      const nextHash = hashFile(mainOutput);
      if (!nextHash || nextHash === lastMainOutputHash) return;
      lastMainOutputHash = nextHash;
      scheduleRestart();
    });
  } catch (err) {
    log("main", `watch failed: ${err.message}`);
  }
}

main().catch((err) => {
  log("dev", `fatal: ${err?.stack ?? err}`);
  void shutdown(1);
});
