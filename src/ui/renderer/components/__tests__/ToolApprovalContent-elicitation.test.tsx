// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";
import {
  createElicitationResolverFactory,
  type ElicitResult,
} from "../../../../mcp/mcp-elicitation-resolver.js";

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

describe("ToolApprovalContent MCP elicitation form", () => {
  it("captures requestedSchema fields as one-shot elicitation content", () => {
    const onDecide = vi.fn();
    render(
      <ToolApprovalContent
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
      <ToolApprovalContent
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
      <ToolApprovalContent
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

  /**
   * Close the real loop: the resolver forwards the server schema to the gate,
   * the dialog renders it and produces content, and the resolver re-validates
   * that same content. The two parsers can only disagree here if one of them
   * re-derives support on its own.
   */
  async function runElicitationRoundTrip(
    requestedSchema: unknown,
    answer: () => void,
  ): Promise<{ result: ElicitResult; approveWasDisabled: boolean; sawUnsupportedNotice: boolean }> {
    let approveWasDisabled = true;
    let sawUnsupportedNotice = false;
    const resolve = createElicitationResolverFactory({
      approvalGate: {
        requestAndWait: async (gateRequest) => {
          let captured: { elicitationContent?: Record<string, unknown> } | undefined;
          render(
            <ToolApprovalContent
              open
              request={{
                id: gateRequest.id,
                category: "agent-action",
                kind: "agent-action",
                toolName: gateRequest.toolName,
                toolCategory: "meta",
                args: gateRequest.args,
                reason: gateRequest.reason,
                source: "mcp",
                createdAt: gateRequest.createdAt,
                requireExplicit: true,
              }}
              onDecide={(_choice, _purpose, extras) => {
                captured = extras as { elicitationContent?: Record<string, unknown> } | undefined;
              }}
            />,
          );
          sawUnsupportedNotice = screen.queryByTestId("mcp-elicitation-unsupported") !== null;
          answer();
          const approve = screen.getByTestId("approve-button") as HTMLButtonElement;
          approveWasDisabled = approve.disabled;
          fireEvent.click(approve);
          return {
            requestId: gateRequest.id,
            choice: "allow-once" as const,
            ...(captured?.elicitationContent ? { elicitationContent: captured.elicitationContent } : {}),
          };
        },
      },
    })("hr-server");

    // The resolver seam is declared as returning `unknown`; the resolver's own
    // contract is `ElicitResult`, which is what the server would receive.
    const result = (await resolve("q1", {
      method: "elicitation/create",
      mode: "form",
      message: "Set priority",
      requestedSchema,
    })) as ElicitResult;
    return { result, approveWasDisabled, sawUnsupportedNotice };
  }

  it("lets the user answer an enum that offers the empty string, and the resolver accepts it", async () => {
    const roundTrip = await runElicitationRoundTrip(
      {
        type: "object",
        required: ["priority"],
        properties: { priority: { type: "string", title: "Priority", enum: ["", "high"] } },
      },
      () => {
        const select = screen.getByTestId("mcp-elicitation-field-priority") as HTMLSelectElement;
        expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
          "Select...",
          '""',
          "high",
        ]);
        fireEvent.change(select, { target: { value: "0" } });
      },
    );

    expect(roundTrip.sawUnsupportedNotice).toBe(false);
    expect(roundTrip.approveWasDisabled).toBe(false);
    expect(roundTrip.result).toEqual({ action: "accept", content: { priority: "" } });
  });

  it("still round-trips an ordinary enum selection", async () => {
    const roundTrip = await runElicitationRoundTrip(
      {
        type: "object",
        required: ["priority"],
        properties: { priority: { type: "string", enum: ["low", "high"] } },
      },
      () => {
        fireEvent.change(screen.getByTestId("mcp-elicitation-field-priority"), {
          target: { value: "1" },
        });
      },
    );

    expect(roundTrip.result).toEqual({ action: "accept", content: { priority: "high" } });
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
      <ToolApprovalContent
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
