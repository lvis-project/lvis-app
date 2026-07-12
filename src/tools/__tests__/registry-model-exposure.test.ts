/**
 * THE MODEL-EXPOSURE BOUNDARY — MCP Apps `_meta.ui.visibility: ["app"]`, on BOTH arms.
 *
 * `["app"]` is the spec's spelling for a tool that serves the server's own CARD and
 * is hidden from the model: a plugin ships `*_ui_list_rows` / `*_ui_toggle_star`
 * without polluting the LLM's tool surface. Making that declaration WORK means
 * separating three things the registry used to conflate:
 *
 *   1. EXECUTION — an app-only tool MUST be a registry `Tool`. That is the only way
 *      a call to it runs under `inspectHostRisk` → reviewer/approval → audit. So it
 *      is registered, `findByName` resolves it, and the executor can run it.
 *   2. MODEL EXPOSURE — and it MUST be absent from the list handed to the LLM. That
 *      subtraction happens HERE, in the registry's model-facing listings, and
 *      therefore covers both arms at once: a first-party plugin's loopback server
 *      (`plugin-server-projection` → `plugin-tool-from-mcp`) and a foreign MCP server
 *      (`mcp-tool-adapter`) both reach the registry with `modelVisible` materialized.
 *      (This is also the fix for external servers' app-only tools leaking into the
 *      model's tool list — one filter, one place, both arms.)
 *   3. OWNERSHIP — untouched here; see `plugins/runtime/__tests__/known-tool-owners-model-only.test.ts`.
 *
 * Registered ≠ exposed. Every assertion below is one half of that sentence.
 */
import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { runWithInvocationOrigin } from "../../plugins/runtime/origin-chain.js";
import { mcpToolToTool } from "../../mcp/mcp-tool-adapter.js";
import { mcpToolToPluginTool } from "../../mcp/plugin-tool-from-mcp.js";
import { manifestToolsToMcpTools } from "../../mcp/plugin-server-projection.js";
import type { McpToolSchema } from "../../mcp/types.js";
import type { PluginManifest } from "../../plugins/types.js";

const PLUGIN_ID = "com.example.meeting";
const SERVER_ID = "github";

type Visibility = Array<"model" | "app">;

/**
 * The plugin arm, built exactly as production does: manifest → the loopback's
 * `tools/list` projection → the reverse projection into a registry `Tool`.
 *
 * `meeting_ui_list_rows` is the card-serving tool of the design brief;
 * `meeting_auth_status` / `meeting_auth_login` are the auth trio, which the manifest
 * validator REQUIRES to be exactly `["app"]` — so they are app-only by construction
 * and this fixture is the real shape, not a contrived one.
 */
const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Meeting",
  version: "1.0.0",
  entry: "dist/index.js",
  description: "meetings",
  tools: [
    { name: "meeting_start", description: "Start", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model"] } } },
    { name: "meeting_toggle", description: "Toggle", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } },
    { name: "meeting_ui_list_rows", description: "Rows for the card", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
    { name: "meeting_auth_status", description: "Auth status", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
    { name: "meeting_auth_login", description: "Auth login", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
  ],
  auth: { statusTool: "meeting_auth_status", loginTool: "meeting_auth_login" },
};

const AUTH_TRIO = ["meeting_auth_status", "meeting_auth_login"];

function pluginTools(): Tool[] {
  const invoke = vi.fn(async (name: string) => ({ text: `ran ${name}` }));
  return manifestToolsToMcpTools(MANIFEST).map((t) => mcpToolToPluginTool(PLUGIN_ID, t, invoke));
}

/** The external arm, built exactly as `mcp-client` does from a foreign `tools/list`. */
function externalTool(name: string, visibility?: Visibility): Tool {
  const schema = {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    ...(visibility ? { _meta: { ui: { visibility } } } : {}),
  } as McpToolSchema;
  return mcpToolToTool(SERVER_ID, `mcp_gh_${name}`, schema, async () => ({ text: "ok" }));
}

function builtinTool(name: string): Tool {
  return createDynamicTool({
    name,
    description: `${name} builtin`,
    source: "builtin",
    category: "read",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "ok", isError: false }),
  });
}

function loadedRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerBatch([
    builtinTool("bash"),
    ...pluginTools(),
    externalTool("query", ["model", "app"]),
    externalTool("gh_ui_rows", ["app"]), // an external server's card-serving tool
    externalTool("legacy"), // declares nothing ⇒ spec default ["model","app"]
  ]);
  return registry;
}

const FULL_SCOPE = {
  activePluginIds: [PLUGIN_ID],
  includeBuiltins: true,
  includeMcp: true,
  deferral: false, // eager: every in-scope tool's full schema loads
};

