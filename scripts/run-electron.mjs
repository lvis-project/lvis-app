import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import electronPath from "electron";

const args = process.argv.slice(2);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

function ensureWindowsUserDataDir(argsList, envVars, profileName) {
  if (process.platform !== "win32") return argsList;
  if (argsList.some((arg) => arg.startsWith("--user-data-dir="))) return argsList;
  const appDataRoot = envVars.APPDATA || resolve(homedir(), "AppData", "Roaming");
  const userDataDir = envVars.LVIS_USER_DATA_DIR || resolve(appDataRoot, profileName);
  argsList.push(`--user-data-dir=${userDataDir}`);
  return argsList;
}

// `bun run start` is still an unpackaged local run: it builds sibling plugins,
// then launches Electron against registry manifests under plugins/installed/*
// whose entries resolve into ../../../node_modules/@lvis/... and are unsigned.
// Keep those local compatibility relaxations here so normal local runs keep
// loading managed plugins, while dev-only UX (watchers, LVIS_DEV, dev console)
// remains exclusive to scripts/run-electron-dev.mjs.
if (!env.LVIS_DEV_SKIP_SIG) {
  env.LVIS_DEV_SKIP_SIG = "1";
}
if (!env.LVIS_ALLOW_LINKED_PLUGIN_ENTRY) {
  env.LVIS_ALLOW_LINKED_PLUGIN_ENTRY = "1";
}
if (!env.LVIS_ENABLE_DEV_CONSOLE) {
  env.LVIS_ENABLE_DEV_CONSOLE = "0";
}

// Force UTF-8 across every subprocess spoken to by Electron's embedded Node.
// Without this, Windows' default ANSI code page (cp949 on Korean locale) turns
// console logs and Python subprocess stdout into mojibake (깨진 한글). These
// env vars are harmless on macOS/Linux (already UTF-8), so set them
// unconditionally.
if (!env.PYTHONIOENCODING) env.PYTHONIOENCODING = "utf-8";
if (!env.PYTHONUTF8) env.PYTHONUTF8 = "1";
if (!env.LANG) env.LANG = "en_US.UTF-8";
if (!env.LC_ALL) env.LC_ALL = "en_US.UTF-8";

// Windows corp PCs often run Electron under EDR/AV sandboxing + restricted
// GPU drivers (Hyper-V isolation / VDI / locked-down ANGLE). Under those
// conditions the default GPU process crashes with "GPU process isn't usable.
// Goodbye!" before the window appears. The minimal reliable combo for
// Chromium 131 (Electron 41) is `--disable-gpu` + `--disable-software-
// rasterizer` + `--disable-gpu-compositing` + `--no-sandbox`. Older flag
// names we used to stack (`--in-process-gpu`, `--use-angle=swiftshader`) are
// either deprecated or renamed in new Chromium and can make things worse —
// they sometimes force GPU init that then fails in the restricted env. Opt
// out with `LVIS_KEEP_GPU=1` on machines with a sane GPU (passthrough VMs,
// CI). Override with `LVIS_EXTRA_ELECTRON_FLAGS="--foo --bar"` to append
// extra flags without losing the defaults.
if (process.platform === "win32" && env.LVIS_KEEP_GPU !== "1") {
  const windowsSafeFlags = [
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-gpu-compositing",
    "--no-sandbox",
  ];
  for (const flag of windowsSafeFlags) {
    if (!args.includes(flag)) args.push(flag);
  }
}
if (env.LVIS_EXTRA_ELECTRON_FLAGS) {
  const extra = env.LVIS_EXTRA_ELECTRON_FLAGS.split(/\s+/).filter(Boolean);
  for (const flag of extra) {
    if (!args.includes(flag)) args.push(flag);
  }
}
ensureWindowsUserDataDir(args, env, "Electron-LVIS-Run");

// Windows: launch Electron through a cmd.exe wrapper so `chcp 65001` and
// Electron share the SAME console. A separate `execSync("chcp")` runs in a
// detached subprocess — the code-page change never reaches Electron's
// console. We use `shell: true` (which invokes `cmd.exe /d /s /c "<cmd>"` on
// Windows) so cmd's `/s` flag preserves our inner quoting around electron.exe
// path; passing cmd.exe + /c manually without /s triggers cmd's legacy
// quote-stripping rule and produces "electron.exe 는 실행할 수 있는 프로그램…
// 아닙니다".
if (process.platform === "win32") {
  if (env.LVIS_DEBUG === "1") {
    process.stderr.write(
      `[run-electron] args=${JSON.stringify(args)}\n` +
        `[run-electron] LVIS_DEV=${env.LVIS_DEV} LVIS_DEV_SKIP_SIG=${env.LVIS_DEV_SKIP_SIG} LVIS_KEEP_GPU=${env.LVIS_KEEP_GPU ?? "<unset>"}\n`,
    );
  }
  const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const electronCmd = [electronPath, ...args].map(quote).join(" ");
  const result = spawnSync(`chcp 65001>nul & ${electronCmd}`, [], {
    env,
    stdio: "inherit",
    shell: true,
  });
  process.exit(result.status ?? 1);
}

const result = spawnSync(electronPath, args, {
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
