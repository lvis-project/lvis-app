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
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSafeArtifactSlug, PluginArtifactStore } from "../plugin-artifact-store.js";
import type { MarketplaceFetcher } from "../marketplace-fetcher.js";

function makeStore(tmpDir: string): PluginArtifactStore {
  const fetcher = {
    listPlugins: async () => [],
    getPluginDetail: async () => null,
    downloadVersion: async () => ({ zipBuffer: Buffer.alloc(0), sha256: "x" }),
  } satisfies MarketplaceFetcher;
  return new PluginArtifactStore({
    installRoot: resolve(tmpDir, "installed"),
    cacheRoot: resolve(tmpDir, "cache"),
    fetcher,
    publicKeys: {},
    tarballCacheBase: null,
  });
}

function makeTmpDir(): string {
  const root = tmpdir();
  return mkdtempSync(join(root, "artifact-store-"));
}

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
        approvedPluginAccess: { plugins: [{ pluginId: "work-assistant", tools: ["task_list"] }] },
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
