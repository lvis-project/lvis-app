import { mkdtempSync } from "node:fs";
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
  it("restores only the exact owner/version/local-id/fingerprint tuple", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-contribution-trust-"));
    roots.push(root);
    const path = join(root, "hooks.json");
    const approved = {
      pluginId: "ep-api",
      pluginVersion: "1.0.0",
      localId: "attendance_policy",
      fingerprint: "a".repeat(64),
    };
    new PluginContributionTrustStore("hook", path).approve(approved);

    const restored = new PluginContributionTrustStore("hook", path);
    expect(restored.isApproved(approved)).toBe(true);
    expect(restored.isApproved({ ...approved, pluginVersion: "2.0.0" })).toBe(false);
    expect(restored.isApproved({ ...approved, fingerprint: "b".repeat(64) })).toBe(false);
  });
});
