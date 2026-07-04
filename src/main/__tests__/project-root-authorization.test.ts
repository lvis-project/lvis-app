import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePermissionSettings } from "../../permissions/permission-settings-store.js";
import {
  defaultWorkspaceProject,
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
    await writePermissionSettings({ additionalDirectories: [allowed] });

    const allowedResolution = resolveAuthorizedWorkspaceProject(allowed, "allowed");
    expect(allowedResolution).toMatchObject({
      authorized: true,
      project: {
        projectName: "allowed",
      },
    });
    expect(allowedResolution.project).not.toBeNull();
    if (!allowedResolution.project) throw new Error("expected authorized project");
    expect(projectRootEquals(allowedResolution.project.projectRoot, allowed)).toBe(true);
    expect(resolveAuthorizedWorkspaceProject(`${allowed}/`, "allowed")).toMatchObject({
      authorized: true,
    });
    expect(resolveAuthorizedWorkspaceProject(denied, "denied")).toMatchObject({
      authorized: false,
      project: null,
    });
  });
});
