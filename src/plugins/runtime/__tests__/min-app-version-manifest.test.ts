/**
 * Plugin↔app minimum-version gate — manifest `requires.minAppVersion` format
 * validation. The host re-validates the SemVer shape at load even though the
 * SDK JSON-schema mirrors the same `pattern` (a plugin shipped against a stale
 * SDK schema must not smuggle a non-SemVer minAppVersion, which would make the
 * compatibility gate fail-closed silently).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { parsePluginJson } from "../manifest-validation.js";
import {
  agentPluginsDocument,
  permissiveManifestEnvelopeSchema,
} from "../../__tests__/test-helpers.js";

describe("manifest requires.minAppVersion validator", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "min-app-version-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makeValidator() {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    return ajv.compile(
      permissiveManifestEnvelopeSchema({
        namespaceProperties: {
          entry: { type: "string" },
          tools: { type: "array" },
          requires: { type: "object" },
        },
        namespaceRequired: ["entry", "tools"],
      }),
    );
  }

  async function writeManifest(extra: Record<string, unknown>): Promise<string> {
    const path = join(workDir, "plugin.json");
    await writeFile(
      path,
      JSON.stringify(agentPluginsDocument({
        id: "min-app-version-test",
        name: "Min App Version Test",
        description: "x",
        version: "1.0.0",
        entry: "dist/p.js",
        tools: [{ name: "t_one", description: "t_one tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        ...extra,
      })));
    return path;
  }

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
