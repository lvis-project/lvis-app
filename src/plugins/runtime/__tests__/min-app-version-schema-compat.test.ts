/**
 * `requires.minAppVersion` schema-compatibility — the REAL SDK-schema validator
 * path (not a permissive test schema). As of @lvis/plugin-sdk v5.18.0 the
 * schema's `requires` block declares `minAppVersion` natively while keeping
 * `additionalProperties:false`, so a manifest declaring `requires.minAppVersion`
 * (the local-indexer shape) is accepted and an unknown `requires` field is still
 * rejected — with no host compatibility patch (sibling to
 * network-access-manifest).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifestValidator, parsePluginJson } from "../manifest-validation.js";
import { pluginManifestWriter } from "../../__tests__/test-helpers.js";

describe("manifest requires.minAppVersion — host-owned schema validator path", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "min-app-version-compat-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const writeManifest = pluginManifestWriter(
    { id: "min-app-version-compat-test", name: "Min App Version Compat Test" },
    () => workDir,
  );

  it("accepts requires.minAppVersion under the real (additionalProperties:false) requires block — the local-indexer shape", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({ requires: { minAppVersion: "0.4.1" } });
    const parsed = await parsePluginJson(path, validator);
    expect(parsed.requires?.minAppVersion).toBe("0.4.1");
  });

  it("accepts requires.minAppVersion alongside capabilities", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      requires: { capabilities: ["meeting-recorder"], minAppVersion: "1.4.0" },
    });
    const parsed = await parsePluginJson(path, validator);
    expect(parsed.requires?.minAppVersion).toBe("1.4.0");
  });

  it("still rejects an unknown property inside requires (additionalProperties intact)", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({ requires: { minAppVersion: "1.4.0", bogusRequiresField: 1 } });
    await expect(parsePluginJson(path, validator)).rejects.toThrow();
  });
});
