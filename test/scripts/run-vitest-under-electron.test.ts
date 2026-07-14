import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { assertElectronNodeVitestRuntime } from "../../scripts/assert-electron-node-vitest.mjs";
import { normalizeElectronNodeRuntime } from "../../scripts/normalize-electron-node-runtime.mjs";
import {
  applyElectronVitestResult,
  createElectronVitestInvocation,
  resolveElectronVitestRuntime,
  runVitestUnderElectron,
} from "../../scripts/run-vitest-under-electron.mjs";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);
}

describe("Electron Node-mode Vitest runner", () => {
  it("locks both test entrypoints to the runtime guard", () => {
    const vitestConfig = readFileSync(
      new URL("../../vitest.config.ts", import.meta.url),
      "utf8",
    );
    const bunfig = readFileSync(new URL("../../bunfig.toml", import.meta.url), "utf8");
    expect(vitestConfig).toMatch(
      /^import "\.\/scripts\/assert-electron-node-vitest\.mjs";$/m,
    );
    expect(bunfig).toMatch(
      /^preload = \["\.\/scripts\/assert-electron-node-vitest\.mjs"\]$/m,
    );
  });

  it("fails fast for direct Node or Bun test runners", () => {
    expect(() =>
      assertElectronNodeVitestRuntime({
        env: {},
        execPath: "C:/runtime/node.exe",
      }),
    ).toThrow("[electron-vitest-runner-required]");
    expect(() =>
      assertElectronNodeVitestRuntime({
        env: { ELECTRON_RUN_AS_NODE: "1" },
        execPath: "/usr/bin/node",
      }),
    ).toThrow("[electron-vitest-runner-required]");
    expect(() =>
      assertElectronNodeVitestRuntime({
        env: { ELECTRON_RUN_AS_NODE: "1" },
        execPath: "C:/runtime/electron.exe",
      }),
    ).not.toThrow();
    expect(() =>
      assertElectronNodeVitestRuntime({
        env: { ELECTRON_RUN_AS_NODE: "1" },
        execPath: "/opt/Electron",
      }),
    ).not.toThrow();
  });

  it("resolves explicit runtime paths and rejects invalid resolvers", () => {
    expect(
      resolveElectronVitestRuntime({
        loadElectron: () => "C:/runtime/electron.exe",
        resolveVitest: () => "C:/runtime/vitest.mjs",
        normalizerPath: "C:/runtime/normalize.mjs",
      }),
    ).toEqual({
      electronPath: "C:/runtime/electron.exe",
      vitestPath: "C:/runtime/vitest.mjs",
      normalizerPath: "C:/runtime/normalize.mjs",
    });
    expect(() =>
      resolveElectronVitestRuntime({
        loadElectron: () => "",
        resolveVitest: () => "C:/runtime/vitest.mjs",
      }),
    ).toThrow("[electron-vitest-runtime-invalid]");
  });

  it("builds a shell-free invocation and forces Electron Node mode", () => {
    const invocation = createElectronVitestInvocation(
      ["run", "./src/example.test.ts"],
      {
        electronPath: "C:/runtime/electron.exe",
        vitestPath: "C:/runtime/vitest.mjs",
        normalizerPath: "C:/runtime/normalize.mjs",
        cwd: "C:/repo",
        env: {
          ELECTRON_RUN_AS_NODE: "0",
          KEEP: "yes",
          NODE_OPTIONS: "--trace-warnings",
        },
        nodeExecPath: "C:/runtime/node.exe",
      },
    );

    expect(invocation).toEqual({
      command: "C:/runtime/electron.exe",
      args: ["C:/runtime/vitest.mjs", "run", "./src/example.test.ts"],
      options: {
        cwd: "C:/repo",
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          KEEP: "yes",
          LVIS_TEST_NODE_EXEC_PATH: "C:/runtime/node.exe",
          NODE_OPTIONS:
            `--trace-warnings --import=${pathToFileURL("C:/runtime/normalize.mjs").href}`,
        },
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      },
    });
    expect(() =>
      createElectronVitestInvocation(["run", 1] as unknown as string[], {
        electronPath: "electron",
        vitestPath: "vitest",
      }),
    ).toThrow("[electron-vitest-args-invalid]");
    expect(() =>
      createElectronVitestInvocation(["run"], {
        electronPath: "",
        vitestPath: "vitest",
      }),
    ).toThrow("[electron-vitest-runtime-invalid]");
  });

  it("rejects partially injected runtime paths instead of ignoring them", async () => {
    await expect(
      runVitestUnderElectron(["run"], {
        electronPath: "C:/runtime/electron.exe",
      }),
    ).rejects.toThrow("[electron-vitest-runtime-invalid]");
  });

  it("forwards termination signals, returns the child result, and removes listeners", async () => {
    const child = new FakeChild();
    const signalSource = new EventEmitter();
    const spawnProcess = vi.fn(() => child);
    const completion = runVitestUnderElectron(["run", "./test.ts"], {
      electronPath: "C:/runtime/electron.exe",
      vitestPath: "C:/runtime/vitest.mjs",
      normalizerPath: "C:/runtime/normalize.mjs",
      cwd: "C:/repo",
      env: { KEEP: "yes" },
      nodeExecPath: "C:/runtime/node.exe",
      signalSource,
      spawnProcess,
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      "C:/runtime/electron.exe",
      ["C:/runtime/vitest.mjs", "run", "./test.ts"],
      expect.objectContaining({
        cwd: "C:/repo",
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          KEEP: "yes",
          LVIS_TEST_NODE_EXEC_PATH: "C:/runtime/node.exe",
          NODE_OPTIONS: `--import=${pathToFileURL("C:/runtime/normalize.mjs").href}`,
        },
        shell: false,
      }),
    );
    signalSource.emit("SIGINT");
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    signalSource.emit("SIGINT");
    expect(child.kill).toHaveBeenCalledTimes(2);
    child.exitCode = 7;
    child.emit("exit", 7, null);

    await expect(completion).resolves.toEqual({ code: 7, signal: null });
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("wraps asynchronous launch errors with a stable code", async () => {
    const child = new FakeChild();
    const completion = runVitestUnderElectron(["run"], {
      electronPath: "electron",
      vitestPath: "vitest",
      signalSource: new EventEmitter(),
      spawnProcess: () => child,
    });

    child.emit("error", new Error("spawn failed"));
    await expect(completion).rejects.toThrow(
      "[electron-vitest-launch-failed] spawn failed",
    );
  });

  it("wraps synchronous launch and runtime resolution errors with stable codes", async () => {
    await expect(
      runVitestUnderElectron(["run"], {
        electronPath: "electron",
        vitestPath: "vitest",
        spawnProcess: () => {
          throw new Error("sync spawn failed");
        },
      }),
    ).rejects.toThrow("[electron-vitest-launch-failed] sync spawn failed");
    expect(() =>
      resolveElectronVitestRuntime({
        loadElectron: () => {
          throw new Error("missing electron");
        },
      }),
    ).toThrow("[electron-vitest-runtime-unavailable] missing electron");
  });

  it("keeps Electron's ABI while exposing plain-Node runtime markers", () => {
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(process.versions.modules).toMatch(/^\d+$/);
    expect(process.versions.electron).toBeUndefined();
    expect(process.versions.chrome).toBeUndefined();
    const runtime = process as NodeJS.Process & {
      helperExecPath?: string;
      resourcesPath?: string;
    };
    expect(runtime.resourcesPath).toBeUndefined();
    expect(runtime.helperExecPath).toBeUndefined();
  });

  it("fails closed when a future Electron marker cannot be normalized", () => {
    const versions: Record<string, string> = {};
    Object.defineProperty(versions, "electron", {
      configurable: false,
      value: "future",
    });
    expect(() =>
      normalizeElectronNodeRuntime({
        env: { ELECTRON_RUN_AS_NODE: "1" },
        versions,
      }),
    ).toThrow("[electron-node-normalization-failed]");
  });

  it("mirrors exit codes and child termination signals", () => {
    const codeTarget = { exitCode: undefined as number | undefined };
    applyElectronVitestResult({ code: 9, signal: null }, codeTarget);
    expect(codeTarget.exitCode).toBe(9);

    const signalTarget = {
      pid: 42,
      exitCode: undefined as number | undefined,
      kill: vi.fn(),
    };
    applyElectronVitestResult(
      { code: null, signal: "SIGTERM" },
      signalTarget,
    );
    expect(signalTarget.kill).toHaveBeenCalledWith(42, "SIGTERM");
    expect(signalTarget.exitCode).toBeUndefined();

    const failedSignalTarget = {
      pid: 42,
      exitCode: undefined as number | undefined,
      kill: vi.fn(() => {
        throw new Error("signal unavailable");
      }),
    };
    applyElectronVitestResult(
      { code: null, signal: "SIGTERM" },
      failedSignalTarget,
    );
    expect(failedSignalTarget.exitCode).toBe(1);
  });
});
