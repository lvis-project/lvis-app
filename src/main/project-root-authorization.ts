import { readPermissionSettings } from "../permissions/permission-settings-store.js";
import { sanitizeRuntimeAllowedDirectories } from "../permissions/allowed-directories.js";
import {
  projectBasename,
  projectRootEquals,
  type ProjectIdentity,
} from "../shared/project-identity.js";
import {
  getDefaultWorkspaceRoot,
  isDefaultWorkspaceRoot,
} from "./default-workspace-root.js";

export interface AuthorizedProjectResolution {
  project: ProjectIdentity | null;
  authorized: boolean;
}

export function defaultWorkspaceProject(defaultWorkspaceRoot = getDefaultWorkspaceRoot()): ProjectIdentity {
  return {
    projectRoot: defaultWorkspaceRoot,
    projectName: projectBasename(defaultWorkspaceRoot) || "workspace",
    isDefault: true,
  };
}

export function listAuthorizedWorkspaceProjects(defaultWorkspaceRoot = getDefaultWorkspaceRoot()): ProjectIdentity[] {
  const defaultProject = defaultWorkspaceProject(defaultWorkspaceRoot);
  const additional = readPermissionSettings().permissions.additionalDirectories;
  const projects: ProjectIdentity[] = [defaultProject];
  for (const root of sanitizeRuntimeAllowedDirectories(additional)) {
    if (projects.some((project) => projectRootEquals(project.projectRoot, root))) continue;
    projects.push({
      projectRoot: root,
      projectName: projectBasename(root) || defaultProject.projectName,
    });
  }
  return projects;
}

export function isAuthorizedWorkspaceProjectRoot(projectRoot: string): boolean {
  if (isDefaultWorkspaceRoot(projectRoot)) return true;
  return listAuthorizedWorkspaceProjects().some((project) => projectRootEquals(project.projectRoot, projectRoot));
}

export function resolveAuthorizedWorkspaceProject(
  requestedRoot: string | undefined,
  requestedName?: string,
): AuthorizedProjectResolution {
  if (!requestedRoot) {
    return { project: defaultWorkspaceProject(), authorized: true };
  }
  const authorized = listAuthorizedWorkspaceProjects().find((project) =>
    projectRootEquals(project.projectRoot, requestedRoot),
  );
  if (!authorized) {
    return { project: null, authorized: false };
  }
  return {
    project: {
      projectRoot: authorized.projectRoot,
      projectName: requestedName?.trim() || authorized.projectName,
      ...(authorized.isDefault ? { isDefault: true } : {}),
    },
    authorized: true,
  };
}
