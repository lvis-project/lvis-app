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
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    if (url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank") {
      callback({ cancel: false });
    } else {
      callback({ cancel: true });
    }
  });
}
