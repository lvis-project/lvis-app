import { describe, expect, it, vi } from "vitest";
import {
  PluginGenerationCoordinator,
  type ActivePluginGeneration,
} from "../plugin-generation-coordinator.js";
import { CommittedPluginGenerationPublicationError } from "../committed-generation-publication-error.js";

interface GenerationState {
  label: string;
  instruction: string;
  hookOwner: string;
  mcpOwner: string;
  auditGeneration: string;
  disposed: boolean;
}

function generation(id: string): ActivePluginGeneration<GenerationState> {
  return {
    pluginId: "bundle-host-test",
    pluginVersion: id === "g1" ? "1.0.0" : "2.0.0",
    artifactGenerationId: (id === "g1" ? "c" : "d").repeat(64),
    generationId: id,
    manifestSha256: (id === "g1" ? "1" : "2").repeat(64),
    receiptSha256: (id === "g1" ? "a" : "b").repeat(64),
    contributions: [],
    state: {
      label: id,
      instruction: `instruction:${id}`,
      hookOwner: `hook:${id}`,
      mcpOwner: `mcp:${id}`,
      auditGeneration: `audit:${id}`,
      disposed: false,
    },
  };
}

function projectionSnapshot(generation: ActivePluginGeneration<GenerationState>): string {
  const state = generation.state;
  return [
    generation.generationId,
    state.instruction,
    state.hookOwner,
    state.mcpOwner,
    state.auditGeneration,
    String(state.disposed),
  ].join("|");
}

async function publishReady<TState>(
  coordinator: PluginGenerationCoordinator<TState>,
  candidate: ActivePluginGeneration<TState>,
) {
  const transition = await coordinator.commit(candidate, async () => undefined);
  await transition.markDispatchReady();
  return transition;
}

