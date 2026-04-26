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
import { session } from "electron";

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
 * Allowed: file://, data:, blob:, about:
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

export function installPluginPartitionPolicy(partitionName: string): void {
  if (installedPluginPartitions.has(partitionName)) return;
  installedPluginPartitions.add(partitionName);
  const ses = session.fromPartition(partitionName);
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      if (
        url.protocol === "file:" ||
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

export function installHtmlPreviewPartitionBlock(): void {
  // ── 1. LLM-authored HTML: strict inline-only partition ──
  installStrictInlineOnly(session.fromPartition("lvis-render-html"));

  // ── 2. MCP App HTML: trusted plugin UI with limited CDN allowlist ──
  installCdnAllowlist(session.fromPartition("lvis-mcp-app"));
}
