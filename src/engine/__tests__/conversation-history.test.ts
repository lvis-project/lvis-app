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
