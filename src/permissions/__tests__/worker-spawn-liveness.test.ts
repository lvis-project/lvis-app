/**
 * The liveness pipe, with a real child.
 *
 * `worker-spawn.test.ts` replaces `node:child_process` with a stub, so it can
 * prove what `spawnWorker` asks the OS for but not what a process does with
 * it. The claim here is about the OS: closing the host's end of the worker's
 * stdin is what a dead host does, in every death mode, and a worker that reads
 * stdin sees EOF exactly then. That needs a real pipe and a real child, which
 * is why this lives beside the stubbed suite rather than inside it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";

// Capture the child so a test can close the host's end of its stdin — the
// handle deliberately exposes no stdin, since no host path writes to it.
// Admission stays open: the sweep this pipe stands in for is the one that
// never runs when the host dies.
let trackedChild: ChildProcess | undefined;
vi.mock("../../main/managed-child-processes.js", () => ({
  assertManagedChildProcessAdmissionOpen: () => {},
  trackManagedChildProcess: (child: ChildProcess) => {
    trackedChild = child;
    return () => {};
  },
}));

import { spawnWorker, type SpawnedWorker } from "../worker-spawn.js";

// RunAsNode makes `process.execPath` the Electron binary under this repo's test
// runner; `ELECTRON_RUN_AS_NODE` makes that binary behave as Node, and is
// harmless when a plain Node path is supplied instead.
const NODE_COMMAND = process.env.LVIS_TEST_NODE_EXEC_PATH ?? process.execPath;
const NODE_ENV = { ELECTRON_RUN_AS_NODE: "1" };
const EXIT_WAIT_MS = 5_000;

function exitOf(worker: SpawnedWorker): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not exit")), EXIT_WAIT_MS);
    worker.onExit((info) => {
      clearTimeout(timer);
      resolve(info);
    });
  });
}

let worker: SpawnedWorker | undefined;

afterEach(() => {
  worker?.stop();
  worker = undefined;
  trackedChild = undefined;
});

describe("spawnWorker — stdin is the host's liveness pipe (real child)", () => {
  it("a worker reading stdin exits the moment the host's end closes", async () => {
    worker = await spawnWorker({
      pluginId: "liveness-probe",
      workerId: "reads-stdin",
      command: NODE_COMMAND,
      args: [
        "-e",
        "process.stdin.resume(); process.stdin.on('end', () => process.exit(7)); process.stdout.write('ready');",
      ],
      env: NODE_ENV,
    });
    const exited = exitOf(worker);
    // Close only once the worker is reading: an EOF nobody consumes proves
    // nothing about the read.
    await new Promise<void>((resolve) => worker?.onStdout((chunk) => chunk.includes("ready") && resolve()));
    expect(trackedChild?.stdin).toBeDefined();

    // The host never writes to or ends this stream; destroying it is what the
    // OS does to the host's end of the pipe when the host process is gone.
    trackedChild?.stdin?.destroy();

    await expect(exited).resolves.toEqual({ code: 7, signal: null });
  }, 20_000);

  it("raises nothing on the host when the worker exits on its own first", async () => {
    const raised: unknown[] = [];
    const record = (err: unknown): void => {
      raised.push(err);
    };
    process.on("uncaughtException", record);
    process.on("unhandledRejection", record);
    try {
      worker = await spawnWorker({
        pluginId: "liveness-probe",
        workerId: "exits-first",
        command: NODE_COMMAND,
        args: ["-e", "process.exit(0)"],
        env: NODE_ENV,
      });
      const exited = exitOf(worker);
      const stdin = trackedChild?.stdin;
      expect(stdin?.listenerCount("error")).toBeGreaterThan(0);

      await expect(exited).resolves.toEqual({ code: 0, signal: null });
      // A stream error on the host's end, if one were coming, arrives after
      // the exit; give it the turn it would need.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(raised).toEqual([]);
    } finally {
      process.off("uncaughtException", record);
      process.off("unhandledRejection", record);
    }
  }, 20_000);
});
