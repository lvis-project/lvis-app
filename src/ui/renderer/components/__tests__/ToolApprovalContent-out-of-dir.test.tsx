// @vitest-environment jsdom
/**
 * Path-grant (out-of-allowed-dir) requests render in the SAME approval frame
 * as every other kind — one identity strip, one impact banner, one review
 * expander, one three-button decision row. Only the evidence and the pattern
 * carried by allow-always are kind-specific. Issue #2104.
 */
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";

const TARGET = "C:\\ProgramData\\lvis\\config.json";
const PARENT = "C:\\ProgramData\\lvis";

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-ood-1",
    category: "tool",
    kind: "out-of-allowed-dir",
    toolName: "read_file",
    toolCategory: "read",
    args: {},
    reason: "outside allowed directories",
    createdAt: 0,
    requireExplicit: false,
    outOfAllowedDir: {
      candidatePath: TARGET,
      suggestedParent: PARENT,
      currentAllowed: ["C:\\work"],
      adjacencyWarnings: [],
    },
    ...overrides,
  } as ApprovalRequest;
}

function renderCard(
  request = makeRequest(),
  extraProps: Partial<Parameters<typeof ToolApprovalContent>[0]> = {},
) {
  const onDecide = vi.fn();
  const record = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("lvis", { userApproval: { record } });
  const view = render(
    <ToolApprovalContent open request={request} onDecide={onDecide} {...extraProps} />,
  );
  return { onDecide, record, view };
}

