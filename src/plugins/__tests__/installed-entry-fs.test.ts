import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tombstoneAndDeferredRemove, TOMBSTONE_SUBDIR } from "../installed-entry-fs.js";

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
    await rm(pluginsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("renames the install dir into +tombstones+/<id>-<ts>-<rand>", async () => {
    const tombstone = await tombstoneAndDeferredRemove(installedDir, pluginsRoot, {
      now: () => 1715000000000,
      randomSuffix: () => "deadbeef",
    });

    expect(tombstone).toBe(join(pluginsRoot, TOMBSTONE_SUBDIR, "local-indexer-1715000000000-deadbeef"));
    // Original dir is gone
    await expect(stat(installedDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the tombstone subdir if missing (idempotent on repeat)", async () => {
    await tombstoneAndDeferredRemove(installedDir, pluginsRoot, {
      now: () => 1,
      randomSuffix: () => "a",
    });
    // Repeat with another fresh dir to hit the existing subdir path
    const second = join(pluginsRoot, "second-plugin");
    await mkdir(second);
    await writeFile(join(second, "plugin.json"), "{}");
    const tombstone2 = await tombstoneAndDeferredRemove(second, pluginsRoot, {
      now: () => 2,
      randomSuffix: () => "b",
    });
    expect(tombstone2).toBe(join(pluginsRoot, TOMBSTONE_SUBDIR, "second-plugin-2-b"));
  });

  it("returns null when the install dir is already gone (ENOENT)", async () => {
    await rm(installedDir, { recursive: true, force: true });

    const result = await tombstoneAndDeferredRemove(installedDir, pluginsRoot);

    expect(result).toBeNull();
  });

  it("eventually rms the tombstone (deferred rm completes)", async () => {
    const tombstone = await tombstoneAndDeferredRemove(installedDir, pluginsRoot, {
      now: () => 9999,
      randomSuffix: () => "x",
    });
    expect(tombstone).not.toBeNull();

    // Wait briefly for the fire-and-forget rm to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const remainingInTombstones = await readdir(join(pluginsRoot, TOMBSTONE_SUBDIR));
    expect(remainingInTombstones).toEqual([]);
  });

  it("does not throw when the deferred rm callback is omitted", async () => {
    await expect(
      tombstoneAndDeferredRemove(installedDir, pluginsRoot, {
        now: () => 42,
        randomSuffix: () => "z",
      }),
    ).resolves.toMatch(/local-indexer-42-z$/);
  });

  const openHandleRenameIt = process.platform === "win32" ? it.skip : it;
  openHandleRenameIt("renames even with an open file handle inside on POSIX", async () => {
    // macOS/Linux allow rename of a directory with open child files.
    const fh = await open(join(installedDir, "data", "fts5.sqlite"), "r");
    try {
      const tombstone = await tombstoneAndDeferredRemove(installedDir, pluginsRoot, {
        now: () => 7,
        randomSuffix: () => "w",
      });
      expect(tombstone).toMatch(/local-indexer-7-w$/);
      // Original install dir is renamed away
      await expect(stat(installedDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fh.close();
    }
  });

  const windowsOpenHandleIt = process.platform === "win32" ? it : it.skip;
  windowsOpenHandleIt("surfaces EPERM when an open Windows handle blocks rename", async () => {
    const fh = await open(join(installedDir, "data", "fts5.sqlite"), "r");
    try {
      await expect(
        tombstoneAndDeferredRemove(installedDir, pluginsRoot, {
          now: () => 7,
          randomSuffix: () => "w",
        }),
      ).rejects.toMatchObject({ code: "EPERM" });
      await expect(stat(installedDir)).resolves.toBeTruthy();
    } finally {
      await fh.close();
    }
  });

  it("uses random suffix to avoid same-millisecond collision", async () => {
    // Two uninstalls of different dirs in the same ms — random suffix differs
    const second = join(pluginsRoot, "second-plugin");
    await mkdir(second);
    await writeFile(join(second, "plugin.json"), "{}");

    const t1 = await tombstoneAndDeferredRemove(installedDir, pluginsRoot, {
      now: () => 100,
      randomSuffix: () => "aaaa",
    });
    const t2 = await tombstoneAndDeferredRemove(second, pluginsRoot, {
      now: () => 100,
      randomSuffix: () => "bbbb",
    });
    expect(t1).not.toBe(t2);
    expect(t1).toMatch(/-100-aaaa$/);
    expect(t2).toMatch(/-100-bbbb$/);
  });
});
