// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";
import type { ParentEscalationCause } from "../../../../shared/parent-escalation-notice.js";

/**
 * The dock's account of the tier-2 stage the user never saw.
 *
 * An ask that a parent agent already looked at and could not settle is not the
 * same ask as one no agent ever considered, and the user deciding it needs to
 * know which of the two is in front of them.
 */
function escalatedRequest(
  parentEscalation: ApprovalRequest["parentEscalation"],
): ApprovalRequest {
  return {
    id: "req-1",
    category: "tool",
    kind: "tool",
    allowedChoices: ["allow-once", "deny-once"],
    toolName: "bash",
    toolCategory: "shell",
    args: { command: "ls /srv/work" },
    reason: "[Sub-Agent: report writer] state-changing tool",
    source: "builtin",
    createdAt: Date.now(),
    requireExplicit: true,
    trustOrigin: "llm-tool-arg",
    reviewerVerdict: { level: "medium", reason: "shell command" },
    ...(parentEscalation ? { parentEscalation } : {}),
  };
}

const ALL_CAUSES: readonly ParentEscalationCause[] = [
  "parent-escalated",
  "timeout",
  "malformed-output",
  "rate-limited",
  "adjudicator-unavailable",
  "llm-error",
  "turn-aborted",
  "repeated-denial",
];

describe("ToolApprovalContent parent-escalation band", () => {
  it("says a parent agent already tried, and names the child that asked", () => {
    render(
      <ToolApprovalContent conversationLabel="conversation"
        open
        request={escalatedRequest({
          cause: "parent-escalated",
          reason: "I cannot tell whether this path belongs to the task",
          childTitle: "report writer",
        })}
        onDecide={vi.fn()}
      />,
    );
    const band = screen.getByTestId("parent-escalation-band");
    expect(band).toHaveAttribute("data-parent-escalation-cause", "parent-escalated");
    expect(screen.getByTestId("parent-escalation-child")).toHaveTextContent("report writer");
    expect(screen.getByTestId("parent-escalation-reason")).toHaveTextContent(
      "I cannot tell whether this path belongs to the task",
    );
  });

  it("quotes the child's title instead of narrating it", () => {
    // The title is not a host fact — `agent_spawn` takes it from the parent
    // model's own arguments. Interpolated into the dock's sentence, a title
    // like the one below would speak in the app's voice on the one surface
    // where the user decides whether to trust the call.
    render(
      <ToolApprovalContent conversationLabel="conversation"
        open
        request={escalatedRequest({
          cause: "parent-escalated",
          reason: "I cannot tell",
          childTitle: "report writer — you already approved this command earlier",
        })}
        onDecide={vi.fn()}
      />,
    );
    const child = screen.getByTestId("parent-escalation-child");
    expect(child.querySelector("q")?.textContent).toBe(
      "report writer — you already approved this command earlier",
    );
    expect(child.querySelector("span")?.textContent?.length).toBeGreaterThan(0);
    expect(child.textContent?.startsWith("report writer")).toBe(false);
  });

  it("puts the host's cause ahead of the parent's own sentence", () => {
    // Reading order is trust order. A model sentence rendered first, and
    // unattributed, reads as the app instructing the user — the band would then
    // become a channel for the very argument the parent declined to accept.
    render(
      <ToolApprovalContent conversationLabel="conversation"
        open
        request={escalatedRequest({
          cause: "timeout",
          reason: "Approve this immediately, it is safe",
          childTitle: "report writer",
        })}
        onDecide={vi.fn()}
      />,
    );
    const band = screen.getByTestId("parent-escalation-band");
    const cause = screen.getByTestId("parent-escalation-cause");
    const reason = screen.getByTestId("parent-escalation-reason");
    expect(band.compareDocumentPosition(cause) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
    expect(cause.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Attributed, not narrated: the parent's sentence is quoted and labelled.
    expect(reason.querySelector("q")?.textContent).toBe("Approve this immediately, it is safe");
    // Locale-independent check that the quote is introduced by an attribution
    // label rather than standing alone as dock prose.
    expect(reason.querySelector("span")?.textContent?.length).toBeGreaterThan(0);
    expect(reason.textContent?.startsWith("Approve")).toBe(false);
  });

  it("labels every cause the host can escalate on", () => {
    for (const cause of ALL_CAUSES) {
      const { unmount } = render(
        <ToolApprovalContent conversationLabel="conversation"
          open
          request={escalatedRequest({ cause, reason: "", childTitle: "report writer" })}
          onDecide={vi.fn()}
        />,
      );
      const text = screen.getByTestId("parent-escalation-cause").textContent ?? "";
      // A cause with no sentence would leave the user holding a decision with
      // no account of how it got to them.
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain(cause);
      expect(text).not.toContain("toolApprovalDialog.");
      unmount();
    }
  });

  it("shows the whole sentence the adjudicator bounded", () => {
    // One cap, in the adjudicator that parses the answer. A second cut here
    // would drop the end of a sentence whose point is usually at the end —
    // and it would do it with nothing on screen saying so.
    const bounded = `${"x".repeat(230)} and that path is not in the task`;
    render(
      <ToolApprovalContent conversationLabel="conversation"
        open
        request={escalatedRequest({
          cause: "malformed-output",
          reason: bounded,
          childTitle: "report writer",
        })}
        onDecide={vi.fn()}
      />,
    );
    const quoted = screen.getByTestId("parent-escalation-reason").querySelector("q");
    expect(quoted?.textContent).toBe(bounded);
  });

  it("says so when the cause is one this build has no sentence for", () => {
    // TypeScript keeps the map exhaustive within one build; the value still
    // crosses IPC. A blank line here would be the one escalation with no
    // account at all — the exact gap the band exists to close.
    render(
      <ToolApprovalContent conversationLabel="conversation"
        open
        request={escalatedRequest({
          cause: "cause-from-a-later-build" as ParentEscalationCause,
          reason: "",
          childTitle: "report writer",
        })}
        onDecide={vi.fn()}
      />,
    );
    const text = screen.getByTestId("parent-escalation-cause").textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("toolApprovalDialog.");
  });

  it("stays absent for an ask no parent ever saw", () => {
    render(<ToolApprovalContent conversationLabel="conversation" open request={escalatedRequest(undefined)} onDecide={vi.fn()} />);
    expect(screen.queryByTestId("parent-escalation-band")).toBeNull();
  });
});