const panel = () => screen.getByTestId("tool-approval-panel");
const targetLine = () => screen.getByTestId("approval-decision-target").textContent ?? "";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ToolApprovalContent out-of-allowed-dir — one frame, one decision row", () => {
  it("renders the shared frame: identity, headline, expander, and the generic buttons", () => {
    renderCard();
    expect(screen.getByTestId("approval-tool-identity").textContent).toContain("read_file");
    expect(screen.getByTestId("approval-impact-summary").textContent)
      .toContain("허용된 디렉터리 밖을 읽으려 합니다");
    expect(screen.getByTestId("approval-review-details")).toBeTruthy();
    expect(screen.getByTestId("deny-button")).toHaveTextContent("거절");
    expect(screen.getByTestId("allow-always-button")).toHaveTextContent("항상 허용");
    expect(screen.getByTestId("approve-button")).toHaveTextContent("한 번만 허용");
    expect(screen.getByTestId("open-permanent-deny-settings")).toBeTruthy();
    // No second layout remains anywhere in the tree.
    expect(document.body.querySelector('[data-testid="docked-approval-panel"]')).toBeNull();
  });

  it("keeps what will be granted on screen as the selection moves", () => {
    renderCard();
    // Fail-closed default selection is Reject, which grants nothing.
    expect(targetLine()).toContain("거부");
    fireEvent.focus(screen.getByTestId("allow-always-button"));
    expect(targetLine()).toContain(PARENT);
    expect(targetLine()).toContain("상위 폴더 전체");
    fireEvent.focus(screen.getByTestId("approve-button"));
    expect(targetLine()).toContain(TARGET);
  });

  it("allow-always carries the host-resolved parent pattern and never writes the exact-args record", async () => {
    const { onDecide, record } = renderCard();
    await act(async () => {
      fireEvent.click(screen.getByTestId("allow-always-button"));
    });
    expect(onDecide).toHaveBeenCalledWith("allow-always", PARENT);
    expect(record).not.toHaveBeenCalled();
  });

  it("allow-once and deny stay narrow: no pattern, no record", async () => {
    const { onDecide, record } = renderCard();
    await act(async () => {
      fireEvent.click(screen.getByTestId("approve-button"));
    });
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
    fireEvent.click(screen.getByTestId("deny-button"));
    expect(onDecide).toHaveBeenCalledWith("deny-once");
    expect(record).not.toHaveBeenCalled();
  });

  it("shows both grant paths in the shared review expander", () => {
    renderCard();
    const details = screen.getByTestId("approval-path-grant-evidence");
    expect(details.textContent).toContain(TARGET);
    expect(details.textContent).toContain(PARENT);
  });

  it("shows the adjacency warning only while the widening decision is selected", () => {
    renderCard(makeRequest({
      outOfAllowedDir: {
        candidatePath: TARGET,
        suggestedParent: PARENT,
        currentAllowed: [],
        adjacencyWarnings: ["path contains '.git' segment"],
      },
    }));
    expect(screen.queryByTestId("approval-adjacency-warning")).toBeNull();
    fireEvent.focus(screen.getByTestId("allow-always-button"));
    expect(screen.getByTestId("approval-adjacency-warning").textContent).toContain(".git");
    fireEvent.focus(screen.getByTestId("approve-button"));
    expect(screen.queryByTestId("approval-adjacency-warning")).toBeNull();
  });

  it("keeps Always allow visible but disabled when the host resolved no parent", () => {
    renderCard(makeRequest({
      outOfAllowedDir: {
        candidatePath: TARGET,
        suggestedParent: null,
        currentAllowed: [],
        adjacencyWarnings: [],
      },
    }));
    const always = screen.getByTestId("allow-always-button");
    expect(always).toBeDisabled();
    expect(always).toHaveAttribute("title", "지속 허용할 안전한 검토 상위 폴더가 없습니다.");
    expect(screen.getByTestId("allow-always-unavailable-reason"))
      .toHaveTextContent("지속 허용할 안전한 검토 상위 폴더가 없습니다.");
    expect(screen.getByTestId("deny-button")).toBeEnabled();
  });

  it("keeps host-forbidden persistence visible but disabled", () => {
    renderCard(makeRequest({ allowedChoices: ["allow-once", "deny-once"] }));
    const always = screen.getByTestId("allow-always-button");
    expect(always).toBeDisabled();
    expect(always).toHaveAttribute("title", "호스트가 이 요청을 일회성 결정으로 제한했습니다.");
    expect(screen.getByTestId("allow-always-unavailable-reason"))
      .toHaveTextContent("호스트가 이 요청을 일회성 결정으로 제한했습니다.");
  });

  it("a proposed choice fills the form without deciding", async () => {
    const { onDecide } = renderCard(makeRequest(), { proposedChoice: "allow-always" });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    const always = screen.getByTestId("allow-always-button");
    expect(always.dataset.proposed).toBe("true");
    expect(document.activeElement).toBe(always);
    expect(targetLine()).toContain(PARENT);
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("ignores a proposal for a decision this request does not offer", async () => {
    renderCard(
      makeRequest({ allowedChoices: ["allow-once", "deny-once"] }),
      { proposedChoice: "allow-always" },
    );
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    const always = screen.getByTestId("allow-always-button");
    expect(always).toBeDisabled();
    expect(always).not.toHaveAttribute("data-proposed");
    expect(screen.getByTestId("deny-button").tabIndex).toBe(0);
  });

  it("Escape denies, unless the request requires an explicit choice", () => {
    const { onDecide } = renderCard();
    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(onDecide).toHaveBeenCalledWith("deny-once");

    const explicit = renderCard(makeRequest({ id: "req-ood-2", requireExplicit: true }));
    fireEvent.keyDown(screen.getAllByTestId("tool-approval-panel")[1]!, { key: "Escape" });
    expect(explicit.onDecide).not.toHaveBeenCalled();
  });

  it("locks every decision while an exact reject is being managed in Settings", () => {
    const { onDecide } = renderCard(makeRequest(), { interactionLocked: true });
    expect(screen.getByTestId("deny-button")).toBeDisabled();
    expect(screen.getByTestId("allow-always-button")).toBeDisabled();
    expect(screen.getByTestId("approve-button")).toBeDisabled();
    expect(screen.getByTestId("approval-decision-locked")).toBeTruthy();
    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(onDecide).not.toHaveBeenCalled();
  });
});
