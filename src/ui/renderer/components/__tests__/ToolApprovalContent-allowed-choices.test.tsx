// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
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

describe("ToolApprovalContent allowed choices", () => {
  it("honors a host one-shot approval contract", () => {
    const onDecide = vi.fn();
    const record = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("lvis", { userApproval: { record } });
    render(
      <ToolApprovalContent conversationLabel="conversation"
        open
        request={makeOneShotPluginRequest()}
        onDecide={onDecide}
      />,
    );

    expect(screen.getByTestId("deny-button")).toHaveTextContent("거절");
    expect(screen.getByTestId("allow-always-button")).toHaveTextContent("항상 허용");
    expect(screen.getByTestId("allow-always-button")).toBeDisabled();

    const approve = screen.getByTestId("approve-button");
    expect(approve).toHaveTextContent("한 번만 허용");
    fireEvent.click(approve);

    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
    expect(record).not.toHaveBeenCalled();

    onDecide.mockClear();
    fireEvent.click(screen.getByTestId("deny-button"));

    expect(onDecide).toHaveBeenCalledWith("deny-once");

    onDecide.mockClear();
    fireEvent.keyDown(approve, { key: "a", code: "KeyA" });

    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
