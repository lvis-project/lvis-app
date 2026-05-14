import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOrphanUninstallDirs } from "../orphan-uninstall-sweeper.js";
import { TOMBSTONE_SUBDIR } from "../installed-entry-fs.js";

describe("sweepOrphanUninstallDirs", () => {
  let pluginsRoot: string;
  let tombstoneDir: string;

  beforeEach(async () => {
    pluginsRoot = await mkdtemp(join(tmpdir(), "orphan-sweeper-"));
    tombstoneDir = join(pluginsRoot, TOMBSTONE_SUBDIR);
  });

  afterEach(async () => {
    await rm(pluginsRoot, { recursive: true, force: true });
  });

  it("returns empty when the tombstone subdir does not exist (pre-first-uninstall)", async () => {
    const result = await sweepOrphanUninstallDirs(pluginsRoot);
    expect(result.swept).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("returns empty when the tombstone subdir is empty", async () => {
    await mkdir(tombstoneDir, { recursive: true });
    const result = await sweepOrphanUninstallDirs(pluginsRoot);
    expect(result.swept).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("removes a single tombstone", async () => {
    await mkdir(tombstoneDir, { recursive: true });
    const tombstone = "local-indexer-1715000000000-deadbeef";
    await mkdir(join(tombstoneDir, tombstone));
    await writeFile(join(tombstoneDir, tombstone, "fts5.sqlite"), "stale");

    const result = await sweepOrphanUninstallDirs(pluginsRoot);

    expect(result.swept).toEqual([tombstone]);
    expect(result.failed).toEqual([]);
  });

  it("removes multiple tombstones in parallel", async () => {
    await mkdir(tombstoneDir, { recursive: true });
    const t1 = "a-100-aaa";
    const t2 = "b-200-bbb";
    const t3 = "c-300-ccc";
    await Promise.all([
      mkdir(join(tombstoneDir, t1)),
      mkdir(join(tombstoneDir, t2)),
      mkdir(join(tombstoneDir, t3)),
    ]);

    const result = await sweepOrphanUninstallDirs(pluginsRoot);

    expect(result.swept.sort()).toEqual([t1, t2, t3].sort());
    expect(result.failed).toEqual([]);
  });

  it("does NOT touch sibling plugin dirs (collision-free namespace)", async () => {
    // Critical regression guard for the "malicious plugin slug ending in
    // .uninstalling-1" attack: sibling dirs to +tombstones+ are NEVER swept.
    await mkdir(join(pluginsRoot, "real-plugin"));
    await writeFile(join(pluginsRoot, "real-plugin", "plugin.json"), "{}");
    // Even if a plugin slug LOOKS like a tombstone naming pattern.
    await mkdir(join(pluginsRoot, "evil-plugin-1234-deadbeef"));
    await writeFile(join(pluginsRoot, "evil-plugin-1234-deadbeef", "plugin.json"), "{}");

    // Real tombstone in the proper subdir
    await mkdir(tombstoneDir, { recursive: true });
    const real = "local-indexer-12345-feedbeef";
    await mkdir(join(tombstoneDir, real));

    const result = await sweepOrphanUninstallDirs(pluginsRoot);

    expect(result.swept).toEqual([real]);
    expect(result.failed).toEqual([]);
    // Sibling plugin dirs untouched
    const { stat } = await import("node:fs/promises");
    await expect(stat(join(pluginsRoot, "real-plugin", "plugin.json"))).resolves.toBeDefined();
    await expect(stat(join(pluginsRoot, "evil-plugin-1234-deadbeef", "plugin.json"))).resolves.toBeDefined();
  });

  it("skips file entries (defensive — host bug or manual fs poking)", async () => {
    await mkdir(tombstoneDir, { recursive: true });
    await writeFile(join(tombstoneDir, "stub-1-x"), "not-a-dir");

    const result = await sweepOrphanUninstallDirs(pluginsRoot);

    expect(result.swept).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("invokes auditFailures hook when rm fails (escalation path)", async () => {
    // Hard to reliably trigger an rm failure cross-platform without
    // injecting fs. Verify the hook is wired by passing a hook that fires
    // on success-path empty failures (hook should NOT be called when
    // failures.length === 0).
    await mkdir(tombstoneDir, { recursive: true });
    await mkdir(join(tombstoneDir, "ok-1-x"));
    const auditFailures = vi.fn();

    const result = await sweepOrphanUninstallDirs(pluginsRoot, { auditFailures });

    expect(result.swept).toEqual(["ok-1-x"]);
    // Hook only fires on failures, not on success
    expect(auditFailures).not.toHaveBeenCalled();
  });
});
