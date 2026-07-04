export interface ProjectIdentity {
  projectRoot: string;
  projectName: string;
  isDefault?: boolean;
}

export interface WorkspaceRootIdentity {
  path: string;
  isDefault: boolean;
}

export function projectBasename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/);
  return parts[parts.length - 1] || path;
}

export function normalizeProjectRoot(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeProjectName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function projectRootKey(value: unknown): string | undefined {
  const root = normalizeProjectRoot(value);
  if (!root) return undefined;
  const hadWindowsSeparator = root.includes("\\");
  let normalized = root.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (normalized.length === 0) normalized = "/";
  const isWindowsRoot = /^[a-zA-Z]:(?:\/|$)/.test(normalized) || /^\/\/[^/]+\/[^/]+/.test(normalized) || hadWindowsSeparator;
  return isWindowsRoot ? normalized.toLowerCase() : normalized;
}

export function projectRootEquals(left: unknown, right: unknown): boolean {
  const leftKey = projectRootKey(left);
  const rightKey = projectRootKey(right);
  return leftKey !== undefined && rightKey !== undefined && leftKey === rightKey;
}

export function projectIdentityFromRoot(
  projectRoot: string,
  fallbackName: string,
  isDefault = false,
): ProjectIdentity {
  return {
    projectRoot,
    // The DEFAULT/base-directory project is labeled by `fallbackName` (a stable
    // "default" / localized "현재 프로젝트" label) rather than the folder
    // basename of the user's workspace directory — deriving it from the folder
    // name surfaced a confusing literal (e.g. "workspace") in the UI. Non-default
    // (user-picked) projects keep their folder basename as the display name.
    projectName: isDefault ? fallbackName : (projectBasename(projectRoot) || fallbackName),
    isDefault,
  };
}

export function projectIdentityFromPayload(
  payload: { projectRoot?: unknown; projectName?: unknown; isDefault?: unknown } | null | undefined,
  fallbackName = "default",
): ProjectIdentity | undefined {
  const projectRoot = normalizeProjectRoot(payload?.projectRoot);
  const projectName = normalizeProjectName(payload?.projectName);
  if (!projectRoot) return undefined;
  return {
    projectRoot,
    projectName: projectName ?? projectBasename(projectRoot) ?? fallbackName,
    ...(payload?.isDefault === true ? { isDefault: true } : {}),
  };
}

export function workspaceRootsToProjects(
  defaultRoot: string | undefined,
  roots: readonly WorkspaceRootIdentity[],
  fallbackName: string,
): ProjectIdentity[] {
  const byRoot = new Map<string, ProjectIdentity>();
  const add = (path: string | undefined, isDefault: boolean) => {
    const root = normalizeProjectRoot(path);
    const key = projectRootKey(root);
    if (!root || !key || byRoot.has(key)) return;
    byRoot.set(key, projectIdentityFromRoot(root, fallbackName, isDefault));
  };
  add(defaultRoot, true);
  for (const root of roots) add(root.path, root.isDefault);
  return Array.from(byRoot.values());
}

export function defaultProjectFromProjects(projects: readonly ProjectIdentity[]): ProjectIdentity | undefined {
  return projects.find((project) => project.isDefault) ?? projects[0];
}
