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

export function installHtmlPreviewPartitionBlock(): void {
  // ── 1. LLM-authored HTML: same CDN allowlist as MCP Apps ──
  installCdnAllowlist(session.fromPartition("lvis-render-html"));

  // ── 2. MCP App HTML: same CDN allowlist ───────────────────
  installCdnAllowlist(session.fromPartition("lvis-mcp-app"));
}
