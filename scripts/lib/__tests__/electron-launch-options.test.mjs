import test from "node:test";
import assert from "node:assert/strict";

import {
  applyUtf8Env,
  applyWindowsNoSandboxEnv,
  applyWindowsSafeElectronFlags,
  ensureWindowsUserDataDir,
  extractUserDataDir,
  prepareElectronLaunchArgs,
  prepareElectronLaunchEnv,
  WINDOWS_SAFE_ELECTRON_FLAGS,
  windowsSafeLaunchRequired,
} from "../electron-launch-options.mjs";

test("windowsSafeLaunchRequired is the shared win32 + LVIS_KEEP_GPU gate", () => {
  assert.equal(windowsSafeLaunchRequired({}, "win32"), true);
  assert.equal(windowsSafeLaunchRequired({ LVIS_KEEP_GPU: "1" }, "win32"), false);
  assert.equal(windowsSafeLaunchRequired({}, "darwin"), false);
});

test("applyWindowsSafeElectronFlags appends shared flags and caller extras once", () => {
  const args = applyWindowsSafeElectronFlags(
    ["dist/src/main/main.js", "--disable-gpu"],
    { LVIS_EXTRA_ELECTRON_FLAGS: "--foo --no-sandbox" },
    "win32",
  );
  assert.deepEqual(
    args,
    [
      "dist/src/main/main.js",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-gpu-compositing",
      "--no-sandbox",
      "--foo",
    ],
  );
  assert.deepEqual(
    applyWindowsSafeElectronFlags(["dist/src/main/main.js"], {}, "linux"),
    ["dist/src/main/main.js"],
  );
  assert.ok(WINDOWS_SAFE_ELECTRON_FLAGS.includes("--no-sandbox"));
});

test("applyWindowsNoSandboxEnv mirrors the same Windows-safe gate", () => {
  const winEnv = { LVIS_WIN_NO_SANDBOX: "0" };
  assert.equal(applyWindowsNoSandboxEnv(winEnv, "win32").LVIS_WIN_NO_SANDBOX, "1");
  const gpuEnv = { LVIS_KEEP_GPU: "1", LVIS_WIN_NO_SANDBOX: "1" };
  assert.equal(applyWindowsNoSandboxEnv(gpuEnv, "win32").LVIS_WIN_NO_SANDBOX, undefined);
  const macEnv = { LVIS_WIN_NO_SANDBOX: "1" };
  assert.equal(applyWindowsNoSandboxEnv(macEnv, "darwin").LVIS_WIN_NO_SANDBOX, undefined);
});

test("ensureWindowsUserDataDir is shared by start/dev launchers", () => {
  const args = ensureWindowsUserDataDir(
    ["dist/src/main/main.js"],
    { LVIS_USER_DATA_DIR: "/tmp/lvis-run" },
    "Electron-LVIS-Run",
    "win32",
  );
  assert.equal(extractUserDataDir(args), "/tmp/lvis-run");
  assert.deepEqual(
    ensureWindowsUserDataDir(["dist/src/main/main.js"], {}, "ignored", "linux"),
    ["dist/src/main/main.js"],
  );
});

test("applyUtf8Env fills only missing UTF-8 env defaults", () => {
  const env = applyUtf8Env({
    PYTHONIOENCODING: "already",
  });
  assert.equal(env.PYTHONIOENCODING, "already");
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.LC_ALL, "en_US.UTF-8");
});

test("prepareElectronLaunchEnv applies launch env policy in one place", () => {
  const env = prepareElectronLaunchEnv(
    {
      ELECTRON_RUN_AS_NODE: "1",
      LVIS_EXTRA_ELECTRON_FLAGS: "--foo",
    },
    { platform: "win32" },
  );
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.LVIS_WIN_NO_SANDBOX, "1");
  assert.equal(env.PYTHONUTF8, "1");
});

test("prepareElectronLaunchArgs applies flags and Windows user data together", () => {
  const args = prepareElectronLaunchArgs(
    ["dist/src/main/main.js"],
    {
      LVIS_EXTRA_ELECTRON_FLAGS: "--foo",
      LVIS_USER_DATA_DIR: "/tmp/lvis-profile",
    },
    {
      profileName: "Electron-LVIS-Run",
      platform: "win32",
    },
  );
  assert.equal(extractUserDataDir(args), "/tmp/lvis-profile");
  assert.ok(args.includes("--disable-gpu"));
  assert.ok(args.includes("--no-sandbox"));
  assert.ok(args.includes("--foo"));
});
