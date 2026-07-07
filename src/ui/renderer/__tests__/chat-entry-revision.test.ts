import { describe, it, expect } from "vitest";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import {
  textRevision,
  valueRevision,
  toolGroupRevision,
  entryRenderRevision,
  bottomFollowSignature,
} from "../utils/chat-entry-revision.js";

type ToolGroupEntry = Extract<ChatEntry, { kind: "tool_group" }>;

describe("textRevision", () => {
  it("returns the sentinel for empty/undefined text", () => {
    expect(textRevision("")).toBe("0:0");
    expect(textRevision(undefined)).toBe("0:0");
  });

  it("is deterministic and prefixes the length", () => {
    expect(textRevision("hello")).toBe(textRevision("hello"));
    expect(textRevision("hello").startsWith("5:")).toBe(true);
  });

  it("differs for different inputs", () => {
    expect(textRevision("hello")).not.toBe(textRevision("world"));
  });
});

describe("valueRevision", () => {
  it("encodes undefined and null distinctly", () => {
    expect(valueRevision(undefined)).toBe("undefined");
    expect(valueRevision(null)).toBe("null");
  });

  it("is stable regardless of object key order", () => {
    expect(valueRevision({ a: 1, b: 2 })).toBe(valueRevision({ b: 2, a: 1 }));
  });

  it("changes when values change", () => {
    expect(valueRevision({ a: 1 })).not.toBe(valueRevision({ a: 2 }));
  });
});

describe("entryRenderRevision", () => {
  it("tags reasoning entries with streaming flag", () => {
    const entry: ChatEntry = { kind: "reasoning", text: "abc" };
    expect(entryRenderRevision({ entry, idx: 0, searchHighlight: "", starred: false })).toBe(
      `0:reasoning:${textRevision("abc")}:0`,
    );
  });

  it("encodes assistant starred + highlight state", () => {
    const entry: ChatEntry = { kind: "assistant", text: "hi", streaming: true };
    const rev = entryRenderRevision({ entry, idx: 3, searchHighlight: "q", starred: true });
    expect(rev.startsWith("3:assistant:")).toBe(true);
    expect(rev.endsWith(":1")).toBe(true);
  });

  it("encodes ask_user_answer rows", () => {
    const entry: ChatEntry = {
      kind: "ask_user_answer",
      sourceToolUseId: "t",
      rows: [{ label: "L", value: "V" }],
    };
    expect(entryRenderRevision({ entry, idx: 2, searchHighlight: "", starred: false })).toBe(
      `2:ask_user_answer:0:L:${textRevision("V")}`,
    );
  });

  it("falls back to idx:kind for unhandled kinds", () => {
    const entry: ChatEntry = { kind: "system", text: "s" };
    expect(entryRenderRevision({ entry, idx: 7, searchHighlight: "", starred: false })).toBe("7:system");
  });
});

describe("toolGroupRevision", () => {
  it("toolGroupRevision changes when a tool result changes", () => {
    const base: ToolGroupEntry = {
      kind: "tool_group",
      groupId: "g",
      groupIds: ["g"],
      status: "done",
      tools: [{ toolUseId: "t1", name: "x", displayOrder: 0, status: "done", result: "r1" }],
    };
    const changed: ToolGroupEntry = {
      ...base,
      tools: [{ ...base.tools[0]!, result: "r2" }],
    };
    expect(toolGroupRevision(base)).not.toBe(toolGroupRevision(changed));
  });
});

describe("bottomFollowSignature", () => {
  it("returns 'empty' for no entries", () => {
    expect(bottomFollowSignature([])).toBe("empty");
  });

  it("encodes the trailing user entry length", () => {
    expect(bottomFollowSignature([{ kind: "user", text: "hi" }])).toBe("1:user:2");
  });

  it("distinguishes streaming vs done assistant tails", () => {
    const streaming: ChatEntry[] = [{ kind: "assistant", text: "abc", streaming: true }];
    const done: ChatEntry[] = [{ kind: "assistant", text: "abc", streaming: false }];
    expect(bottomFollowSignature(streaming)).toBe("1:assistant:3:streaming");
    expect(bottomFollowSignature(done)).toBe("1:assistant:3:done");
  });
});
