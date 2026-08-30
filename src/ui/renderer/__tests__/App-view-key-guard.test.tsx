import "../../../../test/renderer/setup.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
// Named import: the default export does not survive this tsconfig's interop settings.
import { userEvent } from "@testing-library/user-event";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { TEST_IDS } from "../../../shared/test-ids.js";

/**
 * Navigation reached through the `onViewActivate` IPC — the main process
 * naming a destination for the renderer.
 *
 * Driven through the real producer (`emitViewActivate`) rather than by calling
 * the guard directly: the point of this change is that a bad key stops BEFORE
 * it becomes `activeView`, and that is only observable end to end. Previously
 * any unrecognized string fell past every branch in the main content region and rendered
 * as a plugin view that does not exist, so the user saw "plugin view not
 * found" for what was really a typo.
 */
describe("App — view key guard on the activate-view IPC", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("navigates when the key names a real inline destination", async () => {
    const { emitViewActivate } = await renderApp();
    await waitFor(() => expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy());

    act(() => emitViewActivate("memory"));

    await waitFor(() => expect(screen.getByTestId("view-path-current-memory")).toBeTruthy());
    expect(screen.queryByTestId("main-content-back")).toBeNull();
    // The conversations stay MOUNTED across view navigation — a tile's stream
    // subscription starts when it mounts, so unmounting them to show another
    // view would drop the frames of a turn still running. Hidden, not gone.
    expect(screen.getByTestId("chat-surface").dataset.visible).toBe("false");
  });

  it("ignores a misspelled built-in key instead of rendering it as a plugin view", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emitViewActivate } = await renderApp();
    await waitFor(() => expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy());

    act(() => emitViewActivate("hom"));

    // Still home: the key never became `activeView`.
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'hom'")),
    );
    expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy();
    expect(screen.queryByTestId("main-content-unknown-view")).toBeNull();
  });

  it("ignores a detach-only key, which has no inline form to render", async () => {
    // An MCP-app card IS a real, openable destination — it just has no inline
    // form. A check that only asked "is this a known view key?" would wave it
    // through and leave the main window claiming to be somewhere it cannot
    // render.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emitViewActivate } = await renderApp();
    await waitFor(() => expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy());

    act(() => emitViewActivate("mcp-app:6162:card-1"));

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'mcp-app:6162:card-1'")),
    );
    expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy();
  });

  it("ignores a malformed plugin key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emitViewActivate } = await renderApp();
    await waitFor(() => expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy());

    // One segment: `startsWith("plugin:")` was true for this, which is how it
    // used to reach the plugin branch.
    act(() => emitViewActivate("plugin:token-plugin"));

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'plugin:token-plugin'")),
    );
    expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy();
  });

  it("refuses to navigate to a plugin view whose manifest yields a malformed key", async () => {
    // `ui[].id` has no minLength in the manifest schema, so an empty extension
    // id is a shape a real manifest can take. It produces `plugin:<id>:`,
    // which is not a view key — it used to be set as `activeView` anyway.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = userEvent.setup();
    await renderApp({
      pluginCards: [{
        id: "broken-plugin",
        name: "Broken Plugin",
        description: "Ships a UI extension with an empty id",
        sampleTools: [],
        capabilities: [],
        tools: [],
        loadStatus: "loaded" as const,
      }],
      pluginUiExtensions: [{
        pluginId: "broken-plugin",
        extension: {
          id: "",
          slot: "sidebar",
          kind: "embedded-module",
          title: "Broken View",
          entry: "dist/ui.js",
        },
        entryUrl: "file:///broken-plugin/dist/ui.js",
      }],
    });
    await waitFor(() => expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy());

    await user.click(screen.getByTestId(TEST_IDS.commandPopoverTrigger));
    await user.click(await screen.findByTestId("slash-picker-cat-plugin"));
    const group = await screen.findByTestId("slash-group-plugin");
    await user.click(await within(group).findByText("Broken View"));

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'plugin:broken-plugin:'")),
    );
    expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy();
  });
});
