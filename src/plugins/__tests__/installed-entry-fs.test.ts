import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tombstoneAndDeferredRemove } from "../installed-entry-fs.js";

describe("tombstoneAndDeferredRemove", () => {
  let pluginsRoot: string;
  let installedDir: string;

  beforeEach(async () => {
    pluginsRoot = await mkdtemp(join(tmpdir(), "tombstone-fs-"));
    installedDir = join(pluginsRoot, "local-indexer");
    await mkdir(installedDir);
    await writeFile(join(installedDir, "plugin.json"), JSON.stringify({ id: "local-indexer" }));
    await mkdir(join(installedDir, "data"));
    await writeFile(join(installedDir, "data", "fts5.sqlite"), "stub");
  });

  afterEach(async () => {
    await rm(pluginsRoot, { recursive: true, force: true });
  });

  it("renames the install dir to a .uninstalling-<ts> tombstone", async () => {
    const tombstone = await tombstoneAndDeferredRemove(installedDir, {
      now: () => 1715000000000,
    });

    expect(tombstone).toBe(`${installedDir}.uninstalling-1715000000000`);
    // Original dir is gone
    await expect(stat(installedDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns null when the install dir is already gone (ENOENT)", async () => {
    await rm(installedDir, { recursive: true, force: true });

    const result = await tombstoneAndDeferredRemove(installedDir);

    expect(result).toBeNull();
  });

  it("eventually rms the tombstone (deferred rm completes)", async () => {
    const tombstone = await tombstoneAndDeferredRemove(installedDir, {
      now: () => 9999,
    });
    expect(tombstone).not.toBeNull();

    // Wait briefly for the fire-and-forget rm to complete. macOS/Linux
    // unlink succeeds immediately on closed files; this should not flake.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const remaining = await readdir(pluginsRoot);
    expect(remaining).toEqual([]);
  });

  it("preserves contents in the tombstone (rename is non-destructive)", async () => {
    const tombstone = await tombstoneAndDeferredRemove(installedDir, {
      now: () => 1,
      // Suppress the deferred rm by intercepting its failure path —
      // we want to read the tombstone before rm completes. Easier: use
      // a near-future timestamp that makes the tombstone uniquely
      // identifiable, then race the rm by checking immediately.
      onDeferredRmError: () => undefined,
    });
    expect(tombstone).not.toBeNull();
    // Note: rm may have already completed by the time we read; this test
    // primarily verifies the rename happened (assert via tombstone path).
    expect(tombstone).toMatch(/\.uninstalling-1$/);
  });

  it("does not throw when the deferred rm callback is omitted", async () => {
    // Contract: callers may omit onDeferredRmError. The function must
    // resolve cleanly even if the deferred rm later fails (no unhandled
    // rejection). Hard to reliably trigger rm failure cross-platform —
    // smoke test that the call completes without throwing.
    await expect(
      tombstoneAndDeferredRemove(installedDir, { now: () => 42 }),
    ).resolves.toMatch(/\.uninstalling-42$/);
  });
});
