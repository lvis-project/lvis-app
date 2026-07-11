/**
 * The `oncalltool` backends — the SPEC MUST (`_meta.ui.visibility` ∋ "app") and the
 * "always through the host gate, never a raw tools/call" invariant, for BOTH arms.
 *
 * The external arm is proved end-to-end across its two halves: `mcp-tool-adapter`
 * materializes the visibility bit ONCE at ingestion, and `createExternalToolCallSource`
 * is the ONE reader that enforces it.
 */
import { describe, it, expect, vi } from "vitest";
import { createExternalToolCallSource, createLoopbackToolCallSource } from "../mcp-ui-tool-call.js";
import { mcpToolToTool } from "../mcp-tool-adapter.js";
import type { McpToolSchema, McpUiToolVisibility } from "../types.js";
import type { Tool } from "../../tools/base.js";

function schema(name: string, visibility?: McpUiToolVisibility[] | unknown): McpToolSchema {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    ...(visibility === undefined ? {} : { _meta: { ui: { visibility } } }),
  } as McpToolSchema;
}

/** A registry `Tool` exactly as the host builds it from an external server's tools/list. */
function externalTool(serverId: string, name: string, visibility?: McpUiToolVisibility[] | unknown): Tool {
  return mcpToolToTool(serverId, `mcp_gh_${name}`, schema(name, visibility), async () => ({ text: "ok" }));
}

function externalSource(tools: Tool[], invoker = vi.fn(async () => "tool-output")) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const source = createExternalToolCallSource({
    // Same shape as governance namespacing: prefix unless already prefixed.
    namespacedToolName: (_serverId, toolName) =>
      toolName.startsWith("mcp_gh_") ? toolName : `mcp_gh_${toolName}`,
    findTool: (name) => byName.get(name),
    getInvoker: () => invoker,
  });
  return { source, invoker };
}

describe("mcp-tool-adapter — app visibility is materialized ONCE, at ingestion", () => {
  it("applies the MCP Apps spec default [\"model\",\"app\"] when the server declares nothing", () => {
    expect(externalTool("github", "query").appInvokable).toBe(true);
  });

  it("honours an explicit app visibility (app-only and dual)", () => {
    expect(externalTool("github", "query", ["app"]).appInvokable).toBe(true);
    expect(externalTool("github", "query", ["model", "app"]).appInvokable).toBe(true);
  });

  it("marks a model-only tool as NOT app-invokable", () => {
    expect(externalTool("github", "query", ["model"]).appInvokable).toBe(false);
  });

  it("fails closed on a malformed visibility declaration", () => {
    expect(externalTool("github", "query", "app").appInvokable).toBe(false);
    expect(externalTool("github", "query", ["app", "everyone"]).appInvokable).toBe(false);
    expect(externalTool("github", "query", []).appInvokable).toBe(false);
  });
});

describe("external tool-call source — ownership comes from the registry entry", () => {
  it("resolves the owner from the namespaced registry entry's mcpServerId", () => {
    const { source } = externalSource([externalTool("github", "query")]);
    expect(source.resolveToolOwner("github", "query")).toBe("github");
  });

  it("resolves an unknown tool to undefined (the caller's owner check then denies it)", () => {
    const { source } = externalSource([externalTool("github", "query")]);
    expect(source.resolveToolOwner("github", "not_a_tool")).toBeUndefined();
  });

  it("resolves a HOST BUILTIN to undefined — a builtin has no mcpServerId", () => {
    const bash = { name: "mcp_gh_bash", mcpServerId: undefined } as unknown as Tool;
    const { source } = externalSource([bash]);
    expect(source.resolveToolOwner("github", "bash")).toBeUndefined();
  });
});

describe("external tool-call source — the SPEC MUST (visibility) and the gate", () => {
  it("REJECTS a tool whose _meta.ui.visibility does not include \"app\" and never invokes it", async () => {
    const { source, invoker } = externalSource([externalTool("github", "query", ["model"])]);

    await expect(source.callTool("github", "query", {})).rejects.toThrow(/not app-callable/i);
    expect(invoker).not.toHaveBeenCalled();
  });

  it("fails closed for a registry entry that never went through the adapter (no appInvokable)", async () => {
    const raw = { name: "mcp_gh_query", mcpServerId: "github" } as unknown as Tool;
    const { source, invoker } = externalSource([raw]);

    await expect(source.callTool("github", "query", {})).rejects.toThrow(/not app-callable/i);
    expect(invoker).not.toHaveBeenCalled();
  });

  it("runs an app-visible tool through the GATED executor delegate — never a raw mcpManager.callTool", async () => {
    const { source, invoker } = externalSource([externalTool("github", "query", ["model", "app"])]);

    await expect(source.callTool("github", "query", { q: "x" })).resolves.toBe("tool-output");
    // The NAMESPACED registry name (the gated `Tool`), the app's args, and a
    // foreground UI origin that is NEVER marked user-initiated.
    expect(invoker).toHaveBeenCalledWith("mcp_gh_query", { q: "x" }, { origin: "ui", userAction: false });
  });

  it("denies the call when the executor is not wired yet", async () => {
    const byName = new Map([["mcp_gh_query", externalTool("github", "query")]]);
    const source = createExternalToolCallSource({
      namespacedToolName: (_s, n) => `mcp_gh_${n}`,
      findTool: (n) => byName.get(n),
      getInvoker: () => null,
    });
    await expect(source.callTool("github", "query", {})).rejects.toThrow(/not wired/i);
  });
});

describe("loopback tool-call source — plugin methods through callFromUi", () => {
  it("resolves the owner from the runtime method map (a loopback serverId IS a pluginId)", () => {
    const runtime = {
      resolveToolOwner: vi.fn((m: string) => (m === "acme_open" ? "acme-cards" : undefined)),
      callFromUi: vi.fn(async () => "plugin-result"),
    };
    const source = createLoopbackToolCallSource(runtime);

    expect(source.resolveToolOwner("acme-cards", "acme_open")).toBe("acme-cards");
    expect(source.resolveToolOwner("acme-cards", "other_open")).toBeUndefined();
  });

  it("delegates to callFromUi (which enforces the visibility MUST + the gate) with userAction:false", async () => {
    const runtime = {
      resolveToolOwner: vi.fn(() => "acme-cards"),
      callFromUi: vi.fn(async () => "plugin-result"),
    };
    const source = createLoopbackToolCallSource(runtime);

    await expect(source.callTool("acme-cards", "acme_open", { id: 7 })).resolves.toBe("plugin-result");
    expect(runtime.callFromUi).toHaveBeenCalledWith("acme_open", { id: 7 }, { userAction: false });
  });

  it("propagates callFromUi's visibility denial (a tool without app visibility) unchanged", async () => {
    const runtime = {
      resolveToolOwner: vi.fn(() => "acme-cards"),
      // Exactly what `assertUiActionInvokable` throws for a non-app-visible method.
      callFromUi: vi.fn(async () => {
        throw new Error(
          "Method 'acme_secret' is not declared as a UI action for plugin 'acme-cards'.",
        );
      }),
    };
    const source = createLoopbackToolCallSource(runtime);

    await expect(source.callTool("acme-cards", "acme_secret", {})).rejects.toThrow(
      /not declared as a UI action/,
    );
  });
});
