// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { buildPermissionEvaluationContext } from "../../../../permissions/evaluation-context.js";

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
  it("remembers an ordinary request with unavailable review only when the host permits it", async () => {
    const onDecide = vi.fn();
    const record = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("lvis", { userApproval: { record } });
    const request: ApprovalRequest = {
      ...makeOneShotPluginRequest(),
      id: "ordinary-unassessed-shell", source: "builtin", toolName: "bash", toolCategory: "shell",
      args: { command: "printf hello" }, reviewerVerdict: undefined, allowedChoices: undefined,
      persistentAllowAllowed: true, approvalCacheKey: "scoped-exact-request",
      persistentApprovalCwd: "/workspace/project",
      evaluationContext: buildPermissionEvaluationContext({
        policyMode: "auto", headless: false, source: "builtin", category: "shell", trustOrigin: "user-keyboard",
        executionCwd: "/workspace/project", allowedDirectories: ["/workspace/project"],
        pathFields: [], targetFilePaths: [], sensitivePathsAdjacent: [],
      }),
    };
    render(<ToolApprovalContent conversationLabel="conversation" open request={request} onDecide={onDecide} />);
    expect(screen.getByTestId("allow-always-exact-scope")).toHaveTextContent("/workspace/project");
    const always = screen.getByTestId(TEST_IDS.allowAlwaysButton);
    expect(always).toBeEnabled();
    fireEvent.click(always);
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-always", undefined));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      requestId: request.id, args: '{"command":"printf hello"}',
      scope: "persistent", verdictAtApproval: "high", approvalCacheKey: request.approvalCacheKey,
    }));
  });

  it("keeps a non-recordable ordinary request disabled even when its displayed risk is medium", () => {
    const request = { ...makeOneShotPluginRequest(), allowedChoices: undefined, persistentAllowAllowed: false };
    render(<ToolApprovalContent conversationLabel="conversation" open request={request} onDecide={vi.fn()} />);
    expect(screen.getByTestId(TEST_IDS.allowAlwaysButton)).toBeDisabled();
  });

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

    expect(screen.getByTestId(TEST_IDS.denyButton)).toHaveTextContent("거절");
    expect(screen.getByTestId(TEST_IDS.allowAlwaysButton)).toHaveTextContent("항상 허용");
    expect(screen.getByTestId(TEST_IDS.allowAlwaysButton)).toBeDisabled();

    const approve = screen.getByTestId(TEST_IDS.approveButton);
    expect(approve).toHaveTextContent("한 번만 허용");
    fireEvent.click(approve);

    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
    expect(record).not.toHaveBeenCalled();

    onDecide.mockClear();
    fireEvent.click(screen.getByTestId(TEST_IDS.denyButton));

    expect(onDecide).toHaveBeenCalledWith("deny-once");

    onDecide.mockClear();
    fireEvent.keyDown(approve, { key: "a", code: "KeyA" });

    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
