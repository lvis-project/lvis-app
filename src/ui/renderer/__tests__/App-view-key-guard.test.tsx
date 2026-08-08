import "../../../../test/renderer/setup.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";

/**
 * Navigation reached through the `onViewActivate` IPC — the main process
 * naming a destination for the renderer.
 *
 * Driven through the real producer (`emitViewActivate`) rather than by calling
 * the guard directly: the point of this change is that a bad key stops BEFORE
 * it becomes `activeView`, and that is only observable end to end. Previously
 * any unrecognized string fell past every branch in MainContent and rendered
 * as a plugin view that does not exist, so the user saw "plugin view not
 * found" for what was really a typo.
 */
describe("App — view key guard on the activate-view IPC", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("navigates when the key names a real inline destination", async () => {
    const { emitViewActivate } = await renderApp();
    await waitFor(() => expect(screen.getByTestId("chat-view-root")).toBeTruthy());

    act(() => emitViewActivate("memory"));

    // The memory view is a back-affordance pane; home is a chat pane.
    await waitFor(() => expect(screen.getByTestId("main-content-back")).toBeTruthy());
    expect(screen.queryByTestId("chat-view-root")).toBeNull();
  });

  it("ignores a misspelled built-in key instead of rendering it as a plugin view", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emitViewActivate } = await renderApp();
    await waitFor(() => expect(screen.getByTestId("chat-view-root")).toBeTruthy());

    act(() => emitViewActivate("hom"));

    // Still home: the key never became `activeView`.
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'hom'")),
    );
    expect(screen.getByTestId("chat-view-root")).toBeTruthy();
    expect(screen.queryByTestId("main-content-unknown-view")).toBeNull();
  });

  it("ignores a detach-only key, which has no inline form to render", async () => {
    // `reminders` IS in the main process's detach allow-list, so a check that
    // only asked "is this a known view key?" would wave it through and leave
    // the main window claiming to be somewhere it cannot render.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emitViewActivate } = await renderApp();
    await waitFor(() => expect(screen.getByTestId("chat-view-root")).toBeTruthy());

    act(() => emitViewActivate("reminders"));

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'reminders'")),
    );
    expect(screen.getByTestId("chat-view-root")).toBeTruthy();
  });

  it("ignores a malformed plugin key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emitViewActivate } = await renderApp();
    await waitFor(() => expect(screen.getByTestId("chat-view-root")).toBeTruthy());

    // One segment: `startsWith("plugin:")` was true for this, which is how it
    // used to reach the plugin branch.
    act(() => emitViewActivate("plugin:token-plugin"));

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'plugin:token-plugin'")),
    );
    expect(screen.getByTestId("chat-view-root")).toBeTruthy();
  });
});
