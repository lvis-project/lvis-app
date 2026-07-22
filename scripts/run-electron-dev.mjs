#!/usr/bin/env node
// Dev runner: watches main/preload/renderer/styles and restarts Electron on main changes.
// Production entrypoint remains scripts/run-electron.mjs (via `bun run start`).
//
// Usage: node scripts/run-electron-dev.mjs
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
//   - copies src/index.html, src/plugin-ui-shell.html, the host-owned
//     external bootstrap src/plugin-ui-shell.js, and runtime script assets
//     once (and on change).
//     The plugin shell bootstrap MUST be a sibling file (not inlined) so it
//     loads under the shell's strict CSP `script-src 'self'`.
//   - launches electron dist/src/main/main.js after initial build
//   - restarts electron when dist/src/main/main.js changes (debounced)

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, watch, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { waitForAllFirstBuilds } from "./lib/dev-watcher-gate.mjs";
import { resolveBuildAssets } from "./lib/build-assets.mjs";
import { ensureElectronNativeModules } from "./lib/electron-native-modules.mjs";
import {
  extractUserDataDir,
  prepareElectronLaunchArgs,
  prepareElectronLaunchEnv,
} from "./lib/electron-launch-options.mjs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

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
  const localIndexerWorkspace = resolve(repoRoot, ".local-indexer-workspace");
  const launcherScriptPath = resolve(repoRoot, "scripts", "run-electron-dev.mjs");
  const mainEntryPath = mainOutput;
  if (!normalizedUserDataDir) return;

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$currentPid = ${process.pid}`,
    `$userDataDir = '${escapePowerShellSingleQuoted(normalizedUserDataDir)}'`,
    `$localIndexerWorkspace = '${escapePowerShellSingleQuoted(localIndexerWorkspace)}'`,
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
    // Electron / Local Indexer worker 는 resolved userDataDir / workspace 의
    // 전체 경로로 매칭 — `Electron-LVIS-Dev` substring 은 다른 dev profile
    // prefix 와 collide 가능. profile hash suffix + path 매칭의 이중 가드.
    "if ($userDataDir.Length -gt 0) {",
    "  $targets += Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" | Where-Object { $_.CommandLine -like \"*$mainEntryPath*\" -and $_.CommandLine -like \"*$userDataDir*\" }",
    "}",
    "if ($localIndexerWorkspace.Length -gt 0) {",
    "  $targets += Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*pageindex_worker.py*' -and $_.CommandLine -like \"*$localIndexerWorkspace*\" }",
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
const mainOutput = resolve(repoRoot, "dist/src/main/main.js");
const [indexHtmlAsset] = resolveBuildAssets(repoRoot, "app-shell");
const htmlSrc = indexHtmlAsset.src;
const htmlOut = indexHtmlAsset.out;
// Plugin UI shell — HTML + external bootstrap module. Both must reach
// `dist/src/` for plugin webviews to render. The bootstrap is a separate
// file because the shell's CSP (`script-src 'self'`, no `'unsafe-inline'`)
// would silently refuse an inline `<script type="module">` block, leaving
// embedded plugin areas blank and detached windows black.
const pluginShellAssets = resolveBuildAssets(repoRoot, "plugin-shell");
// Runtime script assets imported by compiled main-process modules. The dev
// watcher and `bun run build` read the same registry in scripts/lib/build-assets.mjs.
const runtimeScriptAssets = resolveBuildAssets(repoRoot, "runtime-script");

const RESTART_DELAY_MS = parseMsEnv("LVIS_DEV_RESTART_DELAY_MS", 2500);
const RESTART_FORCE_KILL_MS = parseMsEnv("LVIS_DEV_RESTART_FORCE_KILL_MS", 3000);

const children = [];
const fsWatchDisposers = [];
let electronProc = null;
let restartTimer = null;
let shuttingDown = false;
let restartInFlight = false;
let shutdownPromise = null;
let lastMainOutputHash = "";

function log(tag, msg) {
  process.stdout.write(`[dev:${tag}] ${msg}\n`);
}
function startResilientWatch(tag, targetPath, onChange, options = {}) {
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 750;
  const watchOptions = { persistent: true, ...(options.watchOptions ?? {}) };
  let watcher = null;
  let retryTimer = null;
  let closed = false;

  const scheduleRetry = () => {
    if (closed || shuttingDown || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      start();
    }, retryDelayMs);
  };

  const start = () => {
    if (closed || shuttingDown) return;
    try {
      watcher = watch(targetPath, watchOptions, onChange);
      watcher.on("error", (err) => {
        log(tag, `watch error (${targetPath}): ${err.message}`);
        try {
          watcher?.close();
        } catch {}
        watcher = null;
        scheduleRetry();
      });
    } catch (err) {
      log(tag, `watch failed (${targetPath}): ${err.message}`);
      scheduleRetry();
    }
  };

  start();

  return () => {
    closed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (watcher) {
      try {
        watcher.close();
      } catch {}
      watcher = null;
    }
  };
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

// Map<tag, { resolve, promise }> — populated by spawnWatcher when a watcher
// has readyPattern. Consumed by the watcher list builder so dev-watcher-gate
// can await stdout signals instead of polling output mtime.
const watcherReady = new Map();

function stripAnsi(value) {
  return String(value).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function suppressTailwindStatusLine(line) {
  const normalized = stripAnsi(line).trim();
  return (
    normalized === "" ||
    /^Done in \d+(?:\.\d+)?(?:ms|s|[\u00b5\u03bc]s)$/.test(normalized) ||
    /^(?:\u2248\s*)?tailwindcss v\d+\.\d+\.\d+/.test(normalized)
  );
}

function createLineWriter(sink, suppressLine) {
  let pending = "";
  return {
    write(chunk) {
      if (typeof suppressLine !== "function") {
        sink.write(chunk);
        return;
      }
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!suppressLine(line)) sink.write(`${line}\n`);
      }
    },
    flush() {
      if (pending && !suppressLine(pending)) sink.write(pending);
      pending = "";
    },
  };
}

function spawnWatcher(tag, cmd, args, opts = {}) {
  const { readyPattern, suppressStderrLine, ...spawnOpts } = opts;
  // When readyPattern is supplied, pipe stdout/stderr so we can scan for the
  // first build-complete signal. Optional stderr filtering suppresses known
  // status noise while preserving diagnostics.
  if (readyPattern) {
    let resolveReady;
    const promise = new Promise((r) => { resolveReady = r; });
    watcherReady.set(tag, { resolve: resolveReady, promise });
  }
  const shouldPipeStdout = Boolean(readyPattern);
  const shouldPipeStderr = Boolean(readyPattern || suppressStderrLine);
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    // When readyPattern is set, pipe BOTH stdout and stderr — different
    // tools emit the build-complete signal on different streams
    // (tailwindcss prints "Done in NNNms" on stderr, esbuild prints
    // "build finished" on stderr too). We tee both back to the parent
    // terminal so dev still sees full output, but also scan for the
    // pattern.
    stdio: [
      "ignore",
      shouldPipeStdout ? "pipe" : "inherit",
      shouldPipeStderr ? "pipe" : "inherit",
    ],
    env: { ...process.env, LVIS_DEV: "1" },
    shell: process.platform === "win32" && cmd.toLowerCase().endsWith(".cmd"),
    ...spawnOpts,
  });
  if (readyPattern || suppressStderrLine) {
    let matched = false;
    let readyScanBuffer = "";
    const stdoutWriter = createLineWriter(process.stdout);
    const stderrWriter = createLineWriter(process.stderr, suppressStderrLine);
    const scan = (chunk, writer) => {
      if (readyPattern && !matched) {
        readyScanBuffer += chunk.toString();
        if (readyScanBuffer.length > 4096) readyScanBuffer = readyScanBuffer.slice(-4096);
        if (readyPattern.test(stripAnsi(readyScanBuffer))) {
          matched = true;
          readyScanBuffer = "";
          const entry = watcherReady.get(tag);
          if (entry) entry.resolve();
        }
      }
      writer.write(chunk);
    };
    if (child.stdout) {
      child.stdout.on("data", (c) => scan(c, stdoutWriter));
      child.stdout.on("end", () => stdoutWriter.flush());
    }
    if (child.stderr) {
      child.stderr.on("data", (c) => scan(c, stderrWriter));
      child.stderr.on("end", () => stderrWriter.flush());
    }
  }
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

function copyPluginShellAsset(asset) {
  try {
    mkdirSync(dirname(asset.out), { recursive: true });
    copyFileSync(asset.src, asset.out);
    log("plugin-shell", `copied ${asset.label}`);
  } catch (err) {
    log("plugin-shell", `copy failed (${asset.label}): ${err.message}`);
  }
}

function copyAllPluginShellAssets() {
  for (const asset of pluginShellAssets) copyPluginShellAsset(asset);
}

function copyRuntimeScriptAsset(asset) {
  try {
    mkdirSync(dirname(asset.out), { recursive: true });
    copyFileSync(asset.src, asset.out);
    log("runtime-script", `copied ${asset.label}`);
  } catch (err) {
    log("runtime-script", `copy failed (${asset.label}): ${err.message}`);
  }
}

function copyAllRuntimeScriptAssets() {
  for (const asset of runtimeScriptAssets) copyRuntimeScriptAsset(asset);
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
    const e = {
      ...process.env,
      LVIS_DEV: "1",
      LVIS_DEV_CONSOLE: process.env.LVIS_DEV_CONSOLE ?? "1",
      // Ensure pino logger selects pino-pretty in dev runs. NODE_ENV=production
      // gates JSON output; dev runs use "development" so colorized text is used.
      NODE_ENV: process.env.NODE_ENV ?? "development",
      // The launcher already passes --no-sandbox via shared Windows-safe flags
      // for the foreground dev process; mirror that into the lvis:// protocol
      // command we register so OS-launched second instances can also boot on
      // corp/VDI machines whose Chromium sandbox init fails without the flag.
      LVIS_WIN_NO_SANDBOX: process.env.LVIS_WIN_NO_SANDBOX,
    };
    return prepareElectronLaunchEnv(e);
  })();
  const electronArgs = prepareElectronLaunchArgs([mainOutput], launchEnv, {
    profileName: DEV_PROFILE_NAME,
  });
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

// Each watcher's expected first-build signal. We gate Electron launch on
// ALL of them having a fresh first build so the renderer never loads HTML
// referencing missing styles.css/renderer.js (which previously produced an
// unstyled UI on first dev run after a clean dist).
//
// Two signal sources, picked per watcher:
//   - `output` (mtime ≥ launcherStartedAt) — esbuild always rewrites on
//     first invocation, so mtime polling is reliable.
//   - `readyPromise` (resolves when spawnWatcher's stdout/stderr scan sees
//     `readyPattern`) — required for tools with idempotent skip-write
//     (tailwindcss v4 skips writes when resolved CSS is identical to the
//     prior build, leaving mtime stale → mtime gate would hang).
//
// See scripts/lib/dev-watcher-gate.mjs for the dual-signal detection.
function makeWatcherList() {
  // Sanity check: the styles watcher MUST have been spawned (and thus
  // populated `watcherReady`) before this function runs. Otherwise the
  // readyPromise lookup returns undefined → gate silently falls back to
  // mtime → tailwindcss skip-write → hang. Loud failure here beats a
  // silent regression after a future caller reordering.
  if (!watcherReady.has("styles")) {
    throw new Error(
      "makeWatcherList: styles watcher not spawned yet — call spawnWatcher('styles', ...) first",
    );
  }
  return [
    { tag: "main",           label: "Main process (esbuild)",  output: resolve(repoRoot, "dist/src/main/main.js") },
    { tag: "preload",        label: "Preload (esbuild)",       output: resolve(repoRoot, "dist/src/preload.cjs") },
    { tag: "plugin-preload", label: "Plugin preload (esbuild)",output: resolve(repoRoot, "dist/src/plugin-preload.cjs") },
    { tag: "renderer",       label: "Renderer (esbuild)",      output: resolve(repoRoot, "dist/src/renderer.js") },
    { tag: "styles",         label: "Styles (Tailwind)",       readyPromise: watcherReady.get("styles")?.promise },
  ];
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
  const activeFsWatchDisposers = fsWatchDisposers.splice(0, fsWatchDisposers.length);
  electronProc = null;
  shutdownPromise = (async () => {
    for (const dispose of activeFsWatchDisposers) {
      try {
        dispose();
      } catch {}
    }
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
process.on("uncaughtException", (err) => {
  if (err?.code === "EPERM" && err?.syscall === "watch") {
    log("watch", `transient watcher EPERM suppressed: ${err.message}`);
    return;
  }
  throw err;
});
process.on("exit", () => {
  if (electronProc?.pid) forceKillProcessTree(electronProc.pid);
  for (const child of children) {
    if (child?.pid) forceKillProcessTree(child.pid);
  }
});

async function main() {
  log("dev", "LVIS_DEV=1");
  ensureElectronNativeModules({
    repoRoot,
    log: (message) => log("native", message),
  });
  // Captured BEFORE any watcher spawns. waitForFirstBuild compares each
  // output's mtime against this baseline so we accept ONLY emits produced
  // by the current dev session (not stale incremental output left behind
  // by a prior run).
  const launcherStartedAt = Date.now();
  // Watcher list is built AFTER spawnWatcher calls below so that any
  // readyPromise entries (populated by spawnWatcher into the watcherReady
  // map) are visible. See makeWatcherList for the stdout-vs-mtime split.

  // Initial html copy
  copyHtml();
  fsWatchDisposers.push(startResilientWatch("html", htmlSrc, () => copyHtml()));

  // Plugin UI shell assets (html + external bootstrap js). Copy once and
  // watch each so the dev loop stays in sync without a full `bun run build`.
  copyAllPluginShellAssets();
  for (const asset of pluginShellAssets) {
    fsWatchDisposers.push(
      startResilientWatch("plugin-shell", asset.src, () => copyPluginShellAsset(asset)),
    );
  }

  // Runtime script assets imported from compiled dist/src modules.
  copyAllRuntimeScriptAssets();
  for (const asset of runtimeScriptAssets) {
    fsWatchDisposers.push(
      startResilientWatch("runtime-script", asset.src, () => copyRuntimeScriptAsset(asset)),
    );
  }

  // Main (esbuild --watch via build-main-esbuild.mjs). tsc -p tsconfig.json
  // would emit to `dist/src/main.js`, but the packaged bundle lives at
  // `dist/src/main/main.js`; keeping dev on tsc would race two different
  // entry paths. Reuse the bundle script so dev and prod share output.
  spawnWatcher("main", process.execPath, [resolve(repoRoot, "scripts/build-main-esbuild.mjs"), "--watch"]);

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
  // tailwindcss v4 skips file writes when the resolved CSS is identical to
  // the prior build (intentional incremental optimization). The mtime gate
  // would then never see mtime advance and time out. Instead we capture
  // the watcher's stderr/stdout and treat the first "Done in ..." line as
  // the build-complete signal — works regardless of whether tailwindcss
  // actually rewrote the file. See scripts/lib/dev-watcher-gate.mjs for the
  // dual-signal (stdout + mtime fallback) detection logic.
  // Pattern anchored at line start + known duration suffixes to avoid false positives
  // from any "Done in N" substring appearing in error stack traces or CSS
  // comments. Failing tight is better than silently resolving on a non-build line.
  spawnWatcher("styles", resolveLocalBin("tailwindcss"), [
    "-i",
    "src/styles.css",
    "-o",
    "dist/src/styles.css",
    "--watch=always",
  ], {
    readyPattern: /(^|\n)Done in \d+(?:\.\d+)?(?:ms|s|[\u00b5\u03bc]s)\b/,
    suppressStderrLine: suppressTailwindStatusLine,
  });

  // Wait for ALL watchers' first build before launching Electron. Pre-fix
  // the launcher only awaited dist/src/main/main.js, so renderer.js and
  // styles.css could be missing when Electron loaded index.html — Tailwind
  // utility classes were undefined and v6 composer rendered as raw text
  // (Bug #TBD). The mtime gate ensures every watcher has produced a fresh
  // build for the current dev session.
  const watchers = makeWatcherList();
  const ok = await waitForAllFirstBuilds(watchers, launcherStartedAt, log);
  if (!ok) {
    log("dev", "timed out waiting for watchers — see [dev:progress] FAIL lines above");
    await shutdown(1);
    return;
  }
  log("progress", "all watchers ready — launching Electron");

  lastMainOutputHash = hashFile(mainOutput);
  launchElectron();

  // Watch main output for rebuilds
  fsWatchDisposers.push(
    startResilientWatch("main", mainOutput, () => {
      const nextHash = hashFile(mainOutput);
      if (!nextHash || nextHash === lastMainOutputHash) return;
      lastMainOutputHash = nextHash;
      scheduleRestart();
    }),
  );
}

main().catch((err) => {
  log("dev", `fatal: ${err?.stack ?? err}`);
  void shutdown(1);
});
