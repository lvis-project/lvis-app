import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";

import { createLogger } from "../lib/logger.js";

const log = createLogger("sandbox-process-home");
const SANDBOX_HOME_PREFIX = "lvis-sandbox-home-";

export interface SandboxProcessHome {
  readonly path: string;
  readonly env: Readonly<Record<string, string>>;
  cleanup(): void;
}

function profileEnvironment(
  homePath: string,
  platform: NodeJS.Platform,
): Record<string, string> {
  if (platform === "win32") {
    const appData = win32.join(homePath, "AppData", "Roaming");
    const localAppData = win32.join(homePath, "AppData", "Local");
    const env: Record<string, string> = {
      HOME: homePath,
      USERPROFILE: homePath,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
    };
    const drive = win32.parse(homePath).root.slice(0, 2);
    if (/^[A-Za-z]:$/.test(drive)) {
      env.HOMEDRIVE = drive;
      env.HOMEPATH = homePath.slice(2) || "\\";
    } else {
      // Never inherit the real profile pair when TEMP is UNC-backed. Programs
      // that use %HOMEDRIVE%%HOMEPATH% still resolve the isolated profile.
      env.HOMEDRIVE = "";
      env.HOMEPATH = homePath;
    }
    return env;
  }

  return {
    HOME: homePath,
    XDG_CONFIG_HOME: join(homePath, "config"),
    XDG_DATA_HOME: join(homePath, "data"),
    XDG_CACHE_HOME: join(homePath, "cache"),
    XDG_STATE_HOME: join(homePath, "state"),
  };
}

function createProfileDirectories(env: Readonly<Record<string, string>>): void {
  for (const directory of new Set([
    env.HOME,
    env.USERPROFILE,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_STATE_HOME,
  ])) {
    if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

/**
 * Create a fresh HOME/profile for one ASRT-confined process lifetime.
 *
 * The real user HOME remains on the sandbox deny-list, but child programs no
 * longer probe denied implicit config files such as `.gitconfig`, `.npmrc`, or
 * shell startup files. A unique directory is mandatory: sharing a writable
 * synthetic HOME would let one sandboxed command persist config that changes a
 * later command's behavior.
 */
export function createSandboxProcessHome(
  platform: NodeJS.Platform = process.platform,
  removeHome: typeof rmSync = rmSync,
): SandboxProcessHome {
  const tempRoot = realpathSync.native(tmpdir());
  const createdPath = mkdtempSync(join(tempRoot, SANDBOX_HOME_PREFIX));
  let homePath = createdPath;
  let env: Readonly<Record<string, string>>;
  try {
    if (lstatSync(createdPath).isSymbolicLink()) {
      throw new Error(`refusing symlink sandbox process HOME: ${createdPath}`);
    }
    homePath = realpathSync.native(createdPath);
    if (
      dirname(homePath) !== tempRoot ||
      !basename(homePath).startsWith(SANDBOX_HOME_PREFIX)
    ) {
      throw new Error(`refusing unsafe sandbox process HOME: ${homePath}`);
    }

    env = Object.freeze(profileEnvironment(homePath, platform));
    createProfileDirectories(env);
  } catch (err) {
    if (
      dirname(createdPath) === tempRoot &&
      basename(createdPath).startsWith(SANDBOX_HOME_PREFIX)
    ) {
      try {
        rmSync(createdPath, { recursive: true, force: true });
      } catch {
        // Preserve the initialization error; cleanup failures are secondary.
      }
    }
    throw err;
  }

  let cleaned = false;
  return Object.freeze({
    path: homePath,
    env,
    cleanup(): void {
      if (cleaned) return;
      if (
        dirname(homePath) !== tempRoot ||
        !basename(homePath).startsWith(SANDBOX_HOME_PREFIX)
      ) {
        log.error({ homePath }, "sandbox process HOME cleanup refused unsafe path");
        return;
      }
      try {
        removeHome(homePath, { recursive: true, force: true });
        cleaned = true;
      } catch (err) {
        log.warn(
          { homePath, err: err instanceof Error ? err.message : String(err) },
          "sandbox process HOME cleanup failed",
        );
      }
    },
  });
}
