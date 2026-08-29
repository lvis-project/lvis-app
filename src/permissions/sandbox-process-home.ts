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
import { errorMessage } from "../shared/error-message.js";

const log = createLogger("sandbox-process-home");
const SANDBOX_HOME_PREFIX = "lvis-sandbox-home-";
const CLEANUP_RETRY_DELAYS_MS = [50, 250, 1_000] as const;

export interface SandboxProcessHome {
  readonly path: string;
  readonly env: Readonly<Record<string, string>>;
  cleanup(): void;
}

export function sandboxProcessProfileEnvironment(
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
      // Windows only, and it DOES take effect here: ASRT deletes the `TMPDIR`
      // it generates on this platform ("serves no purpose on Windows and breaks
      // msys2 tools") and sets no replacement, so the profile's own value is
      // what the child sees. Node reads TEMP then TMP; both, so a child that
      // consults either lands in the same place.
      TEMP: win32.join(homePath, "tmp"),
      TMP: win32.join(homePath, "tmp"),
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
    // NO `TMPDIR` here, deliberately. On macOS and Linux ASRT writes its own
    // `TMPDIR=` into the sandboxed command line, which is evaluated INSIDE the
    // sandbox and therefore wins over anything this env carries. Setting one
    // would be a value that never applies — a comment claiming a substitution
    // the child never sees. The POSIX temp root is set where it CAN take
    // effect, at `sandbox-init.ts`, through the variable ASRT reads.
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
    // The temp root has to EXIST, and that is the whole point of it being
    // here. ASRT substitutes a temp root and creates nothing, so a confined
    // child's `os.tmpdir()` routinely names a directory that is not there —
    // `readdirSync` and `mkdtempSync` fail `ENOENT` while a recursive `mkdir`
    // on the same path succeeds. An unguarded sweep of `tmpdir()` in a
    // plugin's activation body therefore does not degrade a feature, it stops
    // the plugin from loading.
    env.TMPDIR,
    env.TEMP,
    env.TMP,
  ])) {
    if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

/**
 * Create a fresh HOME/profile — and temp root — for one ASRT-confined process
 * lifetime.
 *
 * The real user HOME remains on the sandbox deny-list, but child programs no
 * longer probe denied implicit config files such as `.gitconfig`, `.npmrc`, or
 * shell startup files. A unique directory is mandatory: sharing a writable
 * synthetic HOME would let one sandboxed command persist config that changes a
 * later command's behavior.
 *
 * THE TEMP ROOT IS PART OF THAT, and it is the one substitution that is right
 * BECAUSE it vanishes. Rooting durable state at the throwaway HOME is a trap —
 * the write succeeds and the state is gone at exit, which reads as working and
 * costs the user their data on the next start. Temp is the case where vanishing
 * at exit is the contract rather than the defect.
 *
 * Without it, `os.tmpdir()` in a confined child names the root ASRT
 * substitutes, which is SHARED: it is one of ASRT's own default write paths, so
 * every confined process on the machine reaches the same directory — two
 * plugins, or a plugin and a worker, meeting in a place neither one's manifest
 * mentions. Every caller of this module already grants `home.path` for writing,
 * so a temp root beneath it needs no new grant; that uniformity is what makes
 * this a property of confinement rather than a favour done for one caller.
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

    env = Object.freeze(sandboxProcessProfileEnvironment(homePath, platform));
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
  let failedAttempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const attemptCleanup = (): void => {
    try {
      removeHome(homePath, { recursive: true, force: true });
      cleaned = true;
      failedAttempts = 0;
    } catch (err) {
      failedAttempts += 1;
      log.warn(
        { homePath, err: errorMessage(err) },
        "sandbox process HOME cleanup failed",
      );
      const delay = CLEANUP_RETRY_DELAYS_MS[failedAttempts - 1];
      if (delay === undefined) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        attemptCleanup();
      }, delay);
      const nodeTimer = retryTimer as ReturnType<typeof setTimeout> & { unref?: () => void };
      nodeTimer.unref?.();
    }
  };
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
      // A later definitive lifecycle event may arrive before the scheduled
      // retry. Let that call retry immediately instead of waiting for backoff.
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      attemptCleanup();
    },
  });
}
