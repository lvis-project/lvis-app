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
const REAPER_ACTIVE_MAX_AGE_MS = LOCK_TIMEOUT_MS;
const LOCK_OWNER_FILE = "owner.json";
const SAFE_OWNER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_REAPER_GENERATION = /^[A-Za-z0-9][A-Za-z0-9_-]{15,511}$/;

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

function inspectProcessLiveness(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "EPERM") return "alive";
    if (error?.code === "ESRCH") return "dead";
    return "unknown";
  }
}

function inspectLockOwner(ownerPath) {
  try {
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (
      Number.isInteger(owner?.pid)
      && owner.pid > 0
      && typeof owner?.token === "string"
      && SAFE_OWNER_TOKEN.test(owner.token)
    ) {
      return { state: "valid", owner };
    }
    return { state: "malformed" };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    if (error instanceof SyntaxError) return { state: "malformed" };
    return { state: "unreadable", error };
  }
}

function inspectReaperState({
  lockDir,
  now = Date.now,
  inspectProcess = inspectProcessLiveness,
}) {
  const reaperDir = `${lockDir}.reaper`;
  let ageMs;
  let generation;
  try {
    const stats = statSync(reaperDir);
    ageMs = Math.max(0, now() - stats.mtimeMs);
    generation = Buffer.from([
      stats.dev,
      stats.ino,
      stats.birthtimeMs,
      stats.ctimeMs,
      stats.mtimeMs,
    ].join(":"), "utf8").toString("base64url");
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent", reaperDir };
    throw error;
  }

  const ownerResult = inspectLockOwner(join(reaperDir, LOCK_OWNER_FILE));
  if (ownerResult.state !== "valid") {
    const state = ageMs < ORPHANED_LOCK_GRACE_MS
      ? "initializing"
      : "ambiguous";
    return {
      state,
      reaperDir,
      ownerState: ownerResult.state,
      ambiguityReason: `${ownerResult.state} owner metadata`,
      generation,
      recoveryEligible: state === "ambiguous",
      ageMs,
    };
  }

  const { owner } = ownerResult;
  const liveness = inspectProcess(owner.pid);
  if (liveness === "alive") {
    if (ageMs >= REAPER_ACTIVE_MAX_AGE_MS) {
      return {
        state: "ambiguous",
        reaperDir,
        ownerPid: owner.pid,
        ownerToken: owner.token,
        ownerState: "valid",
        ambiguityReason: "live owner PID exceeded the active-owner age limit",
        generation,
        recoveryEligible: true,
        ageMs,
      };
    }
    return {
      state: "active",
      reaperDir,
      ownerPid: owner.pid,
      ownerToken: owner.token,
      generation,
      ageMs,
    };
  }
  if (liveness === "dead") {
    return {
      state: "orphaned",
      reaperDir,
      ownerPid: owner.pid,
      ownerToken: owner.token,
      generation,
      recoveryEligible: true,
      ageMs,
    };
  }
  return {
    state: "ambiguous",
    reaperDir,
    ownerPid: owner.pid,
    ownerToken: owner.token,
    ownerState: "valid",
    ambiguityReason: "owner PID liveness is unknown",
    generation,
    recoveryEligible: ageMs >= ORPHANED_LOCK_GRACE_MS,
    ageMs,
  };
}

export function recoverOrphanedNativeReaper({
  repoRoot,
  expectedToken,
  expectedGeneration,
  confirmQuiesced = false,
} = {}) {
  if (!repoRoot) throw new Error("repository root is required");
  if (!expectedToken && !expectedGeneration) {
    throw new Error("expected reaper token or generation is required");
  }
  if (expectedToken && expectedGeneration) {
    throw new Error("provide only one expected reaper identity");
  }
  if (expectedToken && !SAFE_OWNER_TOKEN.test(expectedToken)) {
    throw new Error("expected reaper token has an invalid format");
  }
  if (expectedGeneration && !SAFE_REAPER_GENERATION.test(expectedGeneration)) {
    throw new Error("expected reaper generation has an invalid format");
  }
  if (!confirmQuiesced) {
    throw new Error(
      "Refusing reaper cleanup until every app/dev launcher and Git hook "
      + "using this checkout has been stopped.",
    );
  }

  const lockDir = resolve(
    repoRoot,
    "node_modules",
    ".cache",
    "lvis-electron-native-rebuild.lock",
  );
  const reaper = inspectReaperState({ lockDir });
  const tokenMatches = expectedToken
    && reaper.state === "orphaned"
    && reaper.ownerToken === expectedToken;
  const generationMatches = expectedGeneration
    && reaper.recoveryEligible
    && reaper.generation === expectedGeneration;
  if (!tokenMatches && !generationMatches) {
    const error = new Error(
      "Refusing reaper cleanup because the orphaned ownership generation "
      + "no longer matches the expected identity.",
    );
    error.code = "ELECTRON_NATIVE_REAPER_CLEANUP_REFUSED";
    throw error;
  }

  // Re-read immediately before removal. The mandatory quiescence precondition
  // prevents a successor generation from being created between this check and
  // removal; the token or directory-generation check makes stale cleanup
  // commands harmless afterward.
  const current = inspectReaperState({ lockDir });
  const currentTokenMatches = expectedToken
    && current.state === "orphaned"
    && current.ownerToken === expectedToken;
  const currentGenerationMatches = expectedGeneration
    && current.recoveryEligible
    && current.generation === expectedGeneration;
  if (!currentTokenMatches && !currentGenerationMatches) {
    const error = new Error(
      "Refusing reaper cleanup because ownership changed during validation.",
    );
    error.code = "ELECTRON_NATIVE_REAPER_CLEANUP_REFUSED";
    throw error;
  }

  rmSync(reaper.reaperDir, { recursive: true });
  return { removed: reaper.reaperDir };
}

