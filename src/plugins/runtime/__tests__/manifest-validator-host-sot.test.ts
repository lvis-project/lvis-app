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

describe("buildManifestValidator — host-owned schema SOT (ph2)", () => {
  it("compiles the host schema into a working validator", async () => {
    const validator = await buildManifestValidator();
    expect(typeof validator).toBe("function");
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
});
