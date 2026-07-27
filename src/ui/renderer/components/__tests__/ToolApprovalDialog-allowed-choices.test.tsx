// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolApprovalDialog } from "../ToolApprovalDialog.js";
import type { ApprovalRequest } from "../../types.js";

function makeOneShotPluginRequest(): ApprovalRequest {
  return {
    id: "plugin-operation-grant-1",
    category: "tool",
    kind: "tool",
    allowedChoices: ["allow-once", "deny-once"],
    toolName: "ep_attendance_write",
    toolCategory: "write",
    args: { operation: "clock" },
    reason: "plugin operation grant",
    source: "plugin",
    sourcePluginId: "ep-api",
    createdAt: Date.now(),
    requireExplicit: true,
    trustOrigin: "user-keyboard",
    reviewerVerdict: { level: "medium", reason: "test" },
  };
}

describe("ToolApprovalDialog allowed choices", () => {
  it("honors a host one-shot approval contract", () => {
    const onDecide = vi.fn();
    const record = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("lvis", { userApproval: { record } });
    render(
      <ToolApprovalDialog
        open
        request={makeOneShotPluginRequest()}
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
    expect(record).not.toHaveBeenCalled();

    onDecide.mockClear();
    fireEvent.keyDown(approve, { key: "a", code: "KeyA" });

    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
