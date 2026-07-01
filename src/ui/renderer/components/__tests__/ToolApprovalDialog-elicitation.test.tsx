// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolApprovalDialog } from "../ToolApprovalDialog.js";
import type { ApprovalRequest } from "../../types.js";

function makeElicitationRequest(): ApprovalRequest {
  return {
    id: "elicitation-1",
    category: "agent-action",
    kind: "agent-action",
    toolName: "mcp:hr-server:elicitation",
    toolCategory: "meta",
    args: {
      message: "Pick a date",
      requestedSchema: {
        type: "object",
        required: ["date", "count"],
        properties: {
          date: { type: "string", title: "Date" },
          count: { type: "integer", title: "Count" },
          includeNotes: { type: "boolean", title: "Include notes" },
        },
      },
    },
    reason: "Pick a date",
    source: "mcp",
    createdAt: Date.now(),
    requireExplicit: true,
    nonce: "nonce",
    hmac: "hmac",
  };
}

describe("ToolApprovalDialog MCP elicitation form", () => {
  it("captures requestedSchema fields as one-shot elicitation content", () => {
    const onDecide = vi.fn();
    render(
      <ToolApprovalDialog
        open
        request={makeElicitationRequest()}
        onDecide={onDecide}
      />,
    );

    const approve = screen.getByTestId("approve-button");
    expect(approve).toBeDisabled();

    fireEvent.change(screen.getByTestId("mcp-elicitation-field-date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByTestId("mcp-elicitation-field-count"), {
      target: { value: "1e2" },
    });
    expect(approve).toBeDisabled();

    fireEvent.change(screen.getByTestId("mcp-elicitation-field-count"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByTestId("mcp-elicitation-field-includeNotes"));

    expect(approve).toBeEnabled();
    fireEvent.click(approve);

    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined, {
      elicitationContent: {
        date: "2026-07-01",
        count: 2,
        includeNotes: true,
      },
    });
  });

  it("preserves optional boolean false in elicitation content", () => {
    const onDecide = vi.fn();
    render(
      <ToolApprovalDialog
        open
        request={makeElicitationRequest()}
        onDecide={onDecide}
      />,
    );

    fireEvent.change(screen.getByTestId("mcp-elicitation-field-date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByTestId("mcp-elicitation-field-count"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByTestId("approve-button"));

    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined, {
      elicitationContent: {
        date: "2026-07-01",
        count: 2,
        includeNotes: false,
      },
    });
  });

  it("treats URL-mode elicitation as one-shot even without renderable fields", () => {
    const onDecide = vi.fn();
    const request = makeElicitationRequest();
    request.args = {
      message: "Authorize",
      url: "https://example.com/oauth",
      elicitationId: "e1",
    };
    render(
      <ToolApprovalDialog
        open
        request={request}
        onDecide={onDecide}
      />,
    );

    const buttonLabels = Array.from(document.body.querySelectorAll("button")).map((button) => button.textContent);
    expect(buttonLabels).not.toContain("항상 허용");
    expect(screen.queryByTestId("mcp-elicitation-form")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("approve-button"));

    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });

  it("fails closed for unsupported requestedSchema instead of rendering a partial form", () => {
    const onDecide = vi.fn();
    const request = makeElicitationRequest();
    request.args = {
      message: "Pick tags",
      requestedSchema: {
        type: "object",
        properties: { tags: { type: "array" } },
      },
    };
    render(
      <ToolApprovalDialog
        open
        request={request}
        onDecide={onDecide}
      />,
    );

    expect(screen.queryByTestId("mcp-elicitation-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("mcp-elicitation-unsupported")).toBeTruthy();
    expect(screen.getByTestId("approve-button")).toBeDisabled();
  });
});
