import { resolve } from "node:path";

export interface GlobalWebviewNavigationDecisionInput {
  url: string;
  currentUrl: string;
  distRoot: string;
  authOwned: boolean;
  linkOwned: boolean;
}

export function shouldBlockGlobalWebviewNavigation(
  input: GlobalWebviewNavigationDecisionInput,
): boolean {
  if (input.authOwned || input.linkOwned) return false;

  const isPluginShellFrame = input.currentUrl.includes("plugin-ui-shell.html");
  if (isPluginShellFrame && input.url.startsWith("file://")) {
    const distSrc = resolve(input.distRoot, "src").replace(/\\/g, "/");
    const allowedPrefix = `file:///${distSrc.replace(/^\//, "")}/`;
    if (input.url.toLowerCase().startsWith(allowedPrefix.toLowerCase())) {
      return false;
    }
  }

  return !input.url.startsWith("data:") && !input.url.startsWith("about:");
}
