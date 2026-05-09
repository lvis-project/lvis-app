/**
 * Q12 Phase 2.5 — OutOfAllowedDirCard unit tests.
 *
 * Verifies the re-typed confirmation gate (M3 phishing defense), the
 * adjacency-warning blocking checkbox, and the three-button decision
 * routing.
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
    trustOrigin: "user",
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
    expect(getByText("한 번만 허용")).toBeTruthy();
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

  it("clicking '한 번만 허용' invokes onDecide('allow-once')", () => {
    const onDecide = vi.fn();
    const { getByText } = render(
      <OutOfAllowedDirCard open={true} request={makeReq()} onDecide={onDecide} />,
    );
    fireEvent.click(getByText("한 번만 허용"));
    expect(onDecide).toHaveBeenCalledWith("allow-once");
  });

  it("'디렉토리 영구 추가' is DISABLED until user re-types the leaf-parent name", () => {
    const onDecide = vi.fn();
    const { getByText, getByPlaceholderText } = render(
      <OutOfAllowedDirCard open={true} request={makeReq()} onDecide={onDecide} />,
    );
    const persist = getByText("디렉토리 영구 추가") as HTMLButtonElement;
    expect(persist.disabled).toBe(true);
    // typing wrong name keeps it disabled
    const input = getByPlaceholderText("today") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "wrong-name" } });
    expect(persist.disabled).toBe(true);
    // typing the exact basename enables it
    fireEvent.change(input, { target: { value: "today" } });
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
    const input = getByPlaceholderText(".git") as HTMLInputElement;
    fireEvent.change(input, { target: { value: ".git" } });
    expect(persist.disabled).toBe(true);

    // Acknowledge → now enabled.
    const checkbox = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(persist.disabled).toBe(false);
  });

  it("trustOrigin badge renders when present", () => {
    render(
      <OutOfAllowedDirCard open={true} request={makeReq({ trustOrigin: "agent" })} onDecide={() => {}} />,
    );
    expect(document.body.textContent).toContain("agent");
  });
});
