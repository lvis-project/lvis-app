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
import type { ApprovalRequest } from "../types.js";

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-1",
    category: "tool",
    toolName: "read_file",
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
      makeRequest({ id: "req-2", toolName: "write_file" }),
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
