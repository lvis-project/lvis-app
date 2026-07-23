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
  it("rejects archive symlink members before extraction", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const zip = new AdmZip();
      zip.addFile("link", Buffer.from("outside"));
      const entry = zip.getEntry("link");
      if (!entry) throw new Error("test fixture entry missing");
      entry.attr = (0o120777 << 16) >>> 0;
      await expect(store.extractZip("acme", zip.toBuffer())).rejects.toThrow(/unsupported member kind/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects case-colliding archive members", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const zip = new AdmZip();
      zip.addFile("Hooks/a.json", Buffer.from("one"));
      zip.addFile("hooks/A.json", Buffer.from("two"));
      await expect(store.extractZip("acme", zip.toBuffer())).rejects.toThrow(/colliding entry/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

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

  it("leaves the live payload untouched when staged candidate preparation fails", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const installDir = store.installDirFor("acme");
      await mkdir(installDir, { recursive: true });
      await writeFile(resolve(installDir, "plugin.json"), JSON.stringify({ id: "acme", version: "old" }));
      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify({ id: "acme", version: "new" })));
      const durableCommit = vi.fn(async () => undefined);

      await expect(store.extractZipWithCommit("acme", zip.toBuffer(), durableCommit, {
        coordinateCommit: async () => {
          throw new Error("candidate import failed");
        },
      })).rejects.toThrow("candidate import failed");

      expect(durableCommit).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf8")).version).toBe("old");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("retains the predecessor backup until coordinated generation retirement settles", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const installRoot = resolve(tmp, "installed");
      const installDir = store.installDirFor("acme");
      await mkdir(installDir, { recursive: true });
      await writeFile(resolve(installDir, "plugin.json"), JSON.stringify({ id: "acme", version: "old" }));
      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify({ id: "acme", version: "new" })));
      let releaseRetirement!: () => void;
      const retirement = new Promise<void>((resolveRetirement) => { releaseRetirement = resolveRetirement; });
      let durableFinished!: () => void;
      const durableFinishedPromise = new Promise<void>((resolveDurable) => { durableFinished = resolveDurable; });

      const installing = store.extractZipWithCommit("acme", zip.toBuffer(), async () => {
        durableFinished();
        return "committed";
      }, {
        coordinateCommit: async ({ durableCommit }) => ({
          result: await durableCommit(),
          retirement,
        }),
      });
      await durableFinishedPromise;
      const backupBeforeDrain = (await readdir(installRoot)).filter((name) => name.startsWith(".acme.old-"));
      expect(backupBeforeDrain).toHaveLength(1);
      let installSettled = false;
      void installing.finally(() => { installSettled = true; });
      await Promise.resolve();
      expect(installSettled).toBe(false);

      releaseRetirement();
      await expect(installing).resolves.toMatchObject({ result: "committed", predecessorRetired: true });
      expect((await readdir(installRoot)).filter((name) => name.startsWith(".acme.old-"))).toEqual([]);
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
