/**
 * Phase 2 §FU#267 — PluginArtifactStore extracted from marketplace.ts.
 *
 * The store owns history journal + version cache + zip extract atomicity.
 * These tests lock the public contract that the orchestrator (and the
 * future MCP install consumer #259) relies on:
 *
 *   - history journal append + read round-trip
 *   - findRollbackTarget skips current version, skips entries without a
 *     cached manifest, returns null when nothing is replayable
 *   - cacheVersionFromManifest is best-effort (no throw on missing source)
 *
 * Download + extract paths are exercised by the existing `marketplace-
 * installer.test.ts` and the orchestrator's integration tests; here we
 * focus on the journaling primitives that previously lived in the god
 * class with no direct coverage.
 */
import AdmZip from "adm-zip";
import { describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ArtifactRollbackError, assertSafeArtifactSlug } from "../plugin-artifact-store.js";
import { TOMBSTONE_SUBDIR } from "../installed-entry-fs.js";
import * as installedEntryFs from "../installed-entry-fs.js";
import { makeStore, makeTmpDir } from "./artifact-store-test-helpers.js";

describe("PluginArtifactStore — history journal", () => {
  it("appendHistory + readHistory round-trip preserves order", async () => {
    const tmp = makeTmpDir();
    try {
      await mkdir(tmp, { recursive: true });
      const store = makeStore(tmp);
      await store.appendHistory("acme", { version: "1.0.0", installedAt: "2026-04-01" });
      await store.appendHistory("acme", { version: "1.0.1", installedAt: "2026-04-02" });
      await store.appendHistory("acme", { version: "2.0.0", installedAt: "2026-04-03" });
      const history = await store.readHistory("acme");
      expect(history.map((e) => e.version)).toEqual(["1.0.0", "1.0.1", "2.0.0"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("readHistory returns [] when history.json is absent", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const history = await store.readHistory("never-installed");
      expect(history).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("PluginArtifactStore — findRollbackTarget", () => {
  it("returns null when history is empty", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      expect(await store.findRollbackTarget("acme")).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns the most recent prior version with a cached manifest", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      await store.appendHistory("acme", { version: "1.0.0", installedAt: "2026-04-01" });
      await store.appendHistory("acme", { version: "1.0.1", installedAt: "2026-04-02" });
      await store.appendHistory("acme", { version: "2.0.0", installedAt: "2026-04-03" });

      // Cache manifests for 1.0.0 and 1.0.1 only — 2.0.0 is the current
      // (no snapshot yet) and 1.0.1 is the rollback target.
      for (const version of ["1.0.0", "1.0.1"]) {
        const dir = resolve(tmp, "cache", "acme", version);
        await mkdir(dir, { recursive: true });
        await writeFile(
          resolve(dir, "plugin.json"),
          JSON.stringify({ id: "acme", version, name: "acme", entry: "x" }),
        );
      }
      const target = await store.findRollbackTarget("acme", "2.0.0");
      expect(target).toBe("1.0.1");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips the current version even if it's the newest history entry", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      await store.appendHistory("acme", { version: "1.0.0", installedAt: "2026-04-01" });
      await store.appendHistory("acme", { version: "2.0.0", installedAt: "2026-04-02" });
      for (const version of ["1.0.0", "2.0.0"]) {
        const dir = resolve(tmp, "cache", "acme", version);
        await mkdir(dir, { recursive: true });
        await writeFile(
          resolve(dir, "plugin.json"),
          JSON.stringify({ id: "acme", version, name: "acme", entry: "x" }),
        );
      }
      // Pretend 2.0.0 is current — should pick 1.0.0.
      expect(await store.findRollbackTarget("acme", "2.0.0")).toBe("1.0.0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips history entries without a cached manifest on disk", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      await store.appendHistory("acme", { version: "1.0.0", installedAt: "2026-04-01" });
      await store.appendHistory("acme", { version: "1.0.1", installedAt: "2026-04-02" });
      // Only cache 1.0.0 — 1.0.1 history entry exists but has no manifest snapshot.
      const dir = resolve(tmp, "cache", "acme", "1.0.0");
      await mkdir(dir, { recursive: true });
      await writeFile(
        resolve(dir, "plugin.json"),
        JSON.stringify({ id: "acme", version: "1.0.0", name: "acme", entry: "x" }),
      );
      // Current is 2.0.0 (not in history) — rollback skips 1.0.1 (missing
      // snapshot) and returns 1.0.0.
      expect(await store.findRollbackTarget("acme", "2.0.0")).toBe("1.0.0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips empty / whitespace history versions (PR#44 Copilot guard)", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      await store.appendHistory("acme", { version: "", installedAt: "2026-04-01" });
      await store.appendHistory("acme", { version: "  ", installedAt: "2026-04-02" });
      await store.appendHistory("acme", { version: "1.0.0", installedAt: "2026-04-03" });
      const dir = resolve(tmp, "cache", "acme", "1.0.0");
      await mkdir(dir, { recursive: true });
      await writeFile(
        resolve(dir, "plugin.json"),
        JSON.stringify({ id: "acme", version: "1.0.0", name: "acme", entry: "x" }),
      );
      expect(await store.findRollbackTarget("acme", "2.0.0")).toBe("1.0.0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("PluginArtifactStore — installDirFor", () => {
  it("anchors install dirs under installRoot", () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const dir = store.installDirFor("acme");
      expect(dir).toBe(resolve(tmp, "installed", "acme"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects slugs that could escape the install root", () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      for (const slug of ["../evil", "/tmp/evil", "evil/path", ".hidden", "bad:slug", ""]) {
        expect(() => store.installDirFor(slug)).toThrow(/invalid artifact slug/);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("PluginArtifactStore — extractZip", () => {
  it("rejects unsafe slugs before staging zip contents", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify({ id: "evil" })));
      await expect(store.extractZip("../evil", zip.toBuffer())).rejects.toThrow(
        /invalid artifact slug/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("restores the prior install dir when commit fails after promotion", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const installDir = store.installDirFor("acme");
      await mkdir(installDir, { recursive: true });
      await writeFile(resolve(installDir, "plugin.json"), JSON.stringify({ id: "acme", version: "old" }));

      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify({ id: "acme", version: "new" })));

      await expect(
        store.extractZipWithCommit("acme", zip.toBuffer(), async () => {
          throw new Error("config registration failed");
        }),
      ).rejects.toThrow(/config registration failed/);

      const restored = JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8"));
      expect(restored.version).toBe("old");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects compressed bytes above the configured ceiling before staging", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp, { artifactLimits: { maxCompressedBytes: 4 } });
      await expect(store.extractZip("acme", Buffer.alloc(5))).rejects.toMatchObject({
        code: "ARTIFACT_TOO_LARGE",
      });
      expect(existsSync(resolve(tmp, "installed"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects too many zip entries and removes the stage directory", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp, { artifactLimits: { maxEntryCount: 1 } });
      const zip = new AdmZip();
      zip.addFile("one.txt", Buffer.from("1"));
      zip.addFile("two.txt", Buffer.from("2"));
      await expect(store.extractZip("acme", zip.toBuffer())).rejects.toMatchObject({
        code: "ARCHIVE_ENTRY_LIMIT_EXCEEDED",
      });
      const entries = existsSync(resolve(tmp, "installed"))
        ? await readdir(resolve(tmp, "installed"))
        : [];
      expect(entries.filter((name) => name.includes(".stage-"))).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects an excessive declared entry count before enumerating central-directory entries", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp, { artifactLimits: { maxEntryCount: 1 } });
      const zip = new AdmZip().toBuffer();
      const endOfCentralDirectoryOffset = zip.byteLength - 22;
      zip.writeUInt16LE(2, endOfCentralDirectoryOffset + 8);
      zip.writeUInt16LE(2, endOfCentralDirectoryOffset + 10);

      await expect(store.extractZip("acme", zip)).rejects.toMatchObject({
        code: "ARCHIVE_ENTRY_LIMIT_EXCEEDED",
      });
      const entries = existsSync(resolve(tmp, "installed"))
        ? await readdir(resolve(tmp, "installed"))
        : [];
      expect(entries.filter((name) => name.includes(".stage-"))).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a real high-compression archive before inflating the entry", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp, {
        artifactLimits: { maxCompressionRatio: 10 },
      });
      const zip = new AdmZip();
      zip.addFile("bomb.bin", Buffer.alloc(1024 * 1024));
      const zipBuffer = zip.toBuffer();
      expect(zipBuffer.byteLength).toBeLessThan(16 * 1024);

      await expect(store.extractZip("acme", zipBuffer)).rejects.toMatchObject({
        code: "ARCHIVE_COMPRESSION_RATIO_EXCEEDED",
      });
      expect(existsSync(resolve(tmp, "installed", "acme"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("enforces individual and aggregate uncompressed entry ceilings", async () => {
    const tmp = makeTmpDir();
    try {
      const individualStore = makeStore(tmp, {
        artifactLimits: { maxEntryUncompressedBytes: 2 },
      });
      const individualZip = new AdmZip();
      individualZip.addFile("large.txt", Buffer.from("123"));
      await expect(individualStore.extractZip("acme", individualZip.toBuffer()))
        .rejects.toMatchObject({ code: "ARCHIVE_ENTRY_TOO_LARGE" });

      const aggregateStore = makeStore(tmp, {
        artifactLimits: { maxEntryUncompressedBytes: 2, maxTotalUncompressedBytes: 3 },
      });
      const aggregateZip = new AdmZip();
      aggregateZip.addFile("one.txt", Buffer.from("12"));
      aggregateZip.addFile("two.txt", Buffer.from("34"));
      await expect(aggregateStore.extractZip("acme", aggregateZip.toBuffer()))
        .rejects.toMatchObject({ code: "ARCHIVE_UNCOMPRESSED_TOO_LARGE" });
      const entries = existsSync(resolve(tmp, "installed"))
        ? await readdir(resolve(tmp, "installed"))
        : [];
      expect(entries.filter((name) => name.includes(".stage-"))).toEqual([]);
      expect(existsSync(resolve(tmp, "installed", "acme"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("allows zip counts and uncompressed bytes exactly at their boundaries", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp, {
        artifactLimits: {
          maxEntryCount: 2,
          maxEntryUncompressedBytes: 2,
          maxTotalUncompressedBytes: 4,
        },
      });
      const zip = new AdmZip();
      zip.addFile("one.txt", Buffer.from("12"));
      zip.addFile("two.txt", Buffer.from("34"));
      await expect(store.extractZip("acme", zip.toBuffer())).resolves.toEqual([
        "one.txt",
        "two.txt",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "surfaces persistent promoted-directory cleanup failure and retains the old backup",
    async () => {
      const tmp = makeTmpDir();
      const installRoot = resolve(tmp, "installed");
      try {
        const store = makeStore(tmp);
        const installDir = store.installDirFor("acme");
        await mkdir(installDir, { recursive: true });
        await writeFile(resolve(installDir, "plugin.json"), JSON.stringify({ id: "acme", version: "old" }));
        const zip = new AdmZip();
        zip.addFile("plugin.json", Buffer.from(JSON.stringify({ id: "acme", version: "new" })));
        const commitError = new Error("registry publication failed");

        const error = await store.extractZipWithCommit("acme", zip.toBuffer(), async () => {
          await chmod(installRoot, 0o500);
          throw commitError;
        }).catch((caught) => caught);
        await chmod(installRoot, 0o700);

        expect(error).toBeInstanceOf(ArtifactRollbackError);
        expect((error as ArtifactRollbackError).errors[0]).toBe(commitError);
        expect((error as ArtifactRollbackError).errors[1]).toMatchObject({ code: expect.stringMatching(/EACCES|EPERM/) });
        expect((error as ArtifactRollbackError).backupDir).toBeTruthy();
        expect(existsSync((error as ArtifactRollbackError).backupDir!)).toBe(true);
        expect(JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8")).version).toBe("new");
      } finally {
        await chmod(installRoot, 0o700).catch(() => undefined);
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it.runIf(process.platform !== "win32")(
    "routes a committed old directory through the tombstone lifecycle when bounded cleanup fails",
    async () => {
      const tmp = makeTmpDir();
      const installRoot = resolve(tmp, "installed");
      try {
        const store = makeStore(tmp);
        vi.spyOn(
          store as unknown as { removeCommittedBackup: (path: string) => Promise<void> },
          "removeCommittedBackup",
        ).mockRejectedValue(Object.assign(new Error("persistent cleanup lock"), { code: "EACCES" }));
        const originalTombstone = installedEntryFs.tombstoneAndDeferredRemove;
        vi.spyOn(installedEntryFs, "tombstoneAndDeferredRemove").mockImplementation(
          (path, root, options) => originalTombstone(path, root, { ...options, deferRemoval: false }),
        );
        const installDir = store.installDirFor("acme");
        await mkdir(installDir, { recursive: true });
        await writeFile(resolve(installDir, "plugin.json"), JSON.stringify({ id: "acme", version: "old" }));
        const zip = new AdmZip();
        zip.addFile("plugin.json", Buffer.from(JSON.stringify({ id: "acme", version: "new" })));

        await store.extractZipWithCommit("acme", zip.toBuffer(), async () => undefined);

        const tombstoneDir = resolve(installRoot, TOMBSTONE_SUBDIR);
        const tombstones = await readdir(tombstoneDir);
        expect(tombstones).toHaveLength(1);
        expect(tombstones[0]).toMatch(/^\.acme\.old-/);
      } finally {
        await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
    10_000,
  );
});

describe("PluginArtifactStore — process-wide artifact resource slot", () => {
  it("serializes full artifact lifetimes across independent stores", async () => {
    const firstTmp = makeTmpDir("artifact-store-slot-a-");
    const secondTmp = makeTmpDir("artifact-store-slot-b-");
    try {
      const firstStore = makeStore(firstTmp);
      const secondStore = makeStore(secondTmp);
      let releaseFirst!: () => void;
      let firstEntered = false;
      let secondEntered = false;
      const firstBlocked = new Promise<void>((resolvePromise) => {
        releaseFirst = resolvePromise;
      });

      const first = firstStore.withArtifactResourceSlot(async () => {
        firstEntered = true;
        await firstBlocked;
        return "first";
      });
      await vi.waitFor(() => expect(firstEntered).toBe(true));

      const second = secondStore.withArtifactResourceSlot(async () => {
        secondEntered = true;
        return "second";
      });
      await Promise.resolve();
      expect(secondEntered).toBe(false);

      releaseFirst();
      await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
      expect(secondEntered).toBe(true);
    } finally {
      rmSync(firstTmp, { recursive: true, force: true });
      rmSync(secondTmp, { recursive: true, force: true });
    }
  });
});

describe("assertSafeArtifactSlug", () => {
  it("accepts marketplace-safe slugs", () => {
    expect(assertSafeArtifactSlug("browser-use_mcp.1")).toBe("browser-use_mcp.1");
  });
});

describe("PluginArtifactStore — cacheVersionFromManifest", () => {
  it("snapshots the manifest under cacheRoot/<slug>/<version>/", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const sourceManifest = resolve(tmp, "live", "plugin.json");
      await mkdir(resolve(tmp, "live"), { recursive: true });
      await writeFile(
        sourceManifest,
        JSON.stringify({ id: "acme", version: "1.2.3", name: "acme", entry: "x" }),
      );
      await store.cacheVersionFromManifest("acme", sourceManifest);
      const cached = resolve(tmp, "cache", "acme", "1.2.3", "plugin.json");
      const { readFile: read } = await import("node:fs/promises");
      const raw = await read(cached, "utf-8");
      expect(JSON.parse(raw)).toMatchObject({ id: "acme", version: "1.2.3" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("snapshots registry metadata next to the cached manifest", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const sourceManifest = resolve(tmp, "live", "plugin.json");
      await mkdir(resolve(tmp, "live"), { recursive: true });
      await writeFile(
        sourceManifest,
        JSON.stringify({ id: "acme", version: "1.2.3", name: "acme", entry: "x" }),
      );

      await store.cacheVersionFromManifest("acme", sourceManifest, {
        installSource: "admin",
        bundleRefs: ["work-assistant"],
        approvedPluginAccess: { plugins: [{ pluginId: "work-assistant", tools: ["task_list"] }] },
      });

      const snapshot = await store.readCachedRegistryEntrySnapshot("acme", "1.2.3");
      expect(snapshot).toEqual({
        installSource: "admin",
        bundleRefs: ["work-assistant"],
        approvedPluginAccess: { plugins: [{ pluginId: "work-assistant" }] },
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null when a cached registry metadata snapshot is absent", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      expect(await store.readCachedRegistryEntrySnapshot("acme", "1.2.3")).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is best-effort: missing source manifest does not throw", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      await expect(
        store.cacheVersionFromManifest("acme", resolve(tmp, "does-not-exist.json")),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
