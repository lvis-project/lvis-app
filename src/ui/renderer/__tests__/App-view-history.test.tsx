import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";
import {
  clickSidebarNavRow,
  deferred,
  focusTile,
  mountedTileIds,
  settingsWithActiveView,
  splitIntoTwoTiles,
} from "../../../../test/renderer/helpers.js";
import { MOCK_DEFAULT_SETTINGS } from "../../../../test/renderer/mock-lvis-api.js";
import { TEST_IDS, testIdSelector } from "../../../shared/test-ids.js";

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
/** Which pane the window is ON — the one the frame marks focused. */
const focusedPaneId = (container: HTMLElement) =>
  container
    .querySelector('[data-testid="chat-group"][data-focused="true"]')
    ?.closest('[data-testid^="chat-group-cell:"]')
    ?.getAttribute("data-testid")
    ?.slice("chat-group-cell:".length) ?? null;

/** The rendered path text, which is what the user actually reads. */
const path = (container: HTMLElement) =>
  container.querySelector('[data-testid="view-path-breadcrumb"]')?.textContent?.trim() ?? "";

/** Click a control the way the user reaches it — by its test id, through the
 *  real handler — and let the resulting commit land before returning. */
async function click(container: HTMLElement, testid: string) {
  const el = container.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement | null;
  expect(el, `missing [data-testid="${testid}"]`).not.toBeNull();
  await act(async () => {
    fireEvent.click(el!);
  });
}

