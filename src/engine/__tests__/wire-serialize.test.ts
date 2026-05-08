/**
 * wire-serialize tests — `stubMarkedToolResults` 가 marked tool_result content 를 stub
 * 으로 변환하면서 memory 의 verbatim 입력을 mutate 하지 않는지 검증.
 */
import { describe, it, expect } from "vitest";
import type { GenericMessage } from "../llm/types.js";
import { stubMarkedToolResults } from "../wire-serialize.js";

describe("stubMarkedToolResults", () => {
  it("returns reference-equal when no tool_result is marked", () => {
    const messages: GenericMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok", toolCalls: [{ id: "t1", name: "search", input: {} }] },
      { role: "tool_result", toolUseId: "t1", toolName: "search", content: "raw output 200 chars".repeat(20) },
    ];
    const out = stubMarkedToolResults(messages);
    expect(out).toBe(messages); // reference-equal — no allocation
  });

  it("replaces marked tool_result content with stub but leaves meta + ids intact", () => {
    const verbatim = "raw output 200 chars".repeat(50);
    const messages: GenericMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "tool_result",
        toolUseId: "t1",
        toolName: "search",
        content: verbatim,
        meta: { compactedAt: "2026-05-08T00:00:00.000Z" },
      },
    ];
    const out = stubMarkedToolResults(messages);

    expect(out).not.toBe(messages); // new array
    expect(out).toHaveLength(messages.length);

    // tool_result 이 stub 으로 변환됨
    const wireToolResult = out[1];
    expect(wireToolResult.role).toBe("tool_result");
    if (wireToolResult.role === "tool_result") {
      expect(wireToolResult.content).toContain("[tool_result stripped:");
      expect(wireToolResult.content).toContain("tool=search");
      expect(wireToolResult.content).toContain(`origLen=${verbatim.length}`);
      expect(wireToolResult.toolUseId).toBe("t1");
      expect(wireToolResult.toolName).toBe("search");
      // meta.compactedAt 은 그대로 carry
      expect(wireToolResult.meta?.compactedAt).toBe("2026-05-08T00:00:00.000Z");
      // meta.serializedStub flag 가 set 됨 (idempotency guard)
      expect(wireToolResult.meta?.serializedStub).toBe(true);
    }

    // 입력 array 의 verbatim message 는 mutate 되지 않음 (memory 보존)
    const memoryToolResult = messages[1];
    if (memoryToolResult.role === "tool_result") {
      expect(memoryToolResult.content).toBe(verbatim);
      expect(memoryToolResult.content.length).toBe(verbatim.length);
      // 원본 meta 에는 serializedStub 가 없음 (입력 객체 mutate 안 함)
      expect(memoryToolResult.meta?.serializedStub).toBeUndefined();
    }
  });

  it("preserves messages without compactedAt meta verbatim", () => {
    const messages: GenericMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "tool_result",
        toolUseId: "t1",
        toolName: "search",
        content: "verbatim short content",
        // no meta — should not be transformed
      },
      {
        role: "tool_result",
        toolUseId: "t2",
        toolName: "edit",
        content: "another verbatim — no compactedAt",
        meta: { lock: true }, // lock set but no compactedAt
      },
    ];
    const out = stubMarkedToolResults(messages);
    expect(out).toBe(messages); // reference-equal
  });

  it("idempotent — meta.serializedStub=true prevents double-stubbing (Copilot round 2 fix)", () => {
    const messages: GenericMessage[] = [
      {
        role: "tool_result",
        toolUseId: "t1",
        toolName: "search",
        content: "[tool_result stripped: tool=search, origLen=12345]",
        meta: { compactedAt: "2026-05-08T00:00:00.000Z", serializedStub: true },
      },
    ];
    const out = stubMarkedToolResults(messages);
    // already stub (meta flag) — reference-equal, no transformation
    expect(out).toBe(messages);
  });

  it("false-positive guard — tool output starting with stub prefix still converted when serializedStub not set", () => {
    // 도구 출력이 우연히 stub prefix 로 시작해도, serializedStub flag 가 없으면 올바르게 stub 변환
    const trickContent = "[tool_result stripped: this is real tool output, not a stub]";
    const messages: GenericMessage[] = [
      {
        role: "tool_result",
        toolUseId: "t1",
        toolName: "search",
        content: trickContent,
        meta: { compactedAt: "2026-05-08T00:00:00.000Z" },
        // serializedStub 미설정 — 아직 stub 화 안 됨
      },
    ];
    const out = stubMarkedToolResults(messages);
    expect(out).not.toBe(messages); // 새 array — 변환 발생
    const wireMsg = out[0];
    if (wireMsg.role === "tool_result") {
      // content 가 새 stub 으로 교체됨 (origLen 이 trickContent.length 기반)
      expect(wireMsg.content).toContain(`origLen=${trickContent.length}`);
      expect(wireMsg.meta?.serializedStub).toBe(true);
    }
  });

  it("transforms only tool_result roles (user/assistant unchanged)", () => {
    const messages: GenericMessage[] = [
      {
        role: "user",
        content: "verbatim user message",
        meta: { compactedAt: "2026-05-08T00:00:00.000Z" }, // even with compactedAt, user role not transformed
      },
      {
        role: "assistant",
        content: "verbatim assistant message",
        meta: { compactedAt: "2026-05-08T00:00:00.000Z" },
      },
      {
        role: "tool_result",
        toolUseId: "t1",
        toolName: "search",
        content: "should be stubbed",
        meta: { compactedAt: "2026-05-08T00:00:00.000Z" },
      },
    ];
    const out = stubMarkedToolResults(messages);

    expect(out[0].content).toBe("verbatim user message"); // user verbatim
    expect(out[1].content).toBe("verbatim assistant message"); // assistant verbatim
    const wireToolResult = out[2];
    if (wireToolResult.role === "tool_result") {
      expect(wireToolResult.content).toContain("[tool_result stripped:");
    }
  });
});
