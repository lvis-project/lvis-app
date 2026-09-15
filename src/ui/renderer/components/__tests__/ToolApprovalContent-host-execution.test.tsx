// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { t } from "../../../../i18n/runtime.js";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";
import { buildHostShellExecutionPlan, getHostShellExecutionPlanAuditProjection } from "../../../../permissions/host-shell-execution-plan.js";

function request(host: boolean): ApprovalRequest {
  return {
    id: "host-request", category: "tool", toolName: "bash", toolCategory: "shell",
    args: { command: "printf '%s' '" + "a".repeat(700) + "-final-marker'", executionMode: "host", justification: "Use the configured host client" },
    reason: "Explicit host execution request", source: "builtin", createdAt: Date.now(),
    requireExplicit: true, allowedChoices: ["allow-once", "deny-once"],
    executionCwd: "/workspace/project",
    executionPlan: getHostShellExecutionPlanAuditProjection(buildHostShellExecutionPlan({
      executionMode: host ? "host" : "default", platform: "darwin", requestedSandbox: true,
      activeCapability: { kind: "asrt", confidence: "verified", platform: "darwin",
        confines: { filesystem: true, process: true, network: true } },
    })),
  };
}

describe("explicit host execution approval", () => {
  it("shows the exact host warning, reason, environment and full command before consent", () => {
    const { container } = render(<ToolApprovalContent conversationLabel="conversation" open request={request(true)} onDecide={() => undefined} />);
    const warning = container.querySelector('[data-testid="tool-approval-host-execution"]');
    expect(warning?.textContent).toContain(t("shellExecution.hostWarning"));
    expect(warning?.textContent).toContain("Use the configured host client");
    expect(container.querySelector('[data-testid="tool-approval-execution-cwd"]')?.textContent).toContain("/workspace/project");
    expect(container.querySelector('[data-testid="tool-approval-shell-environment"]')?.textContent).toContain(t("shellExecution.hostHome"));
    expect(container.querySelector("details")?.open).toBe(true);
    expect(container.textContent).toContain("-final-marker");
  });

  it("does not derive the host execution warning from model-provided arguments", () => {
    const { container } = render(<ToolApprovalContent conversationLabel="conversation" open request={request(false)} onDecide={() => undefined} />);
    expect(container.querySelector('[data-testid="tool-approval-host-execution"]')).toBeNull();
    expect(container.querySelector('[data-testid="tool-approval-shell-environment"]')?.textContent).toContain(t("shellExecution.temporaryHome"));
  });
});
