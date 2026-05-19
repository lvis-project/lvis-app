import { describe, expect, it } from "vitest";
import type { GenericMessage } from "../llm/types.js";
import { stubMarkedToolResults } from "../wire-serialize.js";

function makeToolResult(opts: {
  toolUseId: string;
  toolName: string;
  content: string;
  truncated?: NonNullable<NonNullable<GenericMessage["meta"]>["truncated"]>;
  compactedAt?: string;
  serializedStub?: boolean;
}): GenericMessage {
  return {
    role: "tool_result",
    toolUseId: opts.toolUseId,
    toolName: opts.toolName,
    content: opts.content,
    meta: {
      ...(opts.truncated && { truncated: opts.truncated }),
      ...(opts.compactedAt && { compactedAt: opts.compactedAt }),
      ...(opts.serializedStub && { serializedStub: opts.serializedStub }),
    },
  };
}

describe("stubMarkedToolResults — Issue #902 truncated marker", () => {
  it("passes through messages with no markers (reference equality)", () => {
    const messages: GenericMessage[] = [
      { role: "user", content: "hi" },
      makeToolResult({ toolUseId: "t1", toolName: "bash", content: "ok" }),
    ];
    const out = stubMarkedToolResults(messages);
    expect(out).toBe(messages); // no allocation
  });

  it("swaps content for meta.truncated tool_result", () => {
    const msg = makeToolResult({
      toolUseId: "t1",
      toolName: "index_documents",
      content: "raw huge content".repeat(1000),
      truncated: {
        originalLines: 12_345,
        originalTokens: 110_000,
        originalBytes: 450_000,
        trimmedAt: "2026-05-18T00:00:00.000Z",
      },
    });
    const out = stubMarkedToolResults([msg]);
    expect(out[0]).not.toBe(msg);
    const stub = out[0] as Extract<GenericMessage, { role: "tool_result" }>;
    expect(stub.content).toContain("Issue #902");
    expect(stub.content).toContain("tool=index_documents");
    expect(stub.content).toContain('toolUseId="t1"');
    expect(stub.content).toContain("originalLines=12345");
    expect(stub.content).toContain("originalTokens=110000");
    expect(stub.content).toContain("originalBytes=450000");
    expect(stub.content).toContain("read_tool_result_chunk");
    expect(stub.content).not.toContain("Retry with pagination");
    expect(stub.meta?.serializedStub).toBe(true);
    expect(stub.meta?.truncated).toEqual(msg.meta!.truncated);
  });

  it("compactedAt takes precedence over truncated (LLM-summarized turn)", () => {
    const msg = makeToolResult({
      toolUseId: "t1",
      toolName: "x",
      content: "raw",
      truncated: {
        originalLines: 200,
        originalTokens: 5_000,
        originalBytes: 10_000,
        trimmedAt: "2026-05-18T00:00:00.000Z",
      },
      compactedAt: "2026-05-18T00:01:00.000Z",
    });
    const out = stubMarkedToolResults([msg]);
    const stub = out[0] as Extract<GenericMessage, { role: "tool_result" }>;
    // The compactedAt path uses the generic stub (no "Issue #902" marker)
    expect(stub.content).not.toContain("Issue #902");
    expect(stub.meta?.serializedStub).toBe(true);
  });

  it("idempotent — serializedStub already true is not re-swapped", () => {
    const msg = makeToolResult({
      toolUseId: "t1",
      toolName: "x",
      content: "[already stub]",
      truncated: {
        originalLines: 200,
        originalTokens: 5_000,
        originalBytes: 10_000,
        trimmedAt: "2026-05-18T00:00:00.000Z",
      },
      serializedStub: true,
    });
    const out = stubMarkedToolResults([msg]);
    expect(out[0]).toBe(msg);
    expect((out[0] as { content: string }).content).toBe("[already stub]");
  });

  it("sanitizes toolName before embedding in stub (defense-in-depth)", () => {
    // Even though `registerPluginTools` enforces `^[a-zA-Z0-9_-]+$` at
    // registration, the stub builder must not trust the field — future
    // validation drift would otherwise become an injection vector.
    const msg: GenericMessage = {
      role: "tool_result",
      toolUseId: "t1",
      toolName: "evil tool<script>",
      content: "raw",
      meta: {
        truncated: {
          originalLines: 200,
          originalTokens: 5_000,
          originalBytes: 10_000,
          trimmedAt: "2026-05-18T00:00:00.000Z",
        },
      },
    };
    const out = stubMarkedToolResults([msg]);
    const stub = out[0] as Extract<GenericMessage, { role: "tool_result" }>;
    // The sanitized tool=... segment never carries the dangerous chars.
    expect(stub.content).toContain("tool=evil?tool?script?");
    expect(stub.content).not.toMatch(/tool=[^,]*[<>]/);
    expect(stub.content).not.toMatch(/tool=[^,]* /);
  });

  it("embeds the exact toolUseId as a JSON string in recovery instructions", () => {
    const msg: GenericMessage = {
      role: "tool_result",
      toolUseId: "toolu bad<script>",
      toolName: "safe_tool",
      content: "raw",
      meta: {
        truncated: {
          originalLines: 200,
          originalTokens: 5_000,
          originalBytes: 10_000,
          trimmedAt: "2026-05-18T00:00:00.000Z",
        },
      },
    };
    const out = stubMarkedToolResults([msg]);
    const stub = out[0] as Extract<GenericMessage, { role: "tool_result" }>;
    expect(stub.content).toContain(`toolUseId=${JSON.stringify("toolu bad<script>")}`);
    expect(stub.content).toContain(`read_tool_result_chunk with toolUseId=${JSON.stringify("toolu bad<script>")}`);
  });

  it("renders sentinel -1 counts as 'scan-skipped' (hard byte ceiling case)", () => {
    const msg = makeToolResult({
      toolUseId: "t1",
      toolName: "huge_dump",
      content: "x".repeat(100),
      truncated: {
        originalLines: -1,
        originalTokens: -1,
        originalBytes: 99_999_999,
        trimmedAt: "2026-05-18T00:00:00.000Z",
      },
    });
    const out = stubMarkedToolResults([msg]);
    const stub = out[0] as Extract<GenericMessage, { role: "tool_result" }>;
    expect(stub.content).toContain("originalLines=scan-skipped");
    expect(stub.content).toContain("originalTokens=scan-skipped");
    expect(stub.content).toContain("originalBytes=99999999");
    expect(stub.content).not.toContain("-1");
  });

  it("preserves toolName, toolUseId, isError on swap", () => {
    const msg: GenericMessage = {
      role: "tool_result",
      toolUseId: "t-xyz",
      toolName: "meeting_start",
      isError: true,
      content: "huge",
      meta: {
        truncated: {
          originalLines: 500,
          originalTokens: 8_000,
          originalBytes: 30_000,
          trimmedAt: "2026-05-18T00:00:00.000Z",
        },
      },
    };
    const out = stubMarkedToolResults([msg]);
    const stub = out[0] as Extract<GenericMessage, { role: "tool_result" }>;
    expect(stub.toolUseId).toBe("t-xyz");
    expect(stub.toolName).toBe("meeting_start");
    expect(stub.isError).toBe(true);
  });
});
