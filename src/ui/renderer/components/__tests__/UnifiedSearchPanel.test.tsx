import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UnifiedSearchPanel, type UnifiedSearchPanelProps } from "../UnifiedSearchPanel.js";
import { makeMockLvisApi, type MockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import type { LvisApi } from "../../types.js";

function asApi(mock: MockLvisApi): LvisApi {
  return mock as unknown as LvisApi;
}

function defaultProps(overrides: Partial<UnifiedSearchPanelProps> = {}): UnifiedSearchPanelProps {
  const { api } = makeMockLvisApi({
    sessions: [{ id: "sess-1", title: "검색 세션", modifiedAt: "2026-05-11T00:00:00.000Z" }],
    starred: [{ id: "star-1", sessionId: "sess-1", messageIndex: 2, role: "assistant", text: "중요 즐겨찾기", starredAt: "2026-05-11T00:00:00.000Z" }],
  });
  (api.listRoutinesV2 as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: "routine-1",
      trigger: "schedule",
      execution: "llm-session",
      title: "뉴스 검색 루틴",
      prePrompt: "아침 뉴스 검색",
      createdAt: "2026-05-11T00:00:00.000Z",
    },
  ]);
  (api.memoryListEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
    { filename: "memory.md", title: "검색 메모리", content: "메모리 본문", updatedAt: "2026-05-11T00:00:00.000Z" },
  ]);
  (api.memoryListSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
    { sessionId: "sess-2", matchedMessage: "대화 본문 검색", timestamp: "2026-05-11T00:00:00.000Z" },
  ]);
  (api.memorySearchEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
    { title: "검색 메모리", excerpt: "메모리 본문", updatedAt: "2026-05-11T00:00:00.000Z" },
  ]);
  (api.memorySearchSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
    { sessionId: "sess-2", matchedMessage: "대화 본문 검색", timestamp: "2026-05-11T00:00:00.000Z" },
  ]);
  return {
    api: asApi(api),
    open: true,
    query: "검색",
    caseSensitive: false,
    entries: [
      { kind: "user", text: "검색 질문" },
      { kind: "assistant", text: "검색 답변" },
    ],
    conversationMatches: [0, 1],
    currentConversationMatch: 0,
    sessions: [{ id: "sess-1", title: "검색 세션", modifiedAt: "2026-05-11T00:00:00.000Z" }],
    starred: [{ id: "star-1", sessionId: "sess-1", messageIndex: 2, role: "assistant", text: "중요 즐겨찾기 검색", starredAt: "2026-05-11T00:00:00.000Z" }],
    onChangeQuery: vi.fn(),
    onToggleCase: vi.fn(),
    onNextConversationMatch: vi.fn(),
    onPrevConversationMatch: vi.fn(),
    onJumpToConversationMatch: vi.fn(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onLoadSession: vi.fn(),
    onOpenMemoryView: vi.fn(),
    onOpenRoutinesView: vi.fn(),
    ...overrides,
  };
}

describe("UnifiedSearchPanel", () => {
  it("combines conversation, session, starred, routine, and memory results", async () => {
    render(<UnifiedSearchPanel {...defaultProps()} />);

    const panel = screen.getByTestId("unified-search-panel");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("false");
    expect(panel.className).toContain("absolute");
    expect(panel.className).toContain("left-1/2");
    expect(screen.getByTestId("unified-search-input")).toBeTruthy();
    expect(screen.getByText("현재 대화")).toBeTruthy();
    expect(screen.getByText("대화 기록")).toBeTruthy();
    expect(screen.getByText("핀")).toBeTruthy();
    expect(screen.queryByLabelText("날짜 선택")).toBeNull();

    await waitFor(() => {
      expect(screen.getByText("루틴")).toBeTruthy();
      expect(screen.getByText("메모리")).toBeTruthy();
      expect(screen.getAllByText(/뉴스/).length).toBeGreaterThan(0);
      expect(screen.getByText("검색 메모리")).toBeTruthy();
    });
  });

  it("keeps Cmd/Ctrl+F conversation navigation wired through the same panel", () => {
    const onNextConversationMatch = vi.fn();
    const onPrevConversationMatch = vi.fn();
    render(<UnifiedSearchPanel {...defaultProps({ onNextConversationMatch, onPrevConversationMatch })} />);

    const input = screen.getByTestId("unified-search-input");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNextConversationMatch).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onPrevConversationMatch).toHaveBeenCalledTimes(1);
  });

  it("loads a selected session result and closes the panel", async () => {
    const onLoadSession = vi.fn();
    const onClose = vi.fn();
    render(<UnifiedSearchPanel {...defaultProps({ onLoadSession, onClose })} />);

    await waitFor(() => expect(screen.getByText("세션 제목")).toBeTruthy());
    const sessionButton = screen.getByText("세션 제목").closest("button");
    expect(sessionButton).toBeTruthy();
    fireEvent.click(sessionButton!);

    expect(onLoadSession).toHaveBeenCalledWith("sess-1");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("keeps the panel open when loading a selected session fails", async () => {
    const onLoadSession = vi.fn(async () => false);
    const onClose = vi.fn();
    render(<UnifiedSearchPanel {...defaultProps({ onLoadSession, onClose })} />);

    await waitFor(() => expect(screen.getByText("세션 제목")).toBeTruthy());
    const sessionButton = screen.getByText("세션 제목").closest("button");
    expect(sessionButton).toBeTruthy();
    fireEvent.click(sessionButton!);

    await waitFor(() => expect(onLoadSession).toHaveBeenCalledWith("sess-1"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
