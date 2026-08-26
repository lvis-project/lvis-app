/**
 * #893 — Manifest `hostSecrets.read[]` validator unit tests.
 *
 * Verifies that `parsePluginJson()` rejects allowlist entries that don't
 * match the allowed host LLM secret key patterns (`manifest_schema` failure)
 * and accepts a well-formed allowlist unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { buildManifestValidator, parsePluginJson } from "../manifest-validation.js";
import { parseWhitelistDocument } from "../../whitelist/whitelist-schema.js";
import {
  HOST_SECRET_READ_MAX_ITEMS,
  isAllowedHostSecretKey,
} from "../../../shared/marketplace-package-assets.js";
import manifestSchema from "../../../../schemas/plugin-manifest.schema.json" with { type: "json" };
import { agentPluginsDocument } from "../../__tests__/test-helpers.js";

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
        tools: { type: "array" },
        hostSecrets: { type: "object" },
      },
    });
  }

  async function writeManifest(extra: Record<string, unknown>): Promise<string> {
    const path = join(workDir, "plugin.json");
    await writeFile(
      path,
      JSON.stringify(agentPluginsDocument({
        id: "host-secrets-test",
        name: "Host Secrets Test",
        description: "x",
        version: "1.0.0",
        entry: "dist/p.js",
        tools: [{ name: "t_one", description: "t_one tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        ...extra,
      })));
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

  it("accepts marketplace provider preset host secret keys", async () => {
    const path = await writeManifest({
      hostSecrets: {
        read: ["llm.marketplaceProvider.future-router.apiKey"],
      },
    });
    const validator = makeValidator();
    const parsed = await parsePluginJson(path, validator);
    expect(parsed.hostSecrets?.read).toEqual([
      "llm.marketplaceProvider.future-router.apiKey",
    ]);
  });

  it("patches the SDK schema to accept marketplace provider preset host secret keys", async () => {
    const validator = await buildManifestValidator();
    const valid = validator({
      id: "marketplace-provider-secret",
      name: "Marketplace Provider Secret Plugin",
      version: "1.0.0",
      description: "Marketplace provider secret fixture.",
      publisher: "LVIS",
      entry: "dist/index.js",
      tools: [],
      hostSecrets: {
        read: ["llm.marketplaceProvider.future-router.apiKey"],
      },
    });
    expect(valid, JSON.stringify(validator.errors, null, 2)).toBe(true);
  });

  // ── one predicate, and it may not be looser than the JSON schema ──
  //
  // The runtime gate exists as defence-in-depth against a manifest installing
  // "a wider allowlist than the schema permits". That claim is only true if the
  // TS predicate accepts NOTHING the vendored schema rejects.
  it("never accepts a hostSecrets.read key the vendored JSON schema rejects", async () => {
    const validator = await buildManifestValidator();
    const corpus = [
      "llm.apiKey.openai",
      "llm.apiKey.open-router",
      "llm.marketplaceProvider.future-router.apiKey",
      // The pre-consolidation TS copies routed this through a helper that
      // `.trim()`s, so they accepted padded ids the schema never allowed.
      "llm.marketplaceProvider.  future-router  .apiKey",
      "llm.marketplaceProvider.\tfuture-router.apiKey",
      "llm.marketplaceProvider.\nfuture-router.apiKey",
      "llm.marketplaceProvider.future router.apiKey",
      // Neither TS copy enforced the schema's per-item length bound.
      `llm.apiKey.${"a".repeat(200)}`,
      "llm.apiKey.Claude",
      "webApiKey.tavily",
    ];
    for (const key of corpus) {
      const schemaAccepts = validator({
        id: "host-secret-corpus",
        name: "Host Secret Corpus Plugin",
        version: "1.0.0",
        description: "Host secret corpus fixture.",
        publisher: "LVIS",
        entry: "dist/index.js",
        tools: [],
        hostSecrets: { read: [key] },
      });
      expect(isAllowedHostSecretKey(key), `key ${JSON.stringify(key)}`)
        .toBe(schemaAccepts);
    }
  });

  it("applies the same predicate to a signed whitelist grant as to a manifest", async () => {
    const padded = "llm.marketplaceProvider.  future-router  .apiKey";
    expect(isAllowedHostSecretKey(padded)).toBe(false);

    const path = await writeManifest({ hostSecrets: { read: [padded] } });
    await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
      /hostSecrets\.read\[0\].*manifest_schema/,
    );

    expect(() =>
      parseWhitelistDocument(
        JSON.stringify({
          version: 1,
          schemaVersion: 1,
          issuedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2027-01-01T00:00:00.000Z",
          pluginGrants: {
            "host-secrets-test": {
              publisher: "LVIS",
              approvedManifestSha256: "a".repeat(64),
              hostSecrets: { read: [padded] },
            },
          },
        }),
      ),
    ).toThrow(/hostSecrets\.read\[0\]/);
  });

  it("rejects malformed marketplace provider preset host secret keys", async () => {
    const path = await writeManifest({
      hostSecrets: {
        read: ["llm.marketplaceProvider.bad router.apiKey"],
      },
    });
    const validator = makeValidator();
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /hostSecrets\.read\[0\].*manifest_schema/,
    );
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

  describe("manifest id policy parity", () => {
    async function writeManifestWithId(id: string): Promise<string> {
      const path = join(workDir, "plugin.json");
      await writeFile(
        path,
        JSON.stringify(agentPluginsDocument({
          id,
          name: "Id Test",
          description: "x",
          version: "1.0.0",
          entry: "dist/p.js",
          tools: [{ name: "t_one", description: "t_one tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        })));
      return path;
    }

    it("rejects dotted ids to match the authoritative kebab-case schema", async () => {
      const path = await writeManifestWithId("com.example.meeting-recorder");
      await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
        /dotted ids are not allowed.*manifest_schema/,
      );
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
        /dotted ids are not allowed.*manifest_schema/,
      );
    });

    it("rejects ids with consecutive dots (manifest_schema)", async () => {
      const path = await writeManifestWithId("com..example.foo");
      await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
        /dotted ids are not allowed.*manifest_schema/,
      );
    });
  });

  // ── #1939: the two COLLECTION-level bounds ──
  //
  // `isAllowedHostSecretKey` judges one entry at a time, so it can see neither
  // `maxItems` nor `uniqueItems`. On the manifest path AJV enforces both from
  // the vendored schema; on the signed-whitelist path there is no schema leg,
  // so `findHostSecretReadListViolation` is the only gate there. Every case
  // below drives a real producer — `parseWhitelistDocument` on a whole document
  // string, `parsePluginJson` on a manifest file.
  describe("hostSecrets.read[] collection bounds (#1939)", () => {
    const readSchema = (
      manifestSchema as unknown as {
        properties: {
          hostSecrets: {
            properties: {
              read: { maxItems?: number; uniqueItems?: boolean };
            };
          };
        };
      }
    ).properties.hostSecrets.properties.read;

    /** `count` distinct, individually well-formed host-secret keys. */
    function distinctKeys(count: number): string[] {
      return Array.from(
        { length: count },
        (_, i) => `llm.marketplaceProvider.p${i}.apiKey`,
      );
    }

    function whitelistJson(read: unknown[]): string {
      return JSON.stringify({
        version: 1,
        schemaVersion: 1,
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
        pluginGrants: {
          "host-secrets-test": {
            publisher: "LVIS",
            approvedManifestSha256: "a".repeat(64),
            hostSecrets: { read },
          },
        },
      });
    }

    // Pins the hand-declared TS constant to the JSON schema it mirrors, so a
    // schema edit that is not carried into TS fails here instead of silently
    // splitting the two paths.
    it("declares the same maxItems the vendored JSON schema declares", () => {
      expect(readSchema.maxItems).toBe(HOST_SECRET_READ_MAX_ITEMS);
      expect(readSchema.uniqueItems).toBe(true);
    });

    // Guards the negative cases below: an over-limit rejection must come from
    // the count, not from a generated key the per-item predicate dislikes.
    it("generates fixture keys that are individually allowed", () => {
      for (const key of distinctKeys(HOST_SECRET_READ_MAX_ITEMS + 1)) {
        expect(isAllowedHostSecretKey(key), key).toBe(true);
      }
    });

    it("accepts a whitelist grant at exactly maxItems", () => {
      const doc = parseWhitelistDocument(
        whitelistJson(distinctKeys(HOST_SECRET_READ_MAX_ITEMS)),
      );
      expect(doc.pluginGrants["host-secrets-test"].hostSecrets.read).toHaveLength(
        HOST_SECRET_READ_MAX_ITEMS,
      );
    });

    it("rejects a whitelist grant over maxItems", () => {
      expect(() =>
        parseWhitelistDocument(
          whitelistJson(distinctKeys(HOST_SECRET_READ_MAX_ITEMS + 1)),
        ),
      ).toThrow(
        new RegExp(
          `hostSecrets\\.read has ${HOST_SECRET_READ_MAX_ITEMS + 1} entries \\(max ${HOST_SECRET_READ_MAX_ITEMS}\\)`,
        ),
      );
    });

    it("rejects a whitelist grant with duplicate entries", () => {
      expect(() =>
        parseWhitelistDocument(
          whitelistJson(["llm.apiKey.openai", "llm.apiKey.openai"]),
        ),
      ).toThrow(/hostSecrets\.read\[1\] 'llm\.apiKey\.openai' is a duplicate/);
    });

    it("keeps a whitelist grant with distinct entries", () => {
      const doc = parseWhitelistDocument(
        whitelistJson(["llm.apiKey.openai", "llm.apiKey.claude"]),
      );
      expect(doc.pluginGrants["host-secrets-test"].hostSecrets.read).toEqual([
        "llm.apiKey.openai",
        "llm.apiKey.claude",
      ]);
    });

    // Manifest path, host-side leg only: `makeValidator()` is deliberately
    // permissive (no maxItems/uniqueItems), so these two exercise the TS mirror
    // rather than AJV.
    it("rejects a manifest over maxItems at the host check", async () => {
      const path = await writeManifest({
        hostSecrets: { read: distinctKeys(HOST_SECRET_READ_MAX_ITEMS + 1) },
      });
      await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
        /hostSecrets\.read.*entries.*manifest_schema/,
      );
    });

    it("rejects a manifest with duplicate entries at the host check", async () => {
      const path = await writeManifest({
        hostSecrets: { read: ["llm.apiKey.openai", "llm.apiKey.openai"] },
      });
      await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
        /hostSecrets\.read\[1\].*duplicate.*manifest_schema/,
      );
    });

    // Manifest path, AJV leg: the covering layer the whitelist path lacks.
    it("rejects both bounds against the vendored schema too", async () => {
      const validator = await buildManifestValidator();
      const base = {
        id: "host-secret-bounds",
        name: "Host Secret Bounds Plugin",
        version: "1.0.0",
        description: "Host secret bounds fixture.",
        publisher: "LVIS",
        entry: "dist/index.js",
        tools: [],
      };
      expect(
        validator({
          ...base,
          hostSecrets: { read: distinctKeys(HOST_SECRET_READ_MAX_ITEMS + 1) },
        }),
      ).toBe(false);
      expect(
        validator({
          ...base,
          hostSecrets: { read: ["llm.apiKey.openai", "llm.apiKey.openai"] },
        }),
      ).toBe(false);
      expect(
        validator({
          ...base,
          hostSecrets: { read: distinctKeys(HOST_SECRET_READ_MAX_ITEMS) },
        }),
        JSON.stringify(validator.errors, null, 2),
      ).toBe(true);
    });
  });
});
