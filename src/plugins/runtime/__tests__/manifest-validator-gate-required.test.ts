/**
 * Manifest loading must use the SDK schema validator as the single source of truth.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifestValidator, parsePluginJson } from "../manifest-validation.js";

describe("parsePluginJson — SDK schema validator required", () => {
  let testDir: string;
  let manifestPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-manifest-validator-"));
    manifestPath = join(testDir, "plugin.json");
    await mkdir(testDir, { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "com.test.validator",
        name: "Validator Test",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: ["validator_ping"],
        description: "Validator required test plugin",
        publisher: "Test",
      }),
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("fails closed when the SDK schema validator is absent", async () => {
    await expect(parsePluginJson(manifestPath, null as never)).rejects.toThrow(
      /SDK plugin manifest validator is required/,
    );
  });

  it("parses a valid manifest with the SDK schema validator", async () => {
    const validator = await buildManifestValidator();
    const manifest = await parsePluginJson(manifestPath, validator);
    expect(manifest.id).toBe("com.test.validator");
    expect(manifest.installPolicy).toBe("user");
  });

  it("fails closed instead of normalizing invalid installPolicy before SDK validation", async () => {
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "com.test.validator",
        name: "Validator Test",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: ["validator_ping"],
        description: "Validator required test plugin",
        publisher: "Test",
        installPolicy: "root",
      }),
      "utf-8",
    );

    const validator = await buildManifestValidator();
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(/schema validation failed/);
  });
});
