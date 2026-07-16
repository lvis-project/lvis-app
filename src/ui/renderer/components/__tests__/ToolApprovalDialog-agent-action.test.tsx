// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolApprovalDialog } from "../ToolApprovalDialog.js";
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

describe("ToolApprovalDialog external agent-action affordances", () => {
  it("shows only one-shot approve/deny controls for local-api agent actions", () => {
    const onDecide = vi.fn();
    render(
      <ToolApprovalDialog
        open
        request={makeAgentActionRequest("local-api")}
        onDecide={onDecide}
      />,
    );

    expect(screen.queryByText("항상 허용")).not.toBeInTheDocument();
    expect(screen.queryByText("항상 거부")).not.toBeInTheDocument();
    expect(screen.queryByText("승인 범위")).not.toBeInTheDocument();
    expect(screen.queryByText("지속 허용")).not.toBeInTheDocument();

    const approve = screen.getByTestId("approve-button");
    expect(approve).toHaveTextContent("한 번만 허용");
    fireEvent.click(approve);

    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });

  it("keeps durable controls for user-keyboard agent actions", () => {
    render(
      <ToolApprovalDialog
        open
        request={makeAgentActionRequest("user-keyboard")}
        onDecide={vi.fn()}
      />,
    );

    expect(screen.getByText("항상 허용")).toBeInTheDocument();
    expect(screen.getByText("승인 범위")).toBeInTheDocument();
    expect(screen.getByText("지속 허용")).toBeInTheDocument();
    expect(screen.getByTestId("approve-button")).toHaveTextContent("허용");
  });

  it.each([
    ["explicit builtin source", "builtin"],
    ["omitted legacy source", null],
  ] as const)("forces one-shot approval for remote-wire agent actions with %s", (_label, source) => {
    const onDecide = vi.fn();
    render(
      <ToolApprovalDialog
        open
        request={makeAgentActionRequest("a2a-remote-wire", "a2a-send", source)}
        onDecide={onDecide}
      />,
    );

    expect(screen.queryByText("항상 허용")).not.toBeInTheDocument();
    expect(screen.queryByText("승인 범위")).not.toBeInTheDocument();
    const approve = screen.getByTestId("approve-button");
    expect(approve).toHaveTextContent("한 번만 허용");
    fireEvent.click(approve);
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });

  it("keeps durable controls for an explicit plugin source with remote-wire metadata", () => {
    const onDecide = vi.fn();
    render(
      <ToolApprovalDialog
        open
        request={makeAgentActionRequest("a2a-remote-wire", "a2a-send", "plugin")}
        onDecide={onDecide}
      />,
    );

    expect(screen.getByText("항상 허용")).toBeInTheDocument();
    expect(screen.getByText("승인 범위")).toBeInTheDocument();
    const approve = screen.getByTestId("approve-button");
    expect(approve).toHaveTextContent("허용");
    fireEvent.click(approve);
    expect(onDecide).toHaveBeenCalledWith("allow-session", undefined);
  });
});