function tryReclaimStaleLock({
  lockDir,
  ownerPath,
  now,
  writeOwner = writeFileSync,
}) {
  // Serialise stale-owner decisions separately from the actual rebuild lock.
  // Without this reaper mutex, two waiters can both decide that the old owner
  // is dead and one can delete the replacement lock acquired by the other.
  const reaperDir = `${lockDir}.reaper`;
  const reaperOwnerPath = join(reaperDir, LOCK_OWNER_FILE);
  const token = randomUUID();
  try {
    mkdirSync(reaperDir);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }

  let ownerRecorded = false;
  try {
    writeOwner(reaperOwnerPath, JSON.stringify({
      pid: process.pid,
      token,
      createdAt: new Date(now()).toISOString(),
    }), { encoding: "utf8", flag: "wx" });
    ownerRecorded = true;

    // The ownership evidence may have changed while acquiring the reaper.
    // Re-read it inside the serialized section and only remove that state.
    const currentOwner = inspectLockOwner(ownerPath);
    let lockAgeMs;
    try {
      lockAgeMs = Math.max(0, now() - statSync(lockDir).mtimeMs);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }

    const ownerIsDead = currentOwner.state === "valid"
      && inspectProcessLiveness(currentOwner.owner.pid) === "dead";
    const ownerWasNeverRecorded = currentOwner.state === "absent"
      && lockAgeMs >= ORPHANED_LOCK_GRACE_MS;
    if (!ownerIsDead && !ownerWasNeverRecorded) return false;

    rmSync(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    const currentOwner = inspectLockOwner(reaperOwnerPath);
    if (
      ownerRecorded
      && currentOwner.state === "valid"
      && currentOwner.owner.token === token
    ) {
      rmSync(reaperDir, { recursive: true, force: true });
    }
  }
}

function acquireNativeModuleLock({
  lockDir,
  timeoutMs = LOCK_TIMEOUT_MS,
  pollMs = LOCK_POLL_MS,
  now = Date.now,
  sleep = sleepSync,
  writeOwner = writeFileSync,
  writeReaperOwner = writeFileSync,
} = {}) {
  if (!lockDir) throw new Error("native-module lock path is required");
  mkdirSync(dirname(lockDir), { recursive: true });

  const ownerPath = join(lockDir, LOCK_OWNER_FILE);
  const token = randomUUID();
  const startedAt = now();

  while (true) {
    let createdLock = false;
    try {
      mkdirSync(lockDir);
      createdLock = true;
      writeOwner(ownerPath, JSON.stringify({
        pid: process.pid,
        token,
        createdAt: new Date(now()).toISOString(),
      }), { encoding: "utf8", flag: "wx" });
      return () => {
        const owner = inspectLockOwner(ownerPath);
        if (owner.state === "valid" && owner.owner.token === token) {
          rmSync(lockDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (createdLock) throw error;
      if (error?.code !== "EEXIST") throw error;
    }

    const owner = inspectLockOwner(ownerPath);
    let lockAgeMs = 0;
    try {
      lockAgeMs = Math.max(0, now() - statSync(lockDir).mtimeMs);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    const ownerIsDead = owner.state === "valid"
      && inspectProcessLiveness(owner.owner.pid) === "dead";
    const ownerWasNeverRecorded = owner.state === "absent"
      && lockAgeMs >= ORPHANED_LOCK_GRACE_MS;
    if (ownerIsDead || ownerWasNeverRecorded) {
      if (tryReclaimStaleLock({
        lockDir,
        ownerPath,
        now,
        writeOwner: writeReaperOwner,
      })) continue;
    }

    if (now() - startedAt >= timeoutMs) {
      const reaper = inspectReaperState({ lockDir, now });
      if (reaper.state === "orphaned" || reaper.recoveryEligible) {
        const generationArgument = reaper.state === "orphaned"
          ? `--expected-token ${reaper.ownerToken}`
          : `--expected-generation ${reaper.generation}`;
        const cleanupCommand = "bun scripts/recover-electron-native-reaper.mjs "
          + `${generationArgument} --confirm-quiesced`;
        const ownerStatus = reaper.state === "orphaned"
          ? `Recorded reaper owner PID ${reaper.ownerPid} is not running. `
          : `Reaper has ${reaper.ambiguityReason ?? "ambiguous ownership"}. `;
        const error = new Error(
          "Electron native-module rebuild recovery lock requires validated cleanup. "
          + ownerStatus
          + "Stop every app/dev launcher and Git hook using this checkout, then run "
          + `this generation-validated cleanup from the repository root: ${cleanupCommand}`,
        );
        error.code = "ELECTRON_NATIVE_REAPER_ORPHANED";
        error.reaperPath = reaper.reaperDir;
        error.ownerPid = reaper.ownerPid;
        error.ownerToken = reaper.ownerToken;
        error.reaperGeneration = reaper.generation;
        error.cleanupCommand = cleanupCommand;
        throw error;
      }

      const currentOwner = inspectLockOwner(ownerPath);
      let ownerStatus = "ambiguous owner state";
      if (reaper.state === "active") {
        ownerStatus = `active reaper owner PID ${reaper.ownerPid}`;
      } else if (reaper.state === "initializing") {
        ownerStatus = "reaper ownership is initializing";
      } else if (
        currentOwner.state === "valid"
        && inspectProcessLiveness(currentOwner.owner.pid) === "alive"
      ) {
        ownerStatus = `active owner PID ${currentOwner.owner.pid}`;
      }
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
  inspectLockOwner,
  inspectReaperState,
  isRepairableNativeFailure,
};
