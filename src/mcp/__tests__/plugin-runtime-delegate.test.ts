/**
 * `pluginRuntimeToolDelegate` parity (mcp-alignment-design.md §5 plugin-loopback-server).
 *
 * The loopback delegate must reproduce buildPluginTool's execute gate exactly:
 * inactive / integrity-disabled fail closed, ManifestIntegrityViolation records
 * + fails closed, and the structured return value survives as
 * _meta["xyz.lvis/rawResult"]. A host-level test asserts that raw value reaches
 * the registered Tool's metadata.rawResult (the executor.ts / boot.ts contract).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { pluginRuntimeToolDelegate, RAW_RESULT_META } from "../plugin-runtime-delegate.js";
import { PluginMcpHost } from "../plugin-mcp-host.js";
import { ToolRegistry } from "../../tools/registry.js";
import {
  ManifestIntegrityViolation,
  manifestIntegrityState,
} from "../../permissions/manifest-integrity.js";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { PluginManifest } from "../../plugins/types.js";

beforeEach(() => manifestIntegrityState.resetForTests());

const PLUGIN_ID = "com.example.notes";

function fakeRuntime(over: Partial<Pick<PluginRuntime, "isPluginEnabled" | "call">>): PluginRuntime {
  return {
    isPluginEnabled: () => true,
    call: vi.fn(async () => "ok"),
    ...over,
  } as unknown as PluginRuntime;
}

describe("pluginRuntimeToolDelegate — fail-closed gate parity", () => {
  it("inactive plugin → isError without invoking the runtime", async () => {
    const call = vi.fn(async () => "should-not-run");
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ isPluginEnabled: () => false, call }),
      PLUGIN_ID,
    );
    const out = await delegate("notes_read", {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("inactive");
    expect(call).not.toHaveBeenCalled();
  });

  it("integrity-disabled plugin → isError without invoking the runtime", async () => {
    await manifestIntegrityState.recordViolation(PLUGIN_ID, "notes_read", "writeFileSync");
    const call = vi.fn(async () => "should-not-run");
    const delegate = pluginRuntimeToolDelegate(fakeRuntime({ call }), PLUGIN_ID);
    const out = await delegate("notes_read", {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("disabled after a manifest integrity violation");
    expect(call).not.toHaveBeenCalled();
  });

  it("success carries the raw value in _meta and renders text", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ call: vi.fn(async () => ({ items: ["a", "b"] })) }),
      PLUGIN_ID,
    );
    const out = await delegate("notes_read", { q: "x" });
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toBe(JSON.stringify({ items: ["a", "b"] }, null, 2));
    expect(out._meta?.[RAW_RESULT_META]).toEqual({ items: ["a", "b"] });
  });

  it("empty args → runtime receives undefined payload (parity with buildPluginTool)", async () => {
    const call = vi.fn(async () => "ok");
    const delegate = pluginRuntimeToolDelegate(fakeRuntime({ call }), PLUGIN_ID);
    await delegate("notes_read", {});
    expect(call).toHaveBeenCalledWith("notes_read", undefined);
  });

  it("ManifestIntegrityViolation → records the violation and fails closed", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => {
          throw new ManifestIntegrityViolation(PLUGIN_ID, "notes_read", "writeFileSync");
        }),
      }),
      PLUGIN_ID,
    );
    const out = await delegate("notes_read", { q: "x" });
    expect(out.isError).toBe(true);
    expect(manifestIntegrityState.isDisabled(PLUGIN_ID)).toBe(true);
  });

  it("ordinary thrown error → isError outcome", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
      PLUGIN_ID,
    );
    const out = await delegate("notes_read", {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe("boom");
  });
});

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Notes",
  version: "1.0.0",
  entry: "dist/index.js",
  description: "notes",
  tools: ["notes_read"],
  toolSchemas: {
    notes_read: {
      description: "Read",
      category: "read",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
  },
} as PluginManifest;

describe("end-to-end: raw plugin value survives manifest → server → host → metadata.rawResult", () => {
  it("registered Tool surfaces metadata.rawResult from the plugin return value", async () => {
    const registry = new ToolRegistry();
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ call: vi.fn(async () => ({ hits: 3 })) }),
      PLUGIN_ID,
    );
    const host = PluginMcpHost.loopback(MANIFEST, delegate, registry);
    await host.start();

    const result = await registry.findByName("notes_read")!.execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(false);
    expect(result.metadata?.rawResult).toEqual({ hits: 3 });
  });
});
