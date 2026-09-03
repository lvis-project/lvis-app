/**
 * Plugin↔app minimum-version gate — manifest `requires.minAppVersion` format
 * validation. The host re-validates the SemVer shape at load even though the
 * SDK JSON-schema mirrors the same `pattern` (a plugin shipped against a stale
 * SDK schema must not smuggle a non-SemVer minAppVersion, which would make the
 * compatibility gate fail-closed silently).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePluginJson } from "../manifest-validation.js";
import {
  permissiveManifestValidatorFactory,
  pluginManifestWriter,
} from "../../__tests__/test-helpers.js";

describe("manifest requires.minAppVersion validator", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "min-app-version-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const makeValidator = permissiveManifestValidatorFactory({
    namespaceProperties: {
      entry: { type: "string" },
      tools: { type: "array" },
      requires: { type: "object" },
    },
    namespaceRequired: ["entry", "tools"],
  });

  const writeManifest = pluginManifestWriter(
    { id: "min-app-version-test", name: "Min App Version Test" },
    () => workDir,
  );

  it("accepts a manifest with no requires (backward-compat)", async () => {
    const path = await writeManifest({});
    const parsed = await parsePluginJson(path, makeValidator());
    expect(parsed.requires).toBeUndefined();
  });

  it("accepts requires without minAppVersion", async () => {
    const path = await writeManifest({ requires: { capabilities: ["meeting-recorder"] } });
    const parsed = await parsePluginJson(path, makeValidator());
    expect(parsed.requires?.minAppVersion).toBeUndefined();
  });

  it("accepts a well-formed plain SemVer minAppVersion", async () => {
    const path = await writeManifest({ requires: { capabilities: [], minAppVersion: "1.4.0" } });
    const parsed = await parsePluginJson(path, makeValidator());
    expect(parsed.requires?.minAppVersion).toBe("1.4.0");
  });

  it("rejects a range/caret minAppVersion (not a plain SemVer)", async () => {
    const path = await writeManifest({ requires: { capabilities: [], minAppVersion: "^1.4.0" } });
    await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
      /requires\.minAppVersion.*manifest_schema/,
    );
  });

  it("rejects a pre-release / leading-zero minAppVersion", async () => {
    const pre = await writeManifest({ requires: { capabilities: [], minAppVersion: "1.4.0-rc1" } });
    await expect(parsePluginJson(pre, makeValidator())).rejects.toThrow(
      /requires\.minAppVersion/,
    );
  });

  it("rejects a non-string minAppVersion", async () => {
    const path = await writeManifest({ requires: { capabilities: [], minAppVersion: 140 } });
    await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
      /requires\.minAppVersion/,
    );
  });
});
