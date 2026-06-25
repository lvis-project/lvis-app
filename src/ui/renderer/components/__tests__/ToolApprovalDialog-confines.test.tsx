/**
 * PR2 finding b — ToolApprovalDialog confines honesty.
 *
 * The "보안 격리" (security isolation) row must reflect per-dimension confines.
 * Before the fix, the confines-BLIND `isWeakSandbox` printed a blanket
 * "OS 격리 활성" for ANY verified non-none ASRT — so a write/shell tool on
 * Windows (network-only srt-win, confines.filesystem === false) wrongly read
 * as fully isolated. Now a non-full confinement renders the network-only
 * qualifier with the per-dimension breakdown. Display-only — the relaxation
 * control (sandboxRelaxesCategory) is untouched.
 *
 * Locale is pinned to Korean for renderer tests (vitest-locale-ko.ts), so the
 * assertions match the Korean catalog.
 */
import { describe, it, expect } from "vitest";
import { approvalReviewRows } from "../ToolApprovalDialog.js";
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

function sandboxRow(req: ApprovalRequest) {
  const rows = approvalReviewRows(req, "shell", "Get-ChildItem", "user", "builtin", "BUILTIN");
  return rows.find((r) => r.testId === "tool-approval-sandbox");
}

describe("ToolApprovalDialog sandbox confines label", () => {
  it("shows the network-only breakdown for a win32 network-only ASRT (fs not confined)", () => {
    const row = sandboxRow(
      makeRequest({
        kind: "asrt",
        confidence: "verified",
        platform: "win32",
        reason: "srt-win network-only",
        confines: { filesystem: false, process: false, network: true },
      }),
    );
    expect(row).toBeDefined();
    // KO: "⚠ 네트워크만 격리 … [net:✓ fs:✗ proc:✗]"
    expect(row?.value).toContain("네트워크만 격리");
    expect(row?.value).toContain("net:✓");
    expect(row?.value).toContain("fs:✗");
    expect(row?.value).toContain("proc:✗");
    // It must NOT print the blanket "OS 격리 활성" full-isolation label.
    expect(row?.value).not.toContain("OS 격리 활성");
  });

  it("shows full-isolation active for a mac/linux full-confine ASRT", () => {
    const row = sandboxRow(
      makeRequest({
        kind: "asrt",
        confidence: "verified",
        platform: "darwin",
        reason: "Seatbelt full",
        confines: { filesystem: true, process: true, network: true },
      }),
    );
    expect(row?.value).toContain("OS 격리 활성");
    expect(row?.value).not.toContain("네트워크만 격리");
  });

  it("shows no-isolation for a kind:none capability", () => {
    const row = sandboxRow(
      makeRequest({
        kind: "none",
        confidence: "verified",
        platform: "win32",
        reason: "gate off",
      }),
    );
    expect(row?.value).toContain("OS 격리 없음");
  });

  it("falls back to full-active label when confines is absent (legacy)", () => {
    // A verified non-none ASRT with no declared confines keeps the old
    // all-or-nothing label — preserving existing fixtures.
    const row = sandboxRow(
      makeRequest({
        kind: "asrt",
        confidence: "verified",
        platform: "linux",
        reason: "legacy",
      }),
    );
    expect(row?.value).toContain("OS 격리 활성");
  });
});
