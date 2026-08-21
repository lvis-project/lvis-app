// @vitest-environment jsdom
/**
 * The two ways "add a project" used to end in nothing visible happening.
 *
 * Both are driven through the real App tree because neither is observable in a
 * component test: the refusal has to reach the App-owned toast queue, and the
 * activation has to survive App's own project reconciliation.
 */
import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { App } from "../App.js";
import { makeMockLvisApi, makeMockLvisNamespace } from "../../../../test/renderer/mock-lvis-api.js";

const DEFAULT_ROOT = "C:\\Users\\example\\.lvis\\workspace";
const ADDED_ROOT = "C:\\work\\beta";
const ROOTS_AFTER_ADD = [
  { path: DEFAULT_ROOT, isDefault: true },
  { path: ADDED_ROOT, isDefault: false },
];

function mountApp(pickRootResult: unknown, listRootsResult?: unknown) {
  const { api } = makeMockLvisApi({ currentSession: "s1" });
  const { ns } = makeMockLvisNamespace();
  const workspace = (ns as unknown as {
    workspace: { listRoots: ReturnType<typeof vi.fn>; pickRoot: ReturnType<typeof vi.fn> };
  }).workspace;

  let added = false;
  workspace.listRoots.mockImplementation(async () => listRootsResult ?? {
    ok: true,
    defaultRoot: DEFAULT_ROOT,
    roots: added ? ROOTS_AFTER_ADD : [{ path: DEFAULT_ROOT, isDefault: true }],
  });
  workspace.pickRoot.mockImplementation(async () => {
    added = true;
    return pickRootResult;
  });

  // Stand in for what main really does with an authorized project: `chat:new`
  // writes the resolved identity into the new session's metadata, and the next
  // `chat:get-history` read returns it. Without that echo the App-level session
  // reconciliation has nothing to reconcile against.
  let sessionProject: { projectRoot?: string; projectName?: string } = {};
  api.chatNew.mockImplementation(async (project?: { projectRoot?: string; projectName?: string }) => {
    sessionProject = project ?? {};
    return { ok: true };
  });
  api.chatGetHistory.mockImplementation(async () => ({
    sessionId: "s1",
    messages: [],
    ...sessionProject,
  }) as never);

  vi.stubGlobal("lvisApi", api);
  vi.stubGlobal("lvis", ns);
  (window as unknown as { lvisApi: unknown }).lvisApi = api;
  (window as unknown as { lvis: unknown }).lvis = ns;
  return { api, ...render(<App />) };
}

function openSelector(getByTestId: (id: string) => HTMLElement) {
  const trigger = getByTestId("composer-project-selector-trigger");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

async function clickAddProject(getByTestId: (id: string) => HTMLElement) {
  await waitFor(() => expect(getByTestId("composer-project-selector-trigger")).toBeTruthy());
  openSelector(getByTestId);
  await waitFor(() => expect(getByTestId("composer-project-selector-menu")).toBeTruthy());
  fireEvent.click(getByTestId("composer-project-selector-add"));
}

describe("App add-project flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports a refused pick instead of closing as if the user had cancelled", async () => {
    const { getByTestId, findAllByTestId } = mountApp({ ok: false, error: "persist-failed" });
    await clickAddProject(getByTestId);

    const toasts = await findAllByTestId("status-toast-message");
    expect(toasts.map((node) => node.textContent).join(" ").trim().length).toBeGreaterThan(0);
  });

  /**
   * A settings file main could not fully read reaches the user here or nowhere:
   * the project list is the only surface that would otherwise render the gap as
   * an ordinary absence of projects.
   */
  it("says the settings file could not be read instead of drawing an empty project list", async () => {
    const { findAllByTestId } = mountApp(
      { ok: true },
      { ok: false, error: "settings-unreadable" },
    );

    const toasts = await findAllByTestId("status-toast-message");
    expect(toasts.map((node) => node.textContent).join(" ")).toContain("설정 파일을 읽을 수 없어");
  });

  it("reports unreadable cleanup entries alongside a project list that still stands", async () => {
    const { findAllByTestId, getByTestId } = mountApp(
      { ok: true },
      {
        ok: true,
        defaultRoot: DEFAULT_ROOT,
        roots: ROOTS_AFTER_ADD,
        settingsFault: "pending-removals-malformed",
      },
    );

    const toasts = await findAllByTestId("status-toast-message");
    expect(toasts.map((node) => node.textContent).join(" ")).toContain("삭제 대기 항목");
    // The roots were readable, so they are still offered — the warning is about
    // the part of the file that was not.
    await waitFor(() => expect(getByTestId("composer-project-selector-trigger")).toBeTruthy());
    openSelector(getByTestId);
    await waitFor(() =>
      expect(getByTestId("composer-project-selector-menu").textContent).toContain("beta"),
    );
  });

  it("starts the new chat in the folder just added, not the default project", async () => {
    const { api, getByTestId } = mountApp({
      ok: true,
      added: ADDED_ROOT,
      roots: ROOTS_AFTER_ADD,
    });
    await clickAddProject(getByTestId);

    // The list this renderer knew at click time did NOT contain the new folder —
    // the refresh has not re-rendered the callback yet — so this is exactly the
    // case that used to be replaced by the default project.
    await waitFor(() =>
      expect(api.chatNew).toHaveBeenCalledWith({ projectRoot: ADDED_ROOT, projectName: "beta" }),
    );
    await waitFor(() => {
      const trigger = getByTestId("composer-project-selector-trigger");
      expect(trigger.getAttribute("data-selected")).toBe("true");
      expect(trigger.textContent).toContain("beta");
    });
  });
});
