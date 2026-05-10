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

function makeManifest(category: string): PluginManifest {
  return {
    id: "rogue-plugin",
    name: "rogue",
    version: "1.0.0",
    main: "x.js",
    tools: ["rogue_search"],
    toolSchemas: {
      rogue_search: {
        category: category as PluginManifest["toolSchemas"][string]["category"],
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
        },
      },
    },
  } as PluginManifest;
}

function makePathFieldsManifest(pathFields: unknown): PluginManifest {
  return {
    id: "path-plugin",
    name: "path",
    version: "1.0.0",
    main: "x.js",
    tools: ["path_scan"],
    toolSchemas: {
      path_scan: {
        category: "read",
        pathFields: pathFields as string[],
        inputSchema: {
          type: "object",
          properties: { targetPath: { type: "string" } },
        },
      },
    },
  } as PluginManifest;
}

describe("Permission policy P4 plugin-tool-adapter manifest integrity gate", () => {
  it("records ManifestIntegrityViolation when the runtime throws it", async () => {
    const fakeRuntime = {
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
      makeManifest("read"),
    );
    expect(tools).toHaveLength(1);
    const result = await tools[0].execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("declared category=read");
    expect(manifestIntegrityState.isDisabled("rogue-plugin")).toBe(true);
  });

  it("subsequent calls fail-deny without invoking pluginRuntime", async () => {
    manifestIntegrityState.recordViolation(
      "rogue-plugin",
      "rogue_search",
      "writeFileSync",
    );
    const fakeRuntime = {
      call: vi.fn(async () => "ok"),
    } as unknown as PluginRuntime;
    const tools = pluginToolsForRegistration(
      fakeRuntime,
      "rogue-plugin",
      makeManifest("read"),
    );
    const result = await tools[0].execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("disabled");
    expect(fakeRuntime.call).not.toHaveBeenCalled();
  });

  it("write-declared tools are NOT subject to the post-violation gate", async () => {
    // Write tools never get the read-only fs proxy, so they cannot
    // trigger the plugin-wide disable path for read-only violations.
    const fakeRuntime = {
      call: vi.fn(async () => "wrote ok"),
    } as unknown as PluginRuntime;
    const tools = pluginToolsForRegistration(
      fakeRuntime,
      "rogue-plugin",
      makeManifest("write"),
    );
    const result = await tools[0].execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("wrote ok");
  });

  it("read tools that read normally pass through unchanged", async () => {
    const fakeRuntime = {
      call: vi.fn(async () => ({ items: ["a", "b"] })),
    } as unknown as PluginRuntime;
    const tools = pluginToolsForRegistration(
      fakeRuntime,
      "good-plugin",
      makeManifest("read"),
    );
    const result = await tools[0].execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("items");
  });

  it("rejects malformed pathFields before exposing them to ToolExecutor", () => {
    const fakeRuntime = {
      call: vi.fn(async () => "ok"),
    } as unknown as PluginRuntime;
    expect(() =>
      pluginToolsForRegistration(
        fakeRuntime,
        "path-plugin",
        makePathFieldsManifest(["targetPath", "", 123, null, "targetPath"]),
      ),
    ).toThrow(/pathFields\[1\] must be a non-empty string/);
  });

  it("keeps valid pathFields unchanged for ToolExecutor", () => {
    const fakeRuntime = {
      call: vi.fn(async () => "ok"),
    } as unknown as PluginRuntime;
    const tools = pluginToolsForRegistration(
      fakeRuntime,
      "path-plugin",
      makePathFieldsManifest(["targetPath"]),
    );
    expect(tools[0].pathFields).toEqual(["targetPath"]);
  });

  it("uses the current SDK contract's conservative write policy when category is absent", () => {
    const fakeRuntime = {
      call: vi.fn(async () => "ok"),
    } as unknown as PluginRuntime;
    const manifest = makeManifest("read");
    delete manifest.toolSchemas!.rogue_search.category;
    const tools = pluginToolsForRegistration(fakeRuntime, "rogue-plugin", manifest);
    expect(tools[0].category).toBe("write");
    expect(tools[0].isReadOnly({})).toBe(false);
  });

  it("violation IPC + audit listeners fire on first violation", async () => {
    const auditSpy = vi.fn();
    manifestIntegrityState.onViolation(auditSpy);
    const fakeRuntime = {
      call: vi.fn(async () => {
        throw new ManifestIntegrityViolation("p1", "t1", "rmSync");
      }),
    } as unknown as PluginRuntime;
    const tools = pluginToolsForRegistration(
      fakeRuntime,
      "p1",
      makeManifest("read"),
    );
    await tools[0].execute({ q: "x" }, {} as never);
    expect(auditSpy).toHaveBeenCalledWith("p1", "t1", "rmSync");
  });

  it("non-integrity errors flow through normal failure path (no record)", async () => {
    const fakeRuntime = {
      call: vi.fn(async () => {
        throw new Error("network down");
      }),
    } as unknown as PluginRuntime;
    const tools = pluginToolsForRegistration(
      fakeRuntime,
      "ok-plugin",
      makeManifest("read"),
    );
    const result = await tools[0].execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("network down");
    expect(manifestIntegrityState.isDisabled("ok-plugin")).toBe(false);
  });
});
