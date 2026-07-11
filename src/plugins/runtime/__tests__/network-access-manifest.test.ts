/**
 * Tier A — `networkAccess` manifest validation through the REAL SDK-schema
 * validator (`buildManifestValidator()`), the load-time path `parsePluginJson()`
 * runs at boot/install.
 *
 * Regression guard: when the host's `@lvis/plugin-sdk` pin lagged the SDK's
 * `networkAccess` schema, the strict root `additionalProperties:false` rejected
 * every migrated plugin manifest (meeting STT, ms-graph) as an unknown
 * property; the fail-soft load path then dropped the plugin with only an
 * audit-log entry. No prior test drove `buildManifestValidator()` with a
 * networkAccess manifest, so the regression was invisible. This locks the real
 * path: the field is accepted, its shape is still validated, and unrelated
 * unknown properties are still rejected (the OR-wrap must not relax that).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifestValidator, parsePluginJson } from "../manifest-validation.js";

describe("manifest networkAccess (Tier A) — host-owned schema validator path", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "network-access-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function writeManifest(extra: Record<string, unknown>): Promise<string> {
    const path = join(workDir, "plugin.json");
    await writeFile(
      path,
      JSON.stringify({
        id: "network-access-test",
        name: "Network Access Test",
        description: "x",
        version: "1.0.0",
        entry: "dist/p.js",
        tools: [{ name: "t_one", description: "t_one tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        ...extra,
      }),
    );
    return path;
  }

  it("accepts a well-formed networkAccess manifest (meeting/ms-graph shape)", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      networkAccess: {
        allowedDomains: ["openai.azure.com", "api.openai.com"],
        reasoning: "STT transcription egress via host-mediated fetch.",
      },
    });
    const parsed = await parsePluginJson(path, validator);
    expect(parsed.networkAccess?.allowedDomains).toEqual([
      "openai.azure.com",
      "api.openai.com",
    ]);
  });

  it("normalizes networkAccess.allowedDomains at manifest load", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      networkAccess: {
        allowedDomains: [".API.EXAMPLE.COM", "api.example.com"],
        reasoning: "Host-mediated API access.",
      },
    });
    const parsed = await parsePluginJson(path, validator);
    expect(parsed.networkAccess?.allowedDomains).toEqual(["api.example.com"]);
  });

  it("rejects a bare public-suffix domain ('com')", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({ networkAccess: { allowedDomains: ["com"] } });
    await expect(parsePluginJson(path, validator)).rejects.toThrow();
  });

  it("rejects networkAccess missing allowedDomains", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({ networkAccess: { reasoning: "no domains" } });
    await expect(parsePluginJson(path, validator)).rejects.toThrow();
  });

  it("still rejects an unknown top-level property (additionalProperties intact)", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({ bogusUnknownField: 123 });
    await expect(parsePluginJson(path, validator)).rejects.toThrow();
  });
});
