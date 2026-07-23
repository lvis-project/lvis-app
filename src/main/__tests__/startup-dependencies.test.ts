import { describe, expect, it, vi } from "vitest";
import { loadMainStartupDependencies } from "../startup-dependencies.js";

describe("loadMainStartupDependencies", () => {
  it("observes an immediate boot rejection while corporate CA setup is pending", async () => {
    const failure = new Error("boot chunk failed");
    let releaseCorporateCa!: () => void;
    const prepareCorporateCa = vi.fn(() => new Promise<void>((resolve) => {
      releaseCorporateCa = resolve;
    }));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const startup = loadMainStartupDependencies(
        () => Promise.reject(failure),
        prepareCorporateCa,
        vi.fn(),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(prepareCorporateCa).toHaveBeenCalledOnce();
      releaseCorporateCa();
      await expect(startup).rejects.toBe(failure);
    } finally {
      releaseCorporateCa?.();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("reports corporate CA readiness without waiting for a delayed boot module", async () => {
    let releaseBoot!: (value: { bootstrap: string }) => void;
    const loadBootModule = vi.fn(() => new Promise<{ bootstrap: string }>((resolve) => {
      releaseBoot = resolve;
    }));
    const onCorporateCaReady = vi.fn();
    const startup = loadMainStartupDependencies(
      loadBootModule,
      () => Promise.resolve(),
      onCorporateCaReady,
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onCorporateCaReady).toHaveBeenCalledOnce();
    releaseBoot({ bootstrap: "ready" });
    await expect(startup).resolves.toEqual({ bootstrap: "ready" });
  });
});
