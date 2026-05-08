/**
 * Phase 3 safety net — redact_notice stream event handling.
 *
 * When PII redaction is enabled the engine emits a redact_notice event;
 * the renderer converts it to a system badge entry in the chat list.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { fakeLlmSettings } from "../../src/shared/__tests__/fake-llm-settings.js";

async function submit(container: HTMLElement, text: string): Promise<void> {
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.change(textarea, { target: { value: text } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
  });
}

describe("Redact notice (Phase 3 regression net)", () => {
  it("redact_notice with count renders a PII system badge", async () => {
    const { container, api, emitChatStream } = await renderApp({
      settings: {
        llm: fakeLlmSettings({ provider: "openai", model: "gpt-4o-mini" }),
        chat: { systemPrompt: "", autoCompact: true },
        webSearch: { provider: "none" },
        routine: {},
        privacy: { piiRedactEnabled: true },
      },
    });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await submit(container, "contains pii");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitChatStream({ type: "redact_notice", count: 2, byKind: { email: 1, phone: 1 } });
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/PII 2건 리댁트됨/);
      expect(container.textContent).toContain("email:1");
    });
  });

  it("no redact_notice event => no PII badge in chat", async () => {
    const { container, api, emitChatStream } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await submit(container, "plain message");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitChatStream({ type: "text_delta", text: "ok" });
      emitChatStream({ type: "assistant_round", text: "ok" });
      emitChatStream({ type: "done" });
    });
    await waitFor(() => {
      expect(container.textContent).toContain("ok");
    });
    expect(container.textContent).not.toMatch(/PII .*리댁트됨/);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
