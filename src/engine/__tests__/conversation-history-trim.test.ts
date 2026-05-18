/**
 * ConversationHistory — Issue #902 tool_result size cap chokepoint.
 *
 * Verifies that `.append` and `.restore` are the single chokepoint that
 * marks over-cap tool_result messages with `meta.truncated`, so every
 * append site (and every rehydrated jsonl row) is protected without
 * per-call-site wiring.
 */
import { describe, expect, it } from "vitest";
import { ConversationHistory } from "../conversation-history.js";
import { MAX_TOOL_RESULT_LINES } from "../../shared/tool-result-trim.js";
import type { GenericMessage } from "../llm/types.js";

const SMALL_CONTENT = "ok\nfine";
const OVERSIZE_CONTENT = Array.from({ length: MAX_TOOL_RESULT_LINES + 50 }, (_, i) => `row ${i}`).join("\n");

describe("ConversationHistory — Issue #902 tool_result cap", () => {
  it("marks meta.truncated on append for oversized tool_result", () => {
    const h = new ConversationHistory();
    h.append({
      role: "tool_result",
      toolUseId: "t1",
      toolName: "index_documents",
      content: OVERSIZE_CONTENT,
    });
    const msg = h.getMessages()[0] as Extract<GenericMessage, { role: "tool_result" }>;
    expect(msg.meta?.truncated).toBeDefined();
    expect(msg.meta!.truncated!.originalLines).toBe(MAX_TOOL_RESULT_LINES + 50);
    // Content stays raw in-memory — wire-serialize swaps to stub only on
    // send/save, not on append. This keeps UI / inspection paths intact.
    expect(msg.content).toBe(OVERSIZE_CONTENT);
  });

  it("does not mark sub-cap tool_result", () => {
    const h = new ConversationHistory();
    h.append({
      role: "tool_result",
      toolUseId: "t1",
      toolName: "bash",
      content: SMALL_CONTENT,
    });
    const msg = h.getMessages()[0] as Extract<GenericMessage, { role: "tool_result" }>;
    expect(msg.meta?.truncated).toBeUndefined();
  });

  it("does not touch non-tool_result messages", () => {
    const h = new ConversationHistory();
    h.append({ role: "user", content: OVERSIZE_CONTENT });
    h.append({ role: "assistant", content: OVERSIZE_CONTENT });
    const [u, a] = h.getMessages();
    expect((u as { meta?: { truncated?: unknown } }).meta?.truncated).toBeUndefined();
    expect((a as { meta?: { truncated?: unknown } }).meta?.truncated).toBeUndefined();
  });

  it("restore marks meta.truncated on rehydrated oversized tool_result", () => {
    // Simulates loading a session jsonl that pre-dates the cap (or was
    // written before the cap tightened) — restore re-checks every row.
    const h = new ConversationHistory();
    h.restore([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "index_documents", input: {} }],
      },
      {
        role: "tool_result",
        toolUseId: "t1",
        toolName: "index_documents",
        content: OVERSIZE_CONTENT,
      },
    ]);
    const tr = h
      .getMessages()
      .find((m) => m.role === "tool_result") as Extract<GenericMessage, { role: "tool_result" }>;
    expect(tr.meta?.truncated).toBeDefined();
    expect(tr.meta!.truncated!.originalLines).toBe(MAX_TOOL_RESULT_LINES + 50);
  });

  it("restore strips forged meta.serializedStub and re-derives from content (jsonl tamper defense)", () => {
    // Adversarial jsonl: sub-cap content but claims `serializedStub: true`
    // (which `wire-serialize` would otherwise honour as "already stubbed,
    // skip"). Restore must strip the forged flag.
    const h = new ConversationHistory();
    h.restore([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "bash", input: {} }],
      },
      {
        role: "tool_result",
        toolUseId: "t1",
        toolName: "bash",
        content: SMALL_CONTENT,
        meta: { serializedStub: true }, // forged
      },
    ]);
    const tr = h
      .getMessages()
      .find((m) => m.role === "tool_result") as Extract<GenericMessage, { role: "tool_result" }>;
    expect(tr.meta?.serializedStub).toBeUndefined();
  });

  it("restore re-marks oversized content even if forged meta.truncated claims smaller size", () => {
    // Adversarial: oversize content but jsonl claims truncated with tiny
    // numbers. Restore must re-measure, overwriting forged values.
    const h = new ConversationHistory();
    h.restore([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "index_documents", input: {} }],
      },
      {
        role: "tool_result",
        toolUseId: "t1",
        toolName: "index_documents",
        content: OVERSIZE_CONTENT,
        meta: {
          truncated: {
            originalLines: 5, // forged tiny value
            originalTokens: 5,
            originalBytes: 5,
            trimmedAt: "1999-01-01T00:00:00.000Z",
          },
        },
      },
    ]);
    const tr = h
      .getMessages()
      .find((m) => m.role === "tool_result") as Extract<GenericMessage, { role: "tool_result" }>;
    expect(tr.meta!.truncated!.originalLines).toBe(MAX_TOOL_RESULT_LINES + 50);
    expect(tr.meta!.truncated!.trimmedAt).not.toBe("1999-01-01T00:00:00.000Z");
  });

  it("idempotent — restore-after-append does not re-mark or change trimmedAt", () => {
    const h = new ConversationHistory();
    // Append a paired (assistant + tool_result) so normalizeToolPairInvariant
    // in restore() keeps the tool_result rather than dropping it as orphan.
    h.append({ role: "user", content: "hi" });
    h.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "t1", name: "index_documents", input: {} }],
    });
    h.append({
      role: "tool_result",
      toolUseId: "t1",
      toolName: "index_documents",
      content: OVERSIZE_CONTENT,
    });
    const trMsg = h
      .getMessages()
      .find((m) => m.role === "tool_result") as Extract<GenericMessage, { role: "tool_result" }>;
    const firstStamp = trMsg.meta!.truncated!.trimmedAt;
    // Cross-restore — feed the same marked messages back through restore.
    const h2 = new ConversationHistory();
    h2.restore(h.getMessages());
    const reTr = h2
      .getMessages()
      .find((m) => m.role === "tool_result") as Extract<GenericMessage, { role: "tool_result" }>;
    expect(reTr.meta!.truncated!.trimmedAt).toBe(firstStamp);
  });
});
