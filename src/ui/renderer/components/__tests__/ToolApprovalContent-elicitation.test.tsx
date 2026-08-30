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
import { TEST_IDS } from "../../../../shared/test-ids.js";

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
          date: { type: "string", title: "Date", default: "2026-07-01" },
          count: { type: "integer", title: "Count", default: 2 },
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
  it("uses pre-supplied values and explicit choices without rendering typeable controls", () => {
    const onDecide = vi.fn();
    const { container } = render(
      <ToolApprovalContent conversationLabel="conversation"
        open
        request={makeElicitationRequest()}
        onDecide={onDecide}
      />,
    );

    const approve = screen.getByTestId(TEST_IDS.approveButton);
    expect(container.querySelector('input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], [role="textbox"]')).toBeNull();
    expect(screen.getByTestId("mcp-elicitation-field-date")).toHaveTextContent("2026-07-01");
    expect(screen.getByTestId("mcp-elicitation-field-count")).toHaveTextContent("2");
    expect(approve).toBeEnabled();
    fireEvent.click(screen.getByTestId("mcp-elicitation-field-includeNotes"));

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
      <ToolApprovalContent conversationLabel="conversation"
        open
        request={makeElicitationRequest()}
        onDecide={onDecide}
      />,
    );

    fireEvent.click(screen.getByTestId(TEST_IDS.approveButton));

    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined, {
      elicitationContent: {
        date: "2026-07-01",
        count: 2,
        includeNotes: false,
      },
    });
  });

  it("fails closed when required free-form values were not supplied before approval", () => {
    const onDecide = vi.fn();
    const request = makeElicitationRequest();
    request.args = {
      message: "Pick a date",
      requestedSchema: {
        type: "object",
        required: ["date", "count"],
        properties: {
          date: { type: "string", title: "Date" },
          count: { type: "integer", title: "Count" },
        },
      },
    };
    const { container } = render(
      <ToolApprovalContent conversationLabel="conversation" open request={request} onDecide={onDecide} />,
    );

    expect(container.querySelector('input, textarea, [contenteditable="true"], [role="textbox"]')).toBeNull();
    expect(screen.getByTestId("mcp-elicitation-input-unavailable")).toBeVisible();
    expect(screen.getByTestId(TEST_IDS.approveButton)).toBeDisabled();
    fireEvent.click(screen.getByTestId(TEST_IDS.approveButton));
    expect(onDecide).not.toHaveBeenCalled();
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
      <ToolApprovalContent conversationLabel="conversation"
        open
        request={request}
        onDecide={onDecide}
      />,
    );

    expect(screen.getByTestId(TEST_IDS.allowAlwaysButton)).toHaveTextContent("항상 허용");
    expect(screen.getByTestId(TEST_IDS.allowAlwaysButton)).toBeDisabled();
    expect(screen.queryByTestId("mcp-elicitation-form")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId(TEST_IDS.approveButton));

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
            <ToolApprovalContent conversationLabel="conversation"
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
          const approve = screen.getByTestId(TEST_IDS.approveButton) as HTMLButtonElement;
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
      <ToolApprovalContent conversationLabel="conversation"
        open
        request={request}
        onDecide={onDecide}
      />,
    );

    expect(screen.queryByTestId("mcp-elicitation-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("mcp-elicitation-unsupported")).toBeTruthy();
    expect(screen.getByTestId(TEST_IDS.approveButton)).toBeDisabled();
  });
});
