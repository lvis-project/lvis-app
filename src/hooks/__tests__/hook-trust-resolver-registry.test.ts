/**
 * Q12 P4 Area B — IPC trust-prompt resolver registry tests.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 6.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { hookTrustResolverRegistry } from "../hook-trust-resolver-registry.js";
import type { HookDiff } from "../hook-discovery.js";

function fakeDiff(fileName: string, state: HookDiff["state"] = "new"): HookDiff {
  return {
    hook: { path: `/x/${fileName}`, fileName, hookType: "pre", sha256: "abc", size: 0 },
    state,
  };
}

beforeEach(() => {
  hookTrustResolverRegistry.resetForTests();
});

describe("Q12 P4 hookTrustResolverRegistry", () => {
  it("acceptFiles resolves the pending promise with per-file decisions", async () => {
    const diff = [fakeDiff("pre-a.sh"), fakeDiff("pre-b.sh")];
    const { id, promise } = hookTrustResolverRegistry.registerRequest(diff);
    expect(hookTrustResolverRegistry.acceptFiles(id, ["pre-a.sh"])).toBe(true);
    const decisions = await promise;
    expect(decisions).toEqual([
      { fileName: "pre-a.sh", trust: true },
      { fileName: "pre-b.sh", trust: false },
    ]);
  });

  it("rejectAll resolves with all-untrusted", async () => {
    const diff = [fakeDiff("pre-a.sh"), fakeDiff("pre-b.sh")];
    const { id, promise } = hookTrustResolverRegistry.registerRequest(diff);
    expect(hookTrustResolverRegistry.rejectAll(id)).toBe(true);
    const decisions = await promise;
    expect(decisions.every((d) => d.trust === false)).toBe(true);
  });

  it("acceptFiles returns false for unknown id", () => {
    const diff = [fakeDiff("pre-a.sh")];
    const { promise } = hookTrustResolverRegistry.registerRequest(diff);
    promise.catch(() => undefined); // consume — afterEach reset will reject.
    expect(hookTrustResolverRegistry.acceptFiles("bogus-id", [])).toBe(false);
  });

  it("registerRequest supersedes any prior pending request", async () => {
    const first = hookTrustResolverRegistry.registerRequest([fakeDiff("pre-a.sh")]);
    const second = hookTrustResolverRegistry.registerRequest([fakeDiff("pre-b.sh")]);
    await expect(first.promise).rejects.toThrow(/superseded/);
    expect(hookTrustResolverRegistry.acceptFiles(second.id, ["pre-b.sh"])).toBe(true);
    await expect(second.promise).resolves.toEqual([
      { fileName: "pre-b.sh", trust: true },
    ]);
  });

  it("current() reports the live pending request for late-mount UIs", () => {
    const diff = [fakeDiff("pre-c.sh", "changed")];
    const { id, promise } = hookTrustResolverRegistry.registerRequest(diff);
    promise.catch(() => undefined); // afterEach reset rejects.
    const view = hookTrustResolverRegistry.current();
    expect(view).not.toBeNull();
    expect(view!.id).toBe(id);
    expect(view!.files[0]).toMatchObject({
      fileName: "pre-c.sh",
      state: "changed",
    });
  });

  it("current() returns null when nothing pending", () => {
    expect(hookTrustResolverRegistry.current()).toBeNull();
  });
});
