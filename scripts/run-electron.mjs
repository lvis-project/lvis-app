import { spawnSync } from "node:child_process";
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

// Windows: launch Electron through a cmd.exe wrapper so `chcp 65001` and
// Electron share the SAME console. A separate `execSync("chcp")` runs in a
// detached subprocess — the code-page change never reaches Electron's
// console. We use `shell: true` (which invokes `cmd.exe /d /s /c "<cmd>"` on
// Windows) so cmd's `/s` flag preserves our inner quoting around electron.exe
// path; passing cmd.exe + /c manually without /s triggers cmd's legacy
// quote-stripping rule and produces "electron.exe 는 실행할 수 있는 프로그램…
// 아닙니다".
if (process.platform === "win32") {
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
