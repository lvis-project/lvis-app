/**
 * Issue #737 — schema validation error message must name the offending
 * additional property + suggest reinstall, instead of the opaque
 * "/ must NOT have additional properties".
 *
 * Companion to #736: clear error message helps users diagnose why a stale
 * plugin install fails AJV validation after the SDK schema tightens.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { parsePluginJson } from "../manifest-validation.js";

describe("manifest-validation enriched error messages (#737)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manifest-error-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makeValidator() {
    // Strict schema mirroring the SDK's additionalProperties:false discipline.
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    return ajv.compile({
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "version", "entry", "tools", "description"],
      properties: {
        id: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9._-]*$", minLength: 3 },
        name: { type: "string" },
        description: { type: "string" },
        version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
        entry: { type: "string" },
        tools: { type: "array", items: { type: "string" } },
      },
    });
  }

  it("names the unknown top-level property and includes a reinstall hint", async () => {
    const path = join(workDir, "plugin.json");
    // Stale manifest with a deprecated `startupTools` field (the actual
    // ms-graph v0.3.2 case the user hit).
    await writeFile(
      path,
      JSON.stringify({
        id: "ms-graph",
        name: "MS Graph",
        description: "x",
        version: "0.3.2",
        entry: "dist/p.js",
        tools: ["a"],
        startupTools: ["a"],
      }),
    );

    const validator = makeValidator();
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /unknown property: 'startupTools'/,
    );
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /try reinstalling from the marketplace/,
    );
  });

  it("names multiple unknown properties when several appear", async () => {
    const path = join(workDir, "plugin.json");
    await writeFile(
      path,
      JSON.stringify({
        id: "x.x",
        name: "X",
        description: "y",
        version: "0.0.1",
        entry: "e",
        tools: [],
        deprecatedField1: 1,
        deprecatedField2: 2,
      }),
    );

    const validator = makeValidator();
    const err = await parsePluginJson(path, validator).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("deprecatedField1");
    expect(err!.message).toContain("deprecatedField2");
    expect(err!.message).toContain("fields"); // plural form
  });

  it("plural detection — single-property case uses 'a field' wording", async () => {
    const path = join(workDir, "plugin.json");
    await writeFile(
      path,
      JSON.stringify({
        id: "x.x",
        name: "X",
        description: "y",
        version: "0.0.1",
        entry: "e",
        tools: [],
        oneStrayField: 1,
      }),
    );

    const validator = makeValidator();
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /contains a field/,
    );
  });

  it("non-additionalProperties errors still surface the original message + path", async () => {
    const path = join(workDir, "plugin.json");
    // Wrong version format — validation should mention the path /version
    // and the AJV pattern message, but NOT the reinstall hint.
    await writeFile(
      path,
      JSON.stringify({
        id: "x.x",
        name: "X",
        description: "y",
        version: "not-semver",
        entry: "e",
        tools: [],
      }),
    );

    const validator = makeValidator();
    const err = await parsePluginJson(path, validator).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("/version");
    expect(err!.message).not.toContain("try reinstalling from the marketplace");
  });
});
