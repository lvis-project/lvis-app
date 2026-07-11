/**
 * HtmlPreview Partition Network Block — defense-in-depth
 *
 * The `lvis-render-html` partition carries LLM-authored HTML.
 * A meta CSP already blocks most loads at the renderer level; this adds a
 * main-process webRequest gate so even a CSP bypass cannot exfiltrate data
 * over the network.
 *
 * Allowed: data:, blob:, about:blank (inline content only)
 * Blocked: http, https, file, ftp, and any other scheme
 *
 * ─── Per-server MCP App partition (`lvis-mcp-app:<hex(serverId)>`) ────────────
 * MCP App HTML is UNTRUSTED (server-authored), so the partition is deny-by-default
 * and is opened ONLY by the origins that server's own UI resources DECLARED in their
 * `_meta.ui.csp`. It also serves the host-owned sandbox-proxy document and installs
 * the relay preload. Each MCP server gets its OWN partition (#885 b1); everything is
 * installed lazily per-server via `installMcpAppPartitionPolicy` (idempotent), NOT
 * once at boot.
 */
import { createRequire } from "node:module";
import { dirname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RENDER_HTML_PARTITION } from "../shared/render-html-preview.js";
import { mcpAppPartitionName } from "../shared/mcp-app-partition.js";
import { installPluginAssetProtocolHandler, PLUGIN_ASSET_SCHEME } from "./plugin-asset-protocol.js";
import { installMcpAppProtocolHandler, isDeclaredOriginForServer, MCP_APP_SCHEME } from "./mcp-app-protocol.js";

// ESM equivalent of CommonJS `__dirname`. The original code referenced
// `__dirname` directly, which is undefined under `"type": "module"` and
// crashed when `installPluginPartitionPolicy` was first reached at runtime
// (#498). Resolve once at module load.
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pluginShellHtmlPath = normalize(resolve(__dirname, "..", "plugin-ui-shell.html"));
const pluginShellJsPath = normalize(resolve(__dirname, "..", "plugin-ui-shell.js"));

type SessionApi = { fromPartition(partition: string): Electron.Session };

function getElectronSession(): SessionApi {
  return require("electron").session as SessionApi;
}

function installStrictInlineOnly(ses: Electron.Session): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") {
        callback({ cancel: false });
        return;
      }
      callback({ cancel: true });
    } catch {
      callback({ cancel: true });
    }
  });
}

/**
 * Network gate for one MCP server's partition — deny-by-default, opened ONLY by the
 * origins that server's own UI resources declared in their `_meta.ui.csp`.
 *
 * It used to be a hardcoded 5-CDN allowlist. That was wrong twice over:
 *  - it GRANTED undeclared hosts (any app could reach jsdelivr/unpkg/… without
 *    declaring them — the spec's No-Loosening MUST says the host MUST NOT allow
 *    undeclared domains); and
 *  - it CANCELLED declared ones (a conformant server's `connectDomains` host was not
 *    in the list, so the CSP would permit the fetch and this gate would silently kill
 *    it — declared network access could never actually work).
 *
 * Now the two layers are in lockstep: the CSP header (per resource) and this gate
 * (per server, the union of that server's declared origins) are both derived from the
 * same sanitized `_meta.ui.csp`. The CSP remains the tighter, per-frame gate.
 */
function installDeclaredOriginGate(ses: Electron.Session, serverId: string): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      // The host-owned sandbox-proxy document itself. Served exclusively by our own
      // `protocol.handle`, which fail-closes on an unknown token or an authority that
      // does not match that token's serverId — so this cannot reach anything the host
      // did not mint. Without it the gate cancels the proxy navigation and the card
      // never loads.
      if (url.protocol === `${MCP_APP_SCHEME}:`) {
        callback({ cancel: false });
        return;
      }
      // Local, inline-only schemes: not exfiltration channels.
      if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") {
        callback({ cancel: false });
        return;
      }
      if (url.protocol === "https:" && isDeclaredOriginForServer(serverId, url.origin)) {
        callback({ cancel: false });
        return;
      }
      callback({ cancel: true });
    } catch {
      callback({ cancel: true });
    }
  });
}

/**
 * #237 Option B — Plugin webview partition policy.
 *
 * Plugin webviews use `persist:plugin:<slug>` partitions.  They load from a
 * local file:// URL (plugin-ui-shell.html) and execute plugin-bundled JS.
 * We apply a permissive policy that still blocks raw http/https to external
 * hosts that weren't explicitly loaded by the plugin module itself.
 *
 * Allowed: file://, lvis-plugin://, data:, blob:, about:
 * Blocked: http, https, ftp, and any other scheme (plugin UI should be
 *   self-contained; network calls go through lvis:plugin:call-tool IPC).
 *
 * This function is called once per partition name the first time a webview
 * with that partition is attached.  The caller must pass the partition string
 * exactly as used in the <webview> tag.
 */
/**
 * Tracked partitions so re-installing the same policy is a no-op. Without
 * this, every webview re-attach (plugin tab switch / re-mount) would
 * stack `onBeforeRequest` handlers on the same session.
 */
const installedPluginPartitions = new Set<string>();

