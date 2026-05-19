import { describe, expect, it } from "vitest";

import {
  createReadToolResultChunkTool,
  TOOL_RESULT_CHUNK_READER_METADATA_KEY,
  type ReadableToolResult,
} from "../tool-result-chunk.js";
import type { ToolExecutionContext } from "../base.js";

function ctx(reader?: (toolUseId: string) => ReadableToolResult | null): ToolExecutionContext {
  return {
    cwd: "/tmp",
    extraAllowedDirectories: [],
    metadata: reader ? { [TOOL_RESULT_CHUNK_READER_METADATA_KEY]: reader } : {},
  };
}

describe("read_tool_result_chunk", () => {
  it("returns a bounded chunk from a host-truncated in-memory tool_result", async () => {
    const content = "abcdefghijklmnopqrstuvwxyz".repeat(50);
    const tool = createReadToolResultChunkTool();
    const result = await tool.execute(
      { toolUseId: "toolu_123", chunkIndex: 1, maxChars: 500 },
      ctx((toolUseId) => ({
        toolUseId,
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
      })),
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      toolUseId: "toolu_123",
      toolName: "long_output_query",
      chunkIndex: 1,
      chunkCount: 3,
      startChar: 500,
      endChar: 1000,
      hasMore: true,
      chunk: content.slice(500, 1000),
    });
  });

  it("fails closed when no current-session reader is available", async () => {
    const tool = createReadToolResultChunkTool();
    const result = await tool.execute({ toolUseId: "toolu_123" }, ctx());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).error).toContain("not available");
  });

  it("refuses ordinary tool results that were not host-truncated or compacted", async () => {
    const tool = createReadToolResultChunkTool();
    const result = await tool.execute(
      { toolUseId: "toolu_123" },
      ctx((toolUseId) => ({
        toolUseId,
        toolName: "bash",
        content: "already visible",
      })),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).error).toContain("not host-truncated");
  });

  it("reports unavailable when only a serialized stub remains", async () => {
    const tool = createReadToolResultChunkTool();
    const result = await tool.execute(
      { toolUseId: "toolu_123" },
      ctx((toolUseId) => ({
        toolUseId,
        toolName: "bash",
        content: "[tool_result truncated by host (Issue #902): tool=bash]",
        meta: {
          truncated: {
            originalLines: 200,
            originalTokens: 5000,
            originalBytes: 30000,
            trimmedAt: "2026-05-19T00:00:00.000Z",
          },
          serializedStub: true,
        },
      })),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).error).toContain("no longer available");
  });

  it("allows raw host-truncated content that happens to start with a stub prefix", async () => {
    const content = `[tool_result truncated by host but this is real output]\n${"row\n".repeat(200)}`;
    const tool = createReadToolResultChunkTool();
    const result = await tool.execute(
      { toolUseId: "toolu_prefix", chunkIndex: 0, maxChars: 500 },
      ctx((toolUseId) => ({
        toolUseId,
        toolName: "long_output_query",
        content,
        meta: {
          truncated: {
            originalLines: 201,
            originalTokens: 600,
            originalBytes: content.length,
            trimmedAt: "2026-05-19T00:00:00.000Z",
          },
        },
      })),
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({
      toolUseId: "toolu_prefix",
      chunk: content.slice(0, 500),
    });
  });
});
