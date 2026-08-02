import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemorySearchPanel } from "../MemorySearchPanel.js";
import type { LvisApi } from "../../types.js";
import type { ProjectIdentity } from "../../../../shared/project-identity.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

type UserEventDriver = {
  click(target: HTMLElement): Promise<void>;
};

function setupUser(): UserEventDriver {
  return (userEvent as unknown as { setup: () => UserEventDriver }).setup();
}

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
    const user = setupUser();

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
    const user = setupUser();

    render(<MemorySearchPanel api={api} onOpenSession={onOpenSession} />);

    await user.click(await screen.findByRole("tab", { name: /채팅 목록/ }));
    fireEvent.click(await screen.findByRole("button", { name: /채팅 열기: 분기 후 확인 대화/ }));

    await waitFor(() => expect(screen.getByText("로드 실패")).toBeTruthy());
    expect(screen.getByText("캘린더 세션 목록에서 열어야 하는 대화입니다.")).toBeTruthy();
  });
  it("approves a project candidate with the active project scope and refreshes active memories", async () => {
    const api = memorySearchPanelApi();
    const user = setupUser();
    const project: ProjectIdentity = {
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    };
    const candidate = {
      id: "candidate-project-1",
      state: "candidate" as const,
      filename: "deployment-guidance.md",
      title: "배포 환경 주의사항",
      content: "# 배포 환경 주의사항\n\n알파 프로젝트는 스테이징 검증을 먼저 수행합니다.",
      createdAt: "2026-07-15T12:00:00.000Z",
      projectRoot: project.projectRoot,
      projectName: project.projectName,
      source: "assistant" as const,
    };
    let candidates = [candidate];
    Object.assign(api, {
      memoryListCandidates: vi.fn(async () => candidates),
      memoryActivateCandidate: vi.fn(async () => {
        candidates = [];
        return { ok: true, entry: { ...candidate, state: "active" as const } };
      }),
    });

    render(<MemorySearchPanel api={api} project={project} />);

    await user.click(await screen.findByRole("tab", { name: /검토 대기/ }));
    await waitFor(() => {
      expect(api.memoryListCandidates).toHaveBeenCalledWith({
        projectRoot: "C:\\workspace\\alpha",
        projectName: "alpha",
        includeUnscoped: false,
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: "기억 제안 승인: 배포 환경 주의사항" }));

    await waitFor(() => {
      expect(api.memoryActivateCandidate).toHaveBeenCalledWith("candidate-project-1", {
        projectRoot: "C:\\workspace\\alpha",
        projectName: "alpha",
        includeUnscoped: false,
      });
    });
    await waitFor(() => expect(api.memoryListEntries).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("검토할 기억 제안이 없습니다")).toBeTruthy());
  });

  it("discards a global candidate without sending a project option", async () => {
    const api = memorySearchPanelApi();
    const user = setupUser();
    const candidate = {
      id: "candidate-global-1",
      state: "candidate" as const,
      filename: "global-guidance.md",
      title: "전역 작업 방식",
      content: "# 전역 작업 방식\n\n작업 전에 변경 범위를 확인합니다.",
      createdAt: "2026-07-15T12:00:00.000Z",
      source: "assistant" as const,
    };
    let candidates = [candidate];
    Object.assign(api, {
      memoryListCandidates: vi.fn(async () => candidates),
      memoryDeleteCandidate: vi.fn(async () => {
        candidates = [];
        return { ok: true };
      }),
    });

    render(<MemorySearchPanel api={api} />);

    await user.click(await screen.findByRole("tab", { name: /검토 대기/ }));
    await waitFor(() => expect(api.memoryListCandidates).toHaveBeenCalledWith());

    fireEvent.click(await screen.findByRole("button", { name: "기억 제안 폐기: 전역 작업 방식" }));

    await waitFor(() => {
      expect(api.memoryDeleteCandidate).toHaveBeenCalledWith("candidate-global-1");
    });
    await waitFor(() => expect(screen.getByText("검토할 기억 제안이 없습니다")).toBeTruthy());
  });
});
