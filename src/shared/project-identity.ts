export interface ProjectIdentity {
  projectRoot: string;
  projectName: string;
  isDefault?: boolean;
}

export interface WorkspaceRootIdentity {
  path: string;
  isDefault: boolean;
}

function projectParentParts(projectRoot: string): string[] {
  const normalized = projectRoot.replace(/\\/g, "/").replace(/\/+$/g, "");
  const leafSeparator = normalized.lastIndexOf("/");
  if (leafSeparator < 0) return [];
  const parent = normalized.slice(0, leafSeparator);
  if (parent.length === 0) return ["/"];
  return parent.split("/").filter(Boolean);
}

function fullRootQualifier(projectRoot: string): string {
  return projectRoot.replace(/\\/g, "/").replace(/\/+$/g, "") || "/";
}

function uniqueParentQualifiers(projects: readonly ProjectIdentity[]): string[] {
  const states = projects.map((project) => {
    const parts = projectParentParts(project.projectRoot);
    return {
      project,
      parts,
      depth: parts.length > 0 ? 1 : 0,
      useFullRoot: parts.length === 0,
    };
  });

  const qualifierFor = (state: (typeof states)[number]): string => {
    if (state.useFullRoot) return fullRootQualifier(state.project.projectRoot);
    return state.parts.slice(-state.depth).join("/");
  };

  // Only colliding qualifiers grow. This keeps already-distinct labels short
  // while escalating shared parent names to the shortest unique suffix.
  for (;;) {
    const byQualifier = new Map<string, Array<(typeof states)[number]>>();
    for (const state of states) {
      const qualifier = qualifierFor(state);
      const collisions = byQualifier.get(qualifier) ?? [];
      collisions.push(state);
      byQualifier.set(qualifier, collisions);
    }

    const collisions = Array.from(byQualifier.values()).filter((group) => group.length > 1);
    if (collisions.length === 0) break;

    let changed = false;
    for (const collision of collisions) {
      for (const state of collision) {
        if (!state.useFullRoot && state.depth < state.parts.length) {
          state.depth += 1;
          changed = true;
        } else if (!state.useFullRoot) {
          state.useFullRoot = true;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  return states.map(qualifierFor);
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

export function disambiguateProjectNames(
  projects: readonly ProjectIdentity[],
): ProjectIdentity[] {
  const collisionsByName = new Map<string, ProjectIdentity[]>();
  for (const project of projects) {
    if (project.isDefault) continue;
    const collisions = collisionsByName.get(project.projectName) ?? [];
    collisions.push(project);
    collisionsByName.set(project.projectName, collisions);
  }

  const displayNameByRoot = new Map<string, string>();
  for (const collisions of collisionsByName.values()) {
    if (collisions.length < 2) continue;
    const qualifiers = uniqueParentQualifiers(collisions);
    collisions.forEach((project, index) => {
      const key = projectRootKey(project.projectRoot);
      if (key) displayNameByRoot.set(key, `${project.projectName} \u2014 ${qualifiers[index]}`);
    });
  }

  return projects.map((project) => {
    const key = projectRootKey(project.projectRoot);
    const projectName = key ? displayNameByRoot.get(key) : undefined;
    return projectName ? { ...project, projectName } : project;
  });
}

export function projectIdentityFromRoot(
  projectRoot: string,
  fallbackName: string,
  isDefault = false,
): ProjectIdentity {
  // No isDefault-branching: the earlier "avoid a literal folder name for the
  // default project" special-case is dead weight now that isDefault projects
  // are never surfaced as a selectable/displayed project at all (composer
  // selector, sidebar grouping, and Insights all exclude/reclassify them — see
  // 2026-07 "remove Current Project labeling" refinement). `fallbackName` is
  // therefore only a safety net for the near-unreachable case of a root with
  // no resolvable basename (e.g. a bare drive root).
  return {
    projectRoot,
    projectName: projectBasename(projectRoot) || fallbackName,
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
  return disambiguateProjectNames(Array.from(byRoot.values()));
}

export function defaultProjectFromProjects(projects: readonly ProjectIdentity[]): ProjectIdentity | undefined {
  return projects.find((project) => project.isDefault) ?? projects[0];
}

export function findWorkspaceProject(
  projects: readonly ProjectIdentity[],
  candidate: Pick<ProjectIdentity, "projectRoot"> | string | null | undefined,
): ProjectIdentity | undefined {
  const projectRoot = typeof candidate === "string" ? candidate : candidate?.projectRoot;
  return projects.find((project) => projectRootEquals(project.projectRoot, projectRoot));
}

export function reconcileActiveProject(
  current: Pick<ProjectIdentity, "projectRoot"> | null | undefined,
  projects: readonly ProjectIdentity[],
): ProjectIdentity | undefined {
  return findWorkspaceProject(projects, current) ?? defaultProjectFromProjects(projects);
}
