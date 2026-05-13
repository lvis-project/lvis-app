/**
 * ApprovalDialog unit tests.
 *
 * ApprovalDialog wraps ToolApprovalDialog (Radix Dialog) which portals content
 * to document.body — assertions must query document.body, not the render container.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { ApprovalDialog } from "../dialogs/ApprovalDialog.js";
import type { ApprovalRequest, PermissionEvaluationContext } from "../types.js";

function makeEvaluationContext(overrides: Partial<PermissionEvaluationContext> = {}): PermissionEvaluationContext {
  return {
    version: "permission-evaluation-context/v1",
    reviewerFrameworkVersion: "permission-reviewer-framework/v1",
    policyMode: "auto",
    headless: false,
    source: "builtin",
    category: "shell",
    trustOrigin: "user-keyboard",
    executionCwd: "C:\\workspace\\lvis-app",
    allowedDirectories: ["C:\\workspace\\lvis-app", "C:\\tmp"],
    pathFields: ["path"],
    targetFilePaths: ["C:\\workspace\\lvis-app\\README.md"],
    sensitivePathsAdjacent: [],
    ...overrides,
  };
}

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-1",
    category: "tool",
    toolName: "read_file",
    toolCategory: "read",
    args: { path: "/tmp/test.txt" },
    reason: "파일 읽기 요청",
    createdAt: Date.now(),
    requireExplicit: false,
    ...overrides,
  };
}

describe("ApprovalDialog", () => {
  it("renders without crashing with empty queue", () => {
    const { container } = render(
      <ApprovalDialog queue={[]} onDecide={vi.fn()} />,
    );
    expect(container).toBeTruthy();
  });

  it("renders approval dialog content to document.body when queue has one item", async () => {
    render(
      <ApprovalDialog queue={[makeRequest()]} onDecide={vi.fn()} />,
    );
    // Radix Dialog portals to document.body
    await waitFor(() => {
      expect(document.body.textContent).toContain("read_file");
      expect(document.body.textContent).toContain("도구 / 출처");
      expect(document.body.textContent).toContain("읽기 판단근거");
    });
  });

  it("warns when approval trust origin is missing", async () => {
    render(
      <ApprovalDialog queue={[makeRequest()]} onDecide={vi.fn()} />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("출처 미확인");
      expect(document.body.textContent).toContain("사용자가 직접 입력한 명령이 아니라");
    });
  });

  it("calls onDecide when 허용 button clicked", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalDialog queue={[makeRequest()]} onDecide={onDecide} />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("read_file");
    });
    const allowBtn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("허용"),
    );
    if (allowBtn) {
      fireEvent.click(allowBtn);
      expect(onDecide).toHaveBeenCalled();
      expect(onDecide.mock.calls[0]?.[0]).toMatch(/allow/);
    }
  });

  it("does not show tool name when queue is empty", () => {
    render(
      <ApprovalDialog queue={[]} onDecide={vi.fn()} />,
    );
    expect(document.body.textContent).not.toContain("read_file");
  });

  it("shows first item when multiple items in queue", async () => {
    const queue = [
      makeRequest({ id: "req-1" }),
      makeRequest({ id: "req-2", toolName: "write_file", toolCategory: "write" }),
    ];
    render(
      <ApprovalDialog queue={queue} onDecide={vi.fn()} />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("read_file");
    });
    expect(document.body.textContent).toContain("대기 중 1개");
    expect(document.body.textContent).not.toContain("모두 허용");
  });

  it("renders the sandbox capability row with ⚠ when kind=none (#691 round-1 user request)", async () => {
    render(
      <ApprovalDialog
        queue={[makeRequest({
          toolName: "bash",
          toolCategory: "shell",
          sandboxCapability: {
            kind: "none",
            confidence: "verified",
            platform: "darwin",
            reason: "no OS sandbox configured for the host process",
          },
        })]}
        onDecide={vi.fn()}
      />,
    );
    await waitFor(() => {
      const row = document.body.querySelector('[data-testid="tool-approval-sandbox"]');
      expect(row).toBeTruthy();
      // Round-5 UX MAJOR — plain Korean copy; raw English `reason`
      // field no longer leaks into UI. "OS 격리 없음" is the canonical
      // weak-sandbox message.
      expect(row!.textContent).toContain("⚠");
      expect(row!.textContent).toContain("OS 격리 없음");
    });
  });

  it("renders the sandbox capability row WITHOUT ⚠ when kind=bubblewrap + confidence=verified", async () => {
    render(
      <ApprovalDialog
        queue={[makeRequest({
          toolName: "bash",
          toolCategory: "shell",
          sandboxCapability: {
            kind: "bubblewrap",
            confidence: "verified",
            platform: "linux",
            reason: "bwrap binary present + invocable",
          },
        })]}
        onDecide={vi.fn()}
      />,
    );
    await waitFor(() => {
      const row = document.body.querySelector('[data-testid="tool-approval-sandbox"]');
      expect(row).toBeTruthy();
      // Round-5 UX MAJOR — strong sandbox renders "OS 격리 활성".
      expect(row!.textContent).toContain("OS 격리 활성");
      expect(row!.textContent).toContain("bubblewrap");
      expect(row!.textContent).not.toContain("⚠");
    });
  });

  it("omits the sandbox row entirely when sandboxCapability is undefined", async () => {
    render(
      <ApprovalDialog
        queue={[makeRequest({ toolName: "read_file", toolCategory: "read" })]}
        onDecide={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="tool-approval-sandbox"]')).toBeNull();
    });
  });

  it("surfaces captured permission evaluation context instead of reconstructing sandbox details from args", async () => {
    render(
      <ApprovalDialog
        queue={[makeRequest({
          toolName: "powershell",
          toolCategory: "shell",
          args: { command: "Get-ChildItem", cwd: "stale-from-args" },
          reviewerVerdict: { level: "medium", reason: "shell unclassified" },
          evaluationContext: makeEvaluationContext({
            executionCwd: "C:\\Users\\ikcha\\workspace\\lvis-project\\lvis-app",
            allowedDirectories: ["C:\\Users\\ikcha\\workspace\\lvis-project\\lvis-app"],
            targetFilePaths: [],
          }),
        })]}
        onDecide={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("검증 환경 / 샌드박스 평가");
      expect(document.body.textContent).toContain("permission-evaluation-context/v1");
      expect(document.body.textContent).toContain("permission-reviewer-framework/v1");
      expect(document.body.textContent).toContain("C:\\Users\\ikcha\\workspace\\lvis-project\\lvis-app");
    });
  });

  it("routes out-of-allowed-dir requests to the directory access card", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalDialog
        queue={[
          makeRequest({
            kind: "out-of-allowed-dir",
            toolName: "read_file",
            reason: "out-of-allowed-dir",
            requireExplicit: true,
            outOfAllowedDir: {
              candidatePath: "/Users/ken/Documents/project/notes.md",
              suggestedParent: "/Users/ken/Documents/project",
              currentAllowed: ["/Users/ken/workspace/GIT/github/lvis-project"],
              adjacencyWarnings: [],
            },
          }),
        ]}
        onDecide={onDecide}
      />,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("허용 디렉토리 외부 접근");
      expect(document.body.textContent).toContain("/Users/ken/Documents/project/notes.md");
    });

    const allowOnce = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "한 번만 허용",
    );
    expect(allowOnce).toBeTruthy();
    fireEvent.click(allowOnce!);
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
