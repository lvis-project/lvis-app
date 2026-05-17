/**
 * #893 — Manifest `hostSecrets.read[]` validator unit tests.
 *
 * Verifies that `parsePluginJson()` rejects allowlist entries that don't
 * match the `llm.apiKey.<vendor>` pattern (`manifest_schema` failure) and
 * accepts a well-formed allowlist unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { parsePluginJson } from "../manifest-validation.js";

describe("manifest hostSecrets.read[] validator (#893)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "host-secrets-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makeValidator() {
    // Permissive AJV schema — the host-side cross-field check is what we want
    // to exercise here, NOT the SDK schema. Mirrors the test helper pattern in
    // manifest-validation-error-clarity.test.ts.
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    return ajv.compile({
      type: "object",
      additionalProperties: true,
      required: ["id", "name", "version", "entry", "tools", "description"],
      properties: {
        id: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9._-]*$", minLength: 3 },
        name: { type: "string" },
        description: { type: "string" },
        version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
        entry: { type: "string" },
        tools: { type: "array", items: { type: "string" } },
        hostSecrets: { type: "object" },
      },
    });
  }

  async function writeManifest(extra: Record<string, unknown>): Promise<string> {
    const path = join(workDir, "plugin.json");
    await writeFile(
      path,
      JSON.stringify({
        id: "com.example.host-secrets-test",
        name: "Host Secrets Test",
        description: "x",
        version: "1.0.0",
        entry: "dist/p.js",
        tools: ["t_one"],
        ...extra,
      }),
    );
    return path;
  }

  it("accepts a well-formed `llm.apiKey.<vendor>` allowlist", async () => {
    const path = await writeManifest({
      hostSecrets: { read: ["llm.apiKey.openai", "llm.apiKey.claude"] },
    });
    const validator = makeValidator();
    const parsed = await parsePluginJson(path, validator);
    expect(parsed.hostSecrets?.read).toEqual([
      "llm.apiKey.openai",
      "llm.apiKey.claude",
    ]);
  });

  it("rejects a non-llm prefix with manifest_schema reason", async () => {
    const path = await writeManifest({
      hostSecrets: { read: ["webApiKey.tavily"] },
    });
    const validator = makeValidator();
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /hostSecrets\.read\[0\].*manifest_schema/,
    );
  });

  it("rejects mixed-case vendor segment", async () => {
    const path = await writeManifest({
      hostSecrets: { read: ["llm.apiKey.Claude"] },
    });
    const validator = makeValidator();
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /hostSecrets\.read\[0\]/,
    );
  });

  it("rejects non-string entries", async () => {
    const path = await writeManifest({
      hostSecrets: { read: [42] },
    });
    const validator = makeValidator();
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /hostSecrets\.read\[0\].*must be a string/,
    );
  });

  it("rejects non-array `read`", async () => {
    const path = await writeManifest({
      hostSecrets: { read: "llm.apiKey.openai" },
    });
    const validator = makeValidator();
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /hostSecrets\.read.*must be an array/,
    );
  });

  it("treats absent hostSecrets block as a no-op", async () => {
    const path = await writeManifest({});
    const validator = makeValidator();
    const parsed = await parsePluginJson(path, validator);
    expect(parsed.hostSecrets).toBeUndefined();
  });

  // PR #894 review B8 — manifest id dot-segment validation
  describe("manifest id dot-segment guard (B8)", () => {
    async function writeManifestWithId(id: string): Promise<string> {
      const path = join(workDir, "plugin.json");
      await writeFile(
        path,
        JSON.stringify({
          id,
          name: "Id Test",
          description: "x",
          version: "1.0.0",
          entry: "dist/p.js",
          tools: ["t_one"],
        }),
      );
      return path;
    }

    it("accepts normal dot-segmented ids (com.example.foo)", async () => {
      const path = await writeManifestWithId("com.example.meeting-recorder");
      const parsed = await parsePluginJson(path, makeValidator());
      expect(parsed.id).toBe("com.example.meeting-recorder");
    });

    // Leading dots are rejected at AJV pattern level (the SDK schema's
    // id pattern requires a leading letter), so the host-side check never
    // sees them. We still want to verify the AJV path rejects.
    it("rejects ids with leading dots", async () => {
      const path = await writeManifestWithId(".com.example.foo");
      await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
        /id.*pattern/i,
      );
    });

    it("rejects ids with trailing dots (manifest_schema)", async () => {
      const path = await writeManifestWithId("com.example.foo.");
      await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
        /id.*manifest_schema/,
      );
    });

    it("rejects ids with consecutive dots (manifest_schema)", async () => {
      const path = await writeManifestWithId("com..example.foo");
      await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
        /id.*manifest_schema/,
      );
    });
  });
});
