// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ReviewerSuggestion } from "../../hooks/use-permission-signals.js";
import type { ApprovalRequest } from "../../types.js";

/**
 * The reviewer suggestion is offered where the user is already deciding, so it
 * is answerable in the same place and the same gesture as the ask itself.
 */
function approvalRequest(
  parentEscalation?: ApprovalRequest["parentEscalation"],
): ApprovalRequest {
  return {
    id: "req-1",
    category: "tool",
    kind: "tool",
    allowedChoices: ["allow-once", "deny-once"],
    toolName: "bash",
    toolCategory: "shell",
    args: { command: "ls /srv/work" },
    reason: "state-changing tool",
    source: "builtin",
    createdAt: Date.now(),
    requireExplicit: true,
    trustOrigin: "llm-tool-arg",
    reviewerVerdict: { level: "medium", reason: "shell command" },
    ...(parentEscalation ? { parentEscalation } : {}),
  };
}

function suggestion(overrides: Partial<ReviewerSuggestion> = {}): ReviewerSuggestion {
  return {
    reason: "repeat-allow",
    allowCount: 3,
    windowMs: 300_000,
    busy: false,
    onEnable: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

describe("ToolApprovalContent reviewer-suggestion band", () => {
  it("states the run of approvals that raised it", () => {
    render(
      <ToolApprovalContent
        conversationLabel="conversation"
        open
        request={approvalRequest()}
        onDecide={vi.fn()}
        reviewerSuggestion={suggestion()}
      />,
    );
    const band = screen.getByTestId("reviewer-suggestion-band");
    expect(band).toHaveAttribute("data-reviewer-suggestion-reason", "repeat-allow");
    // 300_000 ms of window read back as the minutes the sentence names.
    expect(band).toHaveTextContent("5");
    expect(band).toHaveTextContent("3");
    expect(band.textContent).not.toContain("chatView.");
  });

  it("says which of the two patterns the host saw", () => {
    // "always allow" and "many one-off approvals" are different habits, and the
    // sentence that names the wrong one reads as the app guessing.
    render(
      <ToolApprovalContent
        conversationLabel="conversation"
        open
        request={approvalRequest()}
        onDecide={vi.fn()}
        reviewerSuggestion={suggestion({ reason: "allow-always", allowCount: 1 })}
      />,
    );
    const band = screen.getByTestId("reviewer-suggestion-band");
    expect(band).toHaveAttribute("data-reviewer-suggestion-reason", "allow-always");
    const text = band.textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("chatView.");
  });

  it("hands the enable and the dismiss to the one owner of the suggestion", () => {
    const onEnable = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ToolApprovalContent
        conversationLabel="conversation"
        open
        request={approvalRequest()}
        onDecide={vi.fn()}
        reviewerSuggestion={suggestion({ onEnable, onDismiss })}
      />,
    );
    fireEvent.click(screen.getByTestId("reviewer-suggestion-enable"));
    expect(onEnable).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("reviewer-suggestion-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("waits on an enable already in flight instead of sending it twice", () => {
    const onEnable = vi.fn();
    render(
      <ToolApprovalContent
        conversationLabel="conversation"
        open
        request={approvalRequest()}
        onDecide={vi.fn()}
        reviewerSuggestion={suggestion({ busy: true, onEnable })}
      />,
    );
    const enable = screen.getByTestId("reviewer-suggestion-enable") as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    fireEvent.click(enable);
    expect(onEnable).not.toHaveBeenCalled();
  });

  it("shows a failed enable inside the band, leaving the ask answerable", () => {
    render(
      <ToolApprovalContent
        conversationLabel="conversation"
        open
        request={approvalRequest()}
        onDecide={vi.fn()}
        reviewerSuggestion={suggestion({ error: "reviewer key missing" })}
      />,
    );
    expect(screen.getByTestId("reviewer-suggestion-error")).toHaveTextContent(
      "reviewer key missing",
    );
    expect(screen.getByTestId("approval-impact-summary")).toBeTruthy();
  });

  it("takes second place to the escalation band that accounts for this ask", () => {
    // Request context the user needs in order to decide comes before standing
    // advice they may ignore.
    render(
      <ToolApprovalContent
        conversationLabel="conversation"
        open
        request={approvalRequest({
          cause: "parent-escalated",
          reason: "I cannot tell whether this path belongs to the task",
          childTitle: "report writer",
        })}
        onDecide={vi.fn()}
        reviewerSuggestion={suggestion()}
      />,
    );
    const escalation = screen.getByTestId("parent-escalation-band");
    const reviewer = screen.getByTestId("reviewer-suggestion-band");
    expect(
      escalation.compareDocumentPosition(reviewer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws nothing when the window is holding no suggestion", () => {
    render(
      <ToolApprovalContent
        conversationLabel="conversation"
        open
        request={approvalRequest()}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("reviewer-suggestion-band")).toBeNull();
  });
});