describe("PluginGenerationCoordinator", () => {
  it("publishes only after durable commit and preserves predecessor on failure", async () => {
    const coordinator = new PluginGenerationCoordinator<{ label: string }>();
    await publishReady(coordinator, generation("g1"));
    await expect(coordinator.commit(generation("g2"), async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(coordinator.getActive("bundle-host-test")?.generationId).toBe("g1");
  });

  it("blocks new leases during commit and retires only after predecessor leases drain", async () => {
    const coordinator = new PluginGenerationCoordinator<{ label: string }>();
    await publishReady(coordinator, generation("g1"));
    const oldLease = await coordinator.acquire("bundle-host-test");
    let finishCommit!: () => void;
    const durable = new Promise<void>((resolve) => { finishCommit = resolve; });
    const retire = vi.fn(async () => undefined);
    const transition = coordinator.commit(generation("g2"), () => durable, retire);
    const waitingLease = coordinator.acquire("bundle-host-test");
    await Promise.resolve();
    expect(coordinator.getActive("bundle-host-test")?.generationId).toBe("g1");
    finishCommit();
    const published = await transition;
    let candidateAdmitted = false;
    void waitingLease.then(() => { candidateAdmitted = true; });
    await Promise.resolve();
    expect(candidateAdmitted).toBe(false);
    expect(retire).not.toHaveBeenCalled();
    oldLease.release();
    await published.retired;
    await published.markDispatchReady();
    const newLease = await waitingLease;
    expect(newLease.generation.generationId).toBe("g2");
    expect(retire).toHaveBeenCalledWith(expect.objectContaining({ generationId: "g1" }));
    newLease.release();
  });

  it("publishes without waiting for predecessor retirement and rejects stale exact leases", async () => {
    const coordinator = new PluginGenerationCoordinator<{ label: string }>();
    await publishReady(coordinator, generation("g1"));
    const oldLease = await coordinator.acquireExact("bundle-host-test", "g1");
    const retire = vi.fn(async () => undefined);
    const published = await coordinator.commit(generation("g2"), async () => undefined, retire);
    expect(coordinator.getActive("bundle-host-test")?.generationId).toBe("g2");
    expect(retire).not.toHaveBeenCalled();
    await expect(coordinator.acquireExact("bundle-host-test", "g1")).rejects.toThrow(/not active/);
    const candidateLease = coordinator.acquireExact("bundle-host-test", "g2");
    let candidateAdmitted = false;
    void candidateLease.then(() => { candidateAdmitted = true; });
    await Promise.resolve();
    expect(candidateAdmitted).toBe(false);
    oldLease.release();
    await published.retired;
    await published.markDispatchReady();
    (await candidateLease).release();
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it("supports an inactive pointer transition without admitting new invocations", async () => {
    const coordinator = new PluginGenerationCoordinator();
    await publishReady(coordinator, generation("g1"));
    await coordinator.commit(undefined, async () => undefined, undefined, "bundle-host-test");
    expect(coordinator.getActive("bundle-host-test")).toBeUndefined();
    await expect(coordinator.acquire("bundle-host-test")).rejects.toThrow(/no active generation/);
  });

  it("makes lease release idempotent", async () => {
    const coordinator = new PluginGenerationCoordinator();
    await publishReady(coordinator, generation("g1"));
    const lease = await coordinator.acquire("bundle-host-test");
    lease.release();
    lease.release();
    await coordinator.commit(generation("g2"), async () => undefined);
    expect(coordinator.getActive("bundle-host-test")?.generationId).toBe("g2");
  });

  it("expires detached async admission when the owning lease is released", async () => {
    const coordinator = new PluginGenerationCoordinator();
    await publishReady(coordinator, generation("g1"));
    const lease = await coordinator.acquire("bundle-host-test");
    let continueDetached!: () => void;
    const detachedBarrier = new Promise<void>((resolve) => {
      continueDetached = resolve;
    });
    let detached!: Promise<string>;

    await coordinator.runWithLease(lease, async () => {
      detached = (async () => {
        await detachedBarrier;
        const nested = await coordinator.acquireExact("bundle-host-test", "g1");
        try {
          return nested.generation.generationId;
        } finally {
          nested.release();
        }
      })();
    });

    lease.release();
    await coordinator.commit(generation("g2"), async () => undefined);
    continueDetached();
    await expect(detached).rejects.toThrow(/admission has expired/);
    expect(coordinator.isExactAdmitted("bundle-host-test", "g1")).toBe(false);
  });

  it("does not open replacement dispatch when readiness is marked before retirement", async () => {
    const coordinator = new PluginGenerationCoordinator<GenerationState>();
    await publishReady(coordinator, generation("g1"));
    const predecessorLease = await coordinator.acquire("bundle-host-test");
    let releaseRetirement!: () => void;
    const retirementGate = new Promise<void>((resolve) => {
      releaseRetirement = resolve;
    });
    const published = await coordinator.commit(
      generation("g2"),
      async () => undefined,
      async () => retirementGate,
    );
    let ready = false;
    const readiness = published.markDispatchReady().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    predecessorLease.release();
    await Promise.resolve();
    expect(ready).toBe(false);
    releaseRetirement();
    await readiness;
    const candidateLease = await coordinator.acquire("bundle-host-test");
    expect(candidateLease.generation.generationId).toBe("g2");
    candidateLease.release();
  });

  it("runs detached post-commit startup under the candidate admission instead of stale predecessor ALS", async () => {
    const coordinator = new PluginGenerationCoordinator<GenerationState>();
    await publishReady(coordinator, generation("g1"));
    const predecessorLease = await coordinator.acquire("bundle-host-test");
    let published!: Awaited<ReturnType<typeof coordinator.commit>>;
    let detached!: Promise<string>;
    await coordinator.runWithLease(predecessorLease, async () => {
      published = await coordinator.commit(generation("g2"), async () => undefined);
      detached = (async () => {
        await published.retired;
        return coordinator.runPostCommitWithGeneration(
          "bundle-host-test",
          "g2",
          async () => {
            const nested = await coordinator.acquireExact("bundle-host-test", "g2");
            nested.release();
            return "g2";
          },
        );
      })();
    });
    predecessorLease.release();
    await expect(detached).resolves.toBe("g2");
    await published.markDispatchReady();
  });

  it.each(["initial", "replacement"] as const)(
    "keeps %s publication failures permanently unavailable",
    async (kind) => {
      const coordinator = new PluginGenerationCoordinator<GenerationState>();
      if (kind === "replacement") await publishReady(coordinator, generation("g1"));
      const publicationCause = new Error(`${kind} publish failed`);
      const failure = await coordinator.commit(
        generation(kind === "initial" ? "g1" : "g2"),
        async () => undefined,
        async () => undefined,
        "bundle-host-test",
        () => {
          throw publicationCause;
        },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CommittedPluginGenerationPublicationError);
      expect(failure).toMatchObject({
        pluginId: "bundle-host-test",
        generationId: kind === "initial" ? "g1" : "g2",
        publicationCause,
        committed: undefined,
      });
      expect((failure as Error).cause).toBe(publicationCause);
      await expect(coordinator.acquire("bundle-host-test")).rejects.toThrow(
        /dispatch blocked by publication failure/,
      );
      await expect(coordinator.waitForRetirements()).resolves.toBeUndefined();
    },
  );

  it("quiesces existing leases before an in-place projection transition", async () => {
    const coordinator = new PluginGenerationCoordinator<{ label: string }>();
    await publishReady(coordinator, generation("g1"));
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

  it("keeps every high-contention invocation pinned to one generation across replace and disable", async () => {
    const coordinator = new PluginGenerationCoordinator<GenerationState>();
    const g1 = generation("g1");
    await publishReady(coordinator, g1);
    const predecessorLeases = await Promise.all(
      Array.from({ length: 32 }, () => coordinator.acquire("bundle-host-test")),
    );

    let publishReplacement!: () => void;
    const replacementDurable = new Promise<void>((resolve) => {
      publishReplacement = resolve;
    });
    let observeReplacement!: () => void;
    const replacementPublished = new Promise<void>((resolve) => {
      observeReplacement = resolve;
    });
    const retireG1 = vi.fn(async (retired: ActivePluginGeneration<GenerationState>) => {
      retired.state.disposed = true;
    });
    const g2 = generation("g2");
    const replacement = coordinator.commit(g2, () => replacementDurable, retireG1);
    const waiting = Array.from({ length: 32 }, () =>
      coordinator.acquire("bundle-host-test"),
    );
    const predecessorRuns = predecessorLeases.map((lease) =>
      coordinator.runWithLease(lease, async () => {
        const before = projectionSnapshot(lease.generation);
        await replacementPublished;
        const nested = await coordinator.acquireExact("bundle-host-test", "g1");
        const after = projectionSnapshot(nested.generation);
        nested.release();
        return { before, after };
      }),
    );

    publishReplacement();
    const publishedReplacement = await replacement;
    observeReplacement();
    const predecessorResults = await Promise.all(predecessorRuns);
    expect(new Set(predecessorResults.flatMap(({ before, after }) => [before, after])))
      .toEqual(new Set(["g1|instruction:g1|hook:g1|mcp:g1|audit:g1|false"]));
    expect(retireG1).not.toHaveBeenCalled();
    for (const lease of predecessorLeases) lease.release();
    await publishedReplacement.retired;
    await publishedReplacement.markDispatchReady();
    const replacementLeases = await Promise.all(waiting);
    expect(new Set(replacementLeases.map((lease) => projectionSnapshot(lease.generation))))
      .toEqual(new Set(["g2|instruction:g2|hook:g2|mcp:g2|audit:g2|false"]));
    expect(retireG1).toHaveBeenCalledTimes(1);
    expect(g1.state.disposed).toBe(true);
    for (const lease of replacementLeases) lease.release();

    let commitDisable!: () => void;
    const disableDurable = new Promise<void>((resolve) => {
      commitDisable = resolve;
    });
    let observeDisable!: () => void;
    const disablePublished = new Promise<void>((resolve) => {
      observeDisable = resolve;
    });
    const retireG2 = vi.fn(async (retired: ActivePluginGeneration<GenerationState>) => {
      retired.state.disposed = true;
    });
    const activeDuringDisable = await Promise.all(
      Array.from({ length: 32 }, () => coordinator.acquire("bundle-host-test")),
    );
    const activeRuns = activeDuringDisable.map((lease) =>
      coordinator.runWithLease(lease, async () => {
        await disablePublished;
        return projectionSnapshot(lease.generation);
      }),
    );
    const disable = coordinator.commit(
      undefined,
      () => disableDurable,
      retireG2,
      "bundle-host-test",
    );
    const blockedAdmissions = Array.from({ length: 32 }, () =>
      coordinator.acquire("bundle-host-test"),
    );
    commitDisable();
    const publishedDisable = await disable;
    observeDisable();
    expect(new Set(await Promise.all(activeRuns)))
      .toEqual(new Set(["g2|instruction:g2|hook:g2|mcp:g2|audit:g2|false"]));
    const results = await Promise.allSettled(blockedAdmissions);
    expect(results.every(
      (result) =>
        result.status === "rejected" &&
        String(result.reason).includes("no active generation"),
    )).toBe(true);
    expect(coordinator.getActive("bundle-host-test")).toBeUndefined();
    expect(retireG2).not.toHaveBeenCalled();
    for (const lease of activeDuringDisable) lease.release();
    await publishedDisable.retired;
    expect(retireG2).toHaveBeenCalledTimes(1);
    expect(g2.state.disposed).toBe(true);
  });
});
