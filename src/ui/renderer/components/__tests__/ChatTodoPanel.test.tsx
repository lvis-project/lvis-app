// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { ChatTodoPanel } from "../ChatTodoPanel.js";
import type { LvisApi, Task } from "../../types.js";

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: `task-${Math.random()}`,
  title: "테스트 태스크",
  source: "email",
  priority: "medium",
  status: "pending",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

const mockApi = {} as unknown as LvisApi;

describe("ChatTodoPanel", () => {
  it("renders pending tasks", async () => {
    const tasks = [
      makeTask({ id: "t1", title: "첫 번째 태스크" }),
      makeTask({ id: "t2", title: "두 번째 태스크" }),
    ];

    const { getAllByTestId } = render(
      <ChatTodoPanel api={mockApi} tasks={tasks} loading={false} />,
    );

    await waitFor(() => {
      const items = getAllByTestId("chat-todo-item");
      expect(items).toHaveLength(2);
    });
  });

  it("shows empty state when no tasks", async () => {
    const { getByTestId } = render(
      <ChatTodoPanel api={mockApi} tasks={[]} loading={false} />,
    );

    await waitFor(() => {
      const empty = getByTestId("chat-todo-empty");
      expect(empty).toHaveTextContent("진행중인 TODO 가 없습니다.");
    });
  });

  it("shows loading state while tasks are empty and loading", async () => {
    const { getByText } = render(
      <ChatTodoPanel api={mockApi} tasks={[]} loading={true} />,
    );

    expect(getByText("로딩 중...")).toBeTruthy();
  });

  it("shows overflow link when more than 8 tasks", async () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      makeTask({ id: `t${i}`, title: `태스크 ${i}` }),
    );

    const { getByTestId, getAllByTestId } = render(
      <ChatTodoPanel api={mockApi} tasks={tasks} loading={false} />,
    );

    await waitFor(() => {
      const items = getAllByTestId("chat-todo-item");
      expect(items).toHaveLength(8);
      const overflow = getByTestId("chat-todo-overflow-link");
      expect(overflow).toHaveTextContent("+2개 더 보기");
    });
  });

  it("calls onNavigateToTasks when overflow link is clicked", async () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      makeTask({ id: `t${i}`, title: `태스크 ${i}` }),
    );
    const onNavigateToTasks = vi.fn();

    const { getByTestId } = render(
      <ChatTodoPanel
        api={mockApi}
        tasks={tasks}
        loading={false}
        onNavigateToTasks={onNavigateToTasks}
      />,
    );

    await waitFor(() => {
      const overflow = getByTestId("chat-todo-overflow-link");
      overflow.click();
      expect(onNavigateToTasks).toHaveBeenCalledTimes(1);
    });
  });
});