/**
 * Tracked per-server MCP-app partitions (b1). Same idempotency discipline as
 * `installedPluginPartitions`: re-installing the policy for a partition that already
 * has it is a no-op, so a card re-render / detach never stacks a second
 * `onBeforeRequest` handler on the same session.
 */
const installedMcpAppPartitions = new Set<string>();

/**
 * #885 b1 — lazy per-server MCP-app partition policy. Installs, on
 * `lvis-mcp-app:<enc(serverId)>`:
 *   1. the deny-by-default declared-origin network gate,
 *   2. the `lvis-mcp-app://` handler serving the sandbox-proxy document with its
 *      per-resource CSP response header, and
 *   3. the host-owned relay preload (via `session.setPreloads`).
 *
 * Called from the `lvis:mcp:ui-resource` IPC handler — the single main-side chokepoint
 * every card render (inline AND detached) passes through — BEFORE the resource is
 * read, so all three are present before the webview mounts and issues its first
 * request. Idempotent via `installedMcpAppPartitions`.
 *
 * Fail-closed: a `fromPartition` failure throws (No-Fallback) so the card surfaces an
 * error rather than rendering on an ungated partition. The CSP response header
 * (`shared/mcp-app-csp.ts`) is the primary, per-frame control; this webRequest gate is
 * the coarser per-server floor beneath it.
 */
export function installMcpAppPartitionPolicy(
  serverId: string,
  sessionApi: SessionApi = getElectronSession(),
): void {
  const partitionName = mcpAppPartitionName(serverId);
  if (installedMcpAppPartitions.has(partitionName)) return;
  installedMcpAppPartitions.add(partitionName);

  const ses = sessionApi.fromPartition(partitionName);
  installDeclaredOriginGate(ses, serverId);

  // Serves the host-owned sandbox-proxy document (`lvis-mcp-app://…/proxy.html`)
  // with its Content-Security-Policy RESPONSE HEADER — the envelope the inner app
  // frame inherits.
  installMcpAppProtocolHandler(partitionName, ses);

  // The sandbox-proxy relay preload. As with the plugin partition, `setPreloads`
  // is the ONLY path that works: the `preload=` attribute is silently ignored
  // when `webpreferences="sandbox=yes"`, and the `will-attach-webview` guards
  // strip the attribute anyway (they cannot see, and do not affect, session
  // preloads). Registered here — before any webview for this server begins
  // loading — because attach-time hooks do not work (see
  // `boot/steps/plugin-runtime.ts`: `webPreferences.preload` is `undefined` there).
  //
  // Host-resolved path only. An MCP server can never nominate a preload — that
  // would be a Node escape. At runtime __dirname is `dist/src/main/`, so
  // "../mcp-app-preload.cjs" resolves to `dist/src/mcp-app-preload.cjs`.
  ses.setPreloads([resolve(__dirname, "..", "mcp-app-preload.cjs")]);
}

function isAllowedPluginShellFile(url: URL): boolean {
  if (url.protocol !== "file:") return false;
  try {
    const filePath = normalize(fileURLToPath(url));
    return filePath === pluginShellHtmlPath || filePath === pluginShellJsPath;
  } catch {
    return false;
  }
}

export function installPluginPartitionPolicy(
  partitionName: string,
  options: { pluginRoot?: string } = {},
  sessionApi: SessionApi = getElectronSession(),
): void {
  const ses = sessionApi.fromPartition(partitionName);
  if (options.pluginRoot) {
    installPluginAssetProtocolHandler(partitionName, ses, options.pluginRoot);
  }
  if (installedPluginPartitions.has(partitionName)) return;
  installedPluginPartitions.add(partitionName);

  // setPreloads is required for sandboxed <webview> — the preload= attribute
  // alone is silently ignored when webpreferences="sandbox=yes". Electron
  // requires the preload to be registered on the partition's Session before
  // the webview begins loading. At runtime __dirname is `dist/src/main/`,
  // so resolving "../plugin-preload.cjs" yields `dist/src/plugin-preload.cjs`,
  // a sibling of the host preload.cjs.
  const preloadPath = resolve(__dirname, "..", "plugin-preload.cjs");
  ses.setPreloads([preloadPath]);

  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      if (
        isAllowedPluginShellFile(url) ||
        url.protocol === `${PLUGIN_ASSET_SCHEME}:` ||
        url.protocol === "data:" ||
        url.protocol === "blob:" ||
        url.protocol === "about:"
      ) {
        callback({ cancel: false });
        return;
      }
      callback({ cancel: true });
    } catch {
      callback({ cancel: true });
    }
  });
}

export function installHtmlPreviewPartitionBlock(sessionApi: SessionApi = getElectronSession()): void {
  // LLM-authored HTML: strict inline-only partition.
  //
  // The MCP-app CDN gate is NO LONGER installed here — it is a PER-SERVER
  // partition (b1) installed lazily in the `lvis:mcp:ui-resource` chokepoint
  // via `installMcpAppPartitionPolicy`. There is no bare `lvis-mcp-app`
  // partition anymore.
  installStrictInlineOnly(sessionApi.fromPartition(RENDER_HTML_PARTITION));
}
