// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";
import {
  createRationaleApprovalDisplay,
} from "../../../../shared/rationale-approval-display.js";

/**
 * Identity strip SOT: every approval card names the tool it is deciding about,
 * from host-owned request fields — including the degenerate rationale card
 * whose sealed display failed to parse, which used to render with NO tool
 * identity at all while still offering an allow button.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

function baseRequest(): ApprovalRequest {
  return {
    id: "req-1",
    category: "tool",
    kind: "tool",
    allowedChoices: ["allow-once", "deny-once"],
    toolName: "agent_spawn",
    toolCategory: "meta",
    args: { title: "t" },
    reason: "review",
    source: "builtin",
    createdAt: Date.now(),
    requireExplicit: true,
    trustOrigin: "user-keyboard",
    reviewerVerdict: { level: "high", reason: "test" },
  };
}

function sealedDisplayArgs(): Record<string, unknown> {
  return {
    ...createRationaleApprovalDisplay({
      toolName: "agent_spawn",
      canonicalTargets: ["session:abc"],
      requestedEffects: ["change-host-or-agent-state"],
      affectedResources: ["conversation"],
      requiredAuthority: "host-orchestration",
      effectiveVerdict: { level: "high", reason: "needs review" },
      scopeAlignment: "aligned",
      scopeReasons: ["matches request"],
      rationaleStatus: "ready",
      suggestion: "review it",
      modalFallbackRequired: false,
    }),
  };
}

/**
 * Mirrors the REAL host whitelist (`createRendererSafeRationaleApprovalRequest`):
 * a rationale request carries no source/toolCategory/trustOrigin — the host
 * deliberately does not attest them for this kind, and the fixture must not
 * invent them or these tests would exercise a payload production never emits.
 */
function rationaleRequest(args: Record<string, unknown>): ApprovalRequest {
  return {
    id: "rationale-1",
    category: "tool",
    kind: "rationale",
    allowedChoices: ["allow-once", "deny-once"],
    toolName: "agent_spawn",
    args,
    reason: "Review the host-sealed action and its permission rationale.",
    source: "builtin",
    createdAt: Date.now(),
    requireExplicit: true,
    reviewerVerdict: { level: "high", reason: "masked reason" },
  };
}

describe("ToolApprovalContent identity strip", () => {
  it("names the tool on a plain request (unchanged behavior)", () => {
    render(<ToolApprovalContent open request={baseRequest()} onDecide={vi.fn()} />);
    expect(screen.getByTestId("approval-tool-identity")).toHaveTextContent("agent_spawn");
  });

  it("names the tool on a VALID rationale card from the SEALED display", () => {
    // The request-level name is display-untrusted for sealed cards; only the
    // HMAC-sealed display.toolName may render. Diverging names prove which
    // source the strip reads.
    const request = { ...rationaleRequest(sealedDisplayArgs()), toolName: "request-level-name" };
    render(<ToolApprovalContent open request={request} onDecide={vi.fn()} />);
    expect(screen.getByTestId("approval-tool-identity")).toHaveTextContent("agent_spawn");
    expect(screen.getByTestId("approval-tool-identity")).not.toHaveTextContent("request-level-name");
    expect(screen.queryByTestId("approval-identity-unverified")).toBeNull();
    // Full decision surface intact for a valid seal.
    expect(screen.getByTestId("approve-button")).toBeInTheDocument();
    expect(screen.getByTestId("deny-button")).toBeInTheDocument();
    // Fields the host deliberately did not attest are not rendered as facts.
    expect(screen.queryByTestId("approval-conversation")).toBeNull();
  });

  it("names the tool even when the sealed display is INVALID", () => {
    render(
      <ToolApprovalContent
        open
        request={rationaleRequest({ garbage: true })}
        onDecide={vi.fn()}
      />,
    );
    // The bug this pins: identity came only from the sealed table, so a parse
    // failure produced a card that could not say what it was approving. With
    // no sealed name available the request name renders — explicitly marked,
    // because for this kind it is not display-attested.
    expect(screen.getByTestId("approval-tool-identity")).toHaveTextContent("agent_spawn");
    expect(screen.getByTestId("approval-identity-unverified")).toBeInTheDocument();
  });

  it("offers ONLY deny when the sealed display is invalid", () => {
    render(
      <ToolApprovalContent
        open
        request={rationaleRequest({ garbage: true })}
        onDecide={vi.fn()}
      />,
    );
    // Fail-closed means the allow options are not presented at all — a
    // permanently disabled button teaches users to distrust the panel.
    expect(screen.queryByTestId("approve-button")).toBeNull();
    expect(screen.queryByTestId("allow-always-button")).toBeNull();
    expect(screen.getByTestId("deny-button")).toBeInTheDocument();
  });
});
