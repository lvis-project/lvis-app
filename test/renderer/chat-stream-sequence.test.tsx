/**
 * Phase 3.2 safety net — onChatStream event sequencing.
 *
 * Covers the four event kinds most likely to regress during hook extraction:
 *  - text_delta accumulation
 *  - reasoning_delta -> ReasoningCard rendering
 *  - tool_start/tool_end -> ToolGroupCard rendering
 *  - assistant_round / done -> finalize (streaming flag false)
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, waitFor, fireEvent } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { submitChatMessage } from "./helpers.js";


describe("Chat stream sequencing (Phase 3.2 regression net)", () => {
  it("text_delta events accumulate into the streaming assistant entry", async () => {
    const { container, api, emitChatStream } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await submitChatMessage(container, "ask");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitChatStream({ type: "text_delta", text: "Part A " });
      emitChatStream({ type: "text_delta", text: "Part B" });
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Part A Part B");
    });
  });

  it("reasoning_delta events render a (collapsed) reasoning card", async () => {
    const { container, api, emitChatStream } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await submitChatMessage(container, "think");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitChatStream({ type: "reasoning_delta", text: "inner reasoning chain" });
    });
    await waitFor(() => {
      // The reasoning card renders, but its body is COLLAPSED by default — the
      // live "생각 중..." header shows while the raw chain stays hidden until
      // the user clicks to expand.
      expect(container.textContent).toContain("생각 중...");
      expect(container.textContent).not.toContain("inner reasoning chain");
    });
  });

  it("tool_start renders a tool group card for the tool call", async () => {
    const { container, api, emitChatStream } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await submitChatMessage(container, "use tool");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitChatStream({
        type: "tool_start",
        groupId: "g1",
        toolUseId: "t1",
        displayOrder: 0,
        name: "knowledge_search",
        input: { query: "hello" },
      });
    });
    // Single tool renders inline with display name (no group header).
    // Unknown plugin tool names are rendered generically.
    await waitFor(() => {
      expect(container.textContent).toContain("knowledge search");
    });
  });

  it("assistant_round + done finalize the streaming entry", async () => {
    const { container, api, emitChatStream } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await submitChatMessage(container, "complete");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitChatStream({ type: "text_delta", text: "final text" });
      emitChatStream({ type: "assistant_round", text: "final text" });
      emitChatStream({ type: "done" });
    });
    await waitFor(() => {
      // Content rendered, and the "응답을 작성하는 중..." spinner text is gone.
      expect(container.textContent).toContain("final text");
      expect(container.textContent).not.toContain("응답을 작성하는 중...");
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
