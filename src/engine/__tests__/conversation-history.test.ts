/**
 * ConversationHistory — capacity / append / restore lifecycle.
 *
 * Round-5 added `getCapacityRemaining()` for the trigger-import path;
 * round-6 covers the off-by-one + clamp behaviour directly so the
 * integration test in `trigger-executor.test.ts` is not the only proof.
 */
import { describe, expect, it } from "vitest";
import { ConversationHistory } from "../conversation-history.js";

describe("ConversationHistory.getCapacityRemaining", () => {
  it("returns the full cap for an empty history", () => {
    const h = new ConversationHistory({ maxMessages: 10 });
    expect(h.getCapacityRemaining()).toBe(10);
  });

  it("decreases by one per append until cap", () => {
    const h = new ConversationHistory({ maxMessages: 3 });
    h.append({ role: "user", content: "1" });
    expect(h.getCapacityRemaining()).toBe(2);
    h.append({ role: "user", content: "2" });
    expect(h.getCapacityRemaining()).toBe(1);
    h.append({ role: "user", content: "3" });
    expect(h.getCapacityRemaining()).toBe(0);
  });

  it("never goes negative even if trim leaves length === maxMessages", () => {
    const h = new ConversationHistory({ maxMessages: 2 });
    h.append({ role: "user", content: "1" });
    h.append({ role: "user", content: "2" });
    h.append({ role: "user", content: "3" }); // trim drops oldest, length stays 2
    expect(h.length).toBe(2);
    expect(h.getCapacityRemaining()).toBe(0);
  });

  it("uses the default maxMessages (50) when no option is provided", () => {
    const h = new ConversationHistory();
    expect(h.getCapacityRemaining()).toBe(50);
  });
});

describe("ConversationHistory tool-call invariant", () => {
  it("drops orphan tool_result messages after capacity trim", () => {
    const h = new ConversationHistory({ maxMessages: 3 });
    h.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "web_search", input: {} }],
    });
    h.append({
      role: "tool_result",
      toolUseId: "call-1",
      toolName: "web_search",
      content: "result",
    });
    h.append({ role: "assistant", content: "answer" });
    h.append({ role: "user", content: "next" });

    expect(h.getMessages()).toEqual([
      { role: "assistant", content: "answer" },
      { role: "user", content: "next" },
    ]);
  });

  it("repairs loaded sessions with orphan tool_result before they reach the provider", () => {
    const h = new ConversationHistory();
    h.restore([
      {
        role: "tool_result",
        toolUseId: "missing-call",
        toolName: "web_search",
        content: "orphan",
      },
      {
        role: "assistant",
        content: "visible text",
        toolCalls: [{ id: "unanswered-call", name: "web_fetch", input: {} }],
      },
      {
        role: "assistant",
        content: "final",
      },
    ]);

    expect(h.getMessages()).toEqual([
      { role: "assistant", content: "visible text" },
      { role: "assistant", content: "final" },
    ]);
  });

  it("does not keep an assistant tool call when its only result appeared before the call", () => {
    const h = new ConversationHistory();
    h.restore([
      {
        role: "tool_result",
        toolUseId: "out-of-order-call",
        toolName: "web_fetch",
        content: "result before call",
      },
      {
        role: "assistant",
        content: "visible text",
        toolCalls: [{ id: "out-of-order-call", name: "web_fetch", input: {} }],
      },
    ]);

    expect(h.getMessages()).toEqual([
      { role: "assistant", content: "visible text" },
    ]);
  });

  it("does not remove an in-flight assistant tool call while results are still being appended", () => {
    const h = new ConversationHistory({ maxMessages: 3 });
    h.append({ role: "user", content: "older" });
    h.append({ role: "assistant", content: "older answer" });
    h.append({
      role: "assistant",
      content: "calling tools",
      toolCalls: [
        { id: "call-1", name: "tool_a", input: {} },
        { id: "call-2", name: "tool_b", input: {} },
      ],
    });

    expect(h.getMessages()).toEqual([
      { role: "user", content: "older" },
      { role: "assistant", content: "older answer" },
      {
        role: "assistant",
        content: "calling tools",
        toolCalls: [
          { id: "call-1", name: "tool_a", input: {} },
          { id: "call-2", name: "tool_b", input: {} },
        ],
      },
    ]);

    h.append({
      role: "tool_result",
      toolUseId: "call-1",
      toolName: "tool_a",
      content: "A",
    });

    expect(h.getMessages()).toEqual([
      { role: "assistant", content: "older answer" },
      {
        role: "assistant",
        content: "calling tools",
        toolCalls: [
          { id: "call-1", name: "tool_a", input: {} },
          { id: "call-2", name: "tool_b", input: {} },
        ],
      },
      {
        role: "tool_result",
        toolUseId: "call-1",
        toolName: "tool_a",
        content: "A",
      },
    ]);
  });
});
