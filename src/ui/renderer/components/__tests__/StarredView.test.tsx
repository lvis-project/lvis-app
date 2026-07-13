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
  it("renders the current disambiguated project label and leaves general chats unlabelled", async () => {
    const now = new Date().toISOString();
    const api = {
      starredRemove: vi.fn(async () => ({ ok: true })),
    } as unknown as Parameters<typeof StarredView>[0]["api"];

    const { findByText, queryByText } = render(
      <StarredView
        api={api}
        starred={[]}
        sessions={[
          {
            id: "scoped",
            modifiedAt: now,
            title: "범위 지정 대화",
            sessionKind: "main",
            projectRoot: "c:/work/team-a/shared/",
            projectName: "shared",
          },
          {
            id: "general",
            modifiedAt: now,
            title: "일반 대화",
            sessionKind: "main",
            projectName: "stale-general",
          },
        ]}
        workspaceProjects={[
          { projectRoot: "C:\\workspace", projectName: "workspace", isDefault: true },
          { projectRoot: "C:\\work\\team-a\\shared", projectName: "shared — team-a" },
          { projectRoot: "C:\\work\\team-b\\shared", projectName: "shared — team-b" },
        ]}
        currentSessionId=""
        refreshStarred={vi.fn()}
        onJumpToSession={vi.fn()}
        onActivateHome={vi.fn()}
      />,
    );

    expect(await findByText("범위 지정 대화")).toBeTruthy();
    expect(await findByText("shared — team-a")).toBeTruthy();
    expect(await findByText("일반 대화")).toBeTruthy();
    expect(queryByText("shared")).toBeNull();
    expect(queryByText("stale-general")).toBeNull();
  });

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

    const { findAllByText, findByText } = render(
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
    expect(await findAllByText("대화")).not.toHaveLength(0);
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

  it("labels the heatmap and links audit usage to its conversation without recent session metadata", async () => {
    const now = new Date().toISOString();
    const selectedKey = koreaDateKey(new Date(now));
    const api = {
      starredRemove: vi.fn(async () => ({ ok: true })),
      getUsageRange: vi.fn(async (range: { dateFrom: string; dateTo: string }) => ({
        today: {
          inputTokens: 900,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1_000,
          cost: 0.01,
        },
        trend: [{
          date: selectedKey,
          inputTokens: 900,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1_000,
          cost: 0.01,
        }],
        topConversations: range.dateFrom === range.dateTo
          ? [{
              sessionId: "audit-only-session",
              turns: 2,
              firstInput: "감사 로그에서 찾은 대화",
              inputTokens: 900,
              outputTokens: 100,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 1_000,
              cost: 0.01,
            }]
          : [],
      })),
      getUsageDailySummary: vi.fn(async () => ({ ok: false, error: "unavailable" })),
    } as unknown as Parameters<typeof StarredView>[0]["api"];
    const onJumpToSession = vi.fn(async () => true);

    const { findByText, getByTestId } = render(
      <StarredView
        api={api}
        starred={[]}
        sessions={[]}
        currentSessionId=""
        refreshStarred={vi.fn()}
        onJumpToSession={onJumpToSession}
        onActivateHome={vi.fn()}
      />,
    );

    const row = await findByText("감사 로그에서 찾은 대화");
    expect(getByTestId("heatmap-weekday-labels").textContent).toContain("일");
    expect(getByTestId("heatmap-weekday-labels").textContent).toContain("토");
    expect(getByTestId("heatmap-month-labels").children).toHaveLength(12);
    expect(row.closest("button")?.textContent).toContain("1,000");
    fireEvent.click(row);
    await waitFor(() => expect(onJumpToSession).toHaveBeenCalledWith("audit-only-session"));
  });

  it("keeps scrollable insights sections in normal flow with stable list height", () => {
    const api = {
      starredRemove: vi.fn(async () => ({ ok: true })),
    } as unknown as Parameters<typeof StarredView>[0]["api"];
    const { getByTestId } = render(
      <StarredView
        api={api}
        starred={[]}
        sessions={[]}
        currentSessionId=""
        refreshStarred={vi.fn()}
        onJumpToSession={vi.fn()}
        onActivateHome={vi.fn()}
      />,
    );

    expect(getByTestId("insights-scroll-root").className).toContain("overflow-y-auto");
    expect(getByTestId("insights-overview-grid").className).toContain("shrink-0");
    expect(getByTestId("insights-heatmap").className).toContain("shrink-0");
    expect(getByTestId("insights-lists-grid").className).toContain("lg:min-h-[22rem]");
    expect(getByTestId("insights-conversations-panel").className).toContain("h-[22rem]");
  });

  it("disables calendar dates that have no activity signal", async () => {
    const now = new Date();
    const inactive = new Date(now);
    inactive.setDate(inactive.getDate() - 1);
    const activeKey = koreaDateKey(now);
    const inactiveKey = koreaDateKey(inactive);
    const api = {
      starredRemove: vi.fn(async () => ({ ok: true })),
    } as unknown as Parameters<typeof StarredView>[0]["api"];
    const { container } = render(
      <StarredView
        api={api}
        starred={[{
          id: "active-day-star",
          sessionId: "active-day-session",
          messageIndex: 0,
          role: "assistant",
          text: "activity",
          starredAt: now.toISOString(),
        }]}
        sessions={[]}
        currentSessionId="active-day-session"
        refreshStarred={vi.fn()}
        onJumpToSession={vi.fn()}
        onActivateHome={vi.fn()}
      />,
    );

    const dayButton = (dateKey: string) => container.querySelector<HTMLButtonElement>(
      `button[data-day="${dateKey}"], [data-day="${dateKey}"] button`,
    );
    await waitFor(() => {
      expect(dayButton(activeKey)).toBeTruthy();
    }, { timeout: 5_000 });
    const activeButton = dayButton(activeKey);
    const inactiveButton = dayButton(inactiveKey);
    const activeCell = activeButton?.closest("[data-day]");
    const inactiveCell = inactiveButton?.closest("[data-day]");
    expect(activeButton?.disabled).toBe(false);
    expect(inactiveButton?.disabled).toBe(true);
    expect(activeCell?.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(inactiveButton!);

    expect(activeCell?.getAttribute("aria-selected")).toBe("true");
    expect(inactiveCell?.getAttribute("aria-selected")).not.toBe("true");
    expect(container.querySelector<HTMLButtonElement>(`button[aria-label^="${inactiveKey}:"]`)?.disabled).toBe(true);
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
