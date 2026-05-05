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
 * ─── MCP App partition (`lvis-mcp-app`) ──────────────────────────────────────
 * MCP Apps are authored by trusted plugins (not raw LLM output), so they are
 * allowed to load scripts/styles from known CDN domains:
 *   cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com,
 *   fonts.googleapis.com, fonts.gstatic.com
 * All other https hosts and all non-https schemes remain blocked.
 */
import { createRequire } from "node:module";
import { dirname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installPluginAssetProtocolHandler, PLUGIN_ASSET_SCHEME } from "./plugin-asset-protocol.js";

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

const CDN_ALLOWLIST = new Set([
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
]);

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

function installCdnAllowlist(ses: Electron.Session): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") {
        callback({ cancel: false });
        return;
      }
      if (url.protocol === "https:" && CDN_ALLOWLIST.has(url.hostname)) {
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
  // ── 1. LLM-authored HTML: strict inline-only partition ──
  installStrictInlineOnly(sessionApi.fromPartition("lvis-render-html"));

  // ── 2. MCP App HTML: trusted plugin UI with limited CDN allowlist ──
  installCdnAllowlist(sessionApi.fromPartition("lvis-mcp-app"));
}
