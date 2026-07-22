import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __internalForTests,
  ensureElectronNativeModules,
  recoverOrphanedNativeReaper,
} from "../scripts/lib/electron-native-modules.mjs";

const ok = { status: 0, stdout: "", stderr: "" };
const failedAbiProbe = {
  status: 1,
  stdout: "",
  stderr: "NODE_MODULE_VERSION 127 does not match 148",
};
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function immediateLock(callback: () => unknown) {
  return callback();
}

describe("ensureElectronNativeModules", () => {
  it("does not rebuild when Electron can exercise better-sqlite3", () => {
    const spawnSync = vi.fn().mockReturnValue(ok);

    expect(ensureElectronNativeModules({
      repoRoot: "/repo",
      electronExecutable: "/repo/electron",
      nodeExecutable: "/repo/node",
      rebuildCli: "/repo/electron-rebuild-cli.js",
      spawnSync,
      existsSync: () => true,
      log: vi.fn(),
      env: { ELECTRON_RUN_AS_NODE: "0", LVIS_TEST_MARKER: "present" },
      withRebuildLock: immediateLock,
    })).toEqual({ rebuilt: false });

    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0]).toEqual([
      "/repo/electron",
      ["-e", __internalForTests.ELECTRON_NATIVE_PROBE],
      expect.objectContaining({
        cwd: "/repo",
        encoding: "utf8",
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: "1",
          LVIS_TEST_MARKER: "present",
        }),
      }),
    ]);
  });

  it("forces only better-sqlite3 rebuild and verifies the repaired ABI", () => {
    const spawnSync = vi.fn()
      .mockReturnValueOnce(failedAbiProbe)
      .mockReturnValueOnce(failedAbiProbe)
      .mockReturnValueOnce(ok)
      .mockReturnValueOnce(ok);
    const log = vi.fn();

    expect(ensureElectronNativeModules({
      repoRoot: "/repo",
      electronExecutable: "/repo/electron",
      nodeExecutable: "/repo/node",
      rebuildCli: "/repo/electron-rebuild-cli.js",
      spawnSync,
      existsSync: () => true,
      log,
      env: { ELECTRON_RUN_AS_NODE: "0", LVIS_TEST_MARKER: "present" },
      withRebuildLock: immediateLock,
    })).toEqual({ rebuilt: true });

    expect(spawnSync.mock.calls[2]).toEqual([
      "/repo/node",
      [
        "/repo/electron-rebuild-cli.js",
        "--force",
        "--only",
        "better-sqlite3",
      ],
      expect.objectContaining({
        cwd: "/repo",
        stdio: "inherit",
        env: expect.not.objectContaining({ ELECTRON_RUN_AS_NODE: expect.anything() }),
      }),
    ]);
    expect(spawnSync.mock.calls[3]?.[2]).toEqual(expect.objectContaining({
      cwd: "/repo",
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }),
    }));
    expect(log).toHaveBeenCalledWith("Electron better-sqlite3 rebuilt and verified.");
  });

  it("re-probes after locking and skips a rebuild completed by a peer", () => {
    const spawnSync = vi.fn()
      .mockReturnValueOnce(failedAbiProbe)
      .mockReturnValueOnce(ok);
    const log = vi.fn();

    expect(ensureElectronNativeModules({
      repoRoot: "/repo",
      spawnSync,
      log,
      withRebuildLock: immediateLock,
    })).toEqual({ rebuilt: false, repairedByPeer: true });

    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      "Electron better-sqlite3 was repaired by another process.",
    );
  });

  it("refuses dependency mutation for non-native Electron failures", () => {
    const spawnSync = vi.fn().mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Electron failed to initialize AppKit",
    });
    const withRebuildLock = vi.fn(immediateLock);

    expect(() => ensureElectronNativeModules({
      repoRoot: "/repo",
      spawnSync,
      log: vi.fn(),
      withRebuildLock,
    })).toThrow("non-repairable reason; refusing to rebuild dependencies automatically");
    expect(withRebuildLock).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("recognizes Linux cross-architecture loader failures as repairable", () => {
    expect(__internalForTests.isRepairableNativeFailure({
      status: 1,
      stdout: "",
      stderr: "wrong ELF class: ELFCLASS32",
    })).toBe(true);
  });

  it("fails clearly when the forced rebuild is terminated", () => {
    const spawnSync = vi.fn()
      .mockReturnValueOnce(failedAbiProbe)
      .mockReturnValueOnce(failedAbiProbe)
      .mockReturnValueOnce({ status: null, signal: "SIGTERM", stdout: "", stderr: "" });

    expect(() => ensureElectronNativeModules({
      repoRoot: "/repo",
      nodeExecutable: "/repo/node",
      rebuildCli: "/repo/electron-rebuild-cli.js",
      spawnSync,
      existsSync: () => true,
      log: vi.fn(),
      withRebuildLock: immediateLock,
    })).toThrow("Electron native-module rebuild failed: terminated by signal SIGTERM");
  });

  it("fails clearly when rebuilt better-sqlite3 still does not load", () => {
    const spawnSync = vi.fn()
      .mockReturnValueOnce(failedAbiProbe)
      .mockReturnValueOnce(failedAbiProbe)
      .mockReturnValueOnce(ok)
      .mockReturnValueOnce(failedAbiProbe);

    expect(() => ensureElectronNativeModules({
      repoRoot: "/repo",
      spawnSync,
      existsSync: () => true,
      log: vi.fn(),
      withRebuildLock: immediateLock,
    })).toThrow("Electron better-sqlite3 still fails after rebuild");
  });

  it("serializes rebuild owners across processes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-native-lock-"));
    tempDirs.push(dir);
    const lockDir = join(dir, "native.lock");
    const release = __internalForTests.acquireNativeModuleLock({ lockDir });
    const helperUrl = pathToFileURL(
      join(process.cwd(), "scripts", "lib", "electron-native-modules.mjs"),
    ).href;
    const script = `
      import { __internalForTests } from ${JSON.stringify(helperUrl)};
      process.stdout.write("attempting\\n");
      const release = __internalForTests.acquireNativeModuleLock({
        lockDir: ${JSON.stringify(lockDir)},
        timeoutMs: 5000,
        pollMs: 25,
      });
      process.stdout.write("acquired");
      release();
    `;
    const child = spawn("node", ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child did not attempt lock")), 3000);
      child.stdout.on("data", () => {
        if (!stdout.includes("attempting\n")) return;
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stdout).toBe("attempting\n");
    release();

    const status = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
    });
    expect({ status, stdout, stderr }).toEqual({
      status: 0,
      stdout: "attempting\nacquired",
      stderr: "",
    });
  });

  it("serializes multiple contenders reclaiming one stale owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-native-stale-lock-"));
    tempDirs.push(dir);
    const lockDir = join(dir, "native.lock");
    const eventsPath = join(dir, "events.log");
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, token: "stale-owner" }),
      "utf8",
    );

    const helperUrl = pathToFileURL(
      join(process.cwd(), "scripts", "lib", "electron-native-modules.mjs"),
    ).href;
    const childScript = `
      import { appendFileSync } from "node:fs";
      import { __internalForTests } from ${JSON.stringify(helperUrl)};
      const id = process.argv[1];
      const release = __internalForTests.acquireNativeModuleLock({
        lockDir: ${JSON.stringify(lockDir)},
        timeoutMs: 5000,
        pollMs: 10,
      });
      appendFileSync(${JSON.stringify(eventsPath)}, "start:" + id + "\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      appendFileSync(${JSON.stringify(eventsPath)}, "end:" + id + "\\n");
      release();
    `;
    const children = ["one", "two"].map((id) => spawn(
      "node",
      ["--input-type=module", "-e", childScript, id],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    ));

    const results = await Promise.all(children.map((child) => new Promise<{
      status: number | null;
      stderr: string;
    }>((resolve) => {
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (status) => resolve({ status, stderr }));
    })));
    expect(results).toEqual([
      { status: 0, stderr: "" },
      { status: 0, stderr: "" },
    ]);

    const events = readFileSync(eventsPath, "utf8").trim().split("\n");
    expect([
      ["start:one", "end:one", "start:two", "end:two"],
      ["start:two", "end:two", "start:one", "end:one"],
    ]).toContainEqual(events);
  });

  it("does not delete a successor generation after delayed owner publication", () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-native-owner-publish-race-"));
    tempDirs.push(dir);
    const lockDir = join(dir, "native.lock");
    const successor = { pid: process.pid, token: "successor-generation" };
    const collision = Object.assign(new Error("owner already exists"), {
      code: "EEXIST",
    });

    expect(() => __internalForTests.acquireNativeModuleLock({
      lockDir,
      writeOwner: (ownerPath: string) => {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        writeFileSync(ownerPath, JSON.stringify(successor), "utf8");
        throw collision;
      },
    })).toThrow(collision);

    expect(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"))).toEqual(successor);
  });

  it("does not delete a successor reaper after delayed owner publication", () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-native-reaper-publish-race-"));
    tempDirs.push(dir);
    const lockDir = join(dir, "native.lock");
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, token: "stale-owner" }),
      "utf8",
    );
    const reaperDir = `${lockDir}.reaper`;
    const successor = { pid: process.pid, token: "successor-reaper" };
    const collision = Object.assign(new Error("reaper owner already exists"), {
      code: "EEXIST",
    });

    expect(() => __internalForTests.acquireNativeModuleLock({
      lockDir,
      writeReaperOwner: (ownerPath: string) => {
        rmSync(reaperDir, { recursive: true, force: true });
        mkdirSync(reaperDir);
        writeFileSync(ownerPath, JSON.stringify(successor), "utf8");
        throw collision;
      },
    })).toThrow(collision);

    expect(JSON.parse(readFileSync(join(reaperDir, "owner.json"), "utf8"))).toEqual(successor);
  });

  it("distinguishes an active reaper from an orphaned one", () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-native-active-reaper-"));
    tempDirs.push(dir);
    const lockDir = join(dir, "native.lock");
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, token: "stale-owner" }),
      "utf8",
    );
    mkdirSync(`${lockDir}.reaper`);
    writeFileSync(
      join(`${lockDir}.reaper`, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "active-reaper" }),
      "utf8",
    );

    let caught: unknown;
    try {
      __internalForTests.acquireNativeModuleLock({
        lockDir,
        timeoutMs: 0,
        pollMs: 0,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "ELECTRON_NATIVE_REBUILD_LOCK_TIMEOUT",
    });
    expect(String(caught)).toContain(`active reaper owner PID ${process.pid}`);
  });

  it("provides exact fail-closed cleanup guidance for an orphaned reaper", () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-native-orphaned-reaper-"));
    tempDirs.push(dir);
    const lockDir = join(dir, "native.lock");
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, token: "stale-owner" }),
      "utf8",
    );
    mkdirSync(`${lockDir}.reaper`);
    writeFileSync(
      join(`${lockDir}.reaper`, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, token: "orphaned-reaper" }),
      "utf8",
    );

    let caught: unknown;
    try {
      __internalForTests.acquireNativeModuleLock({
        lockDir,
        timeoutMs: 0,
        pollMs: 0,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "ELECTRON_NATIVE_REAPER_ORPHANED",
      reaperPath: `${lockDir}.reaper`,
      ownerPid: 2_147_483_647,
      ownerToken: "orphaned-reaper",
      cleanupCommand: "bun scripts/recover-electron-native-reaper.mjs "
        + "--expected-token orphaned-reaper --confirm-quiesced",
    });
    expect(String(caught)).toContain("Stop every app/dev launcher and Git hook");
  });

  it("keeps ownerless and malformed reapers ambiguous after initialization", () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-native-ownerless-reaper-"));
    tempDirs.push(dir);
    const lockDir = join(dir, "native.lock");
    mkdirSync(`${lockDir}.reaper`);

    expect(__internalForTests.inspectReaperState({ lockDir })).toMatchObject({
      state: "initializing",
      ownerState: "absent",
    });
    expect(__internalForTests.inspectReaperState({
      lockDir,
      now: () => Date.now() + 10_001,
    })).toMatchObject({
      state: "ambiguous",
      ownerState: "absent",
      recoveryEligible: true,
      generation: expect.any(String),
    });

    writeFileSync(join(`${lockDir}.reaper`, "owner.json"), "{", "utf8");
    expect(__internalForTests.inspectReaperState({
      lockDir,
      now: () => Date.now() + 10_001,
    })).toMatchObject({
      state: "ambiguous",
      ownerState: "malformed",
      recoveryEligible: true,
    });
  });

  it("keeps unexpected owner liveness failures ambiguous", () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-native-unknown-liveness-"));
    tempDirs.push(dir);
    const lockDir = join(dir, "native.lock");
    mkdirSync(`${lockDir}.reaper`);
    writeFileSync(
      join(`${lockDir}.reaper`, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "unknown-liveness" }),
      "utf8",
    );

    expect(__internalForTests.inspectReaperState({
      lockDir,
      inspectProcess: () => "unknown",
      now: () => Date.now() + 10_001,
    })).toMatchObject({
      state: "ambiguous",
      ownerPid: process.pid,
      ownerToken: "unknown-liveness",
      recoveryEligible: true,
    });

    expect(__internalForTests.inspectReaperState({
      lockDir,
      inspectProcess: () => "alive",
      now: () => Date.now() + 120_001,
    })).toMatchObject({
      state: "ambiguous",
      ownerState: "valid",
      recoveryEligible: true,
    });
  });

  it("cleans only the expected orphan generation after explicit quiescence", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "lvis-native-cleanup-"));
    tempDirs.push(repoRoot);
    const lockDir = join(
      repoRoot,
      "node_modules",
      ".cache",
      "lvis-electron-native-rebuild.lock",
    );
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, token: "stale-owner" }),
      "utf8",
    );
    mkdirSync(`${lockDir}.reaper`);
    const reaperOwnerPath = join(`${lockDir}.reaper`, "owner.json");
    writeFileSync(
      reaperOwnerPath,
      JSON.stringify({ pid: 2_147_483_647, token: "expected-generation" }),
      "utf8",
    );

    expect(() => recoverOrphanedNativeReaper({
      repoRoot,
      expectedToken: "expected-generation",
      expectedGeneration: "aaaaaaaaaaaaaaaa",
      confirmQuiesced: true,
    })).toThrow("provide only one expected reaper identity");
    expect(() => recoverOrphanedNativeReaper({
      repoRoot,
      expectedToken: "--unsafe-token",
      confirmQuiesced: true,
    })).toThrow("expected reaper token has an invalid format");
    expect(() => recoverOrphanedNativeReaper({
      repoRoot,
      expectedGeneration: "short",
      confirmQuiesced: true,
    })).toThrow("expected reaper generation has an invalid format");
    expect(() => recoverOrphanedNativeReaper({
      repoRoot,
      expectedToken: "expected-generation",
    })).toThrow("every app/dev launcher and Git hook");
    expect(() => recoverOrphanedNativeReaper({
      repoRoot,
      expectedToken: "wrong-generation",
      confirmQuiesced: true,
    })).toThrow("no longer matches the expected identity");

    writeFileSync(
      reaperOwnerPath,
      JSON.stringify({ pid: 2_147_483_647, token: "replacement-generation" }),
      "utf8",
    );
    expect(() => recoverOrphanedNativeReaper({
      repoRoot,
      expectedToken: "expected-generation",
      confirmQuiesced: true,
    })).toThrow("no longer matches the expected identity");
    expect(existsSync(`${lockDir}.reaper`)).toBe(true);

    expect(recoverOrphanedNativeReaper({
      repoRoot,
      expectedToken: "replacement-generation",
      confirmQuiesced: true,
    })).toEqual({ removed: `${lockDir}.reaper` });
    expect(existsSync(`${lockDir}.reaper`)).toBe(false);

    const release = __internalForTests.acquireNativeModuleLock({
      lockDir,
      timeoutMs: 1_000,
      pollMs: 0,
    });
    release();
    expect(existsSync(lockDir)).toBe(false);
  });

  it("recovers a killed pre-publication reaper and re-serializes contenders", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "lvis-native-interrupted-reaper-"));
    tempDirs.push(repoRoot);
    const lockDir = join(
      repoRoot,
      "node_modules",
      ".cache",
      "lvis-electron-native-rebuild.lock",
    );
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, token: "stale-owner" }),
      "utf8",
    );
    const reaperDir = `${lockDir}.reaper`;
    const interrupted = spawn("node", ["--input-type=module", "-e", `
      import { mkdirSync } from "node:fs";
      mkdirSync(${JSON.stringify(reaperDir)});
      process.stdout.write("created");
      setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("reaper was not created")), 3_000);
      interrupted.stdout.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    interrupted.kill("SIGKILL");
    await new Promise((resolve) => interrupted.once("close", resolve));
    const old = new Date(Date.now() - 20_000);
    utimesSync(reaperDir, old, old);

    let caught: unknown;
    try {
      __internalForTests.acquireNativeModuleLock({
        lockDir,
        timeoutMs: 0,
        pollMs: 0,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "ELECTRON_NATIVE_REAPER_ORPHANED",
      reaperGeneration: expect.any(String),
      cleanupCommand: expect.stringContaining("--expected-generation"),
    });
    const recovery = caught as { reaperGeneration: string };
    const recoveryScript = join(
      process.cwd(),
      "scripts",
      "recover-electron-native-reaper.mjs",
    );
    const recoveryChild = spawn("bun", [
      recoveryScript,
      "--expected-generation",
      recovery.reaperGeneration,
      "--confirm-quiesced",
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    const recoveryResult = await new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      let stdout = "";
      let stderr = "";
      recoveryChild.stdout.setEncoding("utf8");
      recoveryChild.stderr.setEncoding("utf8");
      recoveryChild.stdout.on("data", (chunk) => { stdout += chunk; });
      recoveryChild.stderr.on("data", (chunk) => { stderr += chunk; });
      recoveryChild.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    expect(recoveryResult).toMatchObject({
      status: 0,
      stdout: expect.stringContaining("Removed validated orphaned reaper"),
      stderr: "",
    });
    expect(existsSync(reaperDir)).toBe(false);

    const helperUrl = pathToFileURL(
      join(process.cwd(), "scripts", "lib", "electron-native-modules.mjs"),
    ).href;
    const eventsPath = join(repoRoot, "events.log");
    const contenderScript = `
      import { appendFileSync } from "node:fs";
      import { __internalForTests } from ${JSON.stringify(helperUrl)};
      const id = process.argv[1];
      const release = __internalForTests.acquireNativeModuleLock({
        lockDir: ${JSON.stringify(lockDir)},
        timeoutMs: 5000,
        pollMs: 10,
      });
      appendFileSync(${JSON.stringify(eventsPath)}, "start:" + id + "\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      appendFileSync(${JSON.stringify(eventsPath)}, "end:" + id + "\\n");
      release();
    `;
    const contenders = ["one", "two"].map((id) => spawn(
      "node",
      ["--input-type=module", "-e", contenderScript, id],
      { stdio: ["ignore", "ignore", "pipe"] },
    ));
    const contenderResults = await Promise.all(contenders.map((child) => new Promise<{
      status: number | null;
      stderr: string;
    }>((resolve) => {
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (status) => resolve({ status, stderr }));
    })));
    expect(contenderResults).toEqual([
      { status: 0, stderr: "" },
      { status: 0, stderr: "" },
    ]);
    const events = readFileSync(eventsPath, "utf8").trim().split("\n");
    expect([
      ["start:one", "end:one", "start:two", "end:two"],
      ["start:two", "end:two", "start:one", "end:one"],
    ]).toContainEqual(events);
  });

  it("keeps multiple processes fail-closed on the same orphaned reaper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-native-orphaned-reaper-race-"));
    tempDirs.push(dir);
    const lockDir = join(dir, "native.lock");
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, token: "stale-owner" }),
      "utf8",
    );
    mkdirSync(`${lockDir}.reaper`);
    writeFileSync(
      join(`${lockDir}.reaper`, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, token: "orphaned-reaper" }),
      "utf8",
    );

    const helperUrl = pathToFileURL(
      join(process.cwd(), "scripts", "lib", "electron-native-modules.mjs"),
    ).href;
    const childScript = `
      import { __internalForTests } from ${JSON.stringify(helperUrl)};
      try {
        __internalForTests.acquireNativeModuleLock({
          lockDir: ${JSON.stringify(lockDir)},
          timeoutMs: 0,
          pollMs: 0,
        });
        process.exitCode = 2;
      } catch (error) {
        process.stdout.write(JSON.stringify({
          code: error.code,
          reaperPath: error.reaperPath,
          message: error.message,
        }));
      }
    `;
    const children = [0, 1].map(() => spawn(
      "node",
      ["--input-type=module", "-e", childScript],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    ));
    const results = await Promise.all(children.map((child) => new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    })));

    for (const result of results) {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "ELECTRON_NATIVE_REAPER_ORPHANED",
        reaperPath: `${lockDir}.reaper`,
      });
    }
    expect(existsSync(lockDir)).toBe(true);
    expect(existsSync(`${lockDir}.reaper`)).toBe(true);
  });
});
