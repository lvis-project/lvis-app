import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemorySearchPanel } from "../MemorySearchPanel.js";
import type { LvisApi } from "../../types.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

function memorySearchPanelApi(): LvisApi {
  const { api } = makeMockLvisApi();
  Object.assign(api, {
    memoryGetIndex: vi.fn(async () => ""),
    memoryListEntries: vi.fn(async () => []),
    memoryListSessions: vi.fn(async () => [
      {
        sessionId: "11111111-2222-3333-4444-555555555555",
        title: "분기 후 확인 대화",
        matchedMessage: "캘린더 세션 목록에서 열어야 하는 대화입니다.",
        timestamp: "2026-05-20T08:00:00.000Z",
      },
    ]),
    memorySearchEntries: vi.fn(async () => []),
    memorySearchSessions: vi.fn(async () => []),
  });
  return api as unknown as LvisApi;
}

describe("MemorySearchPanel", () => {
  it("opens a selected chat session from the memory session list", async () => {
    const api = memorySearchPanelApi();
    const onOpenSession = vi.fn(async () => true);
    const user = userEvent.setup();

    render(<MemorySearchPanel api={api} onOpenSession={onOpenSession} />);

    await user.click(await screen.findByRole("tab", { name: /채팅 목록/ }));
    const row = await screen.findByRole("button", { name: /채팅 열기: 분기 후 확인 대화/ });
    fireEvent.click(row);

    await waitFor(() => {
      expect(onOpenSession).toHaveBeenCalledWith("11111111-2222-3333-4444-555555555555");
    });
  });

  it("keeps the row inspectable when session loading fails", async () => {
    const api = memorySearchPanelApi();
    const onOpenSession = vi.fn(async () => false);
    const user = userEvent.setup();

    render(<MemorySearchPanel api={api} onOpenSession={onOpenSession} />);

    await user.click(await screen.findByRole("tab", { name: /채팅 목록/ }));
    fireEvent.click(await screen.findByRole("button", { name: /채팅 열기: 분기 후 확인 대화/ }));

    await waitFor(() => expect(screen.getByText("로드 실패")).toBeTruthy());
    expect(screen.getByText("캘린더 세션 목록에서 열어야 하는 대화입니다.")).toBeTruthy();
  });
});
