/**
 * Plugin `ui://` resource provider — serves a first-party plugin's OWN declared
 * MCP App HTML cards (the PLUGIN arm of the `ui://` serving seam,
 * mcp-alignment-design.md §3.x).
 *
 * "Declared POLICY, served CONTENT": a plugin declares a card's `uri` + its
 * security policy (`csp` / `permissions`) in `manifest.uiResources[]`
 * ({@link PluginUiResourceDecl}), and serves the card's BYTES itself
 * (`RuntimePlugin.readUiResource`, injected here as {@link readHtml}). The plugin
 * IS the MCP server — servers serve their own resources; the host relays. That is
 * exactly what the EXTERNAL arm already does (`resources/read` returns bytes), so
 * both arms converge on {@link McpUiResourceRead}.
 *
 * This module is therefore PURE: no fs, no path, no platform. It is the single
 * fail-closed POLICY gate on the serving seam, and nothing else:
 *  1. own-namespace-only — `uri` authority MUST equal this plugin's id. Load-bearing
 *     beyond mere hygiene: the serverId keys the sandbox-proxy origin, its partition,
 *     and the `declaredOriginsByServer` network union — a plugin must not police its
 *     own namespace;
 *  2. declared-only — the `uri` MUST be one the manifest declared. This binds the
 *     served content to the manifest-declared `csp` main computes the CSP header
 *     from, so a plugin cannot serve a card under a policy it never declared;
 *  3. attach the manifest's policy — never the hook's.
 *
 * The host no longer resolves or reads a plugin-declared disk path, so the realpath
 * containment layer that used to guard that read is gone with the read itself.
 */
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
   * Serve one declared resource: the plugin's HTML plus the resource's OWN
   * manifest-declared csp/permissions. Fail-closed — throws when `uri`'s authority
   * is not this plugin, when the uri is not declared, or when the plugin's
   * `readHtml` hook rejects (it is host-bounded: timeout + size cap).
   */
  read(uri: string): Promise<McpUiResourceRead>;
}

export interface CreatePluginUiResourceProviderInput {
  pluginId: string;
  declarations: readonly PluginUiResourceDecl[];
  /**
   * Ask THIS plugin for a declared card's HTML. Called only after the two policy
   * gates pass. Wired to `PluginRuntime.readUiResource`, which applies the runtime
   * gates (enabled / session-activated, manifest integrity) and bounds the hook
   * (timeout + size cap) — this module stays pure.
   */
  readHtml: (uri: string) => Promise<string>;
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
  const { pluginId, readHtml } = input;

  // Declared uri → declaration. A duplicate uri resolves last-write-wins
  // (deterministic); the serving gate reads only from this indexed set.
  const byUri = new Map<string, PluginUiResourceDecl>();
  for (const decl of input.declarations) byUri.set(decl.uri, decl);

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
      // (3) the plugin serves the content; the MANIFEST supplies the policy.
      const html = await readHtml(uri);
      return {
        html,
        ...(decl.csp !== undefined ? { csp: decl.csp } : {}),
        ...(decl.permissions !== undefined ? { permissions: decl.permissions } : {}),
      };
    },
  };
}
