/**
 * Renderer smoke tests for the 5 workflow tool UI components.
 * Mounts each component with a mocked `LvisApi` and verifies the basic
 * render contract + at least one interaction.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { AskUserQuestionCard } from "../components/AskUserQuestionCard.js";
import { RemindersList } from "../components/RemindersList.js";
import { SessionTodoPanel } from "../components/SessionTodoPanel.js";
import { SubAgentCard } from "../components/SubAgentCard.js";
import { SkillBadge } from "../components/SkillBadge.js";
import type { LvisApi } from "../types.js";

function fakeApi(overrides: Partial<LvisApi> = {}): LvisApi {
  const stub = (..._args: unknown[]) => Promise.resolve({ ok: true });
  const noopUnsub = () => () => undefined;
  return {
    // Only methods used by the components under test need real impls;
    // the rest are stubbed minimally to satisfy the type.
    listReminders: () => Promise.resolve([]),
    dismissReminder: stub as never,
    removeReminder: stub as never,
    onReminderFired: noopUnsub as never,
    listSessionTodos: () => Promise.resolve([]),
    onSessionTodoChanged: noopUnsub as never,
    respondAskUserQuestion: stub as never,
    onAskUserQuestion: noopUnsub as never,
    onAgentSpawnEvent: noopUnsub as never,
    onSkillLoaded: noopUnsub as never,
    ...overrides,
  } as unknown as LvisApi;
}

describe("AskUserQuestionCard", () => {
  it("renders question + choices and dispatches respond on click", async () => {
    const respond = vi.fn().mockResolvedValue({ ok: true });
    const api = fakeApi({ respondAskUserQuestion: respond as never });
    const onResolved = vi.fn();
    const { getByText, container } = render(
      <AskUserQuestionCard
        api={api}
        request={{
          id: "q1",
          question: "Continue?",
          choices: ["yes", "no"],
          allowFreeText: true,
          urgent: false,
          createdAt: 0,
        }}
        onResolved={onResolved}
      />,
    );
    expect(container.textContent).toContain("Continue?");
    expect(getByText("yes")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(getByText("yes"));
    });
    expect(respond).toHaveBeenCalledWith({ requestId: "q1", choice: "yes" });
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith("q1"));
  });
});

describe("RemindersList", () => {
  it("renders empty-state when there are no reminders", async () => {
    const api = fakeApi();
    const { findByText } = render(<RemindersList api={api} />);
    expect(await findByText(/등록된 리마인더가 없습니다/)).toBeInTheDocument();
  });

  it("renders an active reminder card", async () => {
    const api = fakeApi({
      listReminders: () =>
        Promise.resolve([
          {
            id: "r1",
            at: "2099-01-01T00:00:00.000Z",
            title: "year-end",
            repeat: "daily",
            createdAt: "2024-01-01T00:00:00.000Z",
          },
        ]),
    });
    const { findByText } = render(<RemindersList api={api} />);
    expect(await findByText("year-end")).toBeInTheDocument();
  });
});

describe("SessionTodoPanel", () => {
  it("hides when no items", async () => {
    const api = fakeApi();
    const { container } = render(<SessionTodoPanel api={api} />);
    // Async initial fetch resolves to []; panel should not render.
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="session-todo-panel"]')).toBeNull();
  });

  it("renders items when present", async () => {
    const api = fakeApi({
      listSessionTodos: () =>
        Promise.resolve([
          { id: "t1", content: "step 1", status: "pending" },
          { id: "t2", content: "step 2", status: "completed" },
        ]),
    });
    const { findByText } = render(<SessionTodoPanel api={api} />);
    expect(await findByText("step 1")).toBeInTheDocument();
    expect(await findByText("step 2")).toBeInTheDocument();
  });

  it("pulses the in-progress row in the expanded view so it's the focal point", async () => {
    const api = fakeApi({
      listSessionTodos: () =>
        Promise.resolve([
          { id: "t1", content: "done thing", status: "completed" },
          { id: "t2", content: "current thing", status: "in_progress" },
          { id: "t3", content: "next thing", status: "pending" },
        ]),
    });
    const { findByTestId, queryAllByTestId } = render(<SessionTodoPanel api={api} />);
    const active = await findByTestId("session-todo-active-row");
    expect(active.className).toContain("animate-pulse");
    // Only the in-progress row gets the active testid — pending/completed
    // must not.
    expect(queryAllByTestId("session-todo-active-row")).toHaveLength(1);
  });

  it("shows the active item next to the count when collapsed, with pulse", async () => {
    const api = fakeApi({
      listSessionTodos: () =>
        Promise.resolve([
          { id: "t1", content: "done thing", status: "completed" },
          { id: "t2", content: "current thing", status: "in_progress" },
          { id: "t3", content: "next thing", status: "pending" },
        ]),
    });
    const { findByText, container } = render(<SessionTodoPanel api={api} />);
    // Wait for items to load + panel to render.
    await findByText("current thing");
    // Collapse the panel.
    const header = container.querySelector('[data-testid="session-todo-panel"] button');
    if (!header) throw new Error("panel header not found");
    await act(async () => {
      header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const collapsed = container.querySelector('[data-testid="session-todo-collapsed-active"]');
    expect(collapsed).not.toBeNull();
    expect(collapsed!.textContent).toBe("current thing");
    expect(collapsed!.className).toContain("animate-pulse");
  });
});

describe("SubAgentCard", () => {
  it("renders title + status badge", () => {
    const { container } = render(
      <SubAgentCard
        spawn={{
          spawnId: "s1",
          title: "search task",
          status: "done",
          turns: [{ turn: 1, text: "hello", toolCallCount: 0 }],
          summary: "all done",
          toolCallCount: 0,
        }}
      />,
    );
    expect(container.textContent).toContain("search task");
    expect(container.textContent).toContain("완료");
  });

  it("renders error state", async () => {
    const { container, getByText } = render(
      <SubAgentCard
        spawn={{
          spawnId: "s2",
          title: "broken",
          status: "error",
          turns: [],
          toolCallCount: 0,
          errorMessage: "kapow",
        }}
      />,
    );
    expect(container.textContent).toContain("오류");
    // Default-collapsed for non-running spawns; open it to inspect details.
    fireEvent.click(getByText("broken"));
    expect(container.textContent).toContain("kapow");
  });
});

describe("SkillBadge", () => {
  it("renders the skill name", () => {
    const { container } = render(
      <TooltipProvider>
        <SkillBadge name="report-writing" description="reports" source="builtin" />
      </TooltipProvider>,
    );
    expect(container.textContent).toContain("Skill loaded: report-writing");
    expect(container.textContent).toContain("builtin");
  });
});
