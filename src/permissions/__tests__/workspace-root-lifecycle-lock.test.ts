import { describe, expect, it, vi } from "vitest";

import { withWorkspaceRootLifecycleLock } from "../workspace-root-lifecycle-lock.js";

describe("workspace root lifecycle lock", () => {
  it("serializes parent removal with a concurrently requested child addition", async () => {
    let releaseParent!: () => void;
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    const childStarted = vi.fn();

    const parent = withWorkspaceRootLifecycleLock("/workspace/parent", async () => {
      await parentGate;
      return "parent";
    });
    const child = withWorkspaceRootLifecycleLock("/workspace/parent/child", async () => {
      childStarted();
      return "child";
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(childStarted).not.toHaveBeenCalled();

    releaseParent();
    await expect(Promise.all([parent, child])).resolves.toEqual(["parent", "child"]);
    expect(childStarted).toHaveBeenCalledTimes(1);
  });

  it("continues the queue after a failed operation", async () => {
    const failure = withWorkspaceRootLifecycleLock("/workspace/a", async () => {
      throw new Error("expected failure");
    });
    const successor = withWorkspaceRootLifecycleLock("/workspace/b", async () => "ok");

    await expect(failure).rejects.toThrow("expected failure");
    await expect(successor).resolves.toBe("ok");
  });
});
