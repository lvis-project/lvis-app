#!/usr/bin/env node
// Dev runner: watches main/preload/renderer/styles and restarts Electron on main changes.
// Production entrypoint remains scripts/run-electron.mjs (via `bun run start`).
//
// Usage: node scripts/run-electron-dev.mjs [--no-plugins]
//
// Env:
//   LVIS_DEV=1 (forced)
//   Plugins must already be installed into ~/.lvis/plugins/ via the marketplace
//   server (`lvis-cli install file://...`) — no host-side sideload bootstrap.
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
import { existsSync, watch, copyFileSync, mkdirSync, rmSync, cpSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  const mainEntryPath = mainOutput;
  if (!normalizedUserDataDir) return;

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$currentPid = ${process.pid}`,
    `$userDataDir = '${escapePowerShellSingleQuoted(normalizedUserDataDir)}'`,
    `$pageIndexWorkspace = '${escapePowerShellSingleQuoted(pageIndexWorkspace)}'`,
    `$launcherScriptPath = '${escapePowerShellSingleQuoted(launcherScriptPath)}'`,
    `$mainEntryPath = '${escapePowerShellSingleQuoted(mainEntryPath)}'`,
    "$killedPids = @()",
    // Launcher kill 은 절대경로 (`$launcherScriptPath`) 만 매칭. 이전엔
    // `$launcherScriptNeedle = ${basename(repoRoot)}/scripts/run-electron-dev.mjs`
    // 를 OR 로 가지고 있었지만, 같은 폴더명을 가진 다른 checkout
    // (`/work/lvis-app` vs `/home/lvis-app`) 의 launcher 까지 매칭돼
    // sibling session 을 죽일 수 있었음. profile 은 hash 로 disjoint 하지만
    // launcher 노드 프로세스에는 profile 정보가 없으므로 path 가 유일한
    // discriminator.
    "$staleLaunchers = @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.ProcessId -ne $currentPid -and $_.CommandLine -like \"*$launcherScriptPath*\" })",
    "foreach ($launcher in $staleLaunchers) {",
    "  taskkill /PID $launcher.ProcessId /T /F | Out-Null",
    "  $killedPids += \"node:$($launcher.ProcessId)\"",
    "}",
    "$targets = @()",
    // Electron / pageindex worker 는 resolved userDataDir / workspace 의
    // 전체 경로로 매칭 — `Electron-LVIS-Dev` substring 은 다른 dev profile
    // prefix 와 collide 가능. profile hash suffix + path 매칭의 이중 가드.
    "if ($userDataDir.Length -gt 0) {",
    "  $targets += Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" | Where-Object { $_.CommandLine -like \"*$mainEntryPath*\" -and $_.CommandLine -like \"*$userDataDir*\" }",
    "}",
    "if ($pageIndexWorkspace.Length -gt 0) {",
    "  $targets += Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*pageindex_worker.py*' -and $_.CommandLine -like \"*$pageIndexWorkspace*\" }",
    "}",
    "$targets = @($targets | Group-Object ProcessId | ForEach-Object { $_.Group[0] })",
    "foreach ($target in $targets) {",
    // taskkill /T /F 로 자식 프로세스 트리까지 같이 종료. `Stop-Process
    // -Force` 는 자식을 남겨서 stale Electron 트리 청소 목적이 깨졌음.
    "  taskkill /PID $target.ProcessId /T /F | Out-Null",
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
    // PowerShell 자체 실패 (spawn 에러 / 비정상 exit) 는 stderr 만 찍히고
    // status != 0 으로 떨어진다. 기존엔 stdout+stderr 를 합쳐 "killed=N"
    // 패턴 검사만 했는데, 그럼 PS 가 에러 메시지를 stderr 로 뱉었을 때
    // "cleaned stale dev processes (<error>)" 로 거짓 양성 로깅되는 케이스.
    if (result.error) {
      log("electron", `stale process cleanup skipped: ${result.error.message}`);
      return;
    }
    if (typeof result.status === "number" && result.status !== 0) {
      const detail = (`${result.stderr ?? ""}` || `${result.stdout ?? ""}`).trim()
        || `exit code ${result.status}`;
      log("electron", `stale process cleanup failed: ${detail}`);
      return;
    }
    const output = `${result.stdout ?? ""}`.trim();
    // 정리된 게 있을 때만 PID:name 리스트 로깅. dev 가 sibling 세션이
    // 사라진 걸 발견했을 때 원인 추적 가능하도록.
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
    // stale-cleanup 과 같은 이유로 status / error 우선 검사 — PS 가 stderr
    // 로 에러 메시지를 뱉었을 때 "pruned (<error>)" 로 거짓 양성 로깅되는
    // 케이스를 차단.
    if (result.error) {
      log("electron", `duplicate main prune skipped: ${result.error.message}`);
      return;
    }
    if (typeof result.status === "number" && result.status !== 0) {
      const detail = (`${result.stderr ?? ""}` || `${result.stdout ?? ""}`).trim()
        || `exit code ${result.status}`;
      log("electron", `duplicate main prune failed: ${detail}`);
      return;
    }
    const output = `${result.stdout ?? ""}`.trim();
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
  // statSync 만으로 mtime 을 얻을 수 있는데 기존 코드는 readFileSync 로
  // 파일 전체를 메모리에 올린 뒤 truthy 체크용으로만 썼음. 플러그인 빌드
  // 게이트가 자주 호출하는 hot path 라 큰 파일에서 비용이 누적된다.
  try {
    return Number(statSync(filePath).mtimeMs);
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

const disabledPluginIds = parseDisabledPluginIds();

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
  // env / cwd / shell / stdio 모두 caller 가 옵션으로 덮어쓸 수 있는 필드라
  // 명시적으로 destructure 해서 default 와 머지 순서를 분리한다.
  // - env: `{ ...process.env, LVIS_DEV: "1", ...callerEnv }` — caller 가
  //   추가/오버라이드는 가능하지만 process.env / LVIS_DEV 같은 default 는
  //   잃지 않게.
  // - cwd: caller 명시값 우선, 없으면 repoRoot.
  // 이전 구현은 `cwd: options.cwd ?? repoRoot` 다음에 `...options` 를
  // spread 했는데, rest 안에도 cwd 가 살아있어 default 가 도로 덮어졌고
  // env 도 통째로 교체되는 두 가지 함정이 있었다.
  const { env: callerEnv, cwd: callerCwd, ...rest } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: process.platform === "win32" && cmd.toLowerCase().endsWith(".cmd"),
      ...rest,
      cwd: callerCwd ?? repoRoot,
      env: { ...process.env, LVIS_DEV: "1", ...(callerEnv ?? {}) },
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
      LVIS_DEV_CONSOLE: process.env.LVIS_DEV_CONSOLE ?? "1",
      // Ensure pino logger selects pino-pretty in dev runs. NODE_ENV=production
      // gates JSON output; dev runs use "development" so colorized text is used.
      NODE_ENV: process.env.NODE_ENV ?? "development",
      // The launcher already passes --no-sandbox via WINDOWS_SAFE_ELECTRON_FLAGS
      // for the foreground dev process; mirror that into the lvis:// protocol
      // command we register so OS-launched second instances can also boot on
      // corp/VDI machines whose Chromium sandbox init fails without the flag.
      LVIS_WIN_NO_SANDBOX: process.env.LVIS_WIN_NO_SANDBOX ?? "1",
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
      "../lvis-plugin-ms-graph",
      "../lvis-plugin-lge-api",
      "../lvis-plugin-work-proactive",
      "../lvis-plugin-agent-hub",
    ].filter((relPath) => !disabledPluginIds.has(relPath.replace("../lvis-plugin-", "")));

    const bunEnv = getBunInstallEnv();

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
          // Retry once with an explicit SDK seed — covers `bun install`
          // racing against the symlinked `@lvis/plugin-sdk` not yet
          // materialised. Persistent failure falls through to the outer
          // catch and shuts the runner down.
          log("plugins", `bun failed for ${relPath}; retrying with SDK seed (${bunErr.message})`);
          seedPluginSdk(pluginDir);
          await runStep("plugins:build:bun-retry", "bun", ["run", "--cwd", pluginDir, "build"], { env: bunEnv });
        }
      }
    } catch (err) {
      log("plugins", `prepare failed: ${err.message}`);
      await shutdown(1);
      return;
    }
  }

  // Initial html copy
  copyHtml();
  try {
    watch(htmlSrc, { persistent: true }, () => copyHtml());
  } catch (err) {
    log("html", `watch failed: ${err.message}`);
  }

  // Main (tsc --watch)
  spawnWatcher("main", resolveLocalBin("tsc"), ["-p", "tsconfig.json", "--watch", "--preserveWatchOutput"]);

  // Preload (esbuild --watch) — must write `.cjs` so Electron's main
  // process loads the freshly built file. `main.ts` resolves the preload
  // by literal filename `preload.cjs`; outputting to `preload.js` here
  // produced a stale-preload regression — dev mode never updated the
  // file Electron actually loads, so renderer crashed with
  // `api.<methodAddedThisSession> is not a function` (e.g. `notifyPluginTheme`
  // from PR #489) until a manual `bun run build:preload` regenerated the .cjs.
  spawnWatcher("preload", resolveLocalBin("esbuild"), [
    "src/preload.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--external:electron",
    "--outfile=dist/src/preload.cjs",
    "--watch=forever",
  ]);

  // Plugin webview preload (esbuild --watch, CJS) — same `.cjs` target
  // requirement: plugin webviews load this by literal filename in main.ts.
  spawnWatcher("plugin-preload", resolveLocalBin("esbuild"), [
    "src/plugin-preload.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--external:electron",
    "--outfile=dist/src/plugin-preload.cjs",
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
