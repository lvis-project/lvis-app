import { canonicalizePathForMatch, caseFoldForMatch } from "../permissions/sensitive-paths.js";

/**
 * Default LVIS workspace project root.
 *
 * The main process calls ensureWorkspaceCwd() during early boot, before IPC
 * handlers are registered, so process.cwd() here is the app-managed
 * ~/.lvis/workspace anchor rather than an OS launch directory.
 */
export function getDefaultWorkspaceRoot(): string {
  return process.cwd();
}

export function isDefaultWorkspaceRoot(projectRoot: string, defaultWorkspaceRoot = getDefaultWorkspaceRoot()): boolean {
  try {
    return caseFoldForMatch(canonicalizePathForMatch(projectRoot)) ===
      caseFoldForMatch(canonicalizePathForMatch(defaultWorkspaceRoot));
  } catch {
    return projectRoot.trim() === defaultWorkspaceRoot.trim();
  }
}
