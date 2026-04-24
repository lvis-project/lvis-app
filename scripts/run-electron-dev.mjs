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
import { existsSync, watch, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

// Windows corp PC runtime flags — see scripts/run-electron.mjs for rationale.
const WINDOWS_SAFE_ELECTRON_FLAGS = [
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-gpu-compositing",
  "--no-sandbox",
];

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

function applyUtf8Env(env) {
  if (!env.PYTHONIOENCODING) env.PYTHONIOENCODING = "utf-8";
  if (!env.PYTHONUTF8) env.PYTHONUTF8 = "1";
  if (!env.LANG) env.LANG = "en_US.UTF-8";
  if (!env.LC_ALL) env.LC_ALL = "en_US.UTF-8";
  return env;
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

// Dev mode wraps the Electron launch via cmd.exe /c "chcp 65001 & electron …"
// in launchElectron() below so the code-page change shares Electron's console.
// See scripts/run-electron.mjs for the detailed rationale.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
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
    });
    delete e.ELECTRON_RUN_AS_NODE;
    return e;
  })();
  const electronArgs = ensureWindowsUserDataDir(applyWindowsSafeFlags([mainOutput]), launchEnv, "Electron-LVIS-Dev");
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
    const plugins = spawn("bun", ["run", "prepare:plugins"], {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });
    plugins.on("error", (err) => {
      log("plugins", `spawn failed: ${err.message}`);
      void shutdown(1);
    });
    await new Promise((res) => plugins.on("exit", res));
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

  launchElectron();

  // Watch main output for rebuilds
  try {
    watch(mainOutput, { persistent: true }, () => scheduleRestart());
  } catch (err) {
    log("main", `watch failed: ${err.message}`);
  }
}

main().catch((err) => {
  log("dev", `fatal: ${err?.stack ?? err}`);
  void shutdown(1);
});
