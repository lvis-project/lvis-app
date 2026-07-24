/**
 * `PluginRuntime.readUiResource` — the host-side chokepoint of the plugin
 * CONTENT-serving seam (the plugin serves its own `ui://` card bytes; the host
 * relays them, and no longer resolves/reads a plugin-declared disk path).
 *
 * The provider (`plugin-ui-resource-provider.ts`) already enforced the serving
 * POLICY (own-namespace + declared-only). What is proven here is what only the
 * runtime can enforce:
 *   - the SAME fail-closed runtime gates `pluginRuntimeToolDelegate` applies to
 *     `tools/call` — an inactive or integrity-disabled plugin cannot render a card
 *     any more than it can run a tool (this path previously checked NEITHER);
 *   - the hook is BOUNDED — a plugin hook, unlike a file read, can hang or return
 *     an unbounded body: timeout + size cap, both fail-closed.
 *
 * The runtime is built with a hand-crafted plugins map (the same seam
 * `ui-action-ceiling.test.ts` uses) so the REAL method runs without a plugin entry
 * file. `ceilingMs` is a defaulted (= SOT) parameter used only as a test seam.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_UI_RESOURCE_HTML_BYTES } from "../index.js";
import { TestPluginRuntime as PluginRuntime } from "../../__tests__/test-helpers.js";
import { manifestIntegrityState } from "../../../permissions/manifest-integrity.js";
import { sessionContext } from "../../../engine/session-context.js";
import type { RuntimePlugin } from "../../types.js";

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PLUGIN_ID = "com.cards";
const URI = `ui://${PLUGIN_ID}/card.html`;

beforeEach(() => manifestIntegrityState.resetForTests());

/** A runtime holding one loaded plugin whose instance serves (or doesn't) a card. */
function runtimeWithCardPlugin(instance: Partial<RuntimePlugin>): PluginRuntime {
  const rt = new PluginRuntime({ hostRoot: HOST_ROOT, manifestPaths: [] });
  const internals = rt as unknown as {
    plugins: Map<string, { manifest: unknown; instance: Partial<RuntimePlugin> }>;
    knownInstallClaims: Map<string, string | null>;
  };
  internals.plugins.set(PLUGIN_ID, {
    manifest: { id: PLUGIN_ID, tools: [], uiResources: [{ uri: URI }] },
    instance: { handlers: {}, ...instance },
  });
  internals.knownInstallClaims.set(PLUGIN_ID, null);
  return rt;
}

describe("PluginRuntime.readUiResource — the plugin serves its own card", () => {
  it("returns the HTML the plugin's readUiResource hook produced", async () => {
    const hook = vi.fn(async (uri: string) => `<h1>${uri}</h1>`);
    const rt = runtimeWithCardPlugin({ readUiResource: hook });
    await expect(rt.readUiResource(PLUGIN_ID, URI)).resolves.toBe(`<h1>${URI}</h1>`);
    expect(hook).toHaveBeenCalledWith(URI);
  });

  it("accepts a synchronous hook (the contract allows string | Promise<string>)", async () => {
    const rt = runtimeWithCardPlugin({ readUiResource: () => "<p>sync</p>" });
    await expect(rt.readUiResource(PLUGIN_ID, URI)).resolves.toBe("<p>sync</p>");
  });

  it("throws when the plugin is not loaded", async () => {
    const rt = runtimeWithCardPlugin({ readUiResource: () => "<p>x</p>" });
    await expect(rt.readUiResource("com.absent", "ui://com.absent/card.html")).rejects.toThrow(
      /not active/i,
    );
  });

  it("throws when the plugin declares ui:// resources but implements no hook", async () => {
    const rt = runtimeWithCardPlugin({});
    await expect(rt.readUiResource(PLUGIN_ID, URI)).rejects.toThrow(/does not implement readUiResource/i);
  });

  it("throws when the hook returns a non-string", async () => {
    const rt = runtimeWithCardPlugin({
      readUiResource: () => ({ html: "<p>nope</p>" } as unknown as string),
    });
    await expect(rt.readUiResource(PLUGIN_ID, URI)).rejects.toThrow(/expected the card HTML as a string/i);
  });
});

describe("PluginRuntime.readUiResource — fail-closed runtime gates (parity with tools/call)", () => {
  it("inactive plugin → refused WITHOUT invoking the hook", async () => {
    const hook = vi.fn(() => "<h1>should-not-run</h1>");
    const rt = runtimeWithCardPlugin({ readUiResource: hook });
    await rt.setPluginEnabled(PLUGIN_ID, false);

    await expect(rt.readUiResource(PLUGIN_ID, URI)).rejects.toThrow(/inactive/i);
    expect(hook).not.toHaveBeenCalled();
  });

  it("registry-disabled + session-activated → refused after the generation is unloaded", async () => {
    const hook = vi.fn(() => "<h1>routine card</h1>");
    const rt = runtimeWithCardPlugin({ readUiResource: hook });
    await rt.setPluginEnabled(PLUGIN_ID, false);
    rt.setSessionActivated("routine-session-A", PLUGIN_ID);

    await expect(
      sessionContext.run({ sessionId: "routine-session-A" }, () => rt.readUiResource(PLUGIN_ID, URI)),
    ).rejects.toThrow(/generation is not active/i);
    expect(hook).not.toHaveBeenCalled();
  });

  it("integrity-disabled plugin → refused WITHOUT invoking the hook", async () => {
    const hook = vi.fn(() => "<h1>should-not-run</h1>");
    const rt = runtimeWithCardPlugin({ readUiResource: hook });
    await manifestIntegrityState.recordViolation(PLUGIN_ID, "card_open", "writeFileSync");

    await expect(rt.readUiResource(PLUGIN_ID, URI)).rejects.toThrow(
      /disabled after a manifest integrity violation/i,
    );
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("PluginRuntime.readUiResource — the hook is BOUNDED (a file read can't hang; a hook can)", () => {
  it("rejects at the ceiling when the hook never resolves (the render path does not hang)", async () => {
    const rt = runtimeWithCardPlugin({ readUiResource: () => new Promise<string>(() => {}) });
    // small ceiling via the test seam — the SOT default (pluginUiResourceReadMs) is untouched
    await expect(rt.readUiResource(PLUGIN_ID, URI, 5)).rejects.toThrow(
      /exceeded global ceiling \(5ms\): com\.cards\.readUiResource/,
    );
  });

  it("rejects HTML over the size cap (fail-closed — no oversized body reaches the render path)", async () => {
    const oversized = "x".repeat(MAX_UI_RESOURCE_HTML_BYTES + 1);
    const rt = runtimeWithCardPlugin({ readUiResource: () => oversized });
    await expect(rt.readUiResource(PLUGIN_ID, URI)).rejects.toThrow(
      new RegExp(`over the ${MAX_UI_RESOURCE_HTML_BYTES}-byte card limit`),
    );
  });

  it("serves HTML exactly at the size cap (the boundary is inclusive)", async () => {
    const atCap = "x".repeat(MAX_UI_RESOURCE_HTML_BYTES);
    const rt = runtimeWithCardPlugin({ readUiResource: () => atCap });
    await expect(rt.readUiResource(PLUGIN_ID, URI)).resolves.toHaveLength(MAX_UI_RESOURCE_HTML_BYTES);
  });
});
