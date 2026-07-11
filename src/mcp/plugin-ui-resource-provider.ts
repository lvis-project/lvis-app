/**
 * Plugin `ui://` resource provider — serves a first-party plugin's OWN declared
 * MCP App HTML cards (the PLUGIN arm of the `ui://` serving seam,
 * mcp-alignment-design.md §3.x).
 *
 * A plugin ships an HTML card in its `dist/` and declares it in
 * `manifest.uiResources[]` ({@link PluginUiResourceDecl}). This provider turns
 * that declaration + the plugin root into the `resources/list` / `resources/read`
 * answers the loopback {@link PluginMcpServer} returns, so a plugin-served card
 * flows through the SAME sandbox-proxy + main-computed CSP path as an
 * external MCP server's `ui://` resource — BOTH converge on {@link McpUiResourceRead}.
 *
 * This is the SINGLE chokepoint that enforces the serving security invariants,
 * fail-closed (no layered guards elsewhere):
 *  1. own-namespace-only — `uri` authority MUST equal this plugin's id, so a
 *     plugin can never serve another plugin's (or an external server's) namespace;
 *  2. declared-only — the `uri` MUST be one the manifest declared;
 *  3. path-containment — the HTML file MUST resolve INSIDE the plugin root
 *     (realpath-checked, mirroring `plugin-asset-protocol.ts`); absolute paths,
 *     `..` escapes, and symlinks pointing outside the root are rejected.
 *
 * The declared `csp` / `permissions` ride back on the resource's `_meta.ui` so
 * main COMPUTES the sandbox-proxy CSP header from them — the plugin never hands
 * the host a policy header string.
 */
import { realpath as fsRealpath, readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import type { McpUiResourceRead, PluginUiResourceDecl } from "./types.js";

/** The MCP Apps HTML profile mime the host renders `ui://` resources as. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** One entry of `resources/list`. */
export interface PluginUiResourceListing {
  uri: string;
  mimeType: string;
}

export interface PluginUiResourceProvider {
  /** The `ui://` resources this plugin declares (for `resources/list`). */
  list(): PluginUiResourceListing[];
  /**
   * Serve one declared resource: its HTML plus the resource's OWN csp/permissions.
   * Fail-closed — throws when `uri`'s authority is not this plugin, when the uri
   * is not declared, or when the HTML path escapes the plugin root.
   */
  read(uri: string): Promise<McpUiResourceRead>;
}

export interface CreatePluginUiResourceProviderInput {
  pluginId: string;
  /** Absolute plugin install root; the HTML path resolves relative to it. */
  pluginRoot: string;
  declarations: readonly PluginUiResourceDecl[];
  /** Injectable for tests. Defaults to `fs.readFile(..., "utf-8")`. */
  readFile?: (absPath: string) => Promise<string>;
  /** Injectable for tests. Defaults to `fs.realpath`. */
  realpath?: (targetPath: string) => Promise<string>;
}

/**
 * The `ui://` authority (host) of `uri`, or `null` when `uri` is not a
 * well-formed `ui://<authority>/…` URL. Non-`ui:` schemes and authority-less
 * forms return `null` so they fail the own-namespace check below.
 */
function uiAuthority(uri: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ui:") return null;
  return parsed.hostname.length > 0 ? parsed.hostname : null;
}

export function createPluginUiResourceProvider(
  input: CreatePluginUiResourceProviderInput,
): PluginUiResourceProvider {
  const { pluginId, pluginRoot } = input;
  const readFile = input.readFile ?? ((abs: string) => fsReadFile(abs, "utf-8"));
  const realpath = input.realpath ?? fsRealpath;

  // Declared uri → declaration. A duplicate uri resolves last-write-wins
  // (deterministic); the serving gate reads only from this indexed set.
  const byUri = new Map<string, PluginUiResourceDecl>();
  for (const decl of input.declarations) byUri.set(decl.uri, decl);

  async function loadContainedHtml(relHtml: string): Promise<string> {
    // Lexical fail-closed BEFORE touching the fs: no absolute paths, no NULs.
    if (typeof relHtml !== "string" || relHtml.length === 0 || relHtml.includes("\0")) {
      throw new Error(`[plugin-ui-resource:${pluginId}] invalid html path`);
    }
    if (path.isAbsolute(relHtml)) {
      throw new Error(`[plugin-ui-resource:${pluginId}] html path must be relative to the plugin root`);
    }
    // Realpath containment — the resolved asset MUST stay inside the (realpath'd)
    // plugin root, so a `..` chain or an escaping symlink cannot read out-of-root.
    // `path.resolve` normalizes the root to one canonical absolute form so the
    // `startsWith` compare is separator/drive-consistent on every platform.
    const realRoot = path.resolve(await realpath(pluginRoot));
    const realAsset = await realpath(path.resolve(realRoot, relHtml));
    const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (realAsset !== realRoot && !realAsset.startsWith(rootWithSep)) {
      throw new Error(`[plugin-ui-resource:${pluginId}] html path escapes the plugin root`);
    }
    return readFile(realAsset);
  }

  return {
    list() {
      return [...byUri.keys()].map((uri) => ({ uri, mimeType: MCP_APP_MIME_TYPE }));
    },
    async read(uri: string): Promise<McpUiResourceRead> {
      // (1) own-namespace-only: the uri's authority MUST be this plugin.
      if (uiAuthority(uri) !== pluginId) {
        throw new Error(
          `[plugin-ui-resource:${pluginId}] refuses to serve a ui:// resource outside its own namespace: '${uri}'`,
        );
      }
      // (2) declared-only.
      const decl = byUri.get(uri);
      if (!decl) {
        throw new Error(`[plugin-ui-resource:${pluginId}] no declared ui:// resource '${uri}'`);
      }
      // (3) path-containment + read.
      const html = await loadContainedHtml(decl.html);
      return {
        html,
        ...(decl.csp !== undefined ? { csp: decl.csp } : {}),
        ...(decl.permissions !== undefined ? { permissions: decl.permissions } : {}),
      };
    },
  };
}
