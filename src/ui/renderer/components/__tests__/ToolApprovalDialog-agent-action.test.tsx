// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolApprovalDialog } from "../ToolApprovalDialog.js";
import type { ApprovalRequest } from "../../types.js";

function makeAgentActionRequest(trustOrigin: string): ApprovalRequest {
  return {
    id: "agent-action-1",
    category: "agent-action",
    kind: "agent-action",
    toolName: "permission:set-mode",
    toolCategory: "meta",
    args: { mode: "allow" },
    reason: "external permission mutation",
    source: "builtin",
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
});
