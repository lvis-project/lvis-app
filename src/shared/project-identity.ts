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

export function projectIdentityFromRoot(
  projectRoot: string,
  fallbackName: string,
  isDefault = false,
): ProjectIdentity {
  return {
    projectRoot,
    projectName: projectBasename(projectRoot) || fallbackName,
    isDefault,
  };
}

export function projectIdentityFromPayload(
  payload: { projectRoot?: unknown; projectName?: unknown; isDefault?: unknown } | null | undefined,
  fallbackName = "workspace",
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
    if (!root || byRoot.has(root)) return;
    byRoot.set(root, projectIdentityFromRoot(root, fallbackName, isDefault));
  };
  add(defaultRoot, true);
  for (const root of roots) add(root.path, root.isDefault);
  return Array.from(byRoot.values());
}

export function defaultProjectFromProjects(projects: readonly ProjectIdentity[]): ProjectIdentity | undefined {
  return projects.find((project) => project.isDefault) ?? projects[0];
}
