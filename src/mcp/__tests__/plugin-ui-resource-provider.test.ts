/**
 * `createPluginUiResourceProvider` — the single fail-closed chokepoint for
 * serving a first-party plugin's OWN `ui://` MCP App cards. Proves:
 *   - serves a declared own-namespace resource (html + declared csp/permissions),
 *   - rejects a cross-plugin uri authority (own-namespace-only),
 *   - rejects an undeclared uri,
 *   - rejects an html path that escapes the plugin root (containment),
 *   - lists declared resources with the mcp-app mime.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  createPluginUiResourceProvider,
  MCP_APP_MIME_TYPE,
} from "../plugin-ui-resource-provider.js";
import type { PluginUiResourceDecl } from "../types.js";

const PLUGIN_ID = "acme-cards";
const ROOT = path.resolve("/plugins/acme-cards");

const DECLS: PluginUiResourceDecl[] = [
  {
    uri: `ui://${PLUGIN_ID}/hello.html`,
    html: "dist/cards/hello.html",
    csp: { connectDomains: ["https://api.acme.example"] },
    permissions: { clipboardWrite: {} },
  },
  { uri: `ui://${PLUGIN_ID}/plain.html`, html: "dist/cards/plain.html" },
];

/** Identity realpath (no symlinks) + an in-memory file table, so the test needs no fs. */
function providerWith(files: Record<string, string>, declarations = DECLS) {
  return createPluginUiResourceProvider({
    pluginId: PLUGIN_ID,
    pluginRoot: ROOT,
    declarations,
    realpath: async (p: string) => p,
    readFile: async (abs: string) => {
      const body = files[abs];
      if (body === undefined) throw new Error(`ENOENT ${abs}`);
      return body;
    },
  });
}

describe("createPluginUiResourceProvider — plugin ui:// serving chokepoint", () => {
  it("serves a declared own-namespace resource with its declared csp/permissions", async () => {
    const abs = path.resolve(ROOT, "dist/cards/hello.html");
    const provider = providerWith({ [abs]: "<h1>hello</h1>" });

    const res = await provider.read(`ui://${PLUGIN_ID}/hello.html`);
    expect(res.html).toBe("<h1>hello</h1>");
    expect(res.csp).toEqual({ connectDomains: ["https://api.acme.example"] });
    expect(res.permissions).toEqual({ clipboardWrite: {} });
  });

  it("serves a declared resource that omits csp/permissions (both undefined)", async () => {
    const abs = path.resolve(ROOT, "dist/cards/plain.html");
    const res = await providerWith({ [abs]: "<p>plain</p>" }).read(`ui://${PLUGIN_ID}/plain.html`);
    expect(res.html).toBe("<p>plain</p>");
    expect(res.csp).toBeUndefined();
    expect(res.permissions).toBeUndefined();
  });

  it("rejects a uri whose authority is a DIFFERENT plugin (own-namespace-only, fail-closed)", async () => {
    const abs = path.resolve(ROOT, "dist/cards/hello.html");
    // Even if the FOREIGN uri were somehow declared, the authority gate rejects it first.
    const provider = providerWith({ [abs]: "<h1>hello</h1>" }, [
      { uri: "ui://evil-plugin/hello.html", html: "dist/cards/hello.html" },
    ]);
    await expect(provider.read("ui://evil-plugin/hello.html")).rejects.toThrow(/own namespace/i);
  });

  it("rejects an undeclared uri in its OWN namespace", async () => {
    await expect(providerWith({}).read(`ui://${PLUGIN_ID}/nope.html`)).rejects.toThrow(
      /no declared ui:\/\/ resource/i,
    );
  });

  it("rejects a non-ui:// scheme", async () => {
    await expect(providerWith({}).read(`https://${PLUGIN_ID}/hello.html`)).rejects.toThrow(
      /own namespace/i,
    );
  });

  it("rejects an html path that escapes the plugin root (containment)", async () => {
    const escaping: PluginUiResourceDecl[] = [
      { uri: `ui://${PLUGIN_ID}/evil.html`, html: "../../../etc/passwd" },
    ];
    const provider = providerWith({ [path.resolve(ROOT, "../../../etc/passwd")]: "secret" }, escaping);
    await expect(provider.read(`ui://${PLUGIN_ID}/evil.html`)).rejects.toThrow(/escapes the plugin root/i);
  });

  it("rejects an absolute html path", async () => {
    const abs: PluginUiResourceDecl[] = [
      { uri: `ui://${PLUGIN_ID}/abs.html`, html: path.resolve("/etc/passwd") },
    ];
    await expect(providerWith({}, abs).read(`ui://${PLUGIN_ID}/abs.html`)).rejects.toThrow(
      /must be relative/i,
    );
  });

  it("lists declared resources with the mcp-app mime", () => {
    expect(providerWith({}).list()).toEqual([
      { uri: `ui://${PLUGIN_ID}/hello.html`, mimeType: MCP_APP_MIME_TYPE },
      { uri: `ui://${PLUGIN_ID}/plain.html`, mimeType: MCP_APP_MIME_TYPE },
    ]);
  });
});
