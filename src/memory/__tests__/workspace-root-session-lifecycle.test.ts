import { describe, expect, it, vi } from "vitest";
import { detachWorkspaceRootSessions } from "../workspace-root-session-lifecycle.js";

describe("detachWorkspaceRootSessions", () => {
  it("awaits every durable namespace and de-duplicates stores", async () => {
    const first = { detachSessionsFromProject: vi.fn(async () => 2) };
    const second = { detachSessionsFromProject: vi.fn(async () => 3) };
    await expect(detachWorkspaceRootSessions("C:\\work\\alpha", [first, second, first]))
      .resolves.toBe(5);
    expect(first.detachSessionsFromProject).toHaveBeenCalledTimes(1);
    expect(second.detachSessionsFromProject).toHaveBeenCalledTimes(1);
  });

  it("fails closed and releases root-wide guards when any namespace cannot detach", async () => {
    const allowFirst = vi.fn();
    const allowSecond = vi.fn();
    const first = {
      allowProjectRoot: allowFirst,
      detachSessionsFromProject: vi.fn(async () => 1),
    };
    const second = {
      allowProjectRoot: allowSecond,
      detachSessionsFromProject: vi.fn(async () => {
        throw Object.assign(new Error("private"), { code: "EIO" });
      }),
    };
    await expect(detachWorkspaceRootSessions("C:\\work\\alpha", [first, second]))
      .rejects.toMatchObject({ code: "EIO" });
    expect(allowFirst).toHaveBeenCalledWith("C:\\work\\alpha");
    expect(allowSecond).toHaveBeenCalledWith("C:\\work\\alpha");
  });

  it.each([
    [{}, "MEMORY_DETACH_UNAVAILABLE"],
    [{ detachSessionsFromProject: async () => Number.NaN }, "MEMORY_DETACH_INVALID_RESULT"],
  ] as const)("rejects an incomplete metadata store", async (store, code) => {
    await expect(detachWorkspaceRootSessions("C:\\work\\alpha", [store]))
      .rejects.toMatchObject({ code });
  });
});