describe("App view history", () => {
  afterEach(() => vi.restoreAllMocks());

  async function ready(container: HTMLElement) {
    await waitFor(() =>
      expect(container.querySelector('[data-testid="view-path-nav"]')).not.toBeNull());
  }

  it("records each visit and replays it backward and forward", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await ready(container);
    expect(path(container)).toContain("대화");

    await clickSidebarNavRow("features", "toolbar-work-board");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    await clickSidebarNavRow("features", "sidebar-routines");
    await waitFor(() => expect(path(container)).toContain("루틴"));

    await click(container, "view-path-back");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    await click(container, "view-path-back");
    await waitFor(() => expect(path(container)).toContain("대화"));

    await click(container, "view-path-forward");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    await click(container, "view-path-forward");
    await waitFor(() => expect(path(container)).toContain("루틴"));
  });

  it("names the destination on the buttons, since chat mode shows no path", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await ready(container);
    const back = () => container.querySelector(testIdSelector(TEST_IDS.viewPathBack)) as HTMLButtonElement;

    // Nothing behind yet: the generic label, and no destination to claim.
    expect(back().getAttribute("aria-label")).toBe("뒤로");

    await clickSidebarNavRow("features", "toolbar-work-board");
    await waitFor(() => expect(back().disabled).toBe(false));
    // Now it can say where it goes — the only cue left at chat width.
    await waitFor(() => expect(back().getAttribute("aria-label")).toContain("대화"));

    await clickSidebarNavRow("features", "sidebar-routines");
    await waitFor(() => expect(back().getAttribute("aria-label")).toContain("업무 보드"));
  });

  it("disables the buttons at each end rather than silently doing nothing", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await ready(container);

    const back = () => container.querySelector(testIdSelector(TEST_IDS.viewPathBack)) as HTMLButtonElement;
    const forward = () => container.querySelector('[data-testid="view-path-forward"]') as HTMLButtonElement;
    expect(back().disabled).toBe(true);
    expect(forward().disabled).toBe(true);

    await clickSidebarNavRow("features", "toolbar-work-board");
    await waitFor(() => expect(back().disabled).toBe(false));
    expect(forward().disabled).toBe(true);

    await click(container, "view-path-back");
    await waitFor(() => expect(forward().disabled).toBe(false));
    expect(back().disabled).toBe(true);
  });

  it("does not record re-selecting the place you are already at", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await ready(container);

    await clickSidebarNavRow("features", "toolbar-work-board");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    await clickSidebarNavRow("features", "sidebar-routines");
    await waitFor(() => expect(path(container)).toContain("루틴"));
    // Clicking the entry you are already on is common and must not stack up
    // entries that appear to do nothing when replayed.
    await clickSidebarNavRow("features", "sidebar-routines");
    await clickSidebarNavRow("features", "sidebar-routines");

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

    // Re-enter a child page, then use the ancestor breadcrumb. The destination
    // is Settings / Model, not the current child tab again.
    await act(async () => {
      fireEvent.mouseDown(screen.getByRole("tab", { name: /권한/ }), { button: 0 });
    });
    await waitFor(() => expect(path(container)).toContain("권한"));
    await click(container, "view-path-segment-settings");
    await waitFor(() => expect(path(container)).toContain("모델"));
    expect(screen.getByRole("tab", { name: /모델/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("moves FOCUS when a step lands on a location another pane already shows", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await ready(container);

    // One pane on Routines, then a second pane on the work board.
    await clickSidebarNavRow("features", "sidebar-routines");
    await waitFor(() => expect(path(container)).toContain("루틴"));
    await clickSidebarNavRow("features", "toolbar-work-board", { metaKey: true });
    await waitFor(() => expect(mountedTileIds(container)).toHaveLength(2));
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    const [first, second] = mountedTileIds(container);
    expect(focusedPaneId(container)).toBe(second);

    // Back: Routines is open in the FIRST pane, so the step focuses that pane
    // instead of drawing a second copy of it. No pane is added, and the second
    // pane keeps the work board.
    await click(container, "view-path-back");
    await waitFor(() => expect(path(container)).toContain("루틴"));
    expect(mountedTileIds(container)).toHaveLength(2);
    expect(focusedPaneId(container)).toBe(first);

    // Forward is the same rule in the other direction.
    await click(container, "view-path-forward");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    expect(mountedTileIds(container)).toHaveLength(2);
    expect(focusedPaneId(container)).toBe(second);
  });

  it("does not record the new pane's own conversation as a stop on the way", async () => {
    // The gesture makes a pane and puts a view in it. If those landed as two
    // location changes, the pane's blank conversation would sit in the history
    // between them and one back would go nowhere the user had been.
    const { container } = await renderApp({ hasApiKey: true });
    await ready(container);

    await clickSidebarNavRow("features", "sidebar-routines");
    await waitFor(() => expect(path(container)).toContain("루틴"));
    await clickSidebarNavRow("features", "toolbar-work-board", { metaKey: true });
    await waitFor(() => expect(path(container)).toContain("업무 보드"));

    await click(container, "view-path-back");
    await waitFor(() => expect(path(container)).toContain("루틴"));
  });

  it("follows a change of FOCUS, with no navigation at all", async () => {
    // The path says where the window is, and the window is the focused pane.
    // Clicking into a pane that holds a different location moves the window
    // there — nothing navigated, and the path still has to agree.
    const { container } = await renderApp({ hasApiKey: true });
    await ready(container);

    const tiles = await splitIntoTwoTiles(container);
    const [firstTile, secondTile] = tiles;
    await focusTile(firstTile!);
    await clickSidebarNavRow("features", "sidebar-routines");
    await waitFor(() => expect(path(container)).toContain("루틴"));

    // The other pane is still on its own conversation.
    await focusTile(secondTile!);
    await waitFor(() => expect(path(container)).toContain("대화"));
    expect(focusedPaneId(container)).toBe(secondTile!.chatGroupId);

    await focusTile(firstTile!);
    await waitFor(() => expect(path(container)).toContain("루틴"));
    expect(focusedPaneId(container)).toBe(firstTile!.chatGroupId);
  });

  it("keeps visit history exclusively in the toolbar", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await ready(container);

    await clickSidebarNavRow("features", "toolbar-work-board");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    await clickSidebarNavRow("features", "sidebar-routines");
    await waitFor(() => expect(path(container)).toContain("루틴"));

    expect(container.querySelector('[data-testid="main-content-back"]')).toBeNull();
    expect(container.querySelector('[data-testid="page-shell-back"]')).toBeNull();
    await click(container, "view-path-back");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
  });

  it("truncates the forward entries when a new visit follows a back", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await ready(container);

    await clickSidebarNavRow("features", "toolbar-work-board");
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    await click(container, "view-path-back");
    await waitFor(() => expect(path(container)).toContain("대화"));

    // Navigating somewhere new discards what was ahead, as a browser does.
    await clickSidebarNavRow("features", "sidebar-routines");
    await waitFor(() => expect(path(container)).toContain("루틴"));
    const forward = container.querySelector('[data-testid="view-path-forward"]') as HTMLButtonElement;
    expect(forward.disabled).toBe(true);

    // ...and back now returns to home, not to the discarded work board.
    await click(container, "view-path-back");
    await waitFor(() => expect(path(container)).toContain("대화"));
  });

});

/**
 * Where visit history meets the restored launch location (#1995).
 *
 * These two features pass their own suites independently and still combine
 * wrongly: the restore lands ASYNCHRONOUSLY, so a history that records every
 * location change sees `home → restored` and offers "back" to a home screen
 * the user never opened.
 */
