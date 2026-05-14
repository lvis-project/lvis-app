import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOrphanUninstallDirs } from "../orphan-uninstall-sweeper.js";

describe("sweepOrphanUninstallDirs", () => {
  let pluginsRoot: string;

  beforeEach(async () => {
    pluginsRoot = await mkdtemp(join(tmpdir(), "orphan-sweeper-"));
  });

  afterEach(async () => {
    await rm(pluginsRoot, { recursive: true, force: true });
  });

  it("returns empty when pluginsRoot does not exist", async () => {
    const missing = join(pluginsRoot, "does-not-exist");
    const result = await sweepOrphanUninstallDirs(missing);
    expect(result.swept).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("returns empty when no tombstones present", async () => {
    await mkdir(join(pluginsRoot, "regular-plugin"));
    await writeFile(join(pluginsRoot, "regular-plugin", "plugin.json"), "{}");
    const result = await sweepOrphanUninstallDirs(pluginsRoot);
    expect(result.swept).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("removes a single tombstone", async () => {
    const tombstone = "local-indexer.uninstalling-1715000000000";
    await mkdir(join(pluginsRoot, tombstone));
    await writeFile(join(pluginsRoot, tombstone, "fts5.sqlite"), "stale");

    const result = await sweepOrphanUninstallDirs(pluginsRoot);

    expect(result.swept).toEqual([tombstone]);
    expect(result.failed).toEqual([]);
  });

  it("removes multiple tombstones independently", async () => {
    const t1 = "a.uninstalling-100";
    const t2 = "b.uninstalling-200";
    const t3 = "c.uninstalling-300";
    await Promise.all([
      mkdir(join(pluginsRoot, t1)),
      mkdir(join(pluginsRoot, t2)),
      mkdir(join(pluginsRoot, t3)),
    ]);

    const result = await sweepOrphanUninstallDirs(pluginsRoot);

    expect(result.swept.sort()).toEqual([t1, t2, t3].sort());
    expect(result.failed).toEqual([]);
  });

  it("ignores non-tombstone entries (regular plugin dirs and lookalikes)", async () => {
    await mkdir(join(pluginsRoot, "real-plugin"));
    // Lookalike: ends in .uninstalling but no digits after — must NOT match.
    await mkdir(join(pluginsRoot, "weird.uninstalling-"));
    // Lookalike: digits but no .uninstalling- prefix — must NOT match.
    await mkdir(join(pluginsRoot, "v2.0.1"));
    // Genuine tombstone among lookalikes.
    const real = "local-indexer.uninstalling-12345";
    await mkdir(join(pluginsRoot, real));

    const result = await sweepOrphanUninstallDirs(pluginsRoot);

    expect(result.swept).toEqual([real]);
    expect(result.failed).toEqual([]);
  });

  it("skips file entries that happen to match the pattern (defensive)", async () => {
    // A FILE (not directory) named like a tombstone — should not be touched
    // by directory-recursive cleanup. Regression-guard for an attacker or
    // odd state placing a regular file with the suffix.
    const lookalike = "stub.uninstalling-1";
    await writeFile(join(pluginsRoot, lookalike), "not-a-dir");

    const result = await sweepOrphanUninstallDirs(pluginsRoot);

    expect(result.swept).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});
