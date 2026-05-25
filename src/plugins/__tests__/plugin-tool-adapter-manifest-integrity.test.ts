/**
 * Permission policy P4 Area C — plugin-tool-adapter manifest integrity integration test.
 *
 * Verifies the runtime-side post-violation gate: when a plugin's tool
 * throws {@link ManifestIntegrityViolation}, the adapter records the
 * violation, returns {isError:true, output: …}, and subsequent calls
 * fail-deny without reaching the plugin runtime.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { pluginToolsForRegistration } from "../plugin-tool-adapter.js";
import {
  ManifestIntegrityViolation,
  manifestIntegrityState,
} from "../../permissions/manifest-integrity.js";
import type { PluginRuntime } from "../runtime.js";
import type { PluginManifest } from "../types.js";

beforeEach(() => {
  manifestIntegrityState.resetForTests();
});

function makeManifest(pluginId = "rogue-plugin"): PluginManifest {
  return {
    id: pluginId,
    name: "rogue",
    version: "1.0.0",
    main: "x.js",
    tools: ["rogue_search"],
    toolSchemas: {
      rogue_search: {
        description: "Searches rogue data for a test query",
        category: "read",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
        },
      },
    },
  } as PluginManifest;
}

describe("Permission policy P4 plugin-tool-adapter manifest integrity gate", () => {
  it("records ManifestIntegrityViolation when the runtime throws it", async () => {
    const fakeRuntime = {
      isPluginEnabled: () => true,
      call: vi.fn(async () => {
        throw new ManifestIntegrityViolation(
          "rogue-plugin",
          "rogue_search",
          "writeFileSync",
        );
      }),
    } as unknown as PluginRuntime;
    const tools = pluginToolsForRegistration(
      fakeRuntime,
      "rogue-plugin",
      makeManifest(),
    );
    expect(tools).toHaveLength(1);
    const result = await tools[0].execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("manifest integrity");
    expect(manifestIntegrityState.isDisabled("rogue-plugin")).toBe(true);
  });

  it("subsequent calls fail-deny without invoking pluginRuntime", async () => {
    await manifestIntegrityState.recordViolation(
      "rogue-plugin",
      "rogue_search",
      "writeFileSync",
    );
    const fakeRuntime = {
      isPluginEnabled: () => true,
      call: vi.fn(async () => "ok"),
    } as unknown as PluginRuntime;
    const tools = pluginToolsForRegistration(
      fakeRuntime,
      "rogue-plugin",
      makeManifest(),
    );
    const result = await tools[0].execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("disabled");
    expect(fakeRuntime.call).not.toHaveBeenCalled();
  });

  it("normal tools pass through with SDK-backed authority metadata", async () => {
    const fakeRuntime = {
      isPluginEnabled: () => true,
      call: vi.fn(async () => ({ items: ["a", "b"] })),
    } as unknown as PluginRuntime;
    const tools = pluginToolsForRegistration(
      fakeRuntime,
      "good-plugin",
      makeManifest("good-plugin"),
    );
    expect(tools[0].category).toBe("read");
    expect(tools[0].isReadOnly({})).toBe(true);
    expect(tools[0].pathFields).toBeUndefined();
    const result = await tools[0].execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("items");
  });

  it("violation IPC + audit listeners fire on first violation", async () => {
    const auditSpy = vi.fn();
    manifestIntegrityState.onViolation(auditSpy);
    const fakeRuntime = {
      isPluginEnabled: () => true,
      call: vi.fn(async () => {
        throw new ManifestIntegrityViolation("p1", "t1", "rmSync");
      }),
    } as unknown as PluginRuntime;
    const tools = pluginToolsForRegistration(
      fakeRuntime,
      "p1",
      makeManifest("p1"),
    );
    await tools[0].execute({ q: "x" }, {} as never);
    expect(auditSpy).toHaveBeenCalledWith("p1", "t1", "rmSync");
  });

  it("non-integrity errors flow through normal failure path (no record)", async () => {
    const fakeRuntime = {
      isPluginEnabled: () => true,
      call: vi.fn(async () => {
        throw new Error("network down");
      }),
    } as unknown as PluginRuntime;
    const tools = pluginToolsForRegistration(
      fakeRuntime,
      "ok-plugin",
      makeManifest("ok-plugin"),
    );
    const result = await tools[0].execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("network down");
    expect(manifestIntegrityState.isDisabled("ok-plugin")).toBe(false);
  });
});
