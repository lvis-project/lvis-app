/**
 * A deadline-bearing gate (approval request, ask_user_question) must reach the
 * user whatever is on screen. Two ways a session stops being drawn that the
 * tile did not know about:
 *
 *   - the route leaves the chat surface — Settings, a plugin view, the work
 *       board — and the whole surface goes display:none while the tile still
 *       believes it is drawn, keeps its approval claim and draws its cards
 *       into the void;
 *   - a question ADOPTED from a headless session (routine, side chat,
 *       orphaned sub-agent) is dropped when the idle tile that adopted it
 *       loads another conversation, while the host keeps waiting on it.
 *
 * Both were found by an audit that reproduced them; these are those probes
 * with the assertions turned the right way round. The cards belong to the
 * conversation that asked, so a routed pane draws its own conversation's
 * cards in the routed frame's settle slot — the same pane, over the view
 * that covers the conversation — and nothing of them appears anywhere else.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { approvalRequest, submitChatMessage, deferred } from "../../../../test/renderer/helpers.js";
import { MOCK_DEFAULT_SESSION_ID } from "../../../../test/renderer/mock-lvis-api.js";
import { MAIN_CHAT_GROUP_ID } from "../../../contract/app-contract.js";

const chatSurface = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-testid="chat-surface"]')!;
// The conversation's own column — where a card sits over the composer.
const conversation = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-testid="chat-main-column"]')!;
const routedPane = (c: HTMLElement, view: string) =>
  c.querySelector<HTMLElement>(`[data-testid="main-pane-shell"][data-view="${view}"]`)!;
const count = (root: ParentNode, id: string) => root.querySelectorAll(`[data-testid="${id}"]`).length;
const question = (id: string, sessionId: string) => ({
  id,
  sessionId,
  questions: [{ question: "어느 형식으로 정리할까요?", choices: ["표", "목록"] }],
  createdAt: Date.now(),
});

describe("gates reach the user when the route leaves the chat surface", () => {
  it("an approval card is drawn in the routed pane while Settings is open, and over the composer when home returns", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api, emitApproval, emitViewActivate } = await renderApp({ hasApiKey: true });
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
    await submitChatMessage(container, "turn in flight");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => { emitApproval(approvalRequest({ sessionId: MOCK_DEFAULT_SESSION_ID })); });
    await waitFor(() => expect(count(container, "approval-dock")).toBe(1));
    expect(count(conversation(container), "approval-dock")).toBe(1);

    await act(async () => { emitViewActivate("settings"); });
    await waitFor(() => expect(chatSurface(container).getAttribute("data-visible")).toBe("false"));

    // The pane still holds the conversation the request belongs to, so the
    // pane draws it: in the settle slot of the frame showing Settings.
    await waitFor(() => expect(count(routedPane(container, "settings"), "approval-dock")).toBe(1));
    expect(count(conversation(container), "approval-dock")).toBe(0);
    expect(count(container, "approval-dock")).toBe(1);
    // Nothing of the window's own draws it — there is no window band.
    expect(container.querySelector('[data-testid="window-approval-scope"]')).toBeNull();
    // A card the user can see gets no dot.
    expect(container.querySelector(`[data-testid="sidebar-pending-answer-${MOCK_DEFAULT_SESSION_ID}"]`)).toBeNull();

    await act(async () => { emitViewActivate("home"); });
    await waitFor(() => expect(chatSurface(container).getAttribute("data-visible")).toBe("true"));
    await waitFor(() => expect(count(conversation(container), "approval-dock")).toBe(1));
    expect(count(container, "approval-dock")).toBe(1);

    await act(async () => { pendingSend.resolve({ ok: true }); await pendingSend.promise; });
  });

  it("an ask_user_question card is drawn in the routed pane while a view covers the conversation", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api, emitAskUserQuestion, emitViewActivate } = await renderApp({ hasApiKey: true });
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
    await submitChatMessage(container, "turn in flight");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => { emitAskUserQuestion(question("ask-gate", MOCK_DEFAULT_SESSION_ID)); });
    await waitFor(() => expect(count(container, "question-overlay")).toBe(1));

    await act(async () => { emitViewActivate("settings"); });
    await waitFor(() => expect(chatSurface(container).getAttribute("data-visible")).toBe("false"));

    await waitFor(() => expect(count(routedPane(container, "settings"), "question-overlay")).toBe(1));
    expect(count(conversation(container), "question-overlay")).toBe(0);
    // Still ONE card: the tile owns the question and draws it once.
    expect(count(container, "question-overlay")).toBe(1);

    await act(async () => { pendingSend.resolve({ ok: true }); await pendingSend.promise; });
  });

  it("a question that ARRIVES while Settings is open reaches the routed pane, then the composer when home returns", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api, emitAskUserQuestion, emitViewActivate } = await renderApp({ hasApiKey: true });
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
    await submitChatMessage(container, "turn in flight");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => { emitViewActivate("settings"); });
    await waitFor(() => expect(chatSurface(container).getAttribute("data-visible")).toBe("false"));

    await act(async () => { emitAskUserQuestion(question("ask-late", MOCK_DEFAULT_SESSION_ID)); });
    await waitFor(() => expect(count(routedPane(container, "settings"), "question-overlay")).toBe(1));
    expect(count(container, "question-overlay")).toBe(1);

    await act(async () => { emitViewActivate("home"); });
    await waitFor(() => expect(count(conversation(container), "question-overlay")).toBe(1));
    expect(count(container, "question-overlay")).toBe(1);

    await act(async () => { pendingSend.resolve({ ok: true }); await pendingSend.promise; });
  });

  it("a headless session's question that ARRIVES while Settings is open is adopted by the focused tile and drawn in its routed pane", async () => {
    const { container, emitAskUserQuestion, emitViewActivate } = await renderApp({ hasApiKey: true });
    await act(async () => { emitViewActivate("settings"); });
    await waitFor(() => expect(chatSurface(container).getAttribute("data-visible")).toBe("false"));

    await act(async () => { emitAskUserQuestion(question("ask-headless-late", "routine-headless-session")); });
    await waitFor(() => expect(count(routedPane(container, "settings"), "question-overlay")).toBe(1));
    expect(count(container, "question-overlay")).toBe(1);

    await act(async () => { emitViewActivate("home"); });
    await waitFor(() => expect(count(conversation(container), "question-overlay")).toBe(1));
    expect(count(container, "question-overlay")).toBe(1);
  });
});

describe("an adopted question survives the adopting tile loading another session", () => {
  const OTHER = "sess-other";
  it("keeps drawing the headless session's question after a sidebar load", async () => {
    const { container, api, emitAskUserQuestion } = await renderApp({
      hasApiKey: true,
      sessions: [
        { id: MOCK_DEFAULT_SESSION_ID, title: "현재", modifiedAt: new Date(2, 0, 2).toISOString() },
        { id: OTHER, title: "다른 대화", modifiedAt: new Date(2, 0, 1).toISOString() },
      ],
    });
    await act(async () => { emitAskUserQuestion(question("ask-headless", "routine-headless-session")); });
    await waitFor(() => expect(count(container, "question-overlay")).toBe(1));
    const cell = container.querySelector(`[data-testid="pane-cell:${MAIN_CHAT_GROUP_ID}"]`)!;
    expect(count(cell, "question-overlay")).toBe(1);

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-collapse-toggle"]');
    if (toggle && toggle.getAttribute("aria-pressed") !== "true") await act(async () => { fireEvent.click(toggle); });
    const row = await waitFor(() => {
      const r = container.querySelector<HTMLButtonElement>(`[data-testid="sidebar-session-${OTHER}"]`);
      if (!r) throw new Error("row not rendered");
      return r;
    });
    await act(async () => { fireEvent.click(row); });
    await waitFor(() => expect(api.chatSessionResume).toHaveBeenCalledWith(OTHER));

    // The tile now shows another conversation; the question it adopted is
    // owned by its own session id and is still on screen, still answerable.
    await waitFor(() => expect(count(container, "question-overlay")).toBe(1));
    expect(count(cell, "question-overlay")).toBe(1);
    expect(api.respondAskUserQuestion).not.toHaveBeenCalled();
  });
});
