import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";

/**
 * Visit history and the top-bar path, driven the way a user drives them:
 *
 * Labels are asserted in the harness's own locale (Korean) rather than
 * English — asserting the shipped catalogue text is what proves the path
 * renders a real translated label and not a raw key.
 *
 * sidebar clicks and the toolbar's own buttons.
 *
 * A unit test over the history stack would pass with the stack wired to
 * nothing, so every assertion here goes through the real producers and reads
 * the rendered path.
 */
describe("App view history", () => {
  afterEach(() => vi.restoreAllMocks());

  const path = (container: HTMLElement) =>
    container.querySelector('[data-testid="view-path-breadcrumb"]')?.textContent?.trim() ?? "";

  async function click(container: HTMLElement, testid: string) {
    const el = container.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement | null;
    expect(el, `missing [data-testid="${testid}"]`).not.toBeNull();
    await act(async () => {
      fireEvent.click(el!);
    });
  }

  async function ready(container: HTMLElement) {
    await waitFor(() =>
      expect(container.querySelector('[data-testid="view-path-nav"]')).not.toBeNull());
  }

  it("records each visit and replays it backward and forward", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await ready(container);
    expect(path(container)).toContain("홈");

    await click(container, "toolbar-work-board");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    await click(container, "sidebar-routines");
    await waitFor(() => expect(path(container)).toContain("루틴"));

    await click(container, "view-path-back");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    await click(container, "view-path-back");
    await waitFor(() => expect(path(container)).toContain("홈"));

    await click(container, "view-path-forward");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    await click(container, "view-path-forward");
    await waitFor(() => expect(path(container)).toContain("루틴"));
  });

  it("disables the buttons at each end rather than silently doing nothing", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await ready(container);

    const back = () => container.querySelector('[data-testid="view-path-back"]') as HTMLButtonElement;
    const forward = () => container.querySelector('[data-testid="view-path-forward"]') as HTMLButtonElement;
    expect(back().disabled).toBe(true);
    expect(forward().disabled).toBe(true);

    await click(container, "toolbar-work-board");
    await waitFor(() => expect(back().disabled).toBe(false));
    expect(forward().disabled).toBe(true);

    await click(container, "view-path-back");
    await waitFor(() => expect(forward().disabled).toBe(false));
    expect(back().disabled).toBe(true);
  });

  it("does not record re-selecting the place you are already at", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await ready(container);

    await click(container, "toolbar-work-board");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    await click(container, "sidebar-routines");
    await waitFor(() => expect(path(container)).toContain("루틴"));
    // Clicking the entry you are already on is common and must not stack up
    // entries that appear to do nothing when replayed.
    await click(container, "sidebar-routines");
    await click(container, "sidebar-routines");

    await click(container, "view-path-back");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
  });

  it("records a settings tab move, so the path and back agree with each other", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await ready(container);

    await click(container, "sidebar-settings");
    await waitFor(() => expect(path(container)).toContain("설정"));
    expect(path(container)).toContain("모델");

    // The panel's own nav — the same control the user clicks. Radix's
    // TabsTrigger switches on mousedown, not click, so a bare click would
    // assert nothing here.
    await act(async () => {
      fireEvent.mouseDown(screen.getByRole("tab", { name: /권한/ }), { button: 0 });
    });
    await waitFor(() => expect(path(container)).toContain("권한"));

    // The path visibly changed, so back must undo exactly that step.
    await click(container, "view-path-back");
    await waitFor(() => expect(path(container)).toContain("모델"));
  });

  it("makes the page's own back button mean the same thing as the toolbar's", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await ready(container);

    await click(container, "toolbar-work-board");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    await click(container, "sidebar-routines");
    await waitFor(() => expect(path(container)).toContain("루틴"));

    // Before this change the in-page back went unconditionally home, which
    // disagreed with the toolbar's back sitting inches away.
    await click(container, "main-content-back");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
  });

  it("truncates the forward entries when a new visit follows a back", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await ready(container);

    await click(container, "toolbar-work-board");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    await click(container, "view-path-back");
    await waitFor(() => expect(path(container)).toContain("홈"));

    // Navigating somewhere new discards what was ahead, as a browser does.
    await click(container, "sidebar-routines");
    await waitFor(() => expect(path(container)).toContain("루틴"));
    const forward = container.querySelector('[data-testid="view-path-forward"]') as HTMLButtonElement;
    expect(forward.disabled).toBe(true);

    // ...and back now returns to home, not to the discarded work board.
    await click(container, "main-content-back");
    await waitFor(() => expect(path(container)).toContain("홈"));
  });

});
