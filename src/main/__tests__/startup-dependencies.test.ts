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
      );
      await expect(startup).rejects.toBe(failure);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(prepareCorporateCa).toHaveBeenCalledOnce();
    } finally {
      releaseCorporateCa?.();
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
