import { describe, expect, it } from "vitest";
import { viewLocationBreadcrumb, type BreadcrumbDeps } from "../view-location.js";

// Labels come back as their catalogue keys, so the assertions read which key
// each crumb reuses rather than one locale's rendering of it.
const deps = (sessionProject?: BreadcrumbDeps["sessionProject"]): BreadcrumbDeps => ({
  t: ((key: string) => key) as BreadcrumbDeps["t"],
  pluginViewLabel: () => undefined,
  sessionProject,
});

describe("viewLocationBreadcrumb root", () => {
  it("names a plain conversation after the sidebar's Chats tab — never 'home'", () => {
    const crumbs = viewLocationBreadcrumb({ view: "home" }, deps());
    expect(crumbs).toEqual([{ key: "home", label: "sidebar.chatsTab" }]);
    expect(crumbs.some((crumb) => crumb.label.includes("home"))).toBe(false);
  });

  it("names a project conversation after the Projects tab, then the project, with no crumb to click", () => {
    const crumbs = viewLocationBreadcrumb({ view: "home" }, deps({ projectName: "alpha" }));
    expect(crumbs).toEqual([
      { key: "projects", label: "sidebar.projectsTab" },
      { key: "home", label: "alpha" },
    ]);
    expect(crumbs.every((crumb) => crumb.target === undefined)).toBe(true);
  });

  it("leaves the other built-ins on their sidebar labels", () => {
    expect(viewLocationBreadcrumb({ view: "routines" }, deps({ projectName: "alpha" }))).toEqual([
      { key: "routines", label: "mainToolbar.routines" },
    ]);
  });
});
