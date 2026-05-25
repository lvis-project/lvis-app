/**
 * plugin-tool-adapter active/inactive execution gate.
 *
 * The adapter's `execute` closure is the single chokepoint every model/agent
 * tool call flows through — the main agent and any sub-agent run the *same*
 * Tool object out of their respective registries. resolveToolScope hides an
 * inactive plugin's tools from the main agent's schema set, but a sub-agent's
 * `sourceTools` allowlist is not filtered by isPluginEnabled, so without a
 * dispatch-level gate a sub-agent could execute an inactive plugin's tool.
 *
 * These tests verify the gate fails closed: an inactive plugin's tool returns
 * {isError:true} without ever reaching pluginRuntime.call(), while an active
 * plugin's tool passes through unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import { pluginToolsForRegistration } from "../plugin-tool-adapter.js";
import type { PluginRuntime } from "../runtime.js";
import type { PluginManifest } from "../types.js";

function makeManifest(pluginId = "indexer-plugin"): PluginManifest {
  return {
    id: pluginId,
    name: "indexer",
    version: "1.0.0",
    main: "x.js",
    tools: ["index_scan"],
    toolSchemas: {
      index_scan: {
        description: "Scans the index for a test query",
        category: "read",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
        },
      },
    },
  } as PluginManifest;
}

describe("plugin-tool-adapter — active/inactive execution gate", () => {
  it("refuses to execute an inactive plugin's tool without invoking the runtime", async () => {
    const call = vi.fn(async () => ({ items: ["a"] }));
    const fakeRuntime = {
      isPluginEnabled: vi.fn(() => false),
      call,
    } as unknown as PluginRuntime;

    const tools = pluginToolsForRegistration(fakeRuntime, "indexer-plugin", makeManifest());
    const result = await tools[0].execute({ q: "x" }, {} as never);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("inactive");
    expect(result.output).toContain("index_scan");
    // Fail-closed: the disabled plugin's handler is never reached.
    expect(call).not.toHaveBeenCalled();
  });

  it("executes normally when the plugin is active", async () => {
    const call = vi.fn(async () => ({ items: ["a", "b"] }));
    const fakeRuntime = {
      isPluginEnabled: vi.fn(() => true),
      call,
    } as unknown as PluginRuntime;

    const tools = pluginToolsForRegistration(fakeRuntime, "indexer-plugin", makeManifest());
    const result = await tools[0].execute({ q: "x" }, {} as never);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("items");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("re-checks active state per call, so a mid-session disable is honored", async () => {
    const call = vi.fn(async () => "ok");
    let enabled = true;
    const fakeRuntime = {
      isPluginEnabled: vi.fn(() => enabled),
      call,
    } as unknown as PluginRuntime;

    const tools = pluginToolsForRegistration(fakeRuntime, "indexer-plugin", makeManifest());

    const first = await tools[0].execute({ q: "x" }, {} as never);
    expect(first.isError).toBe(false);

    enabled = false;
    const second = await tools[0].execute({ q: "x" }, {} as never);
    expect(second.isError).toBe(true);
    expect(second.output).toContain("inactive");
    // call() ran exactly once — only for the active invocation.
    expect(call).toHaveBeenCalledTimes(1);
  });
});
