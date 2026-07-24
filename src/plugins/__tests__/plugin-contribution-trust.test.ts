import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginContributionTrustStore } from "../plugin-contribution-trust.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PluginContributionTrustStore", () => {
  const approved = {
    pluginId: "ep-api",
    pluginVersion: "1.0.0",
    generationId: "1".repeat(64),
    localId: "attendance_policy",
    fingerprint: "a".repeat(64),
  };

  it("restores only the exact owner/version/generation/local-id/fingerprint tuple", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-contribution-trust-"));
    roots.push(root);
    const path = join(root, "hooks.json");
    new PluginContributionTrustStore("hook", path).approve(approved);

    const restored = new PluginContributionTrustStore("hook", path);
    expect(restored.isApproved(approved)).toBe(true);
    expect(restored.isApproved({ ...approved, pluginVersion: "2.0.0" })).toBe(false);
    expect(restored.isApproved({ ...approved, generationId: "2".repeat(64) })).toBe(false);
    expect(restored.isApproved({ ...approved, fingerprint: "b".repeat(64) })).toBe(false);
  });

  it("does not expose an approval in memory when durable persistence fails", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-contribution-trust-fail-"));
    roots.push(root);
    const trustDir = join(root, "trust");
    mkdirSync(trustDir);
    const store = new PluginContributionTrustStore("hook", join(trustDir, "hooks.json"));
    rmSync(trustDir, { recursive: true });
    writeFileSync(trustDir, "not-a-directory");

    expect(() => store.approve(approved)).toThrow();
    expect(store.isApproved(approved)).toBe(false);
  });

  it("does not revoke an in-memory approval when durable persistence fails", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-contribution-trust-revoke-fail-"));
    roots.push(root);
    const trustDir = join(root, "trust");
    mkdirSync(trustDir);
    const store = new PluginContributionTrustStore("hook", join(trustDir, "hooks.json"));
    store.approve(approved);
    rmSync(trustDir, { recursive: true });
    writeFileSync(trustDir, "not-a-directory");

    expect(() => store.revoke(approved)).toThrow();
    expect(store.isApproved(approved)).toBe(true);
  });
});
