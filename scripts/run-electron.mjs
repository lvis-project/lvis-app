import { spawnSync } from "node:child_process";
import electronPath from "electron";
import {
  prepareElectronLaunchArgs,
  prepareElectronLaunchEnv,
} from "./lib/electron-launch-options.mjs";

const args = process.argv.slice(2);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Ensure NODE_ENV is set so logger.ts can select pino-pretty at module load
// time. This script handles unpackaged dev runs (`bun run start`); packaged
// production builds are detected by the absence of process.defaultApp in the
// Electron runtime (see src/lib/logger.ts). Setting "development" here when
// not already set keeps the dev-run experience consistent regardless of the
// shell's NODE_ENV.
if (!env.NODE_ENV) {
  env.NODE_ENV = "development";
}

if (!env.LVIS_DEV_CONSOLE) {
  env.LVIS_DEV_CONSOLE = "0";
}
// `bun run start` already injects --no-sandbox via WINDOWS_SAFE_ELECTRON_FLAGS
// below; tell main.ts to mirror that into the lvis:// protocol registration so
// OS-launched second instances on corp boxes don't silently crash before
// requestSingleInstanceLock(). Mirror the same gate as the runtime flag
// injection (win32 + LVIS_KEEP_GPU !== "1") so the foreground process and
// the protocol-registered command always agree on sandbox posture. The dev-
// flags.ts SoT in main.ts hard-gates this on `!app.isPackaged` regardless,
// so a packaged binary that inherits LVIS_WIN_NO_SANDBOX=1 still keeps
// Chromium sandboxing.
//
// The shared helper owns launch-environment normalization (including UTF-8`r`n// defaults). Dev and start launchers intentionally use the same helper/order.`r`nprepareElectronLaunchEnv(env);

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
args.splice(0, args.length, ...prepareElectronLaunchArgs(args, env, {
  profileName: "Electron-LVIS-Run",
}));

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
        `[run-electron] LVIS_DEV=${env.LVIS_DEV} LVIS_KEEP_GPU=${env.LVIS_KEEP_GPU ?? "<unset>"}\n`,
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
