/**
 * Q12 Phase 4 — HookTrustModal renderer test.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 6.
 */
import "../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  HookTrustModal,
  type HookTrustModalRequest,
} from "../components/permissions/HookTrustModal.js";

function makeRequest(): HookTrustModalRequest {
  return {
    id: "tr-1-100",
    files: [
      {
        fileName: "pre-allow.sh",
        state: "new",
        sha256: "a".repeat(64),
      },
      {
        fileName: "pre-changed.sh",
        state: "changed",
        sha256: "b".repeat(64),
        previousSha256: "c".repeat(64),
      },
    ],
  };
}

describe("Q12 P4 HookTrustModal", () => {
  it("renders nothing when request is null", () => {
    const onAccept = vi.fn();
    const onRejectAll = vi.fn();
    const { container } = render(
      <HookTrustModal
        open={false}
        request={null}
        onAccept={onAccept}
        onRejectAll={onRejectAll}
      />,
    );
    expect(container.querySelector("[role=dialog]")).toBeNull();
  });

  it("lists each actionable hook with its state badge", () => {
    render(
      <HookTrustModal
        open={true}
        request={makeRequest()}
        onAccept={vi.fn()}
        onRejectAll={vi.fn()}
      />,
    );
    expect(screen.getByText("pre-allow.sh")).toBeTruthy();
    expect(screen.getByText("pre-changed.sh")).toBeTruthy();
    expect(screen.getAllByText(/new|changed/i).length).toBeGreaterThanOrEqual(2);
  });

  it("default state: every checkbox unchecked (deny-by-default)", () => {
    render(
      <HookTrustModal
        open={true}
        request={makeRequest()}
        onAccept={vi.fn()}
        onRejectAll={vi.fn()}
      />,
    );
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    for (const cb of checkboxes) {
      expect((cb as HTMLInputElement).checked).toBe(false);
    }
  });

  it("clicking 'Trust selected' submits the user's whitelist", () => {
    const onAccept = vi.fn();
    render(
      <HookTrustModal
        open={true}
        request={makeRequest()}
        onAccept={onAccept}
        onRejectAll={vi.fn()}
      />,
    );
    const checkboxes = screen.getAllByRole("checkbox");
    // Trust the first one only
    fireEvent.click(checkboxes[0]);
    const trustBtn = screen.getByRole("button", { name: /trust/i });
    fireEvent.click(trustBtn);
    expect(onAccept).toHaveBeenCalledWith("tr-1-100", ["pre-allow.sh"]);
  });

  it("'모두 거부' calls onRejectAll", () => {
    const onRejectAll = vi.fn();
    render(
      <HookTrustModal
        open={true}
        request={makeRequest()}
        onAccept={vi.fn()}
        onRejectAll={onRejectAll}
      />,
    );
    const rejectBtn = screen.getByRole("button", { name: /모두 거부/ });
    fireEvent.click(rejectBtn);
    expect(onRejectAll).toHaveBeenCalledWith("tr-1-100");
  });

  it("changed-state entries display previous sha256", () => {
    render(
      <HookTrustModal
        open={true}
        request={makeRequest()}
        onAccept={vi.fn()}
        onRejectAll={vi.fn()}
      />,
    );
    expect(screen.getByText(/previous:/i)).toBeTruthy();
  });
});
