/**
 * Permission policy Phase 2.5 — OutOfAllowedDirCard unit tests.
 *
 * Verifies the re-typed confirmation gate (M3 phishing defense), the
 * adjacency-warning blocking checkbox, and the four-button decision
 * routing (deny / turn-scope / session-scope / persisted).
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { OutOfAllowedDirCard } from "../components/permissions/OutOfAllowedDirCard.js";
import type { ApprovalRequest } from "../types.js";

afterEach(() => {
  cleanup();
});

function makeReq(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-1",
    category: "tool",
    kind: "out-of-allowed-dir",
    toolName: "read_file",
    args: { path: "/Users/ken/Documents/old-project/notes/today/foo.md" },
    reason: "out-of-allowed-dir",
    source: "builtin",
    createdAt: Date.now(),
    requireExplicit: true,
    outOfAllowedDir: {
      candidatePath: "/Users/ken/Documents/old-project/notes/today/foo.md",
      suggestedParent: "/Users/ken/Documents/old-project/notes/today",
      currentAllowed: ["/Users/ken/work"],
      adjacencyWarnings: [],
    },
    trustOrigin: "user-keyboard",
    ...overrides,
  };
}

describe("OutOfAllowedDirCard", () => {
  it("renders nothing when request is null", () => {
    const { container } = render(
      <OutOfAllowedDirCard open={true} request={null} onDecide={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders the candidate path + suggested-parent + current allowed list", () => {
    const { getByText } = render(
      <OutOfAllowedDirCard open={true} request={makeReq()} onDecide={() => {}} />,
    );
    // Radix Dialog renders into a portal at document.body; query that.
    expect(document.body.textContent).toContain("read_file");
    expect(document.body.textContent).toContain("/Users/ken/Documents/old-project/notes/today/foo.md");
    expect(document.body.textContent).toContain("/Users/ken/Documents/old-project/notes/today");
    expect(document.body.textContent).toContain("/Users/ken/work");
    expect(getByText("거부")).toBeTruthy();
    expect(getByText("이번 1회만")).toBeTruthy();
    expect(getByText("이번 세션 동안 허용")).toBeTruthy();
    expect(getByText("디렉토리 영구 추가")).toBeTruthy();
  });

  it("clicking '거부' invokes onDecide('deny-once')", () => {
    const onDecide = vi.fn();
    const { getByText } = render(
      <OutOfAllowedDirCard open={true} request={makeReq()} onDecide={onDecide} />,
    );
    fireEvent.click(getByText("거부"));
    expect(onDecide).toHaveBeenCalledWith("deny-once");
  });

  it("clicking '이번 1회만' invokes onDecide('allow-once') — turn-scope grant", () => {
    const onDecide = vi.fn();
    const { getByText } = render(
      <OutOfAllowedDirCard open={true} request={makeReq()} onDecide={onDecide} />,
    );
    fireEvent.click(getByText("이번 1회만"));
    expect(onDecide).toHaveBeenCalledWith("allow-once");
  });

  it("clicking '이번 세션 동안 허용' invokes onDecide('allow-session', suggestedParent) — conversation-scope grant", () => {
    const onDecide = vi.fn();
    const { getByText } = render(
      <OutOfAllowedDirCard open={true} request={makeReq()} onDecide={onDecide} />,
    );
    fireEvent.click(getByText("이번 세션 동안 허용"));
    expect(onDecide).toHaveBeenCalledWith(
      "allow-session",
      "/Users/ken/Documents/old-project/notes/today",
    );
  });

  it("'디렉토리 영구 추가' is DISABLED until user re-types the full suggested directory", () => {
    const onDecide = vi.fn();
    const { getByText, getByPlaceholderText } = render(
      <OutOfAllowedDirCard open={true} request={makeReq()} onDecide={onDecide} />,
    );
    const persist = getByText("디렉토리 영구 추가") as HTMLButtonElement;
    expect(persist.disabled).toBe(true);
    // typing wrong name keeps it disabled
    const input = getByPlaceholderText("/Users/ken/Documents/old-project/notes/today") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "wrong-name" } });
    expect(persist.disabled).toBe(true);
    // typing the exact full directory enables it
    fireEvent.change(input, { target: { value: "/Users/ken/Documents/old-project/notes/today" } });
    expect(persist.disabled).toBe(false);
    fireEvent.click(persist);
    expect(onDecide).toHaveBeenCalledWith(
      "allow-always",
      "/Users/ken/Documents/old-project/notes/today",
    );
  });

  it("adjacency warnings render + block persist until acknowledged", () => {
    const req = makeReq({
      outOfAllowedDir: {
        candidatePath: "/Users/ken/work/proj/.git/config",
        suggestedParent: "/Users/ken/work/proj/.git",
        currentAllowed: [],
        adjacencyWarnings: ["path contains '.git' segment — secrets may be exposed if added"],
      },
    });
    const onDecide = vi.fn();
    const { getByText, getByPlaceholderText } = render(
      <OutOfAllowedDirCard open={true} request={req} onDecide={onDecide} />,
    );
    const persist = getByText("디렉토리 영구 추가") as HTMLButtonElement;
    expect(document.body.textContent).toContain("주의");
    expect(document.body.textContent).toContain(".git");

    // Type the correct name — still disabled until acknowledged.
    const input = getByPlaceholderText("/Users/ken/work/proj/.git") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/Users/ken/work/proj/.git" } });
    expect(persist.disabled).toBe(true);

    // Acknowledge → now enabled.
    fireEvent.click(document.body.querySelector('[data-testid="adjacency-warning-ack"]') as HTMLElement);
    expect(persist.disabled).toBe(false);
  });

  it("trustOrigin badge renders as a user-facing label when present", () => {
    render(
      <OutOfAllowedDirCard open={true} request={makeReq({ trustOrigin: "llm-tool-arg" })} onDecide={() => {}} />,
    );
    expect(document.body.textContent).toContain("모델 생성 인자");
  });

  it("warns when trustOrigin is missing", () => {
    const req = makeReq();
    delete req.trustOrigin;
    render(
      <OutOfAllowedDirCard open={true} request={req} onDecide={() => {}} />,
    );
    expect(document.body.textContent).toContain("출처 미확인");
    expect(document.body.textContent).toContain("영구 허용은 이후 같은 범위의 파일 접근을 계속 허용합니다");
  });

  it("wraps long path fields inside the dialog", () => {
    render(
      <OutOfAllowedDirCard open={true} request={makeReq()} onDecide={() => {}} />,
    );
    expect(document.body.querySelector("p.font-mono.break-all")?.textContent).toContain("foo.md");
    expect(document.body.querySelector("ul.font-mono.break-all")?.textContent).toContain("/Users/ken/work");
  });
});
