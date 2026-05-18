import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_RESULT_LINES,
  MAX_TOOL_RESULT_TOKENS,
  trimOversizedToolResult,
} from "../tool-result-trim.js";

describe("trimOversizedToolResult (Issue #902)", () => {
  it("passes small content unchanged (no truncated info)", () => {
    const result = trimOversizedToolResult("hello\nworld", "bash");
    expect(result.truncated).toBeUndefined();
  });

  it("passes content right at the line limit", () => {
    const lines = Array.from({ length: MAX_TOOL_RESULT_LINES }, (_, i) => `line ${i}`).join("\n");
    const result = trimOversizedToolResult(lines, "bash");
    expect(result.truncated).toBeUndefined();
  });

  it("trips truncated when line count exceeds the line limit", () => {
    const lines = Array.from({ length: MAX_TOOL_RESULT_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
    const result = trimOversizedToolResult(lines, "index_documents");
    expect(result.truncated).toBeDefined();
    expect(result.truncated!.originalLines).toBe(MAX_TOOL_RESULT_LINES + 1);
    expect(result.truncated!.originalBytes).toBe(lines.length);
    expect(result.truncated!.originalTokens).toBeGreaterThan(0);
  });

  it("trips truncated on single-line content above token limit (long-line shape)", () => {
    // ~12K bytes of a single line, well over MAX_TOOL_RESULT_TOKENS (2_000)
    const oneLong = "x".repeat(12_000);
    const result = trimOversizedToolResult(oneLong, "minified_json_dump");
    expect(result.truncated).toBeDefined();
    expect(result.truncated!.originalLines).toBe(1);
    expect(result.truncated!.originalTokens).toBeGreaterThan(MAX_TOOL_RESULT_TOKENS);
  });

  it("trimmedAt is a valid ISO timestamp", () => {
    const lines = Array.from({ length: MAX_TOOL_RESULT_LINES + 1 }, () => "x").join("\n");
    const result = trimOversizedToolResult(lines, "any");
    expect(result.truncated!.trimmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isNaN(Date.parse(result.truncated!.trimmedAt))).toBe(false);
  });

  it("empty content passes unchanged", () => {
    const result = trimOversizedToolResult("", "bash");
    expect(result.truncated).toBeUndefined();
  });
});
