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
