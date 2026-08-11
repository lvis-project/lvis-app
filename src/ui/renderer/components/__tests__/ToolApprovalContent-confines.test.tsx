// @vitest-environment jsdom

/**
 * PR2 finding b — ToolApprovalContent confines honesty.
 *
 * The always-visible security-isolation summary must reflect per-dimension confines.
 * Before the fix, the confines-BLIND `isWeakSandbox` printed a blanket
 * "OS 격리 활성" for ANY verified non-none ASRT — so a write/shell tool on
 * Windows (partial srt-win, process not confined) wrongly read
 * as fully isolated. Now a non-full confinement renders the partial-isolation
 * qualifier with the per-dimension breakdown. Display-only — the relaxation
 * control (sandboxRelaxesCategory) is untouched.
 *
 * Locale is pinned to Korean for renderer tests (vitest-locale-ko.ts), so the
 * assertions match the Korean catalog.
 */
import "../../../../../test/renderer/setup.js";
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";

function makeRequest(
  sandboxCapability: ApprovalRequest["sandboxCapability"],
): ApprovalRequest {
  return {
    id: "req-1",
    category: "tool",
    toolName: "powershell",
    toolCategory: "shell",
    args: { command: "Get-ChildItem" },
    reason: "test",
    source: "builtin",
    createdAt: Date.now(),
    requireExplicit: false,
    sandboxCapability,
  };
}

function renderSandboxSummary(req: ApprovalRequest) {
  const { container } = render(
    <ToolApprovalContent open request={req} onDecide={() => undefined} />,
  );
  return {
    container,
    summary: container.querySelector<HTMLElement>(
      '[data-testid="tool-approval-sandbox"], [data-testid="tool-approval-execution-plan"]',
    ),
  };
}

describe("ToolApprovalContent sandbox confines label", () => {
  it("shows the partial breakdown for a win32 partial ASRT (process not confined)", () => {
    const { summary } = renderSandboxSummary(
      makeRequest({
        kind: "asrt",
        confidence: "verified",
        platform: "win32",
        reason: "srt-win fs+network partial",
        confines: { filesystem: true, process: false, network: true },
      }),
    );
    expect(summary).toBeTruthy();
    // KO: "⚠ OS 격리 부분적 … [net:✓ fs:✓ proc:✗]"
    expect(summary?.textContent).toContain("OS 격리 부분적");
    expect(summary?.textContent).toContain("net:✓");
    expect(summary?.textContent).toContain("fs:✓");
    expect(summary?.textContent).toContain("proc:✗");
    // It must NOT print the blanket "OS 격리 활성" full-isolation label.
    expect(summary?.textContent).not.toContain("OS 격리 활성");
  });

  it("shows full-isolation active for a mac/linux full-confine ASRT", () => {
    const { summary } = renderSandboxSummary(
      makeRequest({
        kind: "asrt",
        confidence: "verified",
        platform: "darwin",
        reason: "Seatbelt full",
        confines: { filesystem: true, process: true, network: true },
      }),
    );
    expect(summary?.textContent).toContain("OS 격리 활성");
    expect(summary?.textContent).not.toContain("OS 격리 부분적");
  });

  it("shows no-isolation for a kind:none capability", () => {
    const { summary } = renderSandboxSummary(
      makeRequest({
        kind: "none",
        confidence: "verified",
        platform: "win32",
        reason: "gate off",
      }),
    );
    expect(summary?.textContent).toContain("OS 격리 없음");
  });
  it("uses the safe host execution plan instead of a contradictory process capability", () => {
    const request = makeRequest({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "process-wide capability must not override the sealed shell plan",
      confines: { filesystem: true, process: true, network: true },
    });
    // The host gate rejects structural lookalikes before IPC. This confirms the
    // renderer still derives its row only from the safe projection and displays
    // none of the extra host-only fields if such a value reaches it.
    request.executionPlan = {
      version: "host-shell-execution-plan/v2",
      identity: "host-shell-execution-plan/v2:win32:windows-partial-shell-acl-unsafe",
      platform: "win32",
      requestedSandbox: true,
      mode: "plain",
      fallbackReason: "windows-partial-shell-acl-unsafe",
      requiresExplicitUserApproval: true,
      capability: {
        kind: "none",
        confidence: "verified",
        platform: "win32",
        confines: { filesystem: false, process: false, network: false },
      },
      binding: "HOST-ONLY-binding",
      command: "HOST-ONLY-command",
      cwd: "HOST-ONLY-cwd",
      reason: "HOST-ONLY-reason",
    } as unknown as NonNullable<ApprovalRequest["executionPlan"]>;

    const { container, summary } = renderSandboxSummary(request);
    expect(summary).toHaveAttribute("data-testid", "tool-approval-execution-plan");
    expect(summary?.textContent).toContain("OS 격리 없음");
    expect(summary?.textContent).toContain("한 번만 허용");
    expect(container.querySelector('[data-testid="tool-approval-sandbox"]')).toBeNull();
    expect(summary?.textContent).not.toContain("HOST-ONLY-binding");
    expect(summary?.textContent).not.toContain("HOST-ONLY-command");
    expect(summary?.textContent).not.toContain("HOST-ONLY-cwd");
    expect(summary?.textContent).not.toContain("HOST-ONLY-reason");
  });

  it("shows one-shot approval for a generic requested-unavailable plan without exposing its reason", () => {
    const request = makeRequest({
      kind: "none",
      confidence: "verified",
      platform: "linux",
      reason: "process capability must not override the sealed shell plan",
    });
    request.executionPlan = {
      version: "host-shell-execution-plan/v2",
      identity: "host-shell-execution-plan/v2:linux:requested-sandbox-unavailable",
      platform: "linux",
      requestedSandbox: true,
      mode: "plain",
      fallbackReason: "requested-sandbox-unavailable",
      requiresExplicitUserApproval: true,
      capability: {
        kind: "none",
        confidence: "verified",
        platform: "linux",
        confines: { filesystem: false, process: false, network: false },
      },
      reason: "HOST-ONLY-requested-unavailable-reason",
    } as unknown as NonNullable<ApprovalRequest["executionPlan"]>;

    const { summary } = renderSandboxSummary(request);
    expect(summary).toHaveAttribute("data-testid", "tool-approval-execution-plan");
    expect(summary?.textContent).toContain("OS 격리 없음");
    expect(summary?.textContent).toContain("한 번만 허용");
    expect(summary?.textContent).not.toContain("HOST-ONLY-requested-unavailable-reason");
  });
  it("falls back to full-active label when confines is absent (legacy)", () => {
    // A verified non-none ASRT with no declared confines keeps the old
    // all-or-nothing label — preserving existing fixtures.
    const { summary } = renderSandboxSummary(
      makeRequest({
        kind: "asrt",
        confidence: "verified",
        platform: "linux",
        reason: "legacy",
      }),
    );
    expect(summary?.textContent).toContain("OS 격리 활성");
  });
});
