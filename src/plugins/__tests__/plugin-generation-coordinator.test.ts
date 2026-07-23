import { describe, expect, it, vi } from "vitest";
import {
  PluginGenerationCoordinator,
  type ActivePluginGeneration,
} from "../plugin-generation-coordinator.js";

function generation(id: string): ActivePluginGeneration<{ label: string }> {
  return {
    pluginId: "bundle-host-test",
    pluginVersion: id === "g1" ? "1.0.0" : "2.0.0",
    generationId: id,
    manifestSha256: (id === "g1" ? "1" : "2").repeat(64),
    receiptSha256: (id === "g1" ? "a" : "b").repeat(64),
    contributions: [],
    state: { label: id },
  };
}

describe("PluginGenerationCoordinator", () => {
  it("publishes only after durable commit and preserves predecessor on failure", async () => {
    const coordinator = new PluginGenerationCoordinator<{ label: string }>();
    await coordinator.commit(generation("g1"), async () => undefined);
    await expect(coordinator.commit(generation("g2"), async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(coordinator.getActive("bundle-host-test")?.generationId).toBe("g1");
  });

  it("blocks new leases during commit and retires only after predecessor leases drain", async () => {
    const coordinator = new PluginGenerationCoordinator<{ label: string }>();
    await coordinator.commit(generation("g1"), async () => undefined);
    const oldLease = await coordinator.acquire("bundle-host-test");
    let finishCommit!: () => void;
    const durable = new Promise<void>((resolve) => { finishCommit = resolve; });
    const retire = vi.fn(async () => undefined);
    const transition = coordinator.commit(generation("g2"), () => durable, retire);
    const waitingLease = coordinator.acquire("bundle-host-test");
    await Promise.resolve();
    expect(coordinator.getActive("bundle-host-test")?.generationId).toBe("g1");
    finishCommit();
    const newLease = await waitingLease;
    expect(newLease.generation.generationId).toBe("g2");
    expect(retire).not.toHaveBeenCalled();
    oldLease.release();
    const published = await transition;
    await published.retired;
    expect(retire).toHaveBeenCalledWith(expect.objectContaining({ generationId: "g1" }));
    newLease.release();
  });

  it("publishes without waiting for predecessor retirement and rejects stale exact leases", async () => {
    const coordinator = new PluginGenerationCoordinator<{ label: string }>();
    await coordinator.commit(generation("g1"), async () => undefined);
    const oldLease = await coordinator.acquireExact("bundle-host-test", "g1");
    const retire = vi.fn(async () => undefined);
    const published = await coordinator.commit(generation("g2"), async () => undefined, retire);
    expect(coordinator.getActive("bundle-host-test")?.generationId).toBe("g2");
    expect(retire).not.toHaveBeenCalled();
    await expect(coordinator.acquireExact("bundle-host-test", "g1")).rejects.toThrow(/not active/);
    oldLease.release();
    await published.retired;
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it("supports an inactive pointer transition without admitting new invocations", async () => {
    const coordinator = new PluginGenerationCoordinator();
    await coordinator.commit(generation("g1"), async () => undefined);
    await coordinator.commit(undefined, async () => undefined, undefined, "bundle-host-test");
    expect(coordinator.getActive("bundle-host-test")).toBeUndefined();
    await expect(coordinator.acquire("bundle-host-test")).rejects.toThrow(/no active generation/);
  });

  it("makes lease release idempotent", async () => {
    const coordinator = new PluginGenerationCoordinator();
    await coordinator.commit(generation("g1"), async () => undefined);
    const lease = await coordinator.acquire("bundle-host-test");
    lease.release();
    lease.release();
    await coordinator.commit(generation("g2"), async () => undefined);
    expect(coordinator.getActive("bundle-host-test")?.generationId).toBe("g2");
  });

  it("quiesces existing leases before an in-place projection transition", async () => {
    const coordinator = new PluginGenerationCoordinator<{ label: string }>();
    await coordinator.commit(generation("g1"), async () => undefined);
    const oldLease = await coordinator.acquire("bundle-host-test");
    const publish = vi.fn();
    const transition = coordinator.quiesce(
      "bundle-host-test",
      "g1",
      async () => undefined,
      publish,
    );
    const waitingLease = coordinator.acquire("bundle-host-test");
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
    oldLease.release();
    await transition;
    expect(publish).toHaveBeenCalledTimes(1);
    const nextLease = await waitingLease;
    expect(nextLease.generation.generationId).toBe("g1");
    nextLease.release();
  });
});
