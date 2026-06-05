/**
 * #1182 — pluginToolsForRegistration drops tools whose inputSchema would make
 * OpenAI/Azure reject the whole request (e.g. an `array` property without
 * `items`), fail-soft, instead of letting one bad tool take down the turn.
 */
import { describe, expect, it, vi } from "vitest";
import { pluginToolsForRegistration } from "../plugin-tool-adapter.js";
import type { PluginRuntime } from "../runtime.js";
import type { PluginManifest } from "../types.js";

const runtime = {
  isPluginEnabled: vi.fn(() => true),
  call: vi.fn(),
} as unknown as PluginRuntime;

function manifest(toolSchemas: Record<string, unknown>): PluginManifest {
  return {
    id: "p",
    name: "p",
    version: "1.0.0",
    main: "x.js",
    tools: Object.keys(toolSchemas),
    toolSchemas,
  } as unknown as PluginManifest;
}

describe("pluginToolsForRegistration — provider-strict lint (#1182)", () => {
  it("drops a tool with an array property missing items, keeps the rest, and does not throw", () => {
    const tools = pluginToolsForRegistration(
      runtime,
      "p",
      manifest({
        good: { category: "read", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
        bad: { category: "read", inputSchema: { type: "object", properties: { tags: { type: "array" } } } },
      }),
    );
    expect(tools.map((t) => t.name)).toEqual(["good"]);
  });

  it("drops the meeting v0.5.21 union-type incident schema", () => {
    const tools = pluginToolsForRegistration(
      runtime,
      "p",
      manifest({
        meeting_register_scheduled_meeting: {
          category: "write",
          inputSchema: {
            type: "object",
            properties: { meetingAgenda: { type: ["string", "array"] } },
          },
        },
      }),
    );
    expect(tools).toHaveLength(0);
  });

  it("keeps a tool whose array property correctly declares items", () => {
    const tools = pluginToolsForRegistration(
      runtime,
      "p",
      manifest({
        ok: {
          category: "read",
          inputSchema: { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } },
        },
      }),
    );
    expect(tools.map((t) => t.name)).toEqual(["ok"]);
  });

  it("still throws on a structural/authority error (missing category) — boot relies on this", () => {
    expect(() =>
      pluginToolsForRegistration(
        runtime,
        "p",
        manifest({ no_cat: { inputSchema: { type: "object", properties: { q: { type: "string" } } } } }),
      ),
    ).toThrow(/category is required/);
  });
});
