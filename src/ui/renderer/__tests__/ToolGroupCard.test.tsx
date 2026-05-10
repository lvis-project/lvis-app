/**
 * ToolGroupCard unit tests.
 *
 * ToolGroupCard is a pure-props component that renders tool execution groups.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { ToolGroupCard } from "../components/ToolGroupCard.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";

vi.mock("../../../components/ui/scroll-area.js", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

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
    expect(container.textContent).toContain("파일 읽기");
    expect(container.textContent).not.toContain("file content");
  });

  it("single tool running: shows spinner inline", () => {
    const { container } = render(
      <ToolGroupCard group={makeGroup({ status: "running", tools: [{ toolUseId: "tu-1", name: "read_file", input: {}, status: "running", displayOrder: 0 }] })} />,
    );
    expect(container.textContent).not.toContain("도구 사용 중");
    expect(container.textContent).toContain("파일 읽기");
  });

  it("single tool running: keeps input collapsed by default", () => {
    const { container } = render(
      <ToolGroupCard group={makeGroup({ status: "running", tools: [{ toolUseId: "tu-1", name: "read_file", input: { path: "/tmp/live.txt" }, status: "running", displayOrder: 0 }] })} />,
    );

    expect(container.textContent).toContain("파일 읽기");
    expect(container.textContent).not.toContain("/tmp/live.txt");

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.textContent).toContain("/tmp/live.txt");
  });

  it("single tool running then done: does not leave result expanded", () => {
    const running = makeGroup({
      status: "running",
      tools: [{ toolUseId: "tu-1", name: "read_file", input: { path: "/tmp/live.txt" }, status: "running", displayOrder: 0 }],
    });
    const done = makeGroup({
      status: "done",
      tools: [{ toolUseId: "tu-1", name: "read_file", input: { path: "/tmp/live.txt" }, result: "live result", status: "done", displayOrder: 0 }],
    });
    const { container, rerender } = render(<ToolGroupCard group={running} />);

    rerender(<ToolGroupCard group={done} />);

    expect(container.textContent).toContain("파일 읽기");
    expect(container.textContent).not.toContain("live result");
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

  it("multi-tool running: does not auto-expand the first running tool", () => {
    const { container } = render(
      <ToolGroupCard group={makeMultiGroup({ status: "running", tools: [
        { toolUseId: "tu-1", name: "knowledge_search", input: { query: "hidden live input" }, status: "running", displayOrder: 0 },
        { toolUseId: "tu-2", name: "read_file", input: {}, status: "running", displayOrder: 1 },
      ] })} />,
    );

    expect(container.textContent).toContain("도구 사용 중");
    expect(container.textContent).not.toContain("hidden live input");

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.textContent).toContain("knowledge search");
    expect(container.textContent).not.toContain("hidden live input");
  });

  it("multi-tool: shows tool display names in header", () => {
    const { container } = render(<ToolGroupCard group={makeMultiGroup()} />);
    expect(container.textContent).toContain("knowledge search");
  });

  it("multi-tool: expands tool list when clicked", () => {
    const { container } = render(<ToolGroupCard group={makeMultiGroup()} />);
    const headerBtn = container.querySelector("button") as HTMLButtonElement;
    fireEvent.click(headerBtn);
    expect(container.textContent).toContain("knowledge search");
    expect(container.textContent).not.toContain("r1");
  });

  it("multi-tool: expands an individual completed tool only after clicking its row", () => {
    const { container } = render(<ToolGroupCard group={makeMultiGroup()} />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.textContent).not.toContain("r1");

    const buttons = Array.from(container.querySelectorAll("button"));
    const firstToolButton = buttons.filter((button) => button.textContent?.includes("knowledge search")).at(-1) as HTMLButtonElement | undefined;
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

  it("single tool done: renders ⏱ duration badge with one decimal second precision", () => {
    const group = makeGroup({
      status: "done",
      tools: [
        {
          toolUseId: "tu-1",
          name: "read_file",
          input: { path: "/tmp/test.txt" },
          result: "file content",
          status: "done",
          displayOrder: 0,
          durationMs: 1400,
        },
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    const badge = container.querySelector('[data-testid="tool-duration"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("⏱ 1.4s");
  });

  it("single tool done: shows '<0.1s' for sub-100ms calls", () => {
    const group = makeGroup({
      status: "done",
      tools: [
        {
          toolUseId: "tu-1",
          name: "read_file",
          input: {},
          result: "ok",
          status: "done",
          displayOrder: 0,
          durationMs: 50,
        },
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.querySelector('[data-testid="tool-duration"]')?.textContent).toContain("<0.1s");
  });

  it("single tool done: shows minute formatting for >60s calls", () => {
    const group = makeGroup({
      status: "done",
      tools: [
        {
          toolUseId: "tu-1",
          name: "read_file",
          input: {},
          result: "ok",
          status: "done",
          displayOrder: 0,
          durationMs: 72_400,
        },
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.querySelector('[data-testid="tool-duration"]')?.textContent).toContain("⏱ 1m 12.4s");
  });

  it("single tool running: hides ⏱ duration badge while pending", () => {
    const group = makeGroup({
      status: "running",
      tools: [
        {
          toolUseId: "tu-1",
          name: "read_file",
          input: {},
          status: "running",
          displayOrder: 0,
        },
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.querySelector('[data-testid="tool-duration"]')).toBeNull();
  });

  it("multi-tool done: renders ⏱ duration badge for each completed tool row", () => {
    const group = makeMultiGroup({
      status: "done",
      tools: [
        { toolUseId: "tu-1", name: "knowledge_search", input: {}, result: "r1", status: "done", displayOrder: 0, durationMs: 300 },
        { toolUseId: "tu-2", name: "read_file", input: {}, result: "r2", status: "done", displayOrder: 1, durationMs: 1400 },
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    const badges = container.querySelectorAll('[data-testid="tool-duration"]');
    expect(badges.length).toBe(2);
    expect(badges[0]?.textContent).toContain("⏱ 0.3s");
    expect(badges[1]?.textContent).toContain("⏱ 1.4s");
  });

  // ─── PR-4: CompactedToolResult rendering paths (Major #4) ───────────────
  it("PR-4: single tool with stub result + sessionId → renders CompactedToolResult (펼치기 visible)", () => {
    const stubResult = "[tool_result stripped: tool=Read, origLen=5000]";
    vi.stubGlobal("lvisApi", {
      chatGetVerbatimToolResult: vi.fn(() => new Promise(() => {})), // never resolves — just test render
    });
    const group = makeGroup({
      tools: [
        {
          toolUseId: "tu-stub",
          name: "read_file",
          input: { path: "/tmp/big.txt" },
          result: stubResult,
          status: "done",
          displayOrder: 0,
        },
      ],
    });
    const { container } = render(<ToolGroupCard group={group} sessionId="session-1" />);
    // CompactedToolResult renders [펼치기] in collapsed state
    expect(container.textContent).toContain("[펼치기]");
    // Must NOT show raw stub text as-is in a ToolPayloadBlock
    expect(container.textContent).not.toContain("[tool_result stripped:");
  });

  it("PR-4: single tool with stub result but NO sessionId → renders ToolPayloadBlock (raw stub shown)", () => {
    const stubResult = "[tool_result stripped: tool=Read, origLen=5000]";
    const group = makeGroup({
      tools: [
        {
          toolUseId: "tu-stub",
          name: "read_file",
          input: { path: "/tmp/big.txt" },
          result: stubResult,
          status: "done",
          displayOrder: 0,
        },
      ],
    });
    // no sessionId prop → falls back to ToolPayloadBlock
    const { container } = render(<ToolGroupCard group={group} />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.textContent).toContain("[tool_result stripped:");
    expect(container.textContent).not.toContain("[펼치기]");
  });

  it("PR-4: single tool with non-stub result + sessionId → renders ToolPayloadBlock (not CompactedToolResult)", () => {
    const group = makeGroup({
      tools: [
        {
          toolUseId: "tu-normal",
          name: "read_file",
          input: { path: "/tmp/small.txt" },
          result: "normal file content",
          status: "done",
          displayOrder: 0,
        },
      ],
    });
    const { container } = render(<ToolGroupCard group={group} sessionId="session-1" />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.textContent).toContain("normal file content");
    expect(container.textContent).not.toContain("[펼치기]");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
