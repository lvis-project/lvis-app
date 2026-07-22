import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __internalForTests,
  ensureElectronNativeModules,
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

  it("fails retryably instead of spinning when the reaper itself is orphaned", () => {
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
    expect(String(caught)).toContain("retry the app launch");
  });
});
