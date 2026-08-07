/**
 * The teardown helper the artifact-store suites rely on.
 *
 * These suites tore down with a bare `rmSync(tmp, {recursive, force})` in a
 * `finally`. On Windows that is not safe: a scanner or the shell indexer can
 * still hold a handle inside the tree when the last assertion has already
 * passed, and `rm` fails `ENOTEMPTY`. The test is then reported as failed for a
 * teardown that ran after it did its job — and because it needs a real handle
 * race to reproduce, it only shows up in full-suite runs, which is what makes
 * it read as flake rather than as a fixable defect.
 *
 * The first test below is the one that can actually fail: without the retry it
 * throws on the injected `ENOTEMPTY`.
 */
import { describe, expect, it, vi } from "vitest";

const rm = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  rm,
}));

const { cleanupTmpDir } = await import("./artifact-store-test-helpers.js");

describe("cleanupTmpDir", () => {
  it("survives a transient ENOTEMPTY and retries until the directory goes", async () => {
    rm.mockReset();
    rm.mockRejectedValueOnce(Object.assign(new Error("Directory not empty"), { code: "ENOTEMPTY" }));
    rm.mockResolvedValueOnce(undefined);

    await expect(cleanupTmpDir("C:/nowhere/scratch")).resolves.toBeUndefined();
    expect(rm).toHaveBeenCalledTimes(2);
  });

  it("removes the directory recursively and forcibly", async () => {
    rm.mockReset();
    rm.mockResolvedValue(undefined);

    await cleanupTmpDir("C:/nowhere/scratch");

    expect(rm).toHaveBeenCalledWith("C:/nowhere/scratch", { recursive: true, force: true });
  });

  // ENOENT is deliberately outside the retried set — an absent directory is a
  // real signal, not lock contention, and swallowing it here would hide a
  // fixture that never created its scratch dir at all.
  it("propagates a non-lock error instead of retrying it", async () => {
    rm.mockReset();
    rm.mockRejectedValue(Object.assign(new Error("nope"), { code: "ENOENT" }));

    await expect(cleanupTmpDir("C:/nowhere/scratch")).rejects.toThrow(/nope/);
    expect(rm).toHaveBeenCalledTimes(1);
  });

});
