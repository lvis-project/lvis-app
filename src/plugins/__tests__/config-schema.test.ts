/**
 * §9.2 Track B — VSCode-style configSchema tests.
 *
 * Covers acceptance criteria US-B1..US-B6:
 *   - Manifest AJV strict validation accepts/rejects configSchema shapes.
 *   - Renderer fallback for legacy plugins (no configSchema) intact.
 *   - hostApi.config.{get,set,onChange} roundtrip.
 *   - Plugin isolation — listener for plugin A not fired by plugin B.
 *   - Secret routing — `format: "secret"` keys never land in cleartext
 *     pluginConfigs after the IPC strip.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as AjvModule from "ajv";
import * as AddFormatsModule from "ajv-formats";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyConfigDefaults,
  isSecretProperty,
  listSecretKeys,
  pluginSecretKey,
  stripSecretFields,
  compileConfigSchemaValidator,
} from "../config-schema.js";
import {
  emitPluginConfigChange,
  subscribePluginConfigChange,
  _resetPluginConfigChangeBus,
} from "../config-change-bus.js";
import type { PluginConfigSchema } from "../types.js";

// Host-owned manifest schema SOT (ph2) — resolved relative to this test file
// so it works regardless of cwd and no longer depends on the SDK package.
const SCHEMA_PATH = fileURLToPath(
  new URL("../../../schemas/plugin-manifest.schema.json", import.meta.url),
);

function buildAjv() {
  const Ajv = (AjvModule as unknown as { default?: unknown }).default ?? AjvModule;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ajv = new (Ajv as any)({ strict: true, strictRequired: false, allErrors: true });
  const addFormats = (AddFormatsModule as unknown as { default?: unknown }).default ?? AddFormatsModule;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (addFormats as any)(ajv);
  return ajv;
}

async function loadHostManifestSchema() {
  const raw = await readFile(SCHEMA_PATH, "utf-8");
  // The host-owned manifest schema carries the host-required fields natively, so
  // tests compile it verbatim — the same shape (and the same file) the runtime
  // `buildManifestValidator()` enforces.
  return JSON.parse(raw);
}

describe("US-B1 — host plugin.schema.json declares configSchema", () => {
  it("schema includes configSchema property with required 'properties'", async () => {
    const schema = await loadHostManifestSchema();
    expect(schema.properties.configSchema).toBeTypeOf("object");
    expect(schema.properties.configSchema.required).toContain("properties");
    expect(schema.properties.configSchema.additionalProperties).toBe(false);
  });

  it("AJV strict accepts a manifest with a well-formed configSchema", async () => {
    const ajv = buildAjv();
    const validate = ajv.compile(await loadHostManifestSchema());
    const ok = validate({
      id: "test-plugin",
      name: "Test",
      version: "1.0.0",
      description: "Test fixture.",
      publisher: "Test fixture",
      entry: "index.js",
      tools: [
        {
          name: "test_ping",
          description: "Test ping tool fixture.",
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model"] } },
        },
      ],
      configSchema: {
        properties: {
          enabled: { type: "boolean", default: true, title: "Enable" },
          apiKey: { type: "string", format: "secret", title: "API Key" },
          mode: { type: "string", enum: ["fast", "slow"], default: "fast" },
          maxRetries: { type: "integer", minimum: 0, maximum: 10, default: 3 },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["enabled"],
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error("AJV errors:", validate.errors);
    }
    expect(ok).toBe(true);
  });

  it("AJV strict rejects malformed configSchema (missing 'properties')", async () => {
    const ajv = buildAjv();
    const validate = ajv.compile(await loadHostManifestSchema());
    const ok = validate({
      id: "test-plugin",
      name: "Test",
      version: "1.0.0",
      entry: "index.js",
      tools: ["test_ping"],
      configSchema: {
        // missing required `properties`
        required: ["foo"],
      },
    });
    expect(ok).toBe(false);
  });

  it("AJV strict rejects an unknown property type", async () => {
    const ajv = buildAjv();
    const validate = ajv.compile(await loadHostManifestSchema());
    const ok = validate({
      id: "test-plugin",
      name: "Test",
      version: "1.0.0",
      entry: "index.js",
      tools: ["test_ping"],
      configSchema: {
        properties: {
          weird: { type: "object" }, // not in enum
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("AJV strict rejects an unknown UI format", async () => {
    const ajv = buildAjv();
    const validate = ajv.compile(await loadHostManifestSchema());
    const ok = validate({
      id: "test-plugin",
      name: "Test",
      version: "1.0.0",
      entry: "index.js",
      tools: ["test_ping"],
      configSchema: {
        properties: {
          token: { type: "string", format: "credit-card" },
        },
      },
    });
    expect(ok).toBe(false);
  });
});

// #885 v6.1.0 — the "toolSchemas authority metadata" describe block (per-tool
// `category` + `toolSchemas.pathFields` declared via the legacy `toolSchemas`
// map) was removed here: the SDK's pure Tool[] schema collapse now rejects
// `toolSchemas` and per-tool `category` outright (additionalProperties), and
// the host already stopped reading them in #885 Phase R. Current authority
// metadata is `tool._meta["xyz.lvis/pathFields"]` — covered by
// normalize-manifest.test.ts. Category is never declared; the host classifies
// risk itself (see architecture.md §6.3 / CLAUDE.md Permission Policy).
describe("pure Tool authority metadata — no toolSchemas, category, or workerId", () => {
  it("end-to-end: parsePluginJson loads a category-less manifest on the host", async () => {
    const { buildManifestValidator, parsePluginJson } = await import(
      "../runtime/manifest-validation.js"
    );
    const validator = await buildManifestValidator();
    const manifest = {
      id: "category-less-plugin",
      name: "Category-less",
      version: "1.0.0",
      description: "A manifest whose tools carry no permission category.",
      publisher: "Test fixture",
      entry: "dist/index.js",
      tools: [
        {
          name: "test_ping",
          description: "Test ping with no permission category.",
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        },
      ],
    };
    const dir = await mkdtemp(join(realpathSync(tmpdir()), "manifest-cat-less-"));
    try {
      const file = join(dir, "plugin.json");
      await writeFile(file, JSON.stringify(manifest), "utf-8");
      const parsed = await parsePluginJson(file, validator);
      expect(parsed.id).toBe("category-less-plugin");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("end-to-end: parsePluginJson loads a pure model-only tool carrying no workerId", async () => {
    const { buildManifestValidator, parsePluginJson } = await import(
      "../runtime/manifest-validation.js"
    );
    const validator = await buildManifestValidator();
    const manifest = {
      id: "worker-aware-plugin",
      name: "Worker aware",
      version: "1.0.0",
      description: "A manifest with a pure model-only tool (no worker self-claim).",
      publisher: "Test fixture",
      entry: "dist/index.js",
      // #885 Phase R — per-tool `workerId` (and the whole toolSchemas map) left the
      // manifest contract; a pure Tool never carries a worker self-claim.
      tools: [
        {
          name: "worker_ping",
          description: "Worker ping with explicit worker substrate identity.",
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model"] } },
        },
      ],
    };
    const dir = await mkdtemp(join(realpathSync(tmpdir()), "manifest-worker-id-"));
    try {
      const file = join(dir, "plugin.json");
      await writeFile(file, JSON.stringify(manifest), "utf-8");
      const parsed = await parsePluginJson(file, validator);
      const tool = parsed.tools.find((t) => t.name === "worker_ping");
      expect(tool).toBeDefined();
      expect(tool?._meta?.ui?.visibility).toEqual(["model"]);
      expect((parsed as Record<string, unknown>).toolSchemas).toBeUndefined();
      expect((tool as Record<string, unknown> | undefined)?.workerId).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("US-B2 / US-B6 — config-schema helpers", () => {
  const schema: PluginConfigSchema = {
    properties: {
      enabled: { type: "boolean", default: true },
      apiKey: { type: "string", format: "secret" },
      maxRetries: { type: "integer", minimum: 0, maximum: 10, default: 3 },
      mode: { type: "string", enum: ["fast", "slow"], default: "fast" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["enabled"],
  };

  it("isSecretProperty / listSecretKeys / pluginSecretKey", () => {
    expect(isSecretProperty(schema.properties.apiKey)).toBe(true);
    expect(isSecretProperty(schema.properties.enabled)).toBe(false);
    expect(listSecretKeys(schema)).toEqual(new Set(["apiKey"]));
    expect(pluginSecretKey("com.example.plugin", "apiKey")).toBe(
      "plugin.com.example.plugin.apiKey",
    );
  });

  it("applyConfigDefaults fills missing keys without overriding saved values", () => {
    const merged = applyConfigDefaults(schema, { maxRetries: 7 });
    expect(merged.enabled).toBe(true);
    expect(merged.maxRetries).toBe(7); // saved value wins
    expect(merged.mode).toBe("fast");
  });

  it("stripSecretFields removes secret keys defence-in-depth", () => {
    const stripped = stripSecretFields(schema, {
      enabled: true,
      apiKey: "leak-me-in-cleartext",
      maxRetries: 5,
    });
    expect(stripped).toEqual({ enabled: true, maxRetries: 5 });
    expect("apiKey" in stripped).toBe(false);
  });

  it("compileConfigSchemaValidator accepts and rejects against bounds", () => {
    const validator = compileConfigSchemaValidator(schema);
    expect(validator).not.toBeNull();
    if (!validator) return;
    expect(
      validator({ enabled: true, apiKey: "x", mode: "fast", maxRetries: 5, tags: ["a"] }),
    ).toBe(true);
    expect(
      validator({ enabled: true, mode: "fast", maxRetries: -1 }),
    ).toBe(false);
    expect(
      validator({ enabled: true, mode: "unknown" }),
    ).toBe(false);
  });
});

describe("US-B1 regression — baseline manifest WITHOUT configSchema still validates", () => {
  it("AJV strict accepts a manifest that omits configSchema (legacy plugins)", async () => {
    const ajv = buildAjv();
    const validate = ajv.compile(await loadHostManifestSchema());
    // Replicates the shape of the current (post-#885 v6) meeting / local-indexer
    // / ms-graph manifests — no configSchema, but heavy use of pure Tool[] +
    // capabilities. Must keep loading without modification (DoD §4).
    const ok = validate({
      id: "meeting-recorder",
      name: "회의록 녹음",
      version: "1.3.0",
      description: "Test fixture.",
      publisher: "Test fixture",
      entry: "dist/index.js",
      tools: [
        {
          name: "meeting_start",
          description: "Begin a new recording session and stream chunks.",
          inputSchema: {
            type: "object",
            properties: { sessionId: { type: "string" } },
            required: ["sessionId"],
          },
          _meta: { ui: { visibility: ["model"] } },
        },
        {
          name: "meeting_stop",
          description: "Stop the current recording session and finalize.",
          inputSchema: {
            type: "object",
            properties: { sessionId: { type: "string" } },
            required: ["sessionId"],
          },
          _meta: { ui: { visibility: ["model"] } },
        },
      ],
      capabilities: ["meeting-recorder"],
      eventSubscriptions: ["calendar.event.started"],
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error("AJV regression errors:", validate.errors);
    }
    expect(ok).toBe(true);
  });
});

describe("US-B5 — `format:'secret'` routing keeps cleartext pluginConfigs clean", () => {
  it("stripSecretFields drops only the secret key (kept fields untouched)", () => {
    const schema: PluginConfigSchema = {
      properties: {
        endpoint: { type: "string" },
        apiKey: { type: "string", format: "secret" },
        retries: { type: "integer", default: 3 },
      },
    };
    const cleaned = stripSecretFields(schema, {
      endpoint: "https://api.example.com",
      apiKey: "sk-LEAK",
      retries: 5,
    });
    expect(cleaned).toEqual({
      endpoint: "https://api.example.com",
      retries: 5,
    });
    expect(JSON.stringify(cleaned)).not.toContain("sk-LEAK");
    expect(JSON.stringify(cleaned)).not.toContain("apiKey");
  });

  it("listSecretKeys returns the empty set when schema is undefined or has no secret entries", () => {
    expect(listSecretKeys(undefined).size).toBe(0);
    expect(
      listSecretKeys({
        properties: {
          enabled: { type: "boolean" },
          mode: { type: "string", enum: ["a", "b"] },
        },
      }).size,
    ).toBe(0);
  });
});

describe("US-B4 — plugin-config change bus isolation", () => {
  beforeEach(() => {
    _resetPluginConfigChangeBus();
  });

  it("delivers events to plugin A's listener and NOT to plugin B's", () => {
    const aHits: Array<[string, unknown]> = [];
    const bHits: Array<[string, unknown]> = [];
    subscribePluginConfigChange("plugin.a", "endpoint", (k, v) => aHits.push([k, v]));
    subscribePluginConfigChange("plugin.b", "endpoint", (k, v) => bHits.push([k, v]));

    emitPluginConfigChange("plugin.a", "endpoint", "https://a");
    emitPluginConfigChange("plugin.b", "endpoint", "https://b");

    expect(aHits).toEqual([["endpoint", "https://a"]]);
    expect(bHits).toEqual([["endpoint", "https://b"]]);
  });

  it("wildcard '*' listener hears every key for the same pluginId only", () => {
    const aWildcard: Array<[string, unknown]> = [];
    const bWildcard: Array<[string, unknown]> = [];
    subscribePluginConfigChange("plugin.a", "*", (k, v) => aWildcard.push([k, v]));
    subscribePluginConfigChange("plugin.b", "*", (k, v) => bWildcard.push([k, v]));

    emitPluginConfigChange("plugin.a", "endpoint", "https://a");
    emitPluginConfigChange("plugin.a", "timeout", 10);
    emitPluginConfigChange("plugin.b", "endpoint", "https://b");

    expect(aWildcard).toEqual([
      ["endpoint", "https://a"],
      ["timeout", 10],
    ]);
    expect(bWildcard).toEqual([["endpoint", "https://b"]]);
  });

  it("unsubscribe disposer detaches the listener", () => {
    const hits: Array<[string, unknown]> = [];
    const off = subscribePluginConfigChange("plugin.a", "endpoint", (k, v) => hits.push([k, v]));
    emitPluginConfigChange("plugin.a", "endpoint", "https://1");
    off();
    emitPluginConfigChange("plugin.a", "endpoint", "https://2");
    expect(hits).toEqual([["endpoint", "https://1"]]);
  });
});
