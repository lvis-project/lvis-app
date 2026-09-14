import { describe, expect, it } from "vitest";

import {
  TOOL_RESULT_READ_DEFAULT_CHARS,
  TOOL_RESULT_READ_MAX_CHARS,
  TOOL_RESULT_READ_MIN_CHARS,
} from "../../shared/bounded-tool-output.js";
import { estimateTokens } from "../../shared/token-estimate.js";
import { MAX_TOOL_RESULT_TOKENS, trimOversizedToolResult } from "../../shared/tool-result-trim.js";
import { MAX_TOOL_USE_ID_UTF8_BYTES } from "../../shared/tool-use-id.js";
import {
  createReadToolResultChunkTool,
  TOOL_RESULT_CHUNK_READER_METADATA_KEY,
  type ReadableToolResult,
} from "../tool-result-chunk.js";
import type { ToolExecutionContext } from "../base.js";
import type { ToolOutputArtifactInfo } from "../../shared/tool-output-artifact.js";

function ctx(reader?: (toolUseId: string) => ReadableToolResult | null): ToolExecutionContext {
  return {
    cwd: "/tmp",
    extraAllowedDirectories: [],
    metadata: reader ? { [TOOL_RESULT_CHUNK_READER_METADATA_KEY]: reader } : {},
  };
}

function truncatedResult(content: string): ReadableToolResult {
  return {
    toolUseId: "toolu_123",
    toolName: "long_output_query",
    content,
    meta: {
      truncated: {
        originalLines: 1,
        originalTokens: 9,
        originalBytes: content.length,
        trimmedAt: "2026-05-19T00:00:00.000Z",
      },
    },
  };
}

function capturedResult(content: string, status: ToolOutputArtifactInfo["status"]): ReadableToolResult {
  const capturedBytes = Buffer.byteLength(content, "utf8");
  return {
    toolUseId: "toolu_123",
    toolName: "bash",
    content,
    outputArtifact: {
      version: 1,
      captureId: "capture-1",
      status,
      capturedBytes,
      observedBytes: status === "complete" ? capturedBytes : capturedBytes + 1_000,
      capturedChars: content.length,
    },
  };
}

