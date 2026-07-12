/**
 * `ondownloadfile` handler — the app asked the host to save a file (`ui/download-file`).
 *
 * This module decides NOTHING. It proxies the request to the host's gated
 * `CHANNELS.mcp.uiDownloadFile` IPC (via the injected `downloadFile`, which McpAppView
 * binds to the CARD's `serverId`) and shapes the answer into the spec's
 * `McpUiDownloadFileResult`. Three consequences worth naming:
 *
 *  - It does NOT do what the ext-apps JSDoc example does. That example decodes the blob
 *    IN THE HOST FRAME (`atob` → `Blob` → an `<a download>` click) and answers a
 *    `resource_link` with `window.open(item.uri)`. Both are wrong here: the first would
 *    write a file with no user-visible destination, and the second would let a sandboxed
 *    iframe steer the host's network identity at an arbitrary URI. Decoding, bounding and
 *    saving happen in MAIN, behind a save dialog, and a `resource_link` is rejected at
 *    parse time (see mcp/mcp-app-download.ts).
 *  - A user CANCEL is NOT an error. The host outcome distinguishes "saved" from
 *    "cancelled", and both map to `{}` — raising `isError` for a user who simply
 *    declined would tell the app to retry or report a failure that never happened.
 *  - Every rejection — an unsupported resource link, an over-cap payload, a malformed
 *    block, a denied IPC — comes back as `{ isError: true }` and nothing else. The app is
 *    never told WHY, and never sees a rejected bridge request.
 */
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiDownloadOutcome } from "../../../../../mcp/mcp-app-download.js";

/** The `ondownloadfile` request callback shape, derived from the installed `AppBridge`. */
export type OnDownloadFile = NonNullable<AppBridge["ondownloadfile"]>;

/** The `McpUiDownloadFileResult` this handler returns (spec shape, derived off the bridge). */
type McpUiDownloadFileResult = Awaited<ReturnType<OnDownloadFile>>;

export interface OnDownloadFileDeps {
  /**
   * Hand the app's `ui/download-file` params to the host's gated IPC. Already bound to
   * the card's `serverId` by McpAppView — this handler cannot choose a server. Resolves
   * to an outcome; `{ ok: false }` is a host rejection, and a user cancel is `ok: true`.
   */
  downloadFile(params: unknown): Promise<McpUiDownloadOutcome>;
}

export function createOnDownloadFile({ downloadFile }: OnDownloadFileDeps): OnDownloadFile {
  return async (params) => {
    try {
      const outcome = await downloadFile(params);
      // saved → `{}`. cancelled → `{}` (the user declined; nothing failed).
      // rejected → `{ isError: true }`, with no reason attached.
      return outcome.ok ? {} : ({ isError: true } satisfies McpUiDownloadFileResult);
    } catch {
      // The IPC itself failed (transport / unauthorized frame). Still an error RESULT,
      // never a rejected bridge request.
      return { isError: true } satisfies McpUiDownloadFileResult;
    }
  };
}
