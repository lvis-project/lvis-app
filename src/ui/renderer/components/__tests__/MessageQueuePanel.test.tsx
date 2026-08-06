// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MessageQueuePanel } from "../MessageQueuePanel.js";
import { MessageQueueStore } from "../../state/message-queue-store.js";

function renderQueuePanel() {
  const store = new MessageQueueStore();
  store.add("first queued message");
  store.add("second queued message");
  const onSendNow = vi.fn();
  render(<MessageQueuePanel store={store} onSendNow={onSendNow} />);
  return { store, onSendNow };
}

describe("MessageQueuePanel keyboard navigation", () => {
  it("focuses the first queue row when the expanded panel appears", async () => {
    renderQueuePanel();
    const rows = screen.getAllByTestId("message-queue-row");

    await waitFor(() => {
      expect(document.activeElement).toBe(rows[0]);
    });
  });

  it("moves focus between queue rows with ArrowUp and ArrowDown", () => {
    renderQueuePanel();
    const rows = screen.getAllByTestId("message-queue-row");

    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);

    fireEvent.keyDown(rows[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[0]);
  });

  it("toggles the focused queue row with Space", async () => {
    renderQueuePanel();
    const row = screen.getAllByTestId("message-queue-row")[0];

    row.focus();
    fireEvent.keyDown(row, { key: " " });

    await waitFor(() => {
      expect(screen.getAllByTestId("message-queue-row")[0]).toHaveAttribute("data-selected", "true");
    });
  });
});

describe("MessageQueuePanel colour contract", () => {
  // `--accent` is a SURFACE token — a pale tint in every light bundle. Painting
  // text or a border with it made the per-row inject action and the
  // selected-row outline invisible against the panel. Foregrounds here must
  // come from foreground tokens.
  it("never paints a foreground or border with the accent surface token", async () => {
    const { store } = renderQueuePanel();
    const first = store.getItems()[0];
    expect(first).toBeDefined();
    store.toggleSelect(first!.id);
    await waitFor(() => {
      expect(screen.getAllByTestId("message-queue-row")[0]).toHaveAttribute("data-selected", "true");
    });

    const panel = screen.getByTestId("message-queue-panel");
    for (const el of [panel, ...panel.querySelectorAll<HTMLElement>("*")]) {
      const classes = typeof el.className === "string" ? el.className : "";
      expect(classes).not.toMatch(/(?:^|\s)text-accent(?:\/|\s|$)/);
      expect(classes).not.toMatch(/(?:^|\s)border-accent(?:\/|\s|$)/);
      expect(classes).not.toMatch(/(?:^|\s)bg-accent(?:\/|\s|$)/);
    }
  });

  it("keeps the per-row inject action rendered, labelled and wired", () => {
    const { onSendNow } = renderQueuePanel();
    const injectButtons = screen.getAllByTestId("message-queue-row-send-now-button");
    expect(injectButtons).toHaveLength(2);
    expect(injectButtons[0]!.getAttribute("aria-label")).toBeTruthy();

    fireEvent.click(injectButtons[0]!);
    expect(onSendNow).toHaveBeenCalledTimes(1);
  });
});
