// @vitest-environment jsdom
/**
 * Conversation attribution on the two surfaces that raise an approval:
 * the modal itself and the queue of asks waiting behind it.
 *
 * Sub-agents and side chats block on approvals from conversations the user is
 * not looking at, so both surfaces must name the asking conversation.
 */
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import { ApprovalQueueStatus } from "../ApprovalQueueStatus.js";
import type { ApprovalRequest } from "../../types.js";

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-1",
    category: "tool",
    toolName: "fs_write",
    toolCategory: "write",
    args: { path: "/tmp/out.txt" },
    reason: "state-changing tool",
    source: "builtin",
    createdAt: Date.now(),
    requireExplicit: true,
    trustOrigin: "llm-tool-arg",
    reviewerVerdict: { level: "medium", reason: "test" },
    ...overrides,
  };
}

describe("ToolApprovalContent conversation attribution", () => {
  it("names the conversation that raised the modal", () => {
    render(
      <ToolApprovalContent
        open
        request={makeRequest({ sessionId: "side-chat-7f21" })}
        onDecide={vi.fn()}
      />,
    );

    expect(screen.getByTestId("approval-conversation")).toHaveTextContent(
      "side-chat-7f21",
    );
    expect(screen.getByText("대화")).toBeInTheDocument();
  });

  it("distinguishes two conversations asking for the same tool", () => {
    const { unmount } = render(
      <ToolApprovalContent
        open
        request={makeRequest({ id: "a", sessionId: "conv-a" })}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByTestId("approval-conversation")).toHaveTextContent("conv-a");
    unmount();

    render(
      <ToolApprovalContent
        open
        request={makeRequest({ id: "b", sessionId: "conv-b" })}
        onDecide={vi.fn()}
      />,
    );
    const shown = screen.getByTestId("approval-conversation");
    expect(shown).toHaveTextContent("conv-b");
    expect(shown).not.toHaveTextContent("conv-a");
  });

  it("marks a host request that belongs to no conversation", () => {
    render(
      <ToolApprovalContent open request={makeRequest()} onDecide={vi.fn()} />,
    );

    expect(screen.getByTestId("approval-conversation")).toHaveTextContent(
      "대화 없음 (호스트 요청)",
    );
  });
});

describe("ApprovalQueueStatus conversation attribution", () => {
  it("names the conversation for each ask waiting behind the modal", () => {
    render(
      <ApprovalQueueStatus
        queue={[
          makeRequest({ id: "head", sessionId: "conv-head" }),
          makeRequest({ id: "next", sessionId: "conv-next" }),
          makeRequest({ id: "last", sessionId: "conv-last" }),
        ]}
      />,
    );

    const rows = screen.getAllByTestId("approval-queue-item-conversation");
    // The head of the queue is rendered by the modal, not here.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("대화 conv-next");
    expect(rows[1]).toHaveTextContent("대화 conv-last");
  });

  it("marks a queued host request that belongs to no conversation", () => {
    render(
      <ApprovalQueueStatus
        queue={[
          makeRequest({ id: "head", sessionId: "conv-head" }),
          makeRequest({ id: "next" }),
        ]}
      />,
    );

    expect(
      screen.getByTestId("approval-queue-item-conversation"),
    ).toHaveTextContent("대화 없음 (호스트 요청)");
  });
});
