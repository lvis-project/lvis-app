import { describe, expect, it } from "vitest";
import {
  findWorkspaceProject,
  reconcileActiveProject,
  workspaceRootsToProjects,
  type ProjectIdentity,
} from "../project-identity.js";

describe("workspaceRootsToProjects", () => {
  it("deduplicates the same canonical root", () => {
    const projects = workspaceRootsToProjects(
      "C:\\work\\default",
      [
        { path: "C:\\work\\client\\app", isDefault: false },
        { path: "c:/work/client/app/", isDefault: false },
      ],
      "default",
    );

    expect(projects).toHaveLength(2);
    expect(projects[1]?.projectRoot).toBe("C:\\work\\client\\app");
  });

  it("keeps distinct same-basename roots and adds the shortest unique parent suffix", () => {
    const projects = workspaceRootsToProjects(
      "/work/default",
      [
        { path: "/work/client/app", isDefault: false },
        { path: "/work/server/app", isDefault: false },
      ],
      "default",
    );

    expect(projects.filter((project) => !project.isDefault).map((project) => project.projectName)).toEqual([
      "app \u2014 client",
      "app \u2014 server",
    ]);
  });

  it("only expands the labels whose immediate parent still collides", () => {
    const projects = workspaceRootsToProjects(
      "/work/default",
      [
        { path: "/work/one/shared/app", isDefault: false },
        { path: "/work/two/shared/app", isDefault: false },
        { path: "/work/three/solo/app", isDefault: false },
      ],
      "default",
    );

    expect(projects.filter((project) => !project.isDefault).map((project) => project.projectName)).toEqual([
      "app \u2014 one/shared",
      "app \u2014 two/shared",
      "app \u2014 solo",
    ]);
  });

  it("excludes the default project from display-name collision grouping", () => {
    const projects = workspaceRootsToProjects(
      "/workspace/app",
      [{ path: "/client/app", isDefault: false }],
      "default",
    );

    expect(projects.map((project) => project.projectName)).toEqual(["app", "app"]);
  });
});

describe("workspace project reconciliation", () => {
  const defaultProject: ProjectIdentity = {
    projectRoot: "/workspace/default",
    projectName: "default",
    isDefault: true,
  };
  const authorizedProject: ProjectIdentity = {
    projectRoot: "/workspace/client/app",
    projectName: "app \u2014 client",
  };
  const projects = [defaultProject, authorizedProject];

  it("returns the current authorized entry instead of stale display data", () => {
    const staleSelection = {
      projectRoot: "/workspace/client/app/",
      projectName: "old label",
    };

    expect(findWorkspaceProject(projects, staleSelection)).toBe(authorizedProject);
    expect(reconcileActiveProject(staleSelection, projects)).toBe(authorizedProject);
  });

  it("falls back to the default project when the selected root is no longer authorized", () => {
    expect(reconcileActiveProject({ projectRoot: "/workspace/removed" }, projects)).toBe(defaultProject);
    expect(reconcileActiveProject(undefined, [])).toBeUndefined();
  });
});
