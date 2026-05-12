import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    const distSrc = resolve(input.distRoot, "src");
    let targetPath: string | null = null;
    try {
      targetPath = resolve(fileURLToPath(input.url));
    } catch {
      targetPath = null;
    }
    if (targetPath) {
      const rel = relative(distSrc, targetPath);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
        return false;
      }
    }
  }

  return !input.url.startsWith("data:") && !input.url.startsWith("about:");
}
