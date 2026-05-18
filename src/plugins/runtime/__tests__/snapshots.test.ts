/**
 * Tests for readEnabledManifestSnapshots — edge cases.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnabledManifestSnapshots, resolveManifestLoadPlan } from "../snapshots.js";
import { buildManifestValidator } from "../manifest-validation.js";

let validator: Awaited<ReturnType<typeof buildManifestValidator>>;

beforeAll(async () => {
  validator = await buildManifestValidator();
});

const VALID_MANIFEST = {
  id: "snap-test",
  name: "Snap",
  version: "1.0.0",
  entry: "dist/index.js",
  tools: ["snap_ping"],
  description: "Snapshot test plugin",
  publisher: "Test",
};

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "snap-test-"));
}

describe("readEnabledManifestSnapshots", () => {
  it("returns empty map when all plans are disabled", async () => {
    const result = await readEnabledManifestSnapshots(
      [{ manifestPath: "/nonexistent/plugin.json", enabled: false }],
      validator,
    );
    expect(result.size).toBe(0);
  });

  it("returns empty map for empty plan", async () => {
    const result = await readEnabledManifestSnapshots([], validator);
    expect(result.size).toBe(0);
  });

  it("reads a valid manifest and keys by pluginIdHint", async () => {
    const dir = await makeTempDir();
    try {
      const manifestPath = join(dir, "plugin.json");
      await writeFile(manifestPath, JSON.stringify(VALID_MANIFEST), "utf-8");

      const result = await readEnabledManifestSnapshots(
        [{ manifestPath, enabled: true, pluginIdHint: "override-id" }],
        validator,
      );
      expect(result.has("override-id")).toBe(true);
      expect(result.get("override-id")?.manifest.id).toBe("snap-test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to manifest.id when no pluginIdHint", async () => {
    const dir = await makeTempDir();
    try {
      const manifestPath = join(dir, "plugin.json");
      await writeFile(manifestPath, JSON.stringify(VALID_MANIFEST), "utf-8");

      const result = await readEnabledManifestSnapshots(
        [{ manifestPath, enabled: true }],
        validator,
      );
      expect(result.has("snap-test")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips entries with invalid manifests and continues with valid ones", async () => {
    const dir = await makeTempDir();
    try {
      const badPath = join(dir, "bad-plugin.json");
      const goodPath = join(dir, "good-plugin.json");
      await writeFile(badPath, "{ not json", "utf-8");
      await writeFile(goodPath, JSON.stringify(VALID_MANIFEST), "utf-8");

      const result = await readEnabledManifestSnapshots(
        [
          { manifestPath: badPath, enabled: true, pluginIdHint: "bad-plugin" },
          { manifestPath: goodPath, enabled: true, pluginIdHint: "good-plugin" },
        ],
        validator,
      );
      expect(result.has("bad-plugin")).toBe(false);
      expect(result.has("good-plugin")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips missing manifest files with a warning", async () => {
    const result = await readEnabledManifestSnapshots(
      [{ manifestPath: "/tmp/does-not-exist/plugin.json", enabled: true, pluginIdHint: "missing" }],
      validator,
    );
    expect(result.has("missing")).toBe(false);
  });

  it("preserves approvedPluginAccess from the plan", async () => {
    const dir = await makeTempDir();
    try {
      const manifestPath = join(dir, "plugin.json");
      await writeFile(manifestPath, JSON.stringify(VALID_MANIFEST), "utf-8");
      const access = { plugins: [{ pluginId: "other-test", tools: ["other_ping"] }] };

      const result = await readEnabledManifestSnapshots(
        [{ manifestPath, enabled: true, approvedPluginAccess: access as never }],
        validator,
      );
      const snap = result.get("snap-test");
      expect(snap?.approvedPluginAccess).toEqual(access);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveManifestLoadPlan — manifestPaths only", () => {
  it("returns plans for each provided manifest path", async () => {
    const plans = await resolveManifestLoadPlan({
      manifestPaths: ["/a/plugin.json", "/b/plugin.json"],
    });
    expect(plans).toHaveLength(2);
    expect(plans[0]).toEqual({ manifestPath: "/a/plugin.json", enabled: true });
    expect(plans[1]).toEqual({ manifestPath: "/b/plugin.json", enabled: true });
  });

  it("throws when both manifestPaths and registryPath are absent", async () => {
    await expect(
      resolveManifestLoadPlan({ manifestPaths: [] }),
    ).rejects.toThrow("Either manifestPaths or registryPath must be provided");
  });
});

describe("resolveManifestLoadPlan — registry", () => {
  it("reads enabled entries from registry.json", async () => {
    const dir = await makeTempDir();
    try {
      const pluginsRoot = join(dir, "plugins");
      const pluginDir = join(pluginsRoot, "snap-test");
      await mkdir(pluginDir, { recursive: true });
      const manifestPath = join(pluginDir, "plugin.json");
      await writeFile(manifestPath, JSON.stringify(VALID_MANIFEST), "utf-8");

      const registryPath = join(dir, "registry.json");
      await writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          plugins: [{ id: "snap-test", manifestPath, enabled: true }],
        }),
        "utf-8",
      );

      const plans = await resolveManifestLoadPlan({
        manifestPaths: [],
        registryPath,
        pluginsRoot,
      });
      const entry = plans.find((p) => p.pluginIdHint === "snap-test");
      expect(entry).toBeDefined();
      expect(entry?.enabled).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores untrusted registry manifest paths (outside pluginsRoot)", async () => {
    const dir = await makeTempDir();
    try {
      const pluginsRoot = join(dir, "plugins");
      await mkdir(pluginsRoot, { recursive: true });

      // manifest path is outside pluginsRoot
      const outsidePath = join(dir, "evil", "plugin.json");

      const registryPath = join(dir, "registry.json");
      await writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          plugins: [{ id: "evil", manifestPath: outsidePath, enabled: true }],
        }),
        "utf-8",
      );

      const plans = await resolveManifestLoadPlan({
        manifestPaths: [],
        registryPath,
        pluginsRoot,
      });
      expect(plans.find((p) => p.pluginIdHint === "evil")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
