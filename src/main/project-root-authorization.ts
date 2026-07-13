import { readPermissionSettings } from "../permissions/permission-settings-store.js";
import { sanitizeRuntimeAllowedDirectories } from "../permissions/allowed-directories.js";
import {
  disambiguateProjectNames,
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

/**
 * Display label for the app-managed default/base-directory project. Kept as the
 * literal "default" instead of the workspace folder's basename (which surfaced a
 * confusing "workspace" label in the sidebar + insights). Non-default,
 * user-picked projects still derive their name from the folder basename.
 */
export const DEFAULT_PROJECT_NAME = "default";

export function defaultWorkspaceProject(defaultWorkspaceRoot = getDefaultWorkspaceRoot()): ProjectIdentity {
  return {
    projectRoot: defaultWorkspaceRoot,
    projectName: DEFAULT_PROJECT_NAME,
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
  return disambiguateProjectNames(projects);
}

export function isAuthorizedWorkspaceProjectRoot(projectRoot: string): boolean {
  if (isDefaultWorkspaceRoot(projectRoot)) return true;
  return listAuthorizedWorkspaceProjects().some((project) => projectRootEquals(project.projectRoot, projectRoot));
}

export function resolveAuthorizedWorkspaceProject(
  requestedRoot: string | undefined,
  _requestedName?: string,
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
    project: authorized,
    authorized: true,
  };
}
