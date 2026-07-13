import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePermissionSettings } from "../../permissions/permission-settings-store.js";
import {
  defaultWorkspaceProject,
  listAuthorizedWorkspaceProjects,
  resolveAuthorizedWorkspaceProject,
} from "../project-root-authorization.js";
import { projectRootEquals } from "../../shared/project-identity.js";

let oldHome: string | undefined;
let oldCwd: string;
let root: string;
let workspace: string;

beforeEach(() => {
  oldHome = process.env.LVIS_HOME;
  oldCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "lvis-project-auth-"));
  workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  workspace = realpathSync(workspace);
  process.env.LVIS_HOME = root;
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(oldCwd);
  if (oldHome === undefined) delete process.env.LVIS_HOME;
  else process.env.LVIS_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

describe("project root authorization", () => {
  it("resolves missing project selection to the app-managed default workspace", () => {
    expect(defaultWorkspaceProject()).toMatchObject({
      projectRoot: workspace,
      isDefault: true,
    });
    expect(resolveAuthorizedWorkspaceProject(undefined)).toMatchObject({
      authorized: true,
      project: {
        projectRoot: workspace,
        isDefault: true,
      },
    });
  });

  it("accepts only default or permission-approved workspace roots", async () => {
    const allowed = join(root, "allowed-project");
    const denied = join(root, "denied-project");
    mkdirSync(allowed);
    mkdirSync(denied);
    const allowedRoot = realpathSync(allowed);
    await writePermissionSettings({ additionalDirectories: [allowedRoot] });

    const allowedResolution = resolveAuthorizedWorkspaceProject(allowedRoot, "stale-label");
    expect(allowedResolution).toMatchObject({
      authorized: true,
      project: {
        projectName: "allowed-project",
      },
    });
    expect(allowedResolution.project).not.toBeNull();
    if (!allowedResolution.project) throw new Error("expected authorized project");
    expect(projectRootEquals(allowedResolution.project.projectRoot, allowedRoot)).toBe(true);
    expect(resolveAuthorizedWorkspaceProject(`${allowedRoot}/`, "another-stale-label")).toMatchObject({
      authorized: true,
      project: {
        projectName: "allowed-project",
      },
    });
    expect(resolveAuthorizedWorkspaceProject(denied, "denied")).toMatchObject({
      authorized: false,
      project: null,
    });
  });

  it("keeps same-basename roots distinct and resolves their current display labels", async () => {
    const left = join(root, "one", "shared");
    const right = join(root, "two", "shared");
    mkdirSync(left, { recursive: true });
    mkdirSync(right, { recursive: true });
    const leftRoot = realpathSync(left);
    const rightRoot = realpathSync(right);
    await writePermissionSettings({ additionalDirectories: [leftRoot, rightRoot] });

    const additionalProjects = listAuthorizedWorkspaceProjects().filter((project) => !project.isDefault);
    expect(additionalProjects.map((project) => project.projectName)).toEqual([
      "shared \u2014 one",
      "shared \u2014 two",
    ]);
    const resolution = resolveAuthorizedWorkspaceProject(leftRoot, "stale-label");
    expect(resolution).toMatchObject({
      authorized: true,
      project: {
        projectName: "shared \u2014 one",
      },
    });
    expect(resolution.project).not.toBeNull();
    if (!resolution.project) throw new Error("expected authorized project");
    expect(projectRootEquals(resolution.project.projectRoot, leftRoot)).toBe(true);
  });
});
