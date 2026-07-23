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

describe("mcp-tool-adapter — BOTH visibility bits are materialized ONCE, at ingestion", () => {
  it("applies the MCP Apps spec default [\"model\",\"app\"] when the server declares nothing", () => {
    const t = externalTool("github", "query");
    expect(t.appInvokable).toBe(true);
    expect(t.modelVisible).toBe(true);
  });

  it("honours an explicit app visibility (app-only and dual)", () => {
    expect(externalTool("github", "query", ["app"]).appInvokable).toBe(true);
    expect(externalTool("github", "query", ["model", "app"]).appInvokable).toBe(true);
  });

  it("marks a model-only tool as NOT app-invokable", () => {
    expect(externalTool("github", "query", ["model"]).appInvokable).toBe(false);
  });

  it("marks an APP-ONLY tool as NOT model-visible — the spec says the model must not see it", () => {
    // This is the external-arm half of the same declaration: `["app"]` is
    // card-callable AND hidden from the model. The tool is still REGISTERED (that is
    // what puts its card's call under the host gate); `modelVisible: false` is what
    // subtracts it from the model's tool list, at the registry's one boundary.
    const appOnly = externalTool("github", "list_rows", ["app"]);
    expect(appOnly.appInvokable).toBe(true);
    expect(appOnly.modelVisible).toBe(false);
    // …and a dual/model tool stays exposed.
    expect(externalTool("github", "query", ["model", "app"]).modelVisible).toBe(true);
    expect(externalTool("github", "query", ["model"]).modelVisible).toBe(true);
  });

  it("fails closed on a malformed visibility declaration — no app surface, still model-governed", () => {
    for (const malformed of ["app", ["app", "everyone"], []]) {
      const t = externalTool("github", "query", malformed);
      // An unrecognized shape must not silently widen the app surface…
      expect(t.appInvokable).toBe(false);
      // …and resolves to the shared minimal governed surface ["model"], so the tool
      // stays LLM-reachable through the executor rather than becoming unreachable.
      expect(t.modelVisible).toBe(true);
    }
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
    // The NAMESPACED registry name (the gated `Tool`), the app's args, and the
    // APP origin (never "ui" — a card is not the plugin's trusted panel) that is
    // never marked user-initiated.
    expect(invoker).toHaveBeenCalledWith("mcp_gh_query", { q: "x" }, {
      origin: "mcp-app",
      userAction: false,
      expectedMcpServerId: "github",
    });
  });

  it("runs an APP-ONLY tool through the same GATED delegate — parity with the plugin arm", async () => {
    // `["app"]` is the spec's spelling for a card-serving, model-hidden tool. On this
    // arm it was always registered and callable; the plugin arm now behaves the same
    // way. Both land on the executor — same origin, same no-gesture, same gate.
    const { source, invoker } = externalSource([externalTool("github", "list_rows", ["app"])]);

    await expect(source.callTool("github", "list_rows", { page: 2 })).resolves.toBe("tool-output");
    expect(invoker).toHaveBeenCalledWith("mcp_gh_list_rows", { page: 2 }, {
      origin: "mcp-app",
      userAction: false,
      expectedMcpServerId: "github",
    });
  });

  it("rechecks the exact server owner at invocation time", async () => {
    const { source, invoker } = externalSource([externalTool("replacement", "query", ["app"])]);
    await expect(source.callTool("github", "query", {})).rejects.toThrow(/owner changed/);
    expect(invoker).not.toHaveBeenCalled();
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

describe("loopback tool-call source — plugin methods through callFromApp", () => {
  it("resolves the owner from the runtime method map (a loopback serverId IS a pluginId)", () => {
    const runtime = {
      resolveToolOwner: vi.fn((m: string) => (m === "acme_open" ? "acme-cards" : undefined)),
      callFromApp: vi.fn(async () => "plugin-result"),
    };
    const source = createLoopbackToolCallSource(runtime);

    expect(source.resolveToolOwner("acme-cards", "acme_open")).toBe("acme-cards");
    expect(source.resolveToolOwner("acme-cards", "other_open")).toBeUndefined();
  });

  it("delegates to callFromApp (visibility MUST + the gate) — NOT callFromUi", async () => {
    // The security-load-bearing wiring: a card is not the plugin's trusted panel,
    // so it must not take the panel's invocation path. `callFromUi` dispatches
    // `origin: "ui"`, the ONE origin from which the ungoverned app-only dispatch
    // (`callDeclaredAppOnlyTool` — no risk check, no reviewer, no approval, no
    // audit) is reachable. This source must never reach it.
    const callFromUi = vi.fn(async () => "panel-path");
    const runtime = {
      resolveToolOwner: vi.fn(() => "acme-cards"),
      callFromApp: vi.fn(async () => "plugin-result"),
      callFromUi,
    };
    const source = createLoopbackToolCallSource(runtime);

    await expect(source.callTool("acme-cards", "acme_open", { id: 7 })).resolves.toBe("plugin-result");
    // Two args: there is no `userAction` option on the app path at all.
    expect(runtime.callFromApp).toHaveBeenCalledWith("acme_open", { id: 7 });
    expect(callFromUi).not.toHaveBeenCalled();
  });

  it("propagates callFromApp's visibility denial (a tool without app visibility) unchanged", async () => {
    const runtime = {
      resolveToolOwner: vi.fn(() => "acme-cards"),
      // Exactly what `assertUiActionInvokable` throws for a non-app-visible method.
      callFromApp: vi.fn(async () => {
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

  it("passes an APP-ONLY tool straight to callFromApp — no deny of its own", async () => {
    // The source is a thin two-member seam: it does not know or care about
    // visibility. `callFromApp` owns the spec MUST (`assertUiActionInvokable`) and
    // the gate, and an app-only tool is a governed registry `Tool` now — so this
    // call is dispatched, not refused. (Pre-fix the runtime threw
    // `mcp-app-tool-not-app-callable` here, because an app-only tool had no registry
    // entry and therefore no gate to run under.)
    const runtime = {
      resolveToolOwner: vi.fn(() => "acme-cards"),
      callFromApp: vi.fn(async () => "governed-result"),
    };
    const source = createLoopbackToolCallSource(runtime);

    await expect(source.callTool("acme-cards", "acme_auth_status", { q: 1 })).resolves.toBe(
      "governed-result",
    );
    expect(runtime.callFromApp).toHaveBeenCalledWith("acme_auth_status", { q: 1 });
  });
});
