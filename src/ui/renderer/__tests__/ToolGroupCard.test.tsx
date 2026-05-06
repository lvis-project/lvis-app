/**
 * ToolGroupCard unit tests.
 *
 * ToolGroupCard is a pure-props component that renders tool execution groups.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ToolGroupCard } from "../components/ToolGroupCard.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";

type ToolGroupEntry = Extract<ChatEntry, { kind: "tool_group" }>;

function makeGroup(overrides: Partial<ToolGroupEntry> = {}): ToolGroupEntry {
  return {
    kind: "tool_group",
    groupId: "grp-1",
    groupIds: ["grp-1"],
    status: "done",
    tools: [
      {
        toolUseId: "tu-1",
        name: "read_file",
        input: { path: "/tmp/test.txt" },
        result: "file content",
        status: "done",
        displayOrder: 0,
      },
    ],
    ...overrides,
  };
}

/** Multi-tool group (2 tools) — tests group card behavior */
function makeMultiGroup(overrides: Partial<ToolGroupEntry> = {}): ToolGroupEntry {
  return {
    kind: "tool_group",
    groupId: "grp-2",
    groupIds: ["grp-2"],
    status: "done",
    tools: [
      { toolUseId: "tu-1", name: "knowledge_search", input: {}, result: "r1", status: "done", displayOrder: 0 },
      { toolUseId: "tu-2", name: "read_file", input: {}, result: "r2", status: "done", displayOrder: 1 },
    ],
    ...overrides,
  };
}

describe("ToolGroupCard", () => {
  it("renders without crashing", () => {
    const { container } = render(<ToolGroupCard group={makeGroup()} />);
    expect(container).toBeTruthy();
  });

  // Single tool → inline (no group header)
  it("single tool: renders tool name inline without group header", () => {
    const { container } = render(<ToolGroupCard group={makeGroup({ status: "done" })} />);
    expect(container.textContent).not.toContain("도구 사용 결과");
    expect(container.textContent).toContain("read file"); // unmapped name: underscores → spaces fallback
    expect(container.textContent).not.toContain("file content");
  });

  it("single tool running: shows spinner inline", () => {
    const { container } = render(
      <ToolGroupCard group={makeGroup({ status: "running", tools: [{ toolUseId: "tu-1", name: "read_file", input: {}, status: "running", displayOrder: 0 }] })} />,
    );
    expect(container.textContent).not.toContain("도구 사용 중");
    expect(container.textContent).toContain("read file"); // unmapped name: underscores → spaces fallback
  });

  it("single tool error: shows 실패 badge", () => {
    const group = makeGroup({ status: "error", tools: [{ toolUseId: "tu-1", name: "read_file", input: {}, result: "err", status: "error", displayOrder: 0 }] });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.textContent).toContain("실패");
  });

  it("pretty-prints long JSON tool results inside a bounded custom scroll area", () => {
    const result = JSON.stringify({
      url: "https://wttr.in/Seoul?format=j1&lang=ko",
      content: JSON.stringify({
        current_condition: [{ temp_C: "23", lang_ko: [{ value: "맑음" }] }],
        weather: Array.from({ length: 6 }, (_, idx) => ({ date: `2026-05-${String(idx + 1).padStart(2, "0")}` })),
      }),
    });
    const { container } = render(<ToolGroupCard group={makeGroup({ tools: [
      { toolUseId: "tu-1", name: "web_fetch", input: { url: "https://wttr.in/Seoul" }, result, status: "done", displayOrder: 0 },
    ] })} />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);

    expect(container.textContent).toContain('"url": "https://wttr.in/Seoul?format=j1&lang=ko"');
    expect(container.textContent).toContain('"current_condition"');
    expect(container.textContent).not.toContain('\\"current_condition\\"');
    expect(container.querySelector(".h-\\[6\\.9rem\\]")).not.toBeNull();
  });

  it("bounds visually long one-line tool results after wrapping", () => {
    const result = JSON.stringify({
      url: "https://news.google.com/rss/search?q=IT",
      content: "Google News ".repeat(90),
    });
    const { container } = render(<ToolGroupCard group={makeGroup({ tools: [
      { toolUseId: "tu-1", name: "web_fetch", input: { url: "https://news.google.com/rss/search?q=IT" }, result, status: "done", displayOrder: 0 },
    ] })} />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);

    expect(container.textContent).toContain("Google News");
    expect(container.querySelector(".h-\\[6\\.9rem\\]")).not.toBeNull();
  });

  // Multi-tool → group card
  it("multi-tool: shows '도구 사용 결과' header", () => {
    const { container } = render(<ToolGroupCard group={makeMultiGroup({ status: "done" })} />);
    expect(container.textContent).toContain("도구 사용 결과");
    expect(container.textContent).not.toContain("r1");
    expect(container.textContent).not.toContain("r2");
  });

  it("multi-tool: shows '도구 사용 중' header when running", () => {
    const { container } = render(
      <ToolGroupCard group={makeMultiGroup({ status: "running", tools: [
        { toolUseId: "tu-1", name: "knowledge_search", input: {}, status: "running", displayOrder: 0 },
        { toolUseId: "tu-2", name: "read_file", input: {}, status: "running", displayOrder: 1 },
      ] })} />,
    );
    expect(container.textContent).toContain("도구 사용 중");
  });

  it("multi-tool: shows tool display names in header", () => {
    const { container } = render(<ToolGroupCard group={makeMultiGroup()} />);
    expect(container.textContent).toContain("문서 검색"); // knowledge_search mapped
  });

  it("multi-tool: expands tool list when clicked", () => {
    const { container } = render(<ToolGroupCard group={makeMultiGroup()} />);
    const headerBtn = container.querySelector("button") as HTMLButtonElement;
    fireEvent.click(headerBtn);
    expect(container.textContent).toContain("문서 검색");
    expect(container.textContent).not.toContain("r1");
  });

  it("multi-tool: expands an individual completed tool only after clicking its row", () => {
    const { container } = render(<ToolGroupCard group={makeMultiGroup()} />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.textContent).not.toContain("r1");

    const buttons = Array.from(container.querySelectorAll("button"));
    const firstToolButton = buttons.filter((button) => button.textContent?.includes("문서 검색")).at(-1) as HTMLButtonElement | undefined;
    expect(firstToolButton).toBeTruthy();
    fireEvent.click(firstToolButton!);
    expect(container.textContent).toContain("r1");
  });

  it("multi-tool error: shows 오류 있음 badge", () => {
    const group = makeMultiGroup({ status: "error", tools: [
      { toolUseId: "tu-1", name: "knowledge_search", input: {}, result: "err", status: "error", displayOrder: 0 },
      { toolUseId: "tu-2", name: "read_file", input: {}, result: "ok", status: "done", displayOrder: 1 },
    ] });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.textContent).toContain("오류 있음");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