describe("App view history after a restored launch location", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts with nothing behind it — the restore is arrival, not a step", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView("work-board"),
    });

    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    const back = container.querySelector(testIdSelector(TEST_IDS.viewPathBack)) as HTMLButtonElement;
    // Without this, back would offer a home screen that was never visited.
    expect(back.disabled).toBe(true);
  });

  it("restores the settings PAGE into the path, not just the view", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView("settings", "permissions"),
    });

    await waitFor(() => expect(path(container)).toContain("권한"));
    const back = container.querySelector(testIdSelector(TEST_IDS.viewPathBack)) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
  });

  it("records normally once the user navigates from the restored location", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      settings: settingsWithActiveView("work-board"),
    });
    await waitFor(() => expect(path(container)).toContain("업무 보드"));

    await clickSidebarNavRow("features", "sidebar-routines");
    await waitFor(() => expect(path(container)).toContain("루틴"));

    // Back now returns to where the app launched — not to home.
    await act(async () => {
      fireEvent.click(container.querySelector(testIdSelector(TEST_IDS.viewPathBack)) as HTMLButtonElement);
    });
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
  });

  /**
   * The two halves of the pair, driven against a restore that is genuinely
   * still in flight: the settings read is held open, so the app renders and
   * accepts clicks while the launch location has not arrived yet. A restore
   * that resolves before the first paint exercises neither half.
   */
  const restoreGate = () => {
    const gate = deferred<unknown>();
    return { gate, getSettings: () => gate.promise };
  };

  const backButton = (container: HTMLElement) =>
    container.querySelector(testIdSelector(TEST_IDS.viewPathBack)) as HTMLButtonElement;

  it("counts a navigation made before the restore lands as a visit", async () => {
    const { gate, getSettings } = restoreGate();
    const { container } = await renderApp({ hasApiKey: true, getSettings });
    await waitFor(() => expect(container.querySelector('[data-testid="view-path-nav"]')).not.toBeNull());

    // The user acts while the launch location is still in flight. This is a
    // deliberate step away from home, not the app settling into where it left
    // off — losing it strands the user with a dead back button.
    await clickSidebarNavRow("features", "sidebar-routines");
    await waitFor(() => expect(path(container)).toContain("루틴"));

    await act(async () => {
      gate.resolve(MOCK_DEFAULT_SETTINGS);
    });

    await waitFor(() => expect(backButton(container).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(backButton(container));
    });
    await waitFor(() => expect(path(container)).toContain("대화"));
  });

  it("still makes a late-landing restore the root rather than a step from home", async () => {
    const { gate, getSettings } = restoreGate();
    const { container } = await renderApp({ hasApiKey: true, getSettings });
    await waitFor(() => expect(path(container)).toContain("대화"));

    // Nobody navigated; the app simply arrived where it was left. A restart
    // must not offer "back" to the home screen it passed through.
    await act(async () => {
      gate.resolve(settingsWithActiveView("work-board"));
    });
    await waitFor(() => expect(path(container)).toContain("업무 보드"));
    expect(backButton(container).disabled).toBe(true);
  });

  /** Let every pending restore land before concluding that none moved anything. */
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 100)); });

  it("does not move the user off a step they took before the restore landed", async () => {
    const { gate, getSettings } = restoreGate();
    const { container } = await renderApp({ hasApiKey: true, getSettings });
    await waitFor(() => expect(container.querySelector('[data-testid="view-path-nav"]')).not.toBeNull());

    await clickSidebarNavRow("features", "sidebar-routines");
    await waitFor(() => expect(path(container)).toContain("루틴"));

    // The stored location arrives after the user has already chosen one. Being
    // able to press back afterwards is not the same as not being moved: this
    // used to land, and the step out of the user's page was undoable rather
    // than absent.
    await act(async () => {
      gate.resolve(settingsWithActiveView("work-board"));
    });
    await settle();
    expect(path(container)).toContain("루틴");

    // What is behind them is their own step off the seed, not a launch
    // location that never took effect.
    await act(async () => {
      fireEvent.click(backButton(container));
    });
    await waitFor(() => expect(path(container)).toContain("대화"));
  });

  /**
   * The settings PAGE restores from its own read and is NOT discarded by a
   * navigation here — choosing a view says nothing about which settings page
   * you want. It raises the same restore count this history reads, though, and
   * that count is shared between both halves: an increase means "one of them
   * moved", never "the window moved".
   *
   * So the half nobody is looking at can raise the count while the location
   * stays exactly where it was. That increase has to be SPENT where it lands.
   * Surviving, it would be waiting for the next location change — the user's
   * own step, taken while the history is still the untouched seed — and would
   * be read as the launch location arriving, REPLACING the root rather than
   * stacking on it and leaving a step from home with a dead back button.
   *
   * That the page half lands at all is asserted next door and by the
   * reverse-order pair below. It is not re-asserted here, because the user
   * never enters Settings in this test — and every UI route in names a page,
   * `onOpenSettings` supplying its own `llm` default when the caller does not,
   * so the restored page is replaced on the way in. What this pins is the
   * other side of that wire: what the raised count must NOT do.
   */
  it("does not let the settings-page half turn the user's next step into the launch location", async () => {
    // Held open so the whole exchange happens inside the restore window, which
    // is the only place either half can land late.
    let released = false;
    const gates: Array<ReturnType<typeof deferred<unknown>>> = [];
    const stored = settingsWithActiveView("work-board", "permissions");
    const { container } = await renderApp({
      hasApiKey: true,
      getSettings: () => {
        if (released) return Promise.resolve(stored);
        const gate = deferred<unknown>();
        gates.push(gate);
        return gate.promise;
      },
    });
    await waitFor(() => expect(container.querySelector('[data-testid="view-path-nav"]')).not.toBeNull());

    // Starting a new chat discards the VIEW half — it navigates to the chat
    // surface, which is where they already are, so it is the one navigation
    // that leaves the history untouched and the seed is still the only entry
    // when the surviving half lands.
    await click(container, "sidebar-new-chat");
    expect(path(container)).toContain("대화");

    // Released one commit at a time — over IPC these are separate round trips,
    // and batching them never observes the page half on its own.
    released = true;
    for (const gate of [...gates]) {
      await act(async () => {
        gate.resolve(stored);
      });
    }
    await settle();

    // Nothing moved: the view half was discarded, and a settings page is not a
    // place while the user is not in Settings.
    expect(path(container)).toContain("대화");

    // NOW the user takes their first real step, with the history still the
    // untouched seed. It is a step, not an arrival — the count went up for a
    // page they are not looking at.
    await clickSidebarNavRow("features", "sidebar-routines");
    await waitFor(() => expect(path(container)).toContain("루틴"));
    expect(backButton(container).disabled).toBe(false);
    await click(container, "view-path-back");
    await waitFor(() => expect(path(container)).toContain("대화"));
  });

  /**
   * The mirror of the test above: a restore that lands after the user has
   * already been somewhere is a MOVE, not an arrival, and the root belongs to
   * where they started. Only an untouched seed may be replaced.
   *
   * The page half is the only half that still lands here, because it has no
   * discard of its own — choosing a settings page inside the restore window is
   * overridden, a gap `useSettingsTab` owns. This does not assert that
   * override is right; it asserts that while it happens, the step it makes is
   * one the user can undo.
   */
  it("stacks a settings-page restore that lands after the user has been somewhere", async () => {
    let released = false;
    const gates: Array<ReturnType<typeof deferred<unknown>>> = [];
    const stored = settingsWithActiveView("work-board", "permissions");
    const { container } = await renderApp({
      hasApiKey: true,
      getSettings: () => {
        if (released) return Promise.resolve(stored);
        const gate = deferred<unknown>();
        gates.push(gate);
        return gate.promise;
      },
    });
    await waitFor(() => expect(container.querySelector('[data-testid="view-path-nav"]')).not.toBeNull());

    // A real step first, so the history is no longer the seed. This also
    // discards the VIEW half, leaving the page half as the only late arrival.
    await click(container, "sidebar-settings");
    await waitFor(() => expect(path(container)).toContain("모델"));

    released = true;
    for (const gate of [...gates]) {
      await act(async () => {
        gate.resolve(stored);
      });
    }
    await waitFor(() => expect(path(container)).toContain("권한"));

    // Moved off the page they opened, so back has to lead there — not be
    // disabled because the restore claimed the root.
    expect(backButton(container).disabled).toBe(false);
    await click(container, "view-path-back");
    await waitFor(() => expect(path(container)).toContain("모델"));
  });

  // The view and the settings page are restored by two SEPARATE reads. Over
  // IPC those are two round trips and can land in two different commits, in
  // either order, so each pending read is released in its own commit and both
  // orders are driven — batching them into one, as the harness otherwise does,
  // never observes the second half on its own at all.
  for (const order of ["in call order", "in reverse order"] as const) {
    it(`takes the restored settings PAGE as the root when the halves land ${order}`, async () => {
      const gates: Array<ReturnType<typeof deferred<unknown>>> = [];
      const { container } = await renderApp({
        hasApiKey: true,
        getSettings: () => {
          const gate = deferred<unknown>();
          gates.push(gate);
          return gate.promise;
        },
      });
      await waitFor(() => expect(path(container)).toContain("대화"));

      const pending = order === "in reverse order" ? [...gates].reverse() : [...gates];
      for (const gate of pending) {
        await act(async () => {
          gate.resolve(settingsWithActiveView("settings", "permissions"));
        });
      }

      await waitFor(() => expect(path(container)).toContain("권한"));
      // Neither half is a place the user went, so neither may be offered as one.
      expect(backButton(container).disabled).toBe(true);
    });
  }
});