describe("read_tool_result_chunk", () => {
  it.each([undefined, "missing"])("bounds an untrusted stored tool name for query %s", async (query) => {
    const result = await createReadToolResultChunkTool().execute({ toolUseId: "toolu_123", ...(query ? { query } : {}) }, ctx(() => ({ ...truncatedResult("x".repeat(600)), toolName: "x".repeat(20_000) })));
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output).toolName).toBeNull();
    expect(estimateTokens(result.output)).toBeLessThanOrEqual(MAX_TOOL_RESULT_TOKENS);
  });

  it.each(["complete", "partial"] as const)("reads %s capture without legacy truncation metadata", async (status) => {
    const source = capturedResult("retained 😀 tail", status);
    const result = await createReadToolResultChunkTool().execute(
      { toolUseId: source.toolUseId }, ctx(() => source),
    );
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.output);
    expect(payload).toMatchObject({
      captureStatus: status,
      sourceComplete: status === "complete",
      capturedBytes: source.outputArtifact!.capturedBytes,
      observedBytes: source.outputArtifact!.observedBytes,
      hasMore: false,
      nextOffset: null,
      hasMoreMeaning: "content remaining in the retained range, not source completeness",
      chunk: source.content,
    });
    expect(payload.originalBytes).toBeUndefined();
    expect(payload.originalLines).toBeUndefined();
  });

  it("keeps partial capture status on a search miss", async () => {
    const source = capturedResult("retained prefix", "partial");
    const result = await createReadToolResultChunkTool().execute(
      { toolUseId: source.toolUseId, query: "discarded tail" }, ctx(() => source),
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({
      captureStatus: "partial", sourceComplete: false, found: false,
      capturedBytes: source.outputArtifact!.capturedBytes,
      observedBytes: source.outputArtifact!.observedBytes,
      hasMore: false,
      hasMoreMeaning: "matching content remaining in the retained range, not source completeness",
    });
  });

  it.each([
    { status: "unavailable", artifactReadUnavailable: false },
    { status: "complete", artifactReadUnavailable: true },
    { status: "partial", artifactReadUnavailable: true },
  ] as const)("reports an explicit recovery error for $status capture when readUnavailable=$artifactReadUnavailable", async (entry) => {
    const source = { ...capturedResult("display preview", entry.status), artifactReadUnavailable: entry.artifactReadUnavailable };
    const result = await createReadToolResultChunkTool().execute(
      { toolUseId: source.toolUseId }, ctx(() => source),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      captureStatus: entry.status,
      sourceComplete: entry.status === "complete",
      artifactReadUnavailable: entry.artifactReadUnavailable,
      capturedBytes: source.outputArtifact!.capturedBytes,
      observedBytes: source.outputArtifact!.observedBytes,
      error: expect.stringContaining("unavailable for recovery"),
    });
    expect(result.output).not.toContain("display preview");
  });

  it("reads verified capture content even when it resembles a serialized stub", async () => {
    const source = capturedResult("[tool_result truncated by host: literal command output]", "complete");
    source.meta = { serializedStub: true };
    const result = await createReadToolResultChunkTool().execute(
      { toolUseId: source.toolUseId }, ctx(() => source),
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output).chunk).toBe(source.content);
  });

  it("rejects an unreadable capture even when no valid descriptor remains", async () => {
    const result = await createReadToolResultChunkTool().execute(
      { toolUseId: "toolu_123" },
      ctx(() => ({ toolUseId: "toolu_123", content: "display preview", artifactReadUnavailable: true })),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      error: "captured tool output is unavailable for recovery",
      artifactReadUnavailable: true,
      captureStatus: null,
      sourceComplete: null,
      capturedBytes: null,
      observedBytes: null,
    });
    expect(result.output).not.toContain("display preview");
  });

  it("uses absolute offsets when the requested size changes", async () => {
    const content = "abcdefghijklmnopqrstuvwxyz".repeat(100);
    const tool = createReadToolResultChunkTool();
    const first = await tool.execute(
      { toolUseId: "toolu_123", offset: 0, maxChars: 500 },
      ctx(() => truncatedResult(content)),
    );
    const firstPayload = JSON.parse(first.output) as Record<string, unknown>;
    expect(firstPayload).toMatchObject({
      offset: 0,
      requestedMaxChars: 500,
      startOffset: 0,
      endOffset: 500,
      nextOffset: 500,
      hasMore: true,
      chunk: content.slice(0, 500),
    });

    const second = await tool.execute(
      { toolUseId: "toolu_123", offset: firstPayload.nextOffset, maxChars: 1_000 },
      ctx(() => truncatedResult(content)),
    );
    expect(JSON.parse(second.output)).toMatchObject({
      offset: 500,
      startOffset: 500,
      endOffset: 1_500,
      nextOffset: 1_500,
      chunk: content.slice(500, 1_500),
    });
  });

  it("uses the shared default when maxChars is omitted", async () => {
    const content = "x".repeat(TOOL_RESULT_READ_DEFAULT_CHARS + 100);
    const result = await createReadToolResultChunkTool().execute(
      { toolUseId: "toolu_123" },
      ctx(() => truncatedResult(content)),
    );
    expect(JSON.parse(result.output)).toMatchObject({
      requestedMaxChars: TOOL_RESULT_READ_DEFAULT_CHARS,
      startOffset: 0,
      endOffset: TOOL_RESULT_READ_DEFAULT_CHARS,
      nextOffset: TOOL_RESULT_READ_DEFAULT_CHARS,
    });
  });

  it("never splits a Unicode surrogate pair and rejects an offset inside one", async () => {
    const content = `${"a".repeat(499)}😀${"b".repeat(600)}`;
    const tool = createReadToolResultChunkTool();
    const result = await tool.execute(
      { toolUseId: "toolu_123", maxChars: 500 },
      ctx(() => truncatedResult(content)),
    );
    expect(JSON.parse(result.output)).toMatchObject({
      endOffset: 499,
      nextOffset: 499,
      chunk: "a".repeat(499),
    });

    const invalid = await tool.execute(
      { toolUseId: "toolu_123", offset: 500, maxChars: 500 },
      ctx(() => truncatedResult(content)),
    );
    expect(invalid.isError).toBe(true);
    expect(JSON.parse(invalid.output).error).toContain("surrogate pair");
  });

  it("returns an exact final page with no next offset", async () => {
    const content = "x".repeat(620);
    const result = await createReadToolResultChunkTool().execute(
      { toolUseId: "toolu_123", offset: 500, maxChars: 500 },
      ctx(() => truncatedResult(content)),
    );
    expect(JSON.parse(result.output)).toMatchObject({
      startOffset: 500,
      endOffset: 620,
      nextOffset: null,
      hasMore: false,
      chunk: "x".repeat(120),
    });
  });

  it("finds a literal query at or after offset and continues after returned context", async () => {
    const content = `${"a".repeat(700)}needle.${"z".repeat(800)}`;
    const result = await createReadToolResultChunkTool().execute(
      { toolUseId: "toolu_123", offset: 600, query: "needle.", maxChars: 500 },
      ctx(() => truncatedResult(content)),
    );
    expect(JSON.parse(result.output)).toMatchObject({
      query: "needle.",
      found: true,
      offset: 600,
      matchOffset: 700,
      startOffset: 700,
      endOffset: 1_200,
      nextOffset: 1_200,
      nextOffsetMeaning: "continue after the returned context",
      chunk: content.slice(700, 1_200),
    });
  });

  it("reports a literal search miss without turning it into a tool error", async () => {
    const result = await createReadToolResultChunkTool().execute(
      { toolUseId: "toolu_123", offset: 20, query: "missing" },
      ctx(() => truncatedResult("x".repeat(800))),
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({
      found: false,
      offset: 20,
      matchOffset: null,
      startOffset: null,
      endOffset: null,
      nextOffset: null,
      nextOffsetMeaning: "no literal match at or after offset",
      hasMore: false,
      chunk: "",
    });
  });

  it("rejects removed and malformed arguments instead of accepting aliases", async () => {
    const tool = createReadToolResultChunkTool();
    const reader = ctx(() => truncatedResult("x".repeat(800)));
    for (const input of [
      { toolUseId: "toolu_123", chunkIndex: 0 },
      { toolUseId: "toolu_123", offset: 1.5 },
      { toolUseId: "toolu_123", maxChars: `${TOOL_RESULT_READ_MIN_CHARS}` },
      { toolUseId: "toolu_123", maxChars: TOOL_RESULT_READ_MIN_CHARS - 1 },
      { toolUseId: "toolu_123", maxChars: TOOL_RESULT_READ_MAX_CHARS + 1 },
      { toolUseId: "toolu_123", query: "" },
    ]) {
      const result = await tool.execute(input, reader);
      expect(result.isError).toBe(true);
    }
  });

  it("uses the shared 256-byte toolUseId contract", async () => {
    const tool = createReadToolResultChunkTool();
    const schema = tool.toJsonSchema() as {
      properties: { toolUseId: { maxLength: number } };
    };
    expect(schema.properties.toolUseId.maxLength).toBe(MAX_TOOL_USE_ID_UTF8_BYTES);

    const asciiId = "a".repeat(161);
    const ascii = await tool.execute(
      { toolUseId: asciiId },
      ctx(() => ({ ...truncatedResult("x".repeat(800)), toolUseId: asciiId })),
    );
    expect(ascii.isError).toBe(false);

    const boundaryId = "😀".repeat(64);
    const boundary = await tool.execute(
      { toolUseId: boundaryId },
      ctx(() => ({ ...truncatedResult("x".repeat(800)), toolUseId: boundaryId })),
    );
    expect(boundary.isError).toBe(false);

    const overBoundary = await tool.execute(
      { toolUseId: `${boundaryId}😀` },
      ctx(() => truncatedResult("x".repeat(800))),
    );
    expect(overBoundary.isError).toBe(true);
    expect(JSON.parse(overBoundary.output).error).toContain("256 UTF-8 bytes");
  });

  it("keeps the JSON wrapper under the ordinary output cap for escape-heavy content", async () => {
    const content = '\\\\"한'.repeat(4_000);
    const result = await createReadToolResultChunkTool().execute(
      { toolUseId: "toolu_123", maxChars: TOOL_RESULT_READ_MAX_CHARS },
      ctx(() => truncatedResult(content)),
    );
    const payload = JSON.parse(result.output) as { payloadLimited: boolean; chunk: string };
    expect(payload.payloadLimited).toBe(true);
    expect(payload.chunk.length).toBeGreaterThan(0);
    expect(estimateTokens(result.output)).toBeLessThanOrEqual(MAX_TOOL_RESULT_TOKENS);
    expect(trimOversizedToolResult(result.output).truncated).toBeUndefined();
  });

  it("fails closed when no current-session reader is available", async () => {
    const result = await createReadToolResultChunkTool().execute({ toolUseId: "toolu_123" }, ctx());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).error).toContain("not available");
  });

  it("refuses ordinary results and serialized stubs", async () => {
    const tool = createReadToolResultChunkTool();
    const ordinary = await tool.execute(
      { toolUseId: "toolu_123" },
      ctx(() => ({ toolUseId: "toolu_123", content: "already visible" })),
    );
    expect(ordinary.isError).toBe(true);

    const serialized = await tool.execute(
      { toolUseId: "toolu_123" },
      ctx(() => ({
        ...truncatedResult("[tool_result truncated by host: tool=bash]"),
        meta: { ...truncatedResult("").meta, serializedStub: true },
      })),
    );
    expect(serialized.isError).toBe(true);
    expect(JSON.parse(serialized.output).error).toContain("no longer available");
  });
});