describe("registry — an app-only tool IS registered (it must run under the gate)", () => {
  it("resolves app-only tools by name on BOTH arms — findByName is the executor's lookup, and it must see them", () => {
    const registry = loadedRegistry();
    // Plugin arm: the card's tool, and the auth trio.
    expect(registry.findByName("meeting_ui_list_rows")).toBeDefined();
    for (const name of AUTH_TRIO) expect(registry.findByName(name)).toBeDefined();
    // External arm.
    expect(registry.findByName("mcp_gh_gh_ui_rows")).toBeDefined();
    // Without a registry `Tool` there is no risk classifier, no approval gate and no
    // audit row — nothing to run the card's call under. That is why this matters.
    expect(registry.findByName("meeting_ui_list_rows")!.source).toBe("plugin");
    expect(registry.findByName("mcp_gh_gh_ui_rows")!.mcpServerId).toBe(SERVER_ID);
  });

  it("keeps them in getVisibleTools (the executable surface) — it is a superset of the model's", () => {
    const registry = loadedRegistry();
    const executable = registry.getVisibleTools().map((t) => t.name);
    const exposed = registry.getModelVisibleTools().map((t) => t.name);
    expect(executable).toContain("meeting_ui_list_rows");
    expect(executable).toContain("mcp_gh_gh_ui_rows");
    expect(exposed.length).toBeLessThan(executable.length);
    for (const name of exposed) expect(executable).toContain(name);
  });
});

describe("registry — an app-only tool is NOT exposed to the model (both arms, one filter)", () => {
  it("subtracts app-only tools from every model-facing listing", () => {
    const registry = loadedRegistry();

    const listings: Array<[string, string[]]> = [
      ["getModelVisibleTools", registry.getModelVisibleTools().map((t) => t.name)],
      ["getToolSchemas", registry.getToolSchemas().map((s) => s.name)],
      ["getToolSchemasForScope", registry.getToolSchemasForScope(FULL_SCOPE).map((s) => s.name)],
    ];

    for (const [label, names] of listings) {
      // PLUGIN arm app-only — the regression this whole change exists to make safe:
      // it is now registered, so a listing that forgot the filter WOULD leak it.
      expect(names, label).not.toContain("meeting_ui_list_rows");
      // EXTERNAL arm app-only — the separately-requested leak: `mcp-tool-adapter`
      // has always registered everything, so before the filter the model SAW this.
      expect(names, label).not.toContain("mcp_gh_gh_ui_rows");
      // …while model-visible tools on both arms, and builtins, are all still there.
      expect(names, label).toEqual(
        expect.arrayContaining(["bash", "meeting_start", "meeting_toggle", "mcp_gh_query", "mcp_gh_legacy"]),
      );
    }
  });

  it("keeps app-only tools out of the DEFERRED catalog too — a tool the model may not see is not a candidate it may promote", () => {
    const registry = loadedRegistry();
    // Deferred mode: nothing is loaded, everything in scope goes to the catalog the
    // model picks from with `tool_search`. An app-only tool must not appear there
    // either — being invisible is worthless if the model can ask for it by name.
    const deferredScope = { ...FULL_SCOPE, deferral: true, activeToolNames: [] as string[] };
    const catalog = registry.getToolCatalogForScope(deferredScope).map((e) => e.name);

    expect(catalog).not.toContain("meeting_ui_list_rows");
    expect(catalog).not.toContain("mcp_gh_gh_ui_rows");
    for (const name of AUTH_TRIO) expect(catalog).not.toContain(name);
    expect(catalog).toEqual(expect.arrayContaining(["meeting_start", "meeting_toggle", "mcp_gh_query"]));
  });

  it("cannot be forced into exposure by naming the tool in activeToolNames", () => {
    const registry = loadedRegistry();
    // `activeToolNames` is the promotion channel (keyword preload, tool_search,
    // carry-forward). Naming an app-only tool there must not load its schema: the
    // exposure filter runs BEFORE the scope filter, so there is no promotion path.
    const names = registry
      .getToolSchemasForScope({
        ...FULL_SCOPE,
        deferral: true,
        activeToolNames: ["meeting_ui_list_rows", "meeting_auth_status", "mcp_gh_gh_ui_rows", "meeting_start"],
      })
      .map((s) => s.name);

    expect(names).not.toContain("meeting_ui_list_rows");
    expect(names).not.toContain("meeting_auth_status");
    expect(names).not.toContain("mcp_gh_gh_ui_rows");
    expect(names).toContain("meeting_start"); // the promoted model-visible one loads
  });

  it("THE AUTH TRIO stays model-invisible and IS registered under the gate (app-only by manifest law)", () => {
    const registry = loadedRegistry();
    for (const name of AUTH_TRIO) {
      // Not shown to the model, in any listing…
      expect(registry.getModelVisibleTools().map((t) => t.name)).not.toContain(name);
      expect(registry.getToolSchemas().map((s) => s.name)).not.toContain(name);
      expect(registry.getToolSchemasForScope(FULL_SCOPE).map((s) => s.name)).not.toContain(name);
      // …yet IS registered, so that a CARD's auth call runs under the gate — the exact
      // call the old ungoverned bypass handed to an untrusted iframe with no risk check
      // and no audit row. `findByName` resolving it is DELIBERATE, not a leak: model
      // exposure (what the LLM is shown) is subtracted at the listings above, while
      // registration (what may execute under the gate) is retained here.
      expect(registry.findByName(name)).toBeDefined();
      expect(registry.findByName(name)!.modelVisible).toBe(false);
    }
    // The "model can't RUN it" half of the invariant is NOT a registry property — the
    // registry resolves the name on purpose — it is an EXECUTOR property, proved in the
    // "executor refuses a model-origin call" block below. Asserting it here would be the
    // lie this block used to carry (title once said "…AND model-uncallable" while only
    // showing findByName resolves).
  });

  it("leaves builtins alone — a tool that declares no MCP visibility is model-visible", () => {
    const registry = loadedRegistry();
    // `modelVisible` is undefined on every builtin (they have no `_meta.ui`), and the
    // predicate treats absent as EXPOSED. A fail-closed default here would silently
    // empty the model's tool list.
    expect(registry.findByName("bash")!.modelVisible).toBeUndefined();
    expect(registry.getModelVisibleTools().map((t) => t.name)).toContain("bash");
    // Same for an external server that declares nothing: SEP-1865 default is dual.
    expect(registry.findByName("mcp_gh_legacy")!.modelVisible).toBe(true);
  });
});

