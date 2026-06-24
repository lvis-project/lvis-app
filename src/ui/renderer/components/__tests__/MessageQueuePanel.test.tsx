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
