// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { ComposerProjectSelector } from "../ComposerProjectSelector.js";
import type { ProjectIdentity } from "../../../../shared/project-identity.js";

// PROJECTS[0] is the default/base-directory binding — never shown as a
// selectable or "selected" project (2026-07 "remove Current Project
// labeling"). Only PROJECTS[1] ("alpha", a real user-added project) counts
// as an explicit selection.
const PROJECTS: ProjectIdentity[] = [
  { projectRoot: "C:\\Users\\ikcha\\.lvis\\workspace", projectName: "default", isDefault: true },
  { projectRoot: "C:\\work\\alpha", projectName: "alpha" },
];

/** Controlled wrapper so the test drives `open` the same way ChatComposerDock does. */
function Harness(props: Partial<Parameters<typeof ComposerProjectSelector>[0]> = {}) {
  const [open, setOpen] = useState(false);
  return (
    <ComposerProjectSelector
      activeProject={PROJECTS[0]}
      projects={PROJECTS}
      onSelectProject={vi.fn()}
      onRefreshProjects={vi.fn()}
      open={open}
      onOpenChange={setOpen}
      {...props}
    />
  );
}

function installWorkspaceMock(pickRoot = vi.fn(async () => ({ ok: true, roots: [], canceled: true }))) {
  const previous = (window as unknown as { lvis?: unknown }).lvis;
  (window as unknown as { lvis?: unknown }).lvis = {
    ...(previous && typeof previous === "object" ? previous : {}),
    workspace: { pickRoot },
  };
  return () => {
    (window as unknown as { lvis?: unknown }).lvis = previous;
  };
}

/** Radix DropdownMenu opens on pointerdown, so fire that before the click
 *  (mirrors ChatSidePanel.test.tsx's openLauncherMenu helper). */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

