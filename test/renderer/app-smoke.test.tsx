/**
 * Phase 1 renderer split — App smoke tests.
 *
 * These prove the test infrastructure (jsdom + RTL + mock lvisApi) works
 * end-to-end so Phase 2-4 hook extractions have a safety net.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";

describe("App smoke (Phase 1 infra)", () => {
  it("renders App without crash", async () => {
    const { container, api } = await renderApp();
    expect(container).toBeTruthy();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
  });

  it("subscribes to onChatStream on mount", async () => {
    const { api } = await renderApp();
    await waitFor(() => expect(api.onChatStream).toHaveBeenCalled());
  });

  it("receives stream events via emitChatStream without throwing", async () => {
    const { emitChatStream } = await renderApp();
    await act(async () => {
      emitChatStream({ type: "text", text: "hello" });
    });
    expect(true).toBe(true);
  });

  it("BriefingCard appears when onRoutineBriefing fires", async () => {
    const { container, emitRoutineBriefing } = await renderApp();
    await act(async () => {
      emitRoutineBriefing({
        generatedAt: new Date().toISOString(),
        items: [{ category: "info", priority: "low", title: "Test briefing" }],
        summary: "smoke summary",
      });
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="briefing-card"]')).toBeTruthy();
    });
  });

  it("dismissBriefing mock is callable and resolves", async () => {
    const { api } = await renderApp();
    await expect(api.dismissBriefing({ reason: "uninteresting" })).resolves.toEqual({
      ok: true,
    });
    expect(api.dismissBriefing).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+F keydown does not throw on App root", async () => {
    await renderApp();
    await act(async () => {
      fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    });
    expect(true).toBe(true);
  });

  it("addStarred / listStarred mock surface is spy-able", async () => {
    const { api } = await renderApp();
    const entry = { messageIndex: 3, role: "assistant", text: "hi", sessionId: "s1" };
    await api.addStarred(entry);
    expect(api.addStarred).toHaveBeenCalledWith(entry);
    const list = await api.listStarred();
    expect(Array.isArray(list)).toBe(true);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
