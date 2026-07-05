// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { StarredView } from "../StarredView.js";

const KOREA_DATE_KEY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function koreaDateKey(date: Date): string {
  const parts = KOREA_DATE_KEY_FORMATTER.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

describe("StarredView", () => {
  it("renders an LLM-generated daily summary when the usage summary API is available", async () => {
    const now = new Date().toISOString();
    const selectedKey = koreaDateKey(new Date(now));
    const api = {
      starredRemove: vi.fn(async () => ({ ok: true })),
      getUsageRange: vi.fn(async () => ({
        today: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
        trend: [{ date: selectedKey, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120, cost: 0.001 }],
      })),
      getUsageDailySummary: vi.fn(async () => ({ ok: true, summary: "오늘은 프로젝트 흐름을 정리했습니다.", generatedAt: now })),
    } as unknown as Parameters<typeof StarredView>[0]["api"];

    const { findByText } = render(
      <StarredView
        api={api}
        starred={[{
          id: "s-ai",
          sessionId: "sess-ai",
          messageIndex: 0,
          role: "assistant",
          text: "핵심 결정",
          starredAt: now,
        }]}
        sessions={[{
          id: "sess-ai",
          modifiedAt: now,
          title: "프로젝트 인사이트",
          sessionKind: "main",
          projectName: "workspace",
        }]}
        currentSessionId="sess-ai"
        refreshStarred={vi.fn()}
        onJumpToSession={vi.fn()}
        onActivateHome={vi.fn()}
      />,
    );

    expect(await findByText("오늘은 프로젝트 흐름을 정리했습니다.")).toBeTruthy();
    expect(await findByText("토큰 히트맵")).toBeTruthy();
    expect(await findByText("프로젝트별 대화")).toBeTruthy();
    expect(await findByText("workspace")).toBeTruthy();
    await waitFor(() => {
      expect(document.body.querySelector(`[aria-label="${selectedKey}: 토큰 120개"]`)).toBeTruthy();
    });
    await waitFor(() => {
      expect((api as { getUsageDailySummary: ReturnType<typeof vi.fn> }).getUsageDailySummary).toHaveBeenCalledWith(
        expect.objectContaining({
          sessions: [expect.objectContaining({ title: "프로젝트 인사이트", projectName: "workspace" })],
          starred: [expect.objectContaining({ text: "핵심 결정" })],
          usage: expect.objectContaining({ totalTokens: 120 }),
        }),
      );
    });
  });

  it("removes a starred item and refreshes the list", async () => {
    const api = {
      starredRemove: vi.fn(async () => ({ ok: true })),
    } as unknown as Parameters<typeof StarredView>[0]["api"];
    const refreshStarred = vi.fn(async () => {});

    const { getByTitle } = render(
      <StarredView
        api={api}
        starred={[{
          id: "s-42",
          sessionId: "sess-star",
          messageIndex: 0,
          role: "assistant",
          text: "remembered answer",
          starredAt: new Date().toISOString(),
        }]}
        currentSessionId="sess-star"
        refreshStarred={refreshStarred}
        onJumpToSession={vi.fn()}
        onActivateHome={vi.fn()}
      />,
    );

    fireEvent.click(getByTitle("고정 해제"));

    await waitFor(() => expect((api as { starredRemove: ReturnType<typeof vi.fn> }).starredRemove).toHaveBeenCalledWith({ id: "s-42" }));
    await waitFor(() => expect(refreshStarred).toHaveBeenCalled());
  });

  it("jumps to another session before activating home", async () => {
    const api = {
      starredRemove: vi.fn(async () => ({ ok: true })),
    } as unknown as Parameters<typeof StarredView>[0]["api"];
    const onJumpToSession = vi.fn(async () => true);
    const onActivateHome = vi.fn();

    const { getByText } = render(
      <StarredView
        api={api}
        starred={[{
          id: "s-43",
          sessionId: "sess-other",
          messageIndex: 0,
          role: "assistant",
          text: "open another session",
          starredAt: new Date().toISOString(),
        }]}
        currentSessionId="sess-current"
        refreshStarred={vi.fn()}
        onJumpToSession={onJumpToSession}
        onActivateHome={onActivateHome}
      />,
    );

    fireEvent.click(getByText("open another session"));

    await waitFor(() => expect(onJumpToSession).toHaveBeenCalledWith("sess-other"));
    expect(onActivateHome).toHaveBeenCalledOnce();
  });

  it("does not activate home when cross-window jump fails", async () => {
    const api = {
      starredRemove: vi.fn(async () => ({ ok: true })),
    } as unknown as Parameters<typeof StarredView>[0]["api"];
    const onActivateHome = vi.fn();

    const { getByText } = render(
      <StarredView
        api={api}
        starred={[{
          id: "s-44",
          sessionId: "sess-other",
          messageIndex: 0,
          role: "assistant",
          text: "failed jump target",
          starredAt: new Date().toISOString(),
        }]}
        currentSessionId="sess-current"
        refreshStarred={vi.fn()}
        onJumpToSession={vi.fn(async () => false)}
        onActivateHome={onActivateHome}
      />,
    );

    fireEvent.click(getByText("failed jump target"));

    await waitFor(() => expect(onActivateHome).not.toHaveBeenCalled());
  });
});
