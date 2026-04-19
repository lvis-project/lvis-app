/**
 * D3 — ApprovalQueueStatus renderer UI.
 *
 * Verifies:
 *  - Hidden when 0 or 1 requests (head-of-queue lives in the modal).
 *  - Depth badge shows current / max.
 *  - Waiting list renders items in FIFO order starting from queue index 1.
 *  - Cap-reached message surfaces when queue >= max.
 */
import "./setup.js";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ApprovalQueueStatus } from "../../src/ui/renderer/components/ApprovalQueueStatus.js";
import type { ApprovalRequest } from "../../src/ui/renderer/types.js";

function makeReq(id: string, source: "builtin" | "plugin" | "mcp" = "builtin"): ApprovalRequest {
  return {
    id,
    category: "tool",
    toolName: `tool_${id}`,
    args: {},
    reason: `test ${id}`,
    source,
    createdAt: Date.now(),
    requireExplicit: false,
  };
}

describe("ApprovalQueueStatus", () => {
  it("renders nothing when queue is empty or has only the head-of-queue", () => {
    const { container, rerender } = render(<ApprovalQueueStatus queue={[]} />);
    expect(container.firstChild).toBeNull();
    rerender(<ApprovalQueueStatus queue={[makeReq("solo")]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders depth badge and waiting list in FIFO order (skipping head-of-queue)", () => {
    const queue = ["a", "b", "c"].map((id) => makeReq(id));
    const { getByTestId, getAllByTestId } = render(
      <ApprovalQueueStatus queue={queue} max={50} />,
    );
    expect(getByTestId("approval-queue-depth").textContent).toBe("3 / 50");
    const items = getAllByTestId("approval-queue-item");
    // head-of-queue ("a") is NOT listed; only "b" and "c" in order.
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("tool_b");
    expect(items[1].textContent).toContain("tool_c");
  });

  it("shows queue-full message and destructive badge when at cap", () => {
    const queue = Array.from({ length: 3 }, (_, i) => makeReq(`r${i}`));
    const { getByTestId, getByText } = render(
      <ApprovalQueueStatus queue={queue} max={3} />,
    );
    expect(getByTestId("approval-queue-depth").textContent).toBe("3 / 3");
    expect(getByText(/queue full/i)).toBeTruthy();
  });
});
