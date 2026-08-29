// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";

function makeAgentActionRequest(
  trustOrigin: string,
  toolName = "permission:set-mode",
  source: ApprovalRequest["source"] | null = "builtin",
): ApprovalRequest {
  return {
    id: "agent-action-1",
    category: "agent-action",
    kind: "agent-action",
    toolName,
    toolCategory: "meta",
    args: { mode: "allow" },
    reason: "external permission mutation",
    ...(source === null ? {} : { source }),
    createdAt: Date.now(),
    requireExplicit: true,
    sourcePluginId: "local-api",
    approvalScope: "permission-mode",
    trustOrigin,
    reviewerVerdict: { level: "medium", reason: "test" },
  };
}

describe("ToolApprovalContent external agent-action affordances", () => {
  it("keeps the three decisions visible but disables persistence for local-api actions", () => {
    const onDecide = vi.fn();
    const { container } = render(
      <ToolApprovalContent conversationLabel="conversation"
        open
        request={makeAgentActionRequest("local-api")}
        onDecide={onDecide}
      />,
    );

    expect(screen.getByTestId("deny-button")).toHaveTextContent("거절");
    expect(screen.getByTestId("allow-always-button")).toHaveTextContent("항상 허용");
    expect(screen.getByTestId("allow-always-button")).toBeDisabled();
    expect(container.querySelector('input, textarea, [contenteditable="true"], [role="textbox"]'))
      .toBeNull();

    const approve = screen.getByTestId("approve-button");
    expect(approve).toHaveTextContent("한 번만 허용");
    fireEvent.click(approve);

    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });

  it("keeps persistence visible but disabled for user-keyboard agent actions", () => {
    render(
      <ToolApprovalContent conversationLabel="conversation"
        open
        request={makeAgentActionRequest("user-keyboard")}
        onDecide={vi.fn()}
      />,
    );

    expect(screen.getByTestId("deny-button")).toHaveTextContent("거절");
    expect(screen.getByTestId("allow-always-button")).toHaveTextContent("항상 허용");
    expect(screen.getByTestId("allow-always-button")).toBeDisabled();
    expect(screen.getByTestId("approve-button")).toHaveTextContent("한 번만 허용");
  });

  it.each([
    ["explicit builtin source", "builtin"],
    ["omitted legacy source", null],
  ] as const)("forces one-shot approval for remote-wire agent actions with %s", (_label, source) => {
    const onDecide = vi.fn();
    render(
      <ToolApprovalContent conversationLabel="conversation"
        open
        request={makeAgentActionRequest("a2a-remote-wire", "a2a-send", source)}
        onDecide={onDecide}
      />,
    );

    expect(screen.getByTestId("allow-always-button")).toHaveTextContent("항상 허용");
    expect(screen.getByTestId("allow-always-button")).toBeDisabled();
    const approve = screen.getByTestId("approve-button");
    expect(approve).toHaveTextContent("한 번만 허용");
    fireEvent.click(approve);
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });

  it("keeps persistence visible but disabled for plugin agent actions", () => {
    const onDecide = vi.fn();
    render(
      <ToolApprovalContent conversationLabel="conversation"
        open
        request={makeAgentActionRequest("a2a-remote-wire", "a2a-send", "plugin")}
        onDecide={onDecide}
      />,
    );

    expect(screen.getByTestId("allow-always-button")).toHaveTextContent("항상 허용");
    expect(screen.getByTestId("allow-always-button")).toBeDisabled();
    const approve = screen.getByTestId("approve-button");
    expect(approve).toHaveTextContent("한 번만 허용");
    fireEvent.click(approve);
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });
});
