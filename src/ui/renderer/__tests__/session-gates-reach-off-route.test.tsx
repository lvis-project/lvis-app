/**
 * A deadline-bearing gate (approval request, ask_user_question) must reach the
 * user whatever is on screen. Two ways a session stops being drawn that the
 * tile did not know about:
 *
 *   (c) the route leaves the chat surface — Settings, a plugin view, the work
 *       board — and the whole surface goes display:none while the tile still
 *       believes it is drawn, keeps its approval claim and draws its cards
 *       into the void;
 *   (b') a question ADOPTED from a headless session (routine, side chat,
 *       orphaned sub-agent) is dropped when the idle tile that adopted it
 *       loads another conversation, while the host keeps waiting on it.
 *
 * Both were found by an audit that reproduced them; these are those probes
 * with the assertions turned the right way round.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { submitChatMessage, deferred } from "../../../../test/renderer/helpers.js";
import { MOCK_DEFAULT_SESSION_ID } from "../../../../test/renderer/mock-lvis-api.js";
import { MAIN_CHAT_GROUP_ID } from "../../../contract/app-contract.js";

const approval = (overrides: Record<string, unknown>) => ({
  id: "req-gate",
  category: "tool",
  toolName: "read_file",
  toolCategory: "read",
  args: { path: "/tmp/notes.md" },
  reason: "read the notes",
  createdAt: Date.now(),
  requireExplicit: false,
  nonce: "nonce-gate",
  hmac: "hmac-gate",
  ...overrides,
});
const chatSurface = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-testid="chat-surface"]')!;
const windowBand = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-testid="window-approval-scope"]')!;
const count = (root: ParentNode, id: string) => root.querySelectorAll(`[data-testid="${id}"]`).length;

describe("gates reach the user when the route leaves the chat surface", () => {
  it("an approval card moves to the window dock while Settings is open, and back when home returns", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api, emitApproval, emitViewActivate } = await renderApp({ hasApiKey: true });
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
    await submitChatMessage(container, "turn in flight");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => { emitApproval(approval({ sessionId: MOCK_DEFAULT_SESSION_ID })); });
    await waitFor(() => expect(count(container, "approval-dock")).toBe(1));
    expect(count(windowBand(container), "approval-dock")).toBe(0);

    await act(async () => { emitViewActivate("settings"); });
    await waitFor(() => expect(chatSurface(container).getAttribute("data-visible")).toBe("false"));

    // The tile released its claim; the window band — outside the route canvas,
    // so visible over Settings — is the one drawing the card now.
    await waitFor(() => expect(count(windowBand(container), "approval-dock")).toBe(1));
    expect(count(chatSurface(container), "approval-dock")).toBe(0);
    expect(count(container, "approval-dock")).toBe(1);

    await act(async () => { emitViewActivate("home"); });
    await waitFor(() => expect(chatSurface(container).getAttribute("data-visible")).toBe("true"));
    await waitFor(() => expect(count(chatSurface(container), "approval-dock")).toBe(1));
    expect(count(windowBand(container), "approval-dock")).toBe(0);

    await act(async () => { pendingSend.resolve({ ok: true }); await pendingSend.promise; });
  });

  it("an ask_user_question card is lent to the window band while a plugin view is open", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api, emitAskUserQuestion, emitViewActivate } = await renderApp({ hasApiKey: true });
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
    await submitChatMessage(container, "turn in flight");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitAskUserQuestion({
        id: "ask-gate",
        sessionId: MOCK_DEFAULT_SESSION_ID,
        questions: [{ question: "어느 형식으로 정리할까요?", choices: ["표", "목록"] }],
        createdAt: Date.now(),
      });
    });
    await waitFor(() => expect(count(container, "question-overlay")).toBe(1));

    await act(async () => { emitViewActivate("settings"); });
    await waitFor(() => expect(chatSurface(container).getAttribute("data-visible")).toBe("false"));

    await waitFor(() => expect(count(windowBand(container), "question-overlay")).toBe(1));
    expect(count(chatSurface(container), "question-overlay")).toBe(0);
    // Still ONE card: the tile owns the question and only lends the surface.
    expect(count(container, "question-overlay")).toBe(1);

    await act(async () => { pendingSend.resolve({ ok: true }); await pendingSend.promise; });
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
    await act(async () => {
      emitAskUserQuestion({
        id: "ask-headless",
        sessionId: "routine-headless-session",
        questions: [{ question: "어느 형식으로 정리할까요?", choices: ["표", "목록"] }],
        createdAt: Date.now(),
      });
    });
    await waitFor(() => expect(count(container, "question-overlay")).toBe(1));
    const cell = container.querySelector(`[data-testid="chat-group-cell:${MAIN_CHAT_GROUP_ID}"]`)!;
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
