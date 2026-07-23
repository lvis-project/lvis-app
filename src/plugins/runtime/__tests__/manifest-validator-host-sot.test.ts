/**
 * Host-owned manifest validator SOT guard (ph2).
 *
 * The host compiles its OWN vendored `schemas/plugin-manifest.schema.json`
 * (imported as a bundler-visible JSON module) with AJV — no runtime
 * `@lvis/plugin-sdk` import. This suite pins:
 *   1. the validator compiles + accepts every host-required field,
 *   2. the negative-strictness guards (formerly runtime probes, now test-time
 *      assertions per ph2) still REJECT removed / unreachable / removed-ui shapes,
 *   3. fail-closed semantics when AJV cannot compile the schema,
 *   4. schema ↔ types ↔ parsePluginJson coherence on a full-featured manifest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifestValidator,
  formatUnknownErrorMessage,
  parsePluginJson,
} from "../manifest-validation.js";
import { MCP_APP_PERMISSION_FEATURES } from "../../../shared/mcp-app-permissions.js";
import manifestSchema from "../../../../schemas/plugin-manifest.schema.json" with { type: "json" };

describe("buildManifestValidator — host-owned schema SOT (ph2)", () => {
  it("compiles the host schema into a working validator", async () => {
    const validator = await buildManifestValidator();
    expect(typeof validator).toBe("function");
  });

  it("accepts structured plugin-owned Skill, Hook, and MCP declarations", async () => {
    const validator = await buildManifestValidator();
    expect(validator({
      id: "atomic-bundle-plugin",
      version: "1.0.0",
      description: "Atomic contribution bundle fixture.",
      entry: "dist/index.js",
      tools: [],
      skills: [{ id: "attendance", path: "skills/attendance" }],
      hooks: [{ id: "audit", path: "hooks/audit.json" }],
      mcpServers: [{ id: "ep", path: "mcp/ep.json" }],
    })).toBe(true);
  });

  it("rejects malformed contribution declarations and unknown fields", async () => {
    const validator = await buildManifestValidator();
    expect(validator({
      id: "atomic-bundle-plugin",
      version: "1.0.0",
      description: "Atomic contribution bundle fixture.",
      entry: "dist/index.js",
      tools: [],
      skills: [{ id: "invalid-id", path: "skills/attendance", trust: true }],
    })).toBe(false);
    expect(validator.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "additionalProperties" }),
      expect.objectContaining({ keyword: "pattern" }),
    ]));
  });

  // ── accept-probes (formerly runtime guards vs a stale SDK; now test-time
  // assertions against the host-compiled validator) ──────────────────────────
  it("accepts a pure MCP Tool[] object carrying _meta.ui.visibility", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator({
        id: "pure-tool-plugin",
        name: "Pure Tool Plugin",
        version: "1.0.0",
        description: "Pure MCP Tool object fixture.",
        publisher: "LVIS",
        entry: "dist/index.js",
        tools: [
          {
            name: "pure_ping",
            description: "Pure ping tool fixture.",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model"] } },
          },
        ],
      }),
    ).toBe(true);
  });

  it("REJECTS a tool _meta carrying the legacy xyz.lvis/pathFields key (fail-closed — the dual-read was removed)", async () => {
    // The `_meta` vendor namespace rename (`xyz.lvis/* → lvisai/*`) removed the
    // transitional dual-read AND the schema's legacy property. Because tool `_meta`
    // is `additionalProperties:false`, a manifest still declaring the legacy key is
    // now REJECTED at the load-time schema gate — it is NOT silently accepted with
    // the security-bearing pathFields ignored (that would be fail-OPEN: the
    // permission gate would stop seeing the plugin's filesystem effects). This is
    // the schema half of the Doctor safety net: rejection → `manifest_schema`
    // → `manifest-validation-error` → auto-reinstall of the migrated version.
    const validator = await buildManifestValidator();
    const result = validator({
      id: "legacy-meta-plugin",
      name: "Legacy Meta Plugin",
      version: "1.0.0",
      description: "Legacy-only _meta pathFields fixture.",
      publisher: "LVIS",
      entry: "dist/index.js",
      tools: [
        {
          name: "legacy_export",
          description: "Export to a path.",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          _meta: { ui: { visibility: ["model"] }, "xyz.lvis/pathFields": ["path"] },
        },
      ],
    });
    expect(result).toBe(false);
    // The rejection specifically names the legacy key as the disallowed
    // additional property (not some unrelated failure).
    expect(validator.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: "additionalProperties",
          params: expect.objectContaining({ additionalProperty: "xyz.lvis/pathFields" }),
        }),
      ]),
    );
  });

  it("REJECTS retired pluginAccess.plugins[].tools grants (fail-closed)", async () => {
    const validator = await buildManifestValidator();
    const result = validator({
      id: "retired-plugin-access-tool-grant",
      name: "Retired Plugin Access Tool Grant",
      version: "1.0.0",
      description: "A manifest carrying the removed cross-plugin tool grant.",
      publisher: "LVIS",
      entry: "dist/index.js",
      tools: [],
      pluginAccess: {
        plugins: [
          {
            pluginId: "ms-graph",
            events: ["ms-graph.snapshot.ready"],
            tools: ["msgraph_email_list"],
          },
        ],
      },
    });

    expect(result).toBe(false);
    expect(validator.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: "additionalProperties",
          params: expect.objectContaining({ additionalProperty: "tools" }),
        }),
      ]),
    );
  });

  it("accepts networkAccess.allowPrivateNetworks", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator({
        id: "private-network-plugin",
        name: "Private Network Plugin",
        version: "1.0.0",
        description: "Private network fixture.",
        publisher: "LVIS",
        entry: "dist/index.js",
        tools: [],
        networkAccess: {
          allowedDomains: ["intranet.example.com"],
          allowPrivateNetworks: true,
          reasoning: "Host-mediated intranet access.",
        },
      }),
    ).toBe(true);
  });

  // "Declared POLICY, served CONTENT": a uiResources[] entry declares the uri +
  // the resource's security policy. The card HTML is NOT a manifest field — the
  // plugin serves its own bytes (RuntimePlugin.readUiResource), so `uri` is the
  // only required member.
  it("accepts a uiResources[] ui:// serving declaration (csp buckets)", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator({
        id: "ui-resource-plugin",
        name: "UI Resource Plugin",
        version: "1.0.0",
        description: "Plugin serving a ui:// MCP App card.",
        publisher: "LVIS",
        entry: "dist/index.js",
        tools: [],
        uiResources: [
          {
            uri: "ui://ui-resource-plugin/card.html",
            csp: { connectDomains: ["https://api.example.com"], resourceDomains: [] },
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts a uiResources[] entry declaring host-honorable `permissions` (camera/microphone/geolocation)", async () => {
    // The inner app frame now carries `allow-same-origin` (spec origin requirement), so a
    // declared permission can actually be delegated + honored. Main derives BOTH the frame
    // `allow` attribute and the Electron session grant from this declaration; the accepted
    // set is exactly what an e2e proved works (mcp-app-permissions.spec.ts).
    const validator = await buildManifestValidator();
    expect(
      validator({
        id: "ui-resource-plugin",
        name: "UI Resource Plugin",
        version: "1.0.0",
        description: "Plugin serving a ui:// MCP App card.",
        publisher: "LVIS",
        entry: "dist/index.js",
        tools: [],
        uiResources: [
          {
            uri: "ui://ui-resource-plugin/card.html",
            permissions: { camera: {}, microphone: {}, geolocation: {} },
          },
        ],
      }),
    ).toBe(true);
  });

  it("REJECTS a uiResources[] `permissions` key the host cannot honor (clipboardWrite / unknown) — fails LOUDLY", async () => {
    // clipboardWrite is deliberately absent from the schema: measured, a script-initiated
    // clipboard write is denied even when delegated, so accepting it would be an unhonored
    // knob. `additionalProperties:false` on mcpUiResourcePermissions makes declaring it — or
    // any unknown feature — fail validation loudly rather than silently doing nothing.
    const validator = await buildManifestValidator();
    const withPermission = (permissions: Record<string, unknown>) =>
      validator({
        id: "ui-resource-plugin",
        name: "UI Resource Plugin",
        version: "1.0.0",
        description: "Plugin serving a ui:// MCP App card.",
        publisher: "LVIS",
        entry: "dist/index.js",
        tools: [],
        uiResources: [{ uri: "ui://ui-resource-plugin/card.html", permissions }],
      });
    expect(withPermission({ clipboardWrite: {} })).toBe(false);
    expect(withPermission({ notARealFeature: {} })).toBe(false);
  });

  // LOCKSTEP GUARD (cluster critic MINOR-2): the schema's `mcpUiResourcePermissions`
  // properties are a SECOND hand-maintained enumeration of the accepted permission set,
  // and its `$comment` names MCP_APP_PERMISSION_FEATURES as the SOT — but nothing bound
  // them, so a 5th feature added to the table (or the schema) without the other would
  // drift silently. Bind them here: adding/removing a feature on either side fails this
  // test instead of shipping a schema that accepts a feature the host cannot honor, or
  // rejects one it can.
  it("schema `mcpUiResourcePermissions` keys match MCP_APP_PERMISSION_FEATURES exactly (no silent drift)", () => {
    const schemaKeys = Object.keys(
      manifestSchema.definitions.mcpUiResourcePermissions.properties,
    ).sort();
    const sotKeys = MCP_APP_PERMISSION_FEATURES.map((f) => f.key).sort();
    expect(schemaKeys).toEqual(sotKeys);
    // Anchor the current accepted set so a change to EITHER side is visible in the diff,
    // and clipboardWrite stays excluded on both.
    expect(sotKeys).toEqual(["camera", "geolocation", "microphone"]);
    expect(schemaKeys).not.toContain("clipboardWrite");
  });

  it("accepts a uiResources[] entry declaring only its uri (policy is optional)", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator({
        id: "ui-resource-bare",
        name: "UI Resource Bare",
        version: "1.0.0",
        description: "uiResources entry with no declared policy.",
        publisher: "LVIS",
        entry: "dist/index.js",
        tools: [],
        uiResources: [{ uri: "ui://ui-resource-bare/card.html" }],
      }),
    ).toBe(true);
  });

  it("rejects a uiResources[] entry with an unknown sub-property (additionalProperties:false)", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator({
        id: "ui-resource-bad",
        name: "UI Resource Bad",
        version: "1.0.0",
        description: "uiResources entry with a stray field.",
        publisher: "LVIS",
        entry: "dist/index.js",
        tools: [],
        uiResources: [
          { uri: "ui://ui-resource-bad/card.html", cspHeader: "default-src 'none'" },
        ],
      }),
    ).toBe(false);
  });

  // The removed `html` member is now an unknown sub-property: a manifest still
  // shipping a disk path is REJECTED, not silently tolerated (the host no longer
  // reads plugin files, so an ignored `html` would be a lie in the manifest).
  it("rejects a uiResources[] entry still declaring the removed html path", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator({
        id: "ui-resource-legacy",
        name: "UI Resource Legacy",
        version: "1.0.0",
        description: "uiResources entry with the removed html path.",
        publisher: "LVIS",
        entry: "dist/index.js",
        tools: [],
        uiResources: [{ uri: "ui://ui-resource-legacy/card.html", html: "dist/cards/card.html" }],
      }),
    ).toBe(false);
  });

  it("accepts a marketplace-provider host secret grant", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator({
        id: "marketplace-provider-secret",
        name: "Marketplace Provider Secret Plugin",
        version: "1.0.0",
        description: "Marketplace provider secret fixture.",
        publisher: "LVIS",
        entry: "dist/index.js",
        tools: [],
        hostSecrets: { read: ["llm.marketplaceProvider.future-router.apiKey"] },
      }),
    ).toBe(true);
  });

  // ── negative-strictness guards (opposite polarity — each must REJECT) ───────
  it("rejects a pure tool carrying a removed field (writesToOwnSandbox)", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator({
        id: "removed-field-plugin",
        name: "Removed Field Plugin",
        version: "1.0.0",
        description: "Pure tool carrying a removed field fixture.",
        publisher: "LVIS",
        entry: "dist/index.js",
        tools: [
          {
            name: "leaky_tool",
            description: "Declares a removed field.",
            inputSchema: { type: "object", properties: {} },
            writesToOwnSandbox: true,
            _meta: { ui: { visibility: ["model"] } },
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects an empty _meta.ui.visibility: [] (minItems:1)", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator({
        id: "empty-visibility-plugin",
        name: "Empty Visibility Plugin",
        version: "1.0.0",
        description: "Pure tool with empty visibility fixture.",
        publisher: "LVIS",
        entry: "dist/index.js",
        tools: [
          {
            name: "unreachable_tool",
            description: "Reachable by neither surface.",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: [] } },
          },
        ],
      }),
    ).toBe(false);
  });

  it('rejects a ui[] extension declaring the removed kind:"action"', async () => {
    const validator = await buildManifestValidator();
    expect(
      validator({
        id: "ui-action-kind-plugin",
        name: "UI Action Kind Plugin",
        version: "1.0.0",
        description: 'Removed ui[].kind="action" fixture.',
        publisher: "LVIS",
        entry: "dist/index.js",
        tools: [],
        ui: [{ id: "a", slot: "sidebar", kind: "action", title: "x", tool: "t" }],
      }),
    ).toBe(false);
  });

  // ── fail-closed: an uncompilable schema aborts plugin loading ───────────────
  describe("fail-closed", () => {
    beforeEach(() => {
      vi.resetModules();
    });
    afterEach(() => {
      vi.doUnmock("ajv");
      vi.doUnmock("ajv-formats");
      vi.resetModules();
    });

    it("throws a wrapped error when AJV cannot compile the host schema", async () => {
      vi.doMock("ajv", () => {
        class ThrowingAjv {
          compile(): never {
            throw new Error("boom-compile");
          }
        }
        return { default: ThrowingAjv };
      });
      vi.doMock("ajv-formats", () => ({ default: () => undefined }));

      const { buildManifestValidator: build } = await import("../manifest-validation.js");
      await expect(build()).rejects.toThrow(
        /Host plugin manifest validator failed to compile: boom-compile/,
      );
    });
  });

  // ── formatUnknownErrorMessage (still exported + used by the fail-closed wrap) ─
  it("formatUnknownErrorMessage stringifies Error / string / object / null", () => {
    expect(formatUnknownErrorMessage(new Error("boom"))).toBe("boom");
    expect(formatUnknownErrorMessage("failed")).toBe("failed");
    expect(formatUnknownErrorMessage({ code: "ERR_X" })).toBe('{"code":"ERR_X"}');
    expect(formatUnknownErrorMessage(null)).toBe("null");
  });
});

describe("schema ↔ types ↔ parsePluginJson coherence (ph2)", () => {
  // Full-featured manifest: pure Tool[] with _meta.ui.visibility + pathFields,
  // an app-only auth trio, keywords, networkAccess, hostSecrets, requires,
  // ui[], and configSchema. Must satisfy BOTH the compiled host schema AND the
  // host cross-field checks in parsePluginJson end-to-end.
  const fullFeatured = {
    id: "full-featured-plugin",
    name: "Full Featured Plugin",
    version: "1.2.3",
    description: "A representative manifest exercising every host-required field.",
    publisher: "LVIS",
    author: "LVIS Team",
    entry: "dist/index.js",
    tools: [
      {
        name: "ff_search",
        description: "Search indexed documents by query.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" }, path: { type: "string" } },
          required: ["query"],
        },
        _meta: {
          ui: { visibility: ["model", "app"] },
          "lvisai/pathFields": ["path"],
        },
      },
      {
        name: "ff_status",
        description: "Return the plugin auth status for the host UI.",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["app"] } },
      },
      {
        name: "ff_login",
        description: "Begin the host-triggered login flow.",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["app"] } },
      },
      {
        name: "ff_logout",
        description: "Sign the user out of the plugin session.",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["app"] } },
      },
    ],
    capabilities: ["knowledge-index"],
    auth: {
      label: "Full Featured Account",
      statusTool: "ff_status",
      loginTool: "ff_login",
      logoutTool: "ff_logout",
    },
    emittedEvents: ["full-featured-plugin.auth.changed"],
    keywords: [{ keyword: "search docs", skillId: "ff_search" }],
    networkAccess: {
      allowedDomains: ["api.example.com"],
      reasoning: "Host-mediated egress for document sync.",
    },
    hostSecrets: { read: ["llm.apiKey.openai"] },
    requires: { capabilities: ["knowledge-index"], minAppVersion: "1.0.0" },
    ui: [
      {
        id: "settings-page",
        slot: "sidebar",
        kind: "embedded-page",
        title: "Settings",
        page: "settings",
      },
    ],
    uiResources: [
      {
        uri: "ui://full-featured-plugin/card.html",
        csp: { connectDomains: ["https://api.example.com"] },
      },
    ],
    configSchema: {
      properties: {
        enabled: { type: "boolean", default: true, title: "Enable" },
        apiKey: { type: "string", format: "secret", title: "API Key" },
      },
      required: ["enabled"],
    },
    startupTimeoutMs: 8000,
  };

  it("validates against the compiled host schema", async () => {
    const validator = await buildManifestValidator();
    const ok = validator(fullFeatured);
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error("AJV errors:", validator.errors);
    }
    expect(ok).toBe(true);
  });

  it("parses end-to-end through parsePluginJson (schema + host cross-field checks)", async () => {
    const validator = await buildManifestValidator();
    const dir = await mkdtemp(join(realpathSync(tmpdir()), "manifest-full-featured-"));
    try {
      const file = join(dir, "plugin.json");
      await writeFile(file, JSON.stringify(fullFeatured), "utf-8");
      const parsed = await parsePluginJson(file, validator);

      expect(parsed.id).toBe("full-featured-plugin");
      expect(parsed.auth?.statusTool).toBe("ff_status");
      expect(parsed.auth?.logoutTool).toBe("ff_logout");
      expect(parsed.requires?.minAppVersion).toBe("1.0.0");
      expect(parsed.networkAccess?.allowedDomains).toEqual(["api.example.com"]);
      expect(parsed.uiResources?.[0]).toEqual({
        uri: "ui://full-featured-plugin/card.html",
        csp: { connectDomains: ["https://api.example.com"] },
      });

      const search = parsed.tools.find((t) => t.name === "ff_search");
      expect(search?._meta?.ui?.visibility).toEqual(["model", "app"]);
      expect(search?._meta?.["lvisai/pathFields"]).toEqual(["path"]);

      // Auth trio materialized as app-only (never model-visible).
      const status = parsed.tools.find((t) => t.name === "ff_status");
      expect(status?._meta?.ui?.visibility).toEqual(["app"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("materializes omitted Tool visibility into independent arrays", async () => {
    const validator = await buildManifestValidator();
    const dir = await mkdtemp(join(realpathSync(tmpdir()), "manifest-default-visibility-"));
    try {
      const file = join(dir, "plugin.json");
      await writeFile(
        file,
        JSON.stringify({
          id: "default-visibility-plugin",
          name: "Default Visibility Plugin",
          version: "1.0.0",
          description: "Exercises default Tool visibility materialization.",
          publisher: "LVIS",
          entry: "dist/index.js",
          tools: [
            { name: "first_default", inputSchema: { type: "object", properties: {} } },
            { name: "second_default", inputSchema: { type: "object", properties: {} } },
          ],
        }),
        "utf-8",
      );

      const parsed = await parsePluginJson(file, validator);
      const first = parsed.tools[0]?._meta?.ui?.visibility;
      const second = parsed.tools[1]?._meta?.ui?.visibility;
      if (!first || !second) {
        throw new Error("Expected omitted Tool visibility to be materialized");
      }

      expect(first).toEqual(["model", "app"]);
      expect(second).toEqual(["model", "app"]);
      expect(first).not.toBe(second);

      first.pop();
      expect(second).toEqual(["model", "app"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("operationGovernance host-only cross-field contract", () => {
  const governed = {
    id: "governed-plugin",
    version: "1.0.0",
    description: "Governed operation union fixture.",
    entry: "dist/index.js",
    tools: [
      {
        name: "domain_read",
        description: "Read domain state before a write.",
        inputSchema: {
          type: "object",
          properties: { operation: { type: "string", enum: ["status"] } },
          required: ["operation"],
          additionalProperties: false,
        },
        _meta: { ui: { visibility: ["model", "app"] } },
      },
      {
        name: "domain_write",
        description: "Write domain state after confirmation.",
        inputSchema: {
          type: "object",
          properties: { operation: { type: "string", enum: ["save"] } },
          required: ["operation"],
          additionalProperties: false,
        },
        _meta: { ui: { visibility: ["model", "app"] } },
      },
    ],
    operationGovernance: {
      domain_read: {
        discriminant: "operation",
        appAllowed: ["status"],
        operations: { status: { kind: "read", minimumRisk: "read" } },
      },
      domain_write: {
        discriminant: "operation",
        appAllowed: ["save"],
        operations: {
          save: {
            kind: "write",
            minimumRisk: "network",
            requiresRead: { tool: "domain_read", operations: ["status"], maxAgeMs: 60000 },
          },
        },
      },
    },
  };

  async function parse(value: unknown) {
    const dir = await mkdtemp(join(realpathSync(tmpdir()), "manifest-governance-"));
    try {
      const file = join(dir, "plugin.json");
      await writeFile(file, JSON.stringify(value), "utf-8");
      return await parsePluginJson(file, await buildManifestValidator());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("accepts a policy whose operation union exactly matches its tool schema", async () => {
    await expect(parse(governed)).resolves.toMatchObject({ operationGovernance: governed.operationGovernance });
  });

  it("rejects operation drift and app writes without a governed read", async () => {
    const drifted = structuredClone(governed);
    drifted.tools[1].inputSchema.properties.operation.enum = ["save", "delete"];
    await expect(parse(drifted)).rejects.toThrow(/exactly match/);

    const noRead = structuredClone(governed);
    delete (noRead.operationGovernance.domain_write.operations.save as { requiresRead?: unknown }).requiresRead;
    await expect(parse(noRead)).rejects.toThrow(/require a governed read snapshot/);
  });
});
