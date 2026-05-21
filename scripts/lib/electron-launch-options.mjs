import { homedir } from "node:os";
import { resolve } from "node:path";

import { loadRepoDemoEnv } from "./demo-env-loader.mjs";
import { WINDOWS_SAFE_GPU_FLAGS, SANDBOX_BYPASS_FLAG } from "../electron-flags.mjs";

export const WINDOWS_SAFE_ELECTRON_FLAGS = Object.freeze([
  ...WINDOWS_SAFE_GPU_FLAGS,
  SANDBOX_BYPASS_FLAG,
]);

export function windowsSafeLaunchRequired(
  env = process.env,
  platform = process.platform,
) {
  return platform === "win32" && env.LVIS_KEEP_GPU !== "1";
}

export function applyWindowsSafeElectronFlags(
  args,
  env = process.env,
  platform = process.platform,
) {
  const next = [...args];
  if (windowsSafeLaunchRequired(env, platform)) {
    for (const flag of WINDOWS_SAFE_ELECTRON_FLAGS) {
      if (!next.includes(flag)) next.push(flag);
    }
  }
  if (env.LVIS_EXTRA_ELECTRON_FLAGS) {
    const extra = env.LVIS_EXTRA_ELECTRON_FLAGS.split(/\s+/).filter(Boolean);
    for (const flag of extra) {
      if (!next.includes(flag)) next.push(flag);
    }
  }
  return next;
}

export function applyWindowsNoSandboxEnv(
  env,
  platform = process.platform,
) {
  if (windowsSafeLaunchRequired(env, platform)) {
    env.LVIS_WIN_NO_SANDBOX = "1";
  } else {
    delete env.LVIS_WIN_NO_SANDBOX;
  }
  return env;
}

export function ensureWindowsUserDataDir(
  args,
  env,
  profileName,
  platform = process.platform,
) {
  if (platform !== "win32") return args;
  if (args.some((arg) => arg.startsWith("--user-data-dir="))) return args;
  const appDataRoot = env.APPDATA || resolve(homedir(), "AppData", "Roaming");
  const userDataDir = env.LVIS_USER_DATA_DIR || resolve(appDataRoot, profileName);
  args.push(`--user-data-dir=${userDataDir}`);
  return args;
}

export function extractUserDataDir(args) {
  const userDataArg = args.find((arg) => arg.startsWith("--user-data-dir="));
  return userDataArg ? userDataArg.slice("--user-data-dir=".length) : "";
}

export function applyUtf8Env(env) {
  if (!env.PYTHONIOENCODING) env.PYTHONIOENCODING = "utf-8";
  if (!env.PYTHONUTF8) env.PYTHONUTF8 = "1";
  if (!env.LANG) env.LANG = "en_US.UTF-8";
  if (!env.LC_ALL) env.LC_ALL = "en_US.UTF-8";
  return env;
}

export function prepareElectronLaunchEnv(
  env,
  {
    demoEnvRoot,
    platform = process.platform,
  } = {},
) {
  if (demoEnvRoot) loadRepoDemoEnv(env, demoEnvRoot);
  applyWindowsNoSandboxEnv(env, platform);
  applyUtf8Env(env);
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function prepareElectronLaunchArgs(
  args,
  env,
  {
    profileName,
    platform = process.platform,
  } = {},
) {
  const next = applyWindowsSafeElectronFlags(args, env, platform);
  if (profileName) {
    ensureWindowsUserDataDir(next, env, profileName, platform);
  }
  return next;
}
