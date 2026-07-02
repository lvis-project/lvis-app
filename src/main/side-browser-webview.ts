import { session, type WebContents } from "electron";
import { LVIS_SIDE_BROWSER_PARTITION } from "../shared/side-browser.js";
import { markAsLinkOwned } from "./link-window-registry.js";

export type SideBrowserAttachResult = "ignored" | "accepted" | "blocked";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function installSideBrowserPartitionPolicy(): void {
  const sideBrowserSession = session.fromPartition(LVIS_SIDE_BROWSER_PARTITION);
  sideBrowserSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  sideBrowserSession.setPermissionCheckHandler(() => false);
  sideBrowserSession.on("will-download", (event) => {
    event.preventDefault();
  });
}

export function isSideBrowserContents(contents: WebContents): boolean {
  return contents.session === session.fromPartition(LVIS_SIDE_BROWSER_PARTITION);
}

export function takePendingSideBrowserSrc(pendingSrcs: string[], attachedUrl: string): string | null {
  const index = pendingSrcs.indexOf(attachedUrl);
  if (index < 0) return null;
  return pendingSrcs.splice(index, 1)[0] ?? null;
}

export function configureSideBrowserWebviewAttach(input: {
  event: { preventDefault: () => void };
  webPreferences: Record<string, unknown>;
  params: Record<string, string>;
  enqueueAllowedSrc: (src: string) => void;
}): SideBrowserAttachResult {
  if (input.params.partition !== LVIS_SIDE_BROWSER_PARTITION) return "ignored";

  const src = input.params.src ?? "";
  if (!isHttpUrl(src)) {
    input.event.preventDefault();
    return "blocked";
  }

  delete input.webPreferences.preload;
  delete input.webPreferences.preloadURL;
  delete input.webPreferences.additionalArguments;
  input.webPreferences.nodeIntegration = false;
  input.webPreferences.nodeIntegrationInWorker = false;
  input.webPreferences.nodeIntegrationInSubFrames = false;
  input.webPreferences.contextIsolation = true;
  input.webPreferences.webSecurity = true;
  input.webPreferences.sandbox = true;
  input.webPreferences.javascript = true;
  input.webPreferences.webviewTag = false;
  input.webPreferences.partition = LVIS_SIDE_BROWSER_PARTITION;

  input.enqueueAllowedSrc(src);
  return "accepted";
}

export function attachSideBrowserWebview(contents: WebContents): void {
  markAsLinkOwned(contents);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (details) => {
    if (!isHttpUrl(details.url)) details.preventDefault();
  });
  contents.on("will-redirect", (details) => {
    if (!isHttpUrl(details.url)) details.preventDefault();
  });
}
