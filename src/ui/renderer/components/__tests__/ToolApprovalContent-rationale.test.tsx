// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";

function makeReadyDisplay() {
  return {
    contractVersion: 1,
    display: "rationale-approval-display",
    toolName: "host-sealed-tool",
    canonicalTargets: ["/workspace/project/status.txt"],
    requestedEffects: ["Create a status file"],
    affectedResources: ["/workspace/project"],
    requiredAuthority: "Project workspace write access",
    effectiveVerdict: {
      level: "medium",
      reason: "The host-sealed effect is limited to the project workspace.",
    },
    scopeAlignment: "aligned",
    scopeReasons: ["The target is inside the current workspace."],
    rationaleStatus: "ready",
    suggestion: "**bold** [x](javascript:alert(1))",
    modalFallbackRequired: false,
  };
}

function makeRationaleRequest(args: unknown): ApprovalRequest {
  return {
    id: "rationale-1",
    category: "tool",
    kind: "rationale",
    allowedChoices: ["allow-once", "deny-once"],
    // Deliberately different from the display contract: the renderer must not
    // use generic request fields for a rationale decision card.
    toolName: "untrusted-request-tool",
    toolCategory: "shell",
    args,
    reason: "UNTRUSTED request reason: do not render this",
    source: "builtin",
    createdAt: Date.now(),
    requireExplicit: true,
    target: { filePath: "/untrusted/raw-target" },
    reviewerVerdict: { level: "low", reason: "UNTRUSTED reviewer verdict" },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ToolApprovalContent rationale card", () => {
  it("renders only parsed host-sealed facts and keeps the model suggestion separate", () => {
    const onDecide = vi.fn();
    const record = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("lvis", { userApproval: { record } });
    const { container } = render(
      <ToolApprovalContent
        open
        request={makeRationaleRequest(makeReadyDisplay())}
        onDecide={onDecide}
      />,
    );

    expect(screen.getByTestId("rationale-approval-card")).toBeInTheDocument();
    expect(container.querySelector('input, textarea, [contenteditable="true"], [role="textbox"]'))
      .toBeNull();
    expect(screen.getByTestId("rationale-approval-tool")).toHaveTextContent(
      "host-sealed-tool",
    );
    expect(screen.getByTestId("rationale-approval-targets")).toHaveTextContent(
      "/workspace/project/status.txt",
    );
    expect(screen.getByTestId("rationale-approval-effects")).toHaveTextContent(
      "Create a status file",
    );
    expect(screen.getByTestId("rationale-approval-resources")).toHaveTextContent(
      "/workspace/project",
    );
    expect(screen.getByTestId("rationale-approval-authority")).toHaveTextContent(
      "Project workspace write access",
    );
    expect(screen.getByTestId("rationale-model-explanation")).toHaveTextContent(
      "Model suggestion",
    );
    const modelSuggestion = screen.getByTestId("rationale-model-suggestion");
    expect(modelSuggestion).toHaveTextContent("**bold** [x](javascript:alert(1))");
    expect(
      modelSuggestion.querySelector("strong, a, img, script"),
    ).toBeNull();
    expect(screen.queryByTestId("rationale-model-fallback")).not.toBeInTheDocument();

    // Generic request fields, raw args JSON, and raw details must not cross
    // into the rationale UI, even when their values disagree with host facts.
    expect(screen.queryByText("untrusted-request-tool")).not.toBeInTheDocument();
    expect(screen.queryByText("UNTRUSTED request reason: do not render this")).not.toBeInTheDocument();
    expect(screen.queryByText("/untrusted/raw-target")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tool-approval-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("approval-review-details")).not.toHaveAttribute("open");
    const panel = screen.getByTestId("tool-approval-panel");
    expect(panel).not.toHaveAttribute("data-approval-request-id");
    expect(panel).not.toHaveAttribute("data-approval-tool-name");
    expect(panel).not.toHaveAttribute("data-approval-args");

    expect(screen.getByTestId("deny-button")).toHaveTextContent("거절");
    expect(screen.getByTestId("allow-always-button")).toHaveTextContent("항상 허용");
    expect(screen.getByTestId("allow-always-button")).toBeDisabled();
    const approve = screen.getByTestId("approve-button");
    expect(approve).toHaveTextContent("한 번만 허용");
    expect(approve).toBeEnabled();
    fireEvent.click(approve);

    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
    expect(record).not.toHaveBeenCalled();
  });

  it("wraps the full host-sealed tool identity instead of clipping it", () => {
    const display = {
      ...makeReadyDisplay(),
      toolName: `host-sealed-${"very-long-tool-name-".repeat(12)}`,
    };
    vi.stubGlobal("lvis", {
      userApproval: { record: vi.fn().mockResolvedValue({ ok: true }) },
    });
    render(
      <ToolApprovalContent
        open
        request={makeRationaleRequest(display)}
        onDecide={vi.fn()}
      />,
    );

    const identity = screen.getByTestId("rationale-approval-tool");
    expect(identity).toHaveTextContent(display.toolName);
    expect(identity.className).toContain("break-all");
    expect(identity.className).toContain("max-w-full");
  });

  it("shows a safe fallback instead of model text when the rationale round failed", () => {
    const onDecide = vi.fn();
    const ready = makeReadyDisplay();
    const failed = {
      ...ready,
      scopeAlignment: "unknown",
      rationaleStatus: "failed",
      suggestion: null,
      modalFallbackRequired: true,
    };
    render(
      <ToolApprovalContent
        open
        request={makeRationaleRequest(failed)}
        onDecide={onDecide}
      />,
    );

    expect(screen.queryByTestId("rationale-model-suggestion")).not.toBeInTheDocument();
    expect(screen.getByTestId("rationale-model-fallback")).toHaveTextContent(
      "The model explanation is unavailable.",
    );
    expect(screen.getByTestId("approve-button")).toBeEnabled();

    fireEvent.click(screen.getByTestId("approve-button"));
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });

  it("fails closed for a malformed display and never renders raw injected payload", () => {
    const onDecide = vi.fn();
    const malformed = {
      ...makeReadyDisplay(),
      unexpected: '<img data-testid="raw-injection" src="x" />',
    };
    render(
      <ToolApprovalContent
        open
        request={makeRationaleRequest(malformed)}
        onDecide={onDecide}
      />,
    );

    expect(screen.getByTestId("rationale-approval-invalid")).toHaveTextContent(
      "Rationale details could not be verified.",
    );
    expect(screen.queryByTestId("rationale-approval-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("raw-injection")).not.toBeInTheDocument();
    expect(screen.getByTestId("approve-button")).toBeDisabled();

    fireEvent.click(screen.getByText("거절"));
    expect(onDecide).toHaveBeenCalledWith("deny-once");
  });
});
