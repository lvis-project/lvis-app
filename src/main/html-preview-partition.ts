/**
 * HtmlPreview Partition Network Block — defense-in-depth
 *
 * The `lvis-render-html` webview partition carries LLM-authored HTML.
 * A meta CSP already blocks most loads at the renderer level; this adds a
 * main-process webRequest gate so even a CSP bypass cannot exfiltrate data
 * over the network.
 *
 * Allowed: data:, blob:, about:blank (inline content only)
 * Blocked: http, https, file, ftp, and any other scheme
 */
import { session } from "electron";

export function installHtmlPreviewPartitionBlock(): void {
  const ses = session.fromPartition("lvis-render-html");
  const allowedProtocols = new Set(["data:", "blob:", "about:"]);
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const { protocol } = new URL(details.url);
      callback({ cancel: !allowedProtocols.has(protocol) });
    } catch {
      callback({ cancel: true });
    }
  });
}
