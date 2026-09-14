import { describe, expect, it } from "vitest";
import type { GenericMessage } from "../llm/types.js";
import { prepareMarkedToolResultsForWire } from "../wire-serialize.js";
import { estimateMessagesTokens } from "../auto-compact.js";
import { serializeMessageForEstimation } from "../llm/types.js";
import { TOOL_RESULT_WIRE_MAX_CHARS } from "../../shared/bounded-tool-output.js";
import { estimateTokens } from "../../shared/token-estimate.js";
import { MAX_TOOL_RESULT_TOKENS, trimOversizedToolResult } from "../../shared/tool-result-trim.js";

function makeToolResult(opts: {
  toolUseId: string;
  toolName: string;
  content: string;
  truncated?: NonNullable<NonNullable<GenericMessage["meta"]>["truncated"]>;
  compactedAt?: string;
  serializedStub?: boolean;
}): GenericMessage {
  const meta = {
    ...(opts.truncated && { truncated: opts.truncated }),
    ...(opts.compactedAt && { compactedAt: opts.compactedAt }),
    ...(opts.serializedStub && { serializedStub: opts.serializedStub }),
  };
  return {
    role: "tool_result",
    toolUseId: opts.toolUseId,
    toolName: opts.toolName,
    content: opts.content,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
}

describe("prepareMarkedToolResultsForWire truncated output", () => {
  it("passes through messages with no markers (reference equality)", () => {
    const messages: GenericMessage[] = [
      { role: "user", content: "hi" },
      makeToolResult({ toolUseId: "t1", toolName: "bash", content: "ok" }),
    ];
    const out = prepareMarkedToolResultsForWire(messages);
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
    const out = prepareMarkedToolResultsForWire([msg]);
    expect(out[0]).not.toBe(msg);
    const stub = out[0] as Extract<GenericMessage, { role: "tool_result" }>;
    expect(stub.content).toContain("tool=index_documents");
    expect(stub.content).toContain('toolUseId="t1"');
    expect(stub.content).toContain("originalLines=12345");
    expect(stub.content).toContain("originalTokens=110000");
    expect(stub.content).toContain("originalBytes=450000");
    expect(stub.content).toContain("originalChars=16000");
    expect(stub.content).toContain("Preview of original output");
    expect(stub.content).toContain("read_tool_result_chunk");
    expect(stub.content).not.toContain("Retry with pagination");
    expect(stub.meta).toBeUndefined();
    expect(msg.meta?.truncated).toBeDefined();
    expect(prepareMarkedToolResultsForWire(out)).toBe(out);
  });

  it("keeps bounded recovery details when a truncated result is later compacted", () => {
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
    const out = prepareMarkedToolResultsForWire([msg]);
    const stub = out[0] as Extract<GenericMessage, { role: "tool_result" }>;
    expect(stub.content).toContain("[tool_result truncated by host:");
    expect(stub.content).toContain("read_tool_result_chunk");
    expect(stub.meta).toBeUndefined();
  });

  it("keeps an existing serialized stub while removing host metadata", () => {
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
    const out = prepareMarkedToolResultsForWire([msg]);
    expect(out[0]).not.toBe(msg);
    expect((out[0] as { content: string }).content).toBe("[already stub]");
    expect(out[0]?.meta).toBeUndefined();
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
    const out = prepareMarkedToolResultsForWire([msg]);
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
    const out = prepareMarkedToolResultsForWire([msg]);
    const stub = out[0] as Extract<GenericMessage, { role: "tool_result" }>;
    expect(stub.content).toContain(`toolUseId=${JSON.stringify("toolu bad<script>")}`);
    expect(stub.content).toContain(`read_tool_result_chunk with toolUseId=${JSON.stringify("toolu bad<script>")}`);
    expect(stub.content).toContain("offset=0");
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
    const out = prepareMarkedToolResultsForWire([msg]);
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
    const out = prepareMarkedToolResultsForWire([msg]);
    const stub = out[0] as Extract<GenericMessage, { role: "tool_result" }>;
    expect(stub.toolUseId).toBe("t-xyz");
    expect(stub.toolName).toBe("meeting_start");
    expect(stub.isError).toBe(true);
  });

  it("takes head and tail from the original content within the ordinary result cap", () => {
    const head = `HEAD-${"h".repeat(2_000)}`;
    const tail = `${"t".repeat(2_000)}TAIL-END`;
    const content = `${head}${"middle".repeat(2_000)}${tail}`;
    const msg = makeToolResult({
      toolUseId: "t-preview",
      toolName: "large_output",
      content,
      truncated: {
        originalLines: 1,
        originalTokens: 5_000,
        originalBytes: content.length,
        trimmedAt: "2026-05-18T00:00:00.000Z",
      },
    });

    const stub = prepareMarkedToolResultsForWire([msg])[0] as Extract<GenericMessage, { role: "tool_result" }>;
    expect(stub.content).toContain("HEAD-");
    expect(stub.content).toContain("TAIL-END");
    expect(stub.content).toContain("chars omitted");
    expect(stub.content.length).toBeLessThanOrEqual(TOOL_RESULT_WIRE_MAX_CHARS);
    expect(trimOversizedToolResult(stub.content).truncated).toBeUndefined();
    expect(msg.content).toBe(content);
  });

  it("keeps newline-dense previews below the recursive line limit", () => {
    const content = Array.from({ length: 1_000 }, (_, index) => `row-${index}`).join("\n");
    const msg = makeToolResult({
      toolUseId: "t-lines",
      toolName: "large_output",
      content,
      truncated: {
        originalLines: 1_000,
        originalTokens: 3_000,
        originalBytes: content.length,
        trimmedAt: "2026-05-18T00:00:00.000Z",
      },
    });
    const stub = prepareMarkedToolResultsForWire([msg])[0] as Extract<GenericMessage, { role: "tool_result" }>;
    expect(stub.content).toContain("row-0");
    expect(stub.content).toContain("row-999");
    expect(trimOversizedToolResult(stub.content).truncated).toBeUndefined();
  });

  it("bounds the final serialized result after JSON control-character escaping", () => {
    const content = "\u0001".repeat(10_000);
    const msg = makeToolResult({
      toolUseId: "t-controls",
      toolName: "large_output",
      content,
      truncated: {
        originalLines: 1,
        originalTokens: 2_501,
        originalBytes: content.length,
        trimmedAt: "2026-05-18T00:00:00.000Z",
      },
    });
    const wireResult = prepareMarkedToolResultsForWire([msg])[0] as Extract<GenericMessage, { role: "tool_result" }>;
    const serialized = JSON.stringify(wireResult);

    expect(wireResult.content).toContain("Preview of original output");
    expect(estimateTokens(serialized)).toBeLessThanOrEqual(MAX_TOOL_RESULT_TOKENS);
    expect(trimOversizedToolResult(serialized).truncated).toBeUndefined();
  });

  it("excludes large host display metadata and matches the exact text wire estimate", () => {
    const content = "\u0001".repeat(10_000);
    const title = "z".repeat(10_000);
    const uiPayload = { serverId: "server-1", resourceUri: "ui://large-output", title };
    const msg: GenericMessage = {
      role: "tool_result",
      toolUseId: "t-host-meta",
      toolName: "large_output",
      content,
      meta: {
        truncated: {
          originalLines: 1,
          originalTokens: 2_501,
          originalBytes: content.length,
          trimmedAt: "2026-05-18T00:00:00.000Z",
        },
        toolDisplay: { uiPayload },
      },
    };

    const [projected] = prepareMarkedToolResultsForWire([msg]);
    const serialized = serializeMessageForEstimation(projected!);

    expect(projected?.meta).toBeUndefined();
    expect(msg.meta?.toolDisplay?.uiPayload).toEqual(uiPayload);
    expect(estimateMessagesTokens([msg])).toBe(estimateTokens(serialized));
    expect(estimateTokens(serialized)).toBeLessThanOrEqual(MAX_TOOL_RESULT_TOKENS);
    expect(estimateTokens(JSON.stringify(projected))).toBeLessThanOrEqual(MAX_TOOL_RESULT_TOKENS);
  });
});
