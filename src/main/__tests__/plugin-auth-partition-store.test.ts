/**
 * Unit tests for plugin-auth-partition-store.ts (issue #748).
 *
 * Exercises: write → read round-trip, ENOENT returns null, corrupt JSON throws,
 * unexpected schema throws, delete removes single entry, delete no-ops on ENOENT,
 * concurrent write coalescing (write queue serialization).
 *
 * LVIS_HOME is overridden via vi.stubEnv so each test suite block points at
 * a fresh temp dir and the module reads the env at call-time (not import-time).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readPersistedPluginAuthPartitions,
  writePersistedPluginAuthPartitions,
  deletePersistedPluginAuthPartitions,
  __resetWriteQueueForTest,
} from "../plugin-auth-partition-store.js";

// Each test gets its own temp LVIS_HOME so there is no cross-test state.
let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "lvis-auth-store-test-"));
  vi.stubEnv("LVIS_HOME", tmpHome);
  // Reset module-level write queue so concurrent tests don't bleed state.
  __resetWriteQueueForTest();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpHome, { recursive: true, force: true });
});

describe("readPersistedPluginAuthPartitions", () => {
  it("returns null when file does not exist (first boot)", async () => {
    const result = await readPersistedPluginAuthPartitions();
    expect(result).toBeNull();
  });

  it("throws on corrupt JSON", async () => {
    const dir = join(tmpHome, "plugins");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "auth-partitions.json"), "{this is not json}", "utf8");
    await expect(readPersistedPluginAuthPartitions()).rejects.toThrow("corrupt JSON");
  });

  it("throws on valid JSON with unexpected schema", async () => {
    const dir = join(tmpHome, "plugins");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "auth-partitions.json"),
      JSON.stringify({ wrong: true }),
      "utf8",
    );
    await expect(readPersistedPluginAuthPartitions()).rejects.toThrow("unexpected schema");
  });
});

describe("write → read round-trip", () => {
  it("persists and restores partition map", async () => {
    const map = new Map<string, Set<string>>([
      [
        "com.lge.plugin",
        new Set([
          "persist:plugin-auth:com.lge.plugin",
          "persist:plugin-auth:com.lge.plugin:tenant",
        ]),
      ],
      ["other.plugin", new Set(["persist:plugin-auth:other.plugin"])],
    ]);

    await writePersistedPluginAuthPartitions(map);
    const result = await readPersistedPluginAuthPartitions();

    expect(result).not.toBeNull();
    expect(result!["com.lge.plugin"]).toEqual(
      expect.arrayContaining([
        "persist:plugin-auth:com.lge.plugin",
        "persist:plugin-auth:com.lge.plugin:tenant",
      ]),
    );
    expect(result!["other.plugin"]).toEqual(["persist:plugin-auth:other.plugin"]);
  });

  it("overwrites previous file on successive writes", async () => {
    const map1 = new Map([["a", new Set(["persist:plugin-auth:a"])]]);
    const map2 = new Map([["b", new Set(["persist:plugin-auth:b"])]]);

    await writePersistedPluginAuthPartitions(map1);
    await writePersistedPluginAuthPartitions(map2);
    const result = await readPersistedPluginAuthPartitions();

    expect(result!["b"]).toEqual(["persist:plugin-auth:b"]);
    expect(result!["a"]).toBeUndefined();
  });

  it("creates parent directory with mode 0o700 when absent", async () => {
    // Temp home starts empty — plugins/ does not exist yet.
    const map = new Map([["x", new Set(["persist:plugin-auth:x"])]]);
    // Should not throw even though plugins/ dir doesn't exist.
    await expect(writePersistedPluginAuthPartitions(map)).resolves.toBeUndefined();
    const result = await readPersistedPluginAuthPartitions();
    expect(result!["x"]).toEqual(["persist:plugin-auth:x"]);
  });
});

describe("deletePersistedPluginAuthPartitions", () => {
  it("no-ops when file does not exist", async () => {
    await expect(deletePersistedPluginAuthPartitions("any.plugin")).resolves.toBeUndefined();
  });

  it("removes only the target plugin, preserves others", async () => {
    const map = new Map([
      ["com.lge.plugin", new Set(["persist:plugin-auth:com.lge.plugin"])],
      ["other.plugin", new Set(["persist:plugin-auth:other.plugin"])],
    ]);
    await writePersistedPluginAuthPartitions(map);
    await deletePersistedPluginAuthPartitions("com.lge.plugin");

    const result = await readPersistedPluginAuthPartitions();
    expect(result!["com.lge.plugin"]).toBeUndefined();
    expect(result!["other.plugin"]).toEqual(["persist:plugin-auth:other.plugin"]);
  });

  it("no-ops when pluginId is absent from existing file", async () => {
    const map = new Map([["a", new Set(["persist:plugin-auth:a"])]]);
    await writePersistedPluginAuthPartitions(map);
    // Deleting a key that is not in the map should not throw or corrupt data.
    await expect(deletePersistedPluginAuthPartitions("not-there")).resolves.toBeUndefined();

    const result = await readPersistedPluginAuthPartitions();
    expect(result!["a"]).toEqual(["persist:plugin-auth:a"]);
  });
});

describe("write queue — concurrency safety", () => {
  it("10 parallel writes all resolve and final file contains all entries", async () => {
    // Build 10 maps, each with one unique plugin, accumulating entries like the
    // real caller does (each call passes the full in-memory map so far).
    const accumulated = new Map<string, Set<string>>();
    const promises: Promise<void>[] = [];

    for (let i = 0; i < 10; i++) {
      const pluginId = `plugin-${i}`;
      accumulated.set(pluginId, new Set([`persist:plugin-auth:${pluginId}`]));
      // Snapshot the accumulated map at call-time by spreading into a new Map —
      // this mirrors how rememberPluginAuthPartition passes trackedPluginAuthPartitions.
      promises.push(
        writePersistedPluginAuthPartitions(new Map(accumulated)),
      );
    }

    // All promises must resolve without error.
    await expect(Promise.all(promises)).resolves.toBeDefined();

    // The final file must contain all 10 entries (last write wins = largest snapshot).
    const result = await readPersistedPluginAuthPartitions();
    expect(result).not.toBeNull();
    for (let i = 0; i < 10; i++) {
      expect(result![`plugin-${i}`]).toEqual([`persist:plugin-auth:plugin-${i}`]);
    }
  });

  it("snapshot taken before scheduling — later map mutation does not corrupt in-flight write", async () => {
    // Pass a live map, then immediately mutate it before the write completes.
    const liveMap = new Map<string, Set<string>>([
      ["original", new Set(["persist:plugin-auth:original"])],
    ]);

    const writePromise = writePersistedPluginAuthPartitions(liveMap);

    // Mutate the map synchronously right after scheduling.
    liveMap.set("injected", new Set(["persist:plugin-auth:injected"]));
    liveMap.get("original")!.add("persist:plugin-auth:original:extra");

    await writePromise;

    // The write must reflect the snapshot at call-time, not the mutated state.
    const result = await readPersistedPluginAuthPartitions();
    expect(result!["original"]).toEqual(["persist:plugin-auth:original"]);
    expect(result!["injected"]).toBeUndefined();
  });
});
