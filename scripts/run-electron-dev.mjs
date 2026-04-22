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

import { spawn } from "node:child_process";
import { existsSync, watch, copyFileSync, mkdirSync } from "node:fs";
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

function applyUtf8Env(env) {
  if (!env.PYTHONIOENCODING) env.PYTHONIOENCODING = "utf-8";
  if (!env.PYTHONUTF8) env.PYTHONUTF8 = "1";
  if (!env.LANG) env.LANG = "en_US.UTF-8";
  if (!env.LC_ALL) env.LC_ALL = "en_US.UTF-8";
  return env;
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

const children = [];
let electronProc = null;
let restartTimer = null;
let shuttingDown = false;

function log(tag, msg) {
  process.stdout.write(`[dev:${tag}] ${msg}\n`);
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

function launchElectron() {
  if (electronProc) return;
  const electronArgs = applyWindowsSafeFlags([mainOutput]);
  log("electron", `launching ${mainOutput}`);
  const env = (() => {
    const e = applyUtf8Env({
      ...process.env,
      LVIS_DEV: "1",
      LVIS_DEV_SKIP_SIG: process.env.LVIS_DEV_SKIP_SIG ?? "1",
    });
    delete e.ELECTRON_RUN_AS_NODE;
    return e;
  })();
  if (process.platform === "win32") {
    // Wrap in cmd.exe /s /c (via shell: true) so `chcp 65001` binds to
    // Electron's console AND cmd preserves quoting around electron.exe path.
    // See scripts/run-electron.mjs for the detailed rationale.
    const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const electronCmd = [electronPath, ...electronArgs].map(quote).join(" ");
    electronProc = spawn(`chcp 65001>nul & ${electronCmd}`, [], {
      cwd: repoRoot,
      stdio: "inherit",
      env,
      shell: true,
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
    if (!shuttingDown && signal !== "SIGTERM" && signal !== "SIGKILL") {
      // If electron exited on its own (window closed), shut down dev loop.
      shutdown(0);
    }
  });
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (shuttingDown) return;
    if (electronProc) {
      log("electron", "main changed -> restarting");
      electronProc.once("exit", () => launchElectron());
      electronProc.kill("SIGTERM");
    } else {
      launchElectron();
    }
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
  if (shuttingDown) return;
  shuttingDown = true;
  log("dev", "shutting down");
  if (electronProc) {
    try { electronProc.kill("SIGTERM"); } catch {}
  }
  for (const c of children) {
    try { c.kill("SIGTERM"); } catch {}
  }
  setTimeout(() => process.exit(code), 200);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

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
      shutdown(1);
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
    shutdown(1);
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
  shutdown(1);
});
