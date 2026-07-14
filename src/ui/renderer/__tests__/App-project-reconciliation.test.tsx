// @vitest-environment jsdom
import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { App } from "../App.js";
import { makeMockLvisApi, makeMockLvisNamespace } from "../../../../test/renderer/mock-lvis-api.js";

describe("App session project reconciliation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("falls back to the default project when a loaded general chat has no project identity", async () => {
    const { api } = makeMockLvisApi({
      currentSession: "project-session",
      history: {
        sessionId: "project-session",
        messages: [],
        projectRoot: "C:\\work\\alpha",
        projectName: "alpha",
      } as never,
      sessions: [{
        id: "general-session",
        modifiedAt: new Date().toISOString(),
        title: "일반 대화 로드",
        sessionKind: "main",
      }],
    });
    const { ns } = makeMockLvisNamespace();
    const workspace = (ns as unknown as {
      workspace: { listRoots: ReturnType<typeof vi.fn> };
    }).workspace;
    workspace.listRoots.mockResolvedValue({
      ok: true,
      defaultRoot: "C:\\workspace",
      roots: [
        { path: "C:\\workspace", isDefault: true },
        { path: "C:\\work\\alpha", isDefault: false },
      ],
    });

    vi.stubGlobal("lvisApi", api);
    vi.stubGlobal("lvis", ns);
    (window as unknown as { lvisApi: unknown }).lvisApi = api;
    (window as unknown as { lvis: unknown }).lvis = ns;

    const { getByTestId, getByText } = render(<App />);
    await waitFor(() => {
      const trigger = getByTestId("composer-project-selector-trigger");
      expect(trigger.getAttribute("data-selected")).toBe("true");
      expect(trigger.textContent).toContain("alpha");
    });

    fireEvent.click(getByText("일반 대화 로드"));
    await waitFor(() => expect(api.chatSessionHistory).toHaveBeenCalledWith("general-session"));
    await waitFor(() => {
      const trigger = getByTestId("composer-project-selector-trigger");
      expect(trigger.getAttribute("data-selected")).toBe("false");
      expect(trigger.textContent).not.toContain("alpha");
    });
  });
});
