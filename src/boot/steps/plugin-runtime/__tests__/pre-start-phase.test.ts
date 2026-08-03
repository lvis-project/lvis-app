import { describe, expect, it, vi } from "vitest";
import { PluginRuntimePreStartPhase } from "../pre-start-phase.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("PluginRuntimePreStartPhase", () => {
  it("serializes an admitted durable commit before exactly-once startup", async () => {
    const phase = new PluginRuntimePreStartPhase();
    const commitGate = deferred();
    const events: string[] = [];
    const commit = phase.admit(async () => {
      events.push("commit:start");
      await commitGate.promise;
      events.push("commit:end");
    });
    const startAll = vi.fn(async () => {
      events.push("start");
    });

    const firstStart = phase.start(startAll);
    const secondStart = phase.start(startAll);
    expect(phase.getState()).toBe("starting");
    expect(firstStart).toBe(secondStart);

    await Promise.resolve();
    expect(events).toEqual(["commit:start"]);
    commitGate.resolve();
    await Promise.all([commit, firstStart, secondStart]);

    expect(events).toEqual(["commit:start", "commit:end", "start"]);
    expect(startAll).toHaveBeenCalledOnce();
    expect(phase.getState()).toBe("started");
  });

  it("seals admission synchronously when startup is admitted first", async () => {
    const phase = new PluginRuntimePreStartPhase();
    const startGate = deferred();
    const start = phase.start(() => startGate.promise);
    const mutation = vi.fn(async () => undefined);

    const rejected = phase.admit(mutation);
    expect(phase.getState()).toBe("starting");
    await expect(rejected).rejects.toThrow(
      "plugin runtime no longer accepts pre-start operations",
    );
    expect(mutation).not.toHaveBeenCalled();

    startGate.resolve();
    await start;
  });

  it("rejects a late commit while an earlier admitted sync is awaiting I/O", async () => {
    const phase = new PluginRuntimePreStartPhase();
    const networkGate = deferred();
    const admittedSync = phase.admit(async () => {
      await networkGate.promise;
    });
    const startAll = vi.fn(async () => undefined);

    await Promise.resolve();
    const start = phase.start(startAll);
    const lateMutation = vi.fn(async () => undefined);
    await expect(phase.admit(lateMutation)).rejects.toThrow(
      "plugin runtime no longer accepts pre-start operations",
    );
    expect(lateMutation).not.toHaveBeenCalled();
    expect(startAll).not.toHaveBeenCalled();

    networkGate.resolve();
    await Promise.all([admittedSync, start]);
    expect(startAll).toHaveBeenCalledOnce();
  });

  it("serializes multiple managed commits in admission order", async () => {
    const phase = new PluginRuntimePreStartPhase();
    const firstGate = deferred();
    const events: string[] = [];

    const first = phase.admit(async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
    });
    const second = phase.admit(async () => {
      events.push("second");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("waits for transaction rollback after failure before starting the incumbent", async () => {
    const phase = new PluginRuntimePreStartPhase();
    const rollbackGate = deferred();
    const events: string[] = [];
    const transaction = phase.admit(async () => {
      events.push("transaction:failed");
      try {
        throw new Error("commit failed");
      } finally {
        await rollbackGate.promise;
        events.push("rollback:complete");
      }
    });
    const start = phase.start(async () => {
      events.push("incumbent:start");
    });

    await Promise.resolve();
    expect(events).toEqual(["transaction:failed"]);
    rollbackGate.resolve();
    await expect(transaction).rejects.toThrow("commit failed");
    await start;
    expect(events).toEqual([
      "transaction:failed",
      "rollback:complete",
      "incumbent:start",
    ]);
  });
});