/**
 * THE OTHER HALF — registration is NOT executability-by-the-model. `findByName`
 * resolving an app-only tool (proved above) is exactly why the EXECUTOR needs its own
 * guard: a model `tool_use` naming `meeting_auth_login` (whose handler spawns a
 * credentialed auth window) or an ordinary app-only card tool (`meeting_ui_list_rows`)
 * must be REFUSED, while the SAME tool invoked on a governed card origin ("mcp-app",
 * the arm that legitimately reaches app-only tools) still runs. The discriminator is
 * the effective invocation origin: the model's main-loop executor runs in no
 * `runWithInvocationOrigin` frame (undefined), the card arm runs inside one ("mcp-app").
 */
describe("executor refuses a model-origin call to an app-only tool (the model-uncallable half)", () => {
  const APP_ONLY = ["meeting_ui_list_rows", "meeting_auth_login"];

  function loadedWithSpy(): { registry: ToolRegistry; invoke: ReturnType<typeof vi.fn> } {
    const invoke = vi.fn(async (name: string) => ({ text: `ran ${name}` }));
    const registry = new ToolRegistry();
    registry.registerBatch([
      builtinTool("bash"),
      ...manifestToolsToMcpTools(MANIFEST).map((schema) => mcpToolToPluginTool(PLUGIN_ID, schema, invoke)),
    ]);
    return { registry, invoke };
  }

  /**
   * Auto-allow permission manager: the MAJOR-1 deny fires right after `findByName`,
   * BEFORE any permission check, so the model-origin case never consults this — it only
   * lets the app-origin (governed) case reach the tool's handler so the contrast is real.
   */
  function executorFor(registry: ToolRegistry): ToolExecutor {
    const permMgr = new PermissionManager("/tmp/nonexistent-model-exposure.json");
    permMgr.checkDetailed = () => ({ decision: "allow", reason: "test auto-allow", layer: 3 });
    return new ToolExecutor(registry, undefined, permMgr);
  }

  it("MODEL origin (no invocation-origin frame) is DENIED — is_error, and the app-only handler NEVER runs", async () => {
    for (const name of APP_ONLY) {
      const { registry, invoke } = loadedWithSpy();
      const [result] = await executorFor(registry).executeAll(
        [{ id: `tu-${name}`, name, input: {} }],
        {
          sessionId: "s",
          permissionContext: { trustOrigin: "llm-tool-arg", allowedPluginIds: new Set([PLUGIN_ID]) },
        },
      );
      expect(result.is_error, name).toBe(true);
      expect(invoke, `${name} handler must not run`).not.toHaveBeenCalled();
    }
  });

  it("APP origin (runWithInvocationOrigin 'mcp-app') reaches the SAME app-only tool's handler — the contrast", async () => {
    const { registry, invoke } = loadedWithSpy();
    const [result] = await runWithInvocationOrigin("mcp-app", undefined, () =>
      executorFor(registry).executeAll(
        [{ id: "tu-card", name: "meeting_ui_list_rows", input: {} }],
        {
          sessionId: "s",
          permissionContext: { trustOrigin: "plugin-emitted", allowedPluginIds: new Set([PLUGIN_ID]) },
        },
      ),
    );
    expect(result.is_error).toBeFalsy();
    expect(invoke).toHaveBeenCalledWith("meeting_ui_list_rows", {});
  });

  it("a MODEL-VISIBLE plugin tool is unaffected — the guard keys on modelVisible, not on being a plugin tool", async () => {
    const { registry, invoke } = loadedWithSpy();
    const [result] = await executorFor(registry).executeAll(
      [{ id: "tu-model", name: "meeting_start", input: {} }],
      {
        sessionId: "s",
        permissionContext: { trustOrigin: "llm-tool-arg", allowedPluginIds: new Set([PLUGIN_ID]) },
      },
    );
    expect(result.is_error).toBeFalsy();
    expect(invoke).toHaveBeenCalledWith("meeting_start", {});
  });
});
