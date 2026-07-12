/**
 * `createPluginUiResourceProvider` — the single fail-closed POLICY chokepoint for
 * serving a first-party plugin's OWN `ui://` MCP App cards.
 *
 * Content-serving: the plugin supplies the card bytes (`readHtml`, wired to
 * `PluginRuntime.readUiResource`), the manifest supplies the policy. The module is
 * PURE — no fs, no path — so these tests need no disk fixtures. Proves:
 *   - serves a declared own-namespace resource (plugin html + the MANIFEST's csp),
 *   - rejects a cross-plugin uri authority (own-namespace-only),
 *   - rejects an undeclared uri — and never asks the plugin for it,
 *   - a rejecting plugin hook fails closed (no body),
 *   - lists declared resources with the mcp-app mime.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createPluginUiResourceProvider,
  MCP_APP_MIME_TYPE,
} from "../plugin-ui-resource-provider.js";
import type { PluginUiResourceDecl } from "../types.js";

const PLUGIN_ID = "acme-cards";

const DECLS: PluginUiResourceDecl[] = [
  {
    uri: `ui://${PLUGIN_ID}/hello.html`,
    csp: { connectDomains: ["https://api.acme.example"] },
  },
  { uri: `ui://${PLUGIN_ID}/plain.html` },
];

/** The plugin's serving hook, as an in-memory uri → html table. */
function providerWith(cards: Record<string, string>, declarations = DECLS) {
  const readHtml = vi.fn(async (uri: string) => {
    const body = cards[uri];
    if (body === undefined) throw new Error(`plugin has no card '${uri}'`);
    return body;
  });
  return { provider: createPluginUiResourceProvider({ pluginId: PLUGIN_ID, declarations, readHtml }), readHtml };
}

describe("createPluginUiResourceProvider — plugin ui:// serving chokepoint", () => {
  it("serves a declared own-namespace resource: plugin HTML + the MANIFEST's csp", async () => {
    const uri = `ui://${PLUGIN_ID}/hello.html`;
    const { provider, readHtml } = providerWith({ [uri]: "<h1>hello</h1>" });

    const res = await provider.read(uri);
    expect(res.html).toBe("<h1>hello</h1>");
    // Policy comes from the manifest declaration, NEVER from the hook.
    expect(res.csp).toEqual({ connectDomains: ["https://api.acme.example"] });
    expect(readHtml).toHaveBeenCalledWith(uri);
  });

  it("serves a declared resource that omits the csp (undefined ⇒ the host's default policy)", async () => {
    const uri = `ui://${PLUGIN_ID}/plain.html`;
    const res = await providerWith({ [uri]: "<p>plain</p>" }).provider.read(uri);
    expect(res.html).toBe("<p>plain</p>");
    expect(res.csp).toBeUndefined();
  });

  it("rejects a uri whose authority is a DIFFERENT plugin (own-namespace-only, fail-closed)", async () => {
    // Even if the FOREIGN uri were somehow declared, the authority gate rejects it
    // first — and the plugin is never asked to serve it.
    const { provider, readHtml } = providerWith({ "ui://evil-plugin/hello.html": "<h1>pwn</h1>" }, [
      { uri: "ui://evil-plugin/hello.html" },
    ]);
    await expect(provider.read("ui://evil-plugin/hello.html")).rejects.toThrow(/own namespace/i);
    expect(readHtml).not.toHaveBeenCalled();
  });

  it("rejects an undeclared uri in its OWN namespace — without asking the plugin", async () => {
    const undeclared = `ui://${PLUGIN_ID}/nope.html`;
    // The plugin WOULD happily serve it; declared-only refuses first, so served
    // content can never escape the manifest-declared csp the host computes from.
    const { provider, readHtml } = providerWith({ [undeclared]: "<h1>undeclared</h1>" });
    await expect(provider.read(undeclared)).rejects.toThrow(/no declared ui:\/\/ resource/i);
    expect(readHtml).not.toHaveBeenCalled();
  });

  it("rejects a non-ui:// scheme", async () => {
    await expect(providerWith({}).provider.read(`https://${PLUGIN_ID}/hello.html`)).rejects.toThrow(
      /own namespace/i,
    );
  });

  it("fails closed when the plugin's serving hook rejects (no body)", async () => {
    // e.g. the host-side bound fired (timeout / size cap) or the plugin threw.
    const provider = createPluginUiResourceProvider({
      pluginId: PLUGIN_ID,
      declarations: DECLS,
      readHtml: async () => {
        throw new Error("readUiResource timed out");
      },
    });
    await expect(provider.read(`ui://${PLUGIN_ID}/hello.html`)).rejects.toThrow(/timed out/i);
  });

  it("lists declared resources with the mcp-app mime", () => {
    expect(providerWith({}).provider.list()).toEqual([
      { uri: `ui://${PLUGIN_ID}/hello.html`, mimeType: MCP_APP_MIME_TYPE },
      { uri: `ui://${PLUGIN_ID}/plain.html`, mimeType: MCP_APP_MIME_TYPE },
    ]);
  });
});
