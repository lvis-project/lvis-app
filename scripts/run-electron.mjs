import { execSync, spawnSync } from "node:child_process";
import electronPath from "electron";

const args = process.argv.slice(2);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Unpackaged dev runs: bypass plugin signature verification for locally-built
// managed plugins AND allow plugin manifest `entry` paths to traverse into
// ../../../node_modules/@lvis/... (which normally would be rejected by the
// plugin-root confinement check). Both switches reflect the same intent —
// "this is a developer workstation running against sibling-linked plugin
// repos" — and are gated off in packaged builds (app.isPackaged === true).
if (!env.LVIS_DEV_SKIP_SIG) {
  env.LVIS_DEV_SKIP_SIG = "1";
}
if (!env.LVIS_DEV) {
  env.LVIS_DEV = "1";
}

// Force UTF-8 across every subprocess spoken to by Electron's bundled Node.
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
// conditions the default GPU process crashes with error_code=18 before the
// window appears, or partially renders with corrupted glyphs. Force software
// rendering + loosen sandbox so the app boots to a usable state. Opt out
// with `LVIS_KEEP_GPU=1` on machines with a sane GPU (passthrough VMs, CI).
if (process.platform === "win32" && env.LVIS_KEEP_GPU !== "1") {
  const windowsSafeFlags = [
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--disable-gpu-sandbox",
    "--in-process-gpu",
    "--use-angle=swiftshader",
    "--no-sandbox",
  ];
  for (const flag of windowsSafeFlags) {
    if (!args.includes(flag)) args.push(flag);
  }
}

// Windows: flip the console to UTF-8 (code page 65001) so Korean/emoji log
// output renders instead of garbage. `chcp` only affects the parent console,
// but Electron inherits stdio from us, so child stdout/stderr writes hit a
// UTF-8 console too. Non-fatal if it fails (e.g. redirected stdout).
if (process.platform === "win32") {
  try {
    execSync("chcp 65001", { stdio: "ignore", windowsHide: true });
  } catch {
    /* non-interactive console — ignore */
  }
}

const result = spawnSync(electronPath, args, {
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
