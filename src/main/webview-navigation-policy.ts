import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_APP_SCHEME } from "../shared/mcp-app-partition.js";

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

  // The MCP-App sandbox-proxy document is host-owned and served from a privileged
  // scheme whose `protocol.handle` fail-closes on an unknown token or an
  // authority/token mismatch. Allow it explicitly: the initial `src` load does not
  // fire `will-navigate`, but a page-initiated re-navigation or crash-recovery reload
  // (`render-process-gone`) does, and the fallback below permits only data:/about:,
  // which would silently break the card. Mirrors the plugin-shell precedent above.
  if (input.url.startsWith(`${MCP_APP_SCHEME}:`)) return false;

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