describe("ComposerProjectSelector", () => {
  it("shows a muted 'Select project' placeholder CTA when no explicit project is active (default binding)", () => {
    const restore = installWorkspaceMock();
    try {
      const { getByTestId } = render(<Harness activeProject={PROJECTS[0]} />);
      const trigger = getByTestId("composer-project-selector-trigger");
      // PROJECTS[0] is the default/base-directory binding — never surfaced as
      // a selected project name, even though it is a populated ProjectIdentity.
      expect(trigger.textContent).not.toContain("default");
      // Test runtime defaults to the ko locale (see other tests' Korean
      // strings in this codebase's suites) — "프로젝트 선택" is
      // composerProjectSelector.selectProjectPlaceholder's ko value.
      expect(trigger.textContent).toContain("프로젝트 선택");
      expect(trigger.getAttribute("data-selected")).toBe("false");
    } finally {
      restore();
    }
  });

  it("shows a muted 'Select project' placeholder when no project is active at all (undefined)", () => {
    const restore = installWorkspaceMock();
    try {
      const { getByTestId } = render(<Harness activeProject={undefined} />);
      const trigger = getByTestId("composer-project-selector-trigger");
      // Test runtime defaults to the ko locale (see other tests' Korean
      // strings in this codebase's suites) — "프로젝트 선택" is
      // composerProjectSelector.selectProjectPlaceholder's ko value.
      expect(trigger.textContent).toContain("프로젝트 선택");
      expect(trigger.getAttribute("data-selected")).toBe("false");
    } finally {
      restore();
    }
  });

  it("shows the real project name once an explicit (non-default) project is active", () => {
    const restore = installWorkspaceMock();
    try {
      const { getByTestId } = render(<Harness activeProject={PROJECTS[1]} />);
      const trigger = getByTestId("composer-project-selector-trigger");
      expect(trigger.textContent).toContain("alpha");
      expect(trigger.textContent).not.toContain("Select project");
      expect(trigger.getAttribute("data-selected")).toBe("true");
    } finally {
      restore();
    }
  });

  it("opens a downward (side=bottom) menu listing only real (non-default) projects", async () => {
    const restore = installWorkspaceMock();
    try {
      const { getByTestId, getAllByTestId, queryAllByTestId } = render(<Harness />);
      openMenu(getByTestId("composer-project-selector-trigger"));
      await waitFor(() => {
        const menu = getByTestId("composer-project-selector-menu");
        expect(menu).toBeTruthy();
        expect(menu.getAttribute("data-side")).toBe("bottom");
      });
      // The default binding (PROJECTS[0]) is never a pickable list entry.
      const items = getAllByTestId("composer-project-selector-item");
      expect(items).toHaveLength(1);
      expect(items.map((item) => item.textContent)).toEqual(["alpha"]);
      expect(queryAllByTestId("composer-project-selector-item").some((item) => item.textContent?.includes("default"))).toBe(false);
    } finally {
      restore();
    }
  });

  it("selecting a project calls onSelectProject with that project's identity and closes the menu", async () => {
    const restore = installWorkspaceMock();
    try {
      const onSelectProject = vi.fn();
      const { getByTestId, queryByTestId, getAllByTestId } = render(
        <Harness onSelectProject={onSelectProject} />,
      );
      openMenu(getByTestId("composer-project-selector-trigger"));
      await waitFor(() => expect(getByTestId("composer-project-selector-menu")).toBeTruthy());

      const items = getAllByTestId("composer-project-selector-item");
      fireEvent.click(items[0]!);

      expect(onSelectProject).toHaveBeenCalledWith({ projectRoot: "C:\\work\\alpha", projectName: "alpha" });
      await waitFor(() => {
        expect(queryByTestId("composer-project-selector-menu")?.getAttribute("data-state")).not.toBe("open");
      });
    } finally {
      restore();
    }
  });

  it("'add new project' invokes workspace.pickRoot and switches to the newly added root", async () => {
    const pickRoot = vi.fn(async () => ({
      ok: true,
      added: "C:\\work\\beta",
      roots: [
        { path: "C:\\Users\\ikcha\\.lvis\\workspace", isDefault: true },
        { path: "C:\\work\\alpha", isDefault: false },
        { path: "C:\\work\\beta", isDefault: false },
      ],
    }));
    const restore = installWorkspaceMock(pickRoot);
    try {
      const onSelectProject = vi.fn();
      const onRefreshProjects = vi.fn();
      const { getByTestId } = render(
        <Harness onSelectProject={onSelectProject} onRefreshProjects={onRefreshProjects} />,
      );
      openMenu(getByTestId("composer-project-selector-trigger"));
      await waitFor(() => expect(getByTestId("composer-project-selector-menu")).toBeTruthy());
      fireEvent.click(getByTestId("composer-project-selector-add"));

      await waitFor(() => expect(pickRoot).toHaveBeenCalled());
      await waitFor(() => expect(onRefreshProjects).toHaveBeenCalled());
      await waitFor(() =>
        expect(onSelectProject).toHaveBeenCalledWith({ projectRoot: "C:\\work\\beta", projectName: "beta" }),
      );
    } finally {
      restore();
    }
  });

  it("surfaces the adjacency-warning acknowledgement flow before adding", async () => {
    const pickRoot = vi.fn(async (opts?: { ackToken?: string }) => {
      if (opts?.ackToken) {
        return { ok: true, added: "C:\\sensitive-adjacent", roots: [{ path: "C:\\sensitive-adjacent", isDefault: false }] };
      }
      return {
        ok: true,
        requiresAcknowledgement: true,
        pendingPath: "C:\\sensitive-adjacent",
        ackToken: "tok-1",
        warnings: ["adjacent to a sensitive directory"],
      };
    });
    const restore = installWorkspaceMock(pickRoot);
    try {
      const onSelectProject = vi.fn();
      const { getByTestId } = render(<Harness onSelectProject={onSelectProject} />);
      openMenu(getByTestId("composer-project-selector-trigger"));
      await waitFor(() => expect(getByTestId("composer-project-selector-menu")).toBeTruthy());
      fireEvent.click(getByTestId("composer-project-selector-add"));

      await waitFor(() => expect(getByTestId("composer-project-selector-root-warning")).toBeTruthy());
      fireEvent.click(getByTestId("composer-project-selector-root-warning-confirm"));

      await waitFor(() => expect(pickRoot).toHaveBeenCalledWith({ ackToken: "tok-1" }));
      await waitFor(() =>
        expect(onSelectProject).toHaveBeenCalledWith({ projectRoot: "C:\\sensitive-adjacent", projectName: "sensitive-adjacent" }),
      );
    } finally {
      restore();
    }
  });
});
