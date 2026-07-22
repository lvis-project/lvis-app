import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import electronPath from "electron";

const NATIVE_MODULE = "better-sqlite3";
const LOCK_POLL_MS = 100;
const LOCK_TIMEOUT_MS = 120_000;
const ORPHANED_LOCK_GRACE_MS = 10_000;

// Loading better-sqlite3 is lazy: require("better-sqlite3") alone does not
// dlopen the native binding. Open an in-memory database so the probe exercises
// the exact path used by the session-search index at runtime.
const ELECTRON_NATIVE_PROBE = String.raw`
const Database = require("better-sqlite3");
const db = new Database(":memory:");
db.exec("CREATE TABLE abi_probe (id INTEGER)");
db.close();
`;

const REPAIRABLE_NATIVE_FAILURES = [
  /NODE_MODULE_VERSION/i,
  /compiled against a different Node\.js version/i,
  /Module did not self-register/i,
  /Could not locate the bindings file/i,
  /not a valid Win32 application/i,
  /wrong architecture/i,
  /incompatible architecture/i,
  /wrong ELF class/i,
  /invalid ELF header/i,
  /Exec format error/i,
];

function textOutput(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function failureOutput(result) {
  return [textOutput(result?.stderr), textOutput(result?.stdout)]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function failureSummary(result) {
  if (result?.error instanceof Error) return result.error.message;
  if (result?.signal) return `terminated by signal ${result.signal}`;
  const output = failureOutput(result);
  if (output) return output.split("\n").find(Boolean) ?? output;
  return `exit status ${result?.status ?? "unknown"}`;
}

function isRepairableNativeFailure(result) {
  if (result?.error || result?.signal) return false;
  const output = failureOutput(result);
  return REPAIRABLE_NATIVE_FAILURES.some((pattern) => pattern.test(output));
}

function sleepSync(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLockOwner(ownerPath) {
  try {
    return JSON.parse(readFileSync(ownerPath, "utf8"));
  } catch {
    return null;
  }
}

function tryReclaimStaleLock({ lockDir, ownerPath, now }) {
  // Serialise stale-owner decisions separately from the actual rebuild lock.
  // Without this reaper mutex, two waiters can both decide that the old owner
  // is dead and one can delete the replacement lock acquired by the other.
  const reaperDir = `${lockDir}.reaper`;
  try {
    mkdirSync(reaperDir);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }

  try {
    // The ownership evidence may have changed while acquiring the reaper.
    // Re-read it inside the serialized section and only remove that state.
    const currentOwner = readLockOwner(ownerPath);
    let lockAgeMs;
    try {
      lockAgeMs = Math.max(0, now() - statSync(lockDir).mtimeMs);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }

    const ownerIsDead = currentOwner && !processIsAlive(currentOwner.pid);
    const ownerWasNeverRecorded = !currentOwner
      && lockAgeMs >= ORPHANED_LOCK_GRACE_MS;
    if (!ownerIsDead && !ownerWasNeverRecorded) return false;

    rmSync(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    rmSync(reaperDir, { recursive: true, force: true });
  }
}

function acquireNativeModuleLock({
  lockDir,
  timeoutMs = LOCK_TIMEOUT_MS,
  pollMs = LOCK_POLL_MS,
  now = Date.now,
  sleep = sleepSync,
} = {}) {
  if (!lockDir) throw new Error("native-module lock path is required");
  mkdirSync(dirname(lockDir), { recursive: true });

  const ownerPath = join(lockDir, "owner.json");
  const token = randomUUID();
  const startedAt = now();

  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token }), "utf8");
      return () => {
        const owner = readLockOwner(ownerPath);
        if (owner?.token === token) rmSync(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const owner = readLockOwner(ownerPath);
    let lockAgeMs = 0;
    try {
      lockAgeMs = Math.max(0, now() - statSync(lockDir).mtimeMs);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    const ownerIsDead = owner && !processIsAlive(owner.pid);
    const ownerWasNeverRecorded = !owner && lockAgeMs >= ORPHANED_LOCK_GRACE_MS;
    if (ownerIsDead || ownerWasNeverRecorded) {
      if (tryReclaimStaleLock({ lockDir, ownerPath, now })) continue;
    }

    if (now() - startedAt >= timeoutMs) {
      const ownerStatus = owner?.pid && processIsAlive(owner.pid)
        ? `active owner PID ${owner.pid}`
        : "ambiguous owner state";
      const error = new Error(
        `Timed out waiting for Electron native-module rebuild lock `
        + `(${ownerStatus}); retry the app launch after the current rebuild finishes: ${lockDir}`,
      );
      error.code = "ELECTRON_NATIVE_REBUILD_LOCK_TIMEOUT";
      throw error;
    }
    sleep(pollMs);
  }
}

export function withElectronNativeRebuildLock(repoRoot, callback) {
  const lockDir = resolve(
    repoRoot,
    "node_modules",
    ".cache",
    "lvis-electron-native-rebuild.lock",
  );
  const release = acquireNativeModuleLock({ lockDir });
  try {
    return callback();
  } finally {
    release();
  }
}

/**
 * Verify better-sqlite3 against Electron's ABI and repair recognized native
 * binding drift. Unrelated Electron launch or JavaScript failures stay strict:
 * mutating node_modules cannot repair them and would hide the real cause.
 */
export function ensureElectronNativeModules(options = {}) {
  const repoRoot = options.repoRoot ?? process.cwd();
  const run = options.spawnSync ?? spawnSync;
  const pathExists = options.existsSync ?? existsSync;
  const executable = options.electronExecutable ?? electronPath;
  const rebuildCli = options.rebuildCli ?? resolve(
    repoRoot,
    "node_modules",
    "@electron",
    "rebuild",
    "lib",
    "cli.js",
  );
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const log = options.log ?? ((message) => process.stderr.write(`[native] ${message}\n`));
  const baseEnv = { ...process.env, ...(options.env ?? {}) };
  const withRebuildLock = options.withRebuildLock
    ?? ((callback) => withElectronNativeRebuildLock(repoRoot, callback));

  const probe = () => run(executable, ["-e", ELECTRON_NATIVE_PROBE], {
    cwd: repoRoot,
    env: { ...baseEnv, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
  });

  const assertRepairable = (result) => {
    if (isRepairableNativeFailure(result)) return;
    throw new Error(
      `Electron ${NATIVE_MODULE} probe failed for a non-repairable reason; `
      + `refusing to rebuild dependencies automatically: ${failureSummary(result)}`,
    );
  };

  const initial = probe();
  if (initial.status === 0) return { rebuilt: false };
  assertRepairable(initial);

  return withRebuildLock(() => {
    // Another launcher may have repaired the shared checkout while this process
    // waited for the lock. Re-probe before mutating the native build tree.
    const locked = probe();
    if (locked.status === 0) {
      log(`Electron ${NATIVE_MODULE} was repaired by another process.`);
      return { rebuilt: false, repairedByPeer: true };
    }
    assertRepairable(locked);

    log(
      `Electron ${NATIVE_MODULE} native binding is incompatible `
      + `(${failureSummary(locked)}); rebuilding for Electron.`,
    );
    if (!pathExists(rebuildCli)) {
      throw new Error(`electron-rebuild CLI not found: ${rebuildCli}`);
    }

    const rebuildEnv = { ...baseEnv };
    delete rebuildEnv.ELECTRON_RUN_AS_NODE;
    const rebuilt = run(nodeExecutable, [
      rebuildCli,
      "--force",
      "--only",
      NATIVE_MODULE,
    ], {
      cwd: repoRoot,
      env: rebuildEnv,
      stdio: "inherit",
    });
    if (rebuilt.status !== 0) {
      throw new Error(`Electron native-module rebuild failed: ${failureSummary(rebuilt)}`);
    }

    const verified = probe();
    if (verified.status !== 0) {
      throw new Error(
        `Electron ${NATIVE_MODULE} still fails after rebuild: ${failureSummary(verified)}`,
      );
    }
    log(`Electron ${NATIVE_MODULE} rebuilt and verified.`);
    return { rebuilt: true };
  });
}

export const __internalForTests = {
  ELECTRON_NATIVE_PROBE,
  NATIVE_MODULE,
  acquireNativeModuleLock,
  failureSummary,
  isRepairableNativeFailure,
};
