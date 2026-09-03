// @vitest-environment jsdom
/**
 * Conversation attribution on the surface that raises an approval: the modal
 * itself.
 *
 * Sub-agents and side chats block on approvals from conversations the user is
 * not looking at, so the modal must name the asking conversation.
 */
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
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
  it("names the conversation that raised the card by the label its surface gave it", () => {
    render(
      <ToolApprovalContent
        conversationLabel="분기 회의록 정리"
        open
        request={makeRequest({ sessionId: "side-chat-7f21" })}
        onDecide={vi.fn()}
      />,
    );

    expect(screen.getByTestId("approval-conversation")).toHaveTextContent("분기 회의록 정리");
    expect(screen.getByTestId("approval-conversation")).not.toHaveTextContent("side-chat-7f21");
  });

  it("keeps the raw session id where a reviewer looks for it: the review details", () => {
    render(
      <ToolApprovalContent
        conversationLabel="분기 회의록 정리"
        open
        request={makeRequest({ sessionId: "side-chat-7f21" })}
        onDecide={vi.fn()}
      />,
    );

    const details = screen.getByTestId("approval-review-details");
    const id = screen.getByTestId("approval-conversation-id");
    expect(details.contains(id)).toBe(true);
    expect(id).toHaveTextContent("side-chat-7f21");
  });

  it("distinguishes two conversations asking for the same tool", () => {
    const { unmount } = render(
      <ToolApprovalContent
        conversationLabel="conv-a"
        open
        request={makeRequest({ id: "a", sessionId: "conv-a" })}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByTestId("approval-conversation-id")).toHaveTextContent("conv-a");
    unmount();

    render(
      <ToolApprovalContent
        conversationLabel="conv-b"
        open
        request={makeRequest({ id: "b", sessionId: "conv-b" })}
        onDecide={vi.fn()}
      />,
    );
    const shown = screen.getByTestId("approval-conversation-id");
    expect(shown).toHaveTextContent("conv-b");
    expect(shown).not.toHaveTextContent("conv-a");
  });

  it("marks a host request that belongs to no conversation", () => {
    render(
      <ToolApprovalContent
        conversationLabel="대화 없음 (호스트 요청)"
        open
        request={makeRequest()}
        onDecide={vi.fn()}
      />,
    );

    expect(screen.getByTestId("approval-conversation-id")).toHaveTextContent(
      "대화 없음 (호스트 요청)",
    );
  });
});
