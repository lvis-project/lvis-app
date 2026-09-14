import { describe, expect, it } from "vitest";
import { buildToolResultTruncatedStub } from "../tool-result-stub.js";
import { TOOL_RESULT_WIRE_MAX_CHARS } from "../bounded-tool-output.js";
import { estimateTokens } from "../token-estimate.js";
import { MAX_TOOL_RESULT_TOKENS } from "../tool-result-trim.js";
import type { ToolOutputArtifactInfo } from "../tool-output-artifact.js";

function outputArtifact(status: ToolOutputArtifactInfo["status"]): ToolOutputArtifactInfo {
  return {
    version: 1,
    captureId: "3138f9c6-89f0-4645-85ea-2c205f9523f4",
    status,
    capturedBytes: status === "unavailable" ? 0 : 15_000,
    observedBytes: status === "complete" ? 15_000 : 30_000,
    capturedChars: status === "unavailable" ? 0 : 14_000,
    ...(status !== "unavailable" ? { sha256: "a".repeat(64) } : {}),
    ...(status === "partial" ? { reason: "artifact-limit" as const } : {}),
    ...(status === "unavailable" ? { reason: "session-limit" as const } : {}),
  };
}

describe("captured tool result stubs", () => {
  it("rejects an unaddressable stored tool identifier before projection", () => {
    expect(() => buildToolResultTruncatedStub("x".repeat(20_000), "bash", undefined, "preview", { outputArtifactUnavailable: true })).toThrow("tool use ID is invalid");
  });
  it("labels displayed content separately from complete captured bytes", () => {
    const result = buildToolResultTruncatedStub("toolu_capture", "bash", undefined, "display prefix", {
      outputArtifact: outputArtifact("complete"),
    });
    expect(result).toContain("captureStatus=complete");
    expect(result).toContain("capturedBytes=15000");
    expect(result).toContain("capturedChars=14000");
    expect(result).toContain("Preview of displayed output");
    expect(result).toContain("The complete captured output is available");
    expect(result).toContain("read_tool_result_chunk");
    expect(result).not.toContain("originalChars=14");
  });

  it("limits recovery claims to retained content for partial captures", () => {
    const result = buildToolResultTruncatedStub("toolu_capture", "bash", undefined, "prefix", {
      outputArtifact: outputArtifact("partial"),
    });
    expect(result).toContain("captureStatus=partial");
    expect(result).toContain("reason=artifact-limit");
    expect(result).toContain("complete command output was not captured");
    expect(result).toContain("hasMore describes the retained range");
    expect(result).toContain("read_tool_result_chunk");
    expect(result).not.toContain("The verbatim result remains available");
  });

  it("offers no artifact recovery when capture is unavailable", () => {
    const result = buildToolResultTruncatedStub("toolu_capture", "bash", undefined, "prefix", {
      outputArtifact: outputArtifact("unavailable"),
    });
    expect(result).toContain("captureStatus=unavailable");
    expect(result).toContain("no artifact can be recovered");
    expect(result).not.toContain("read_tool_result_chunk");
    expect(result).not.toContain("verbatim result remains available");
  });

  it.each(["complete", "partial", "unavailable"] as const)("keeps %s capture previews bounded with escaping and an opaque identifier", (status) => {
    const toolUseId = "\\\"".repeat(128);
    const result = buildToolResultTruncatedStub(toolUseId, "bash", undefined, "\u0001".repeat(10_000), {
      outputArtifact: outputArtifact(status),
    });
    expect(result.length).toBeLessThanOrEqual(TOOL_RESULT_WIRE_MAX_CHARS);
    expect(estimateTokens(JSON.stringify({
      role: "tool_result", toolUseId, toolName: "bash", content: result, isError: false,
    }))).toBeLessThanOrEqual(MAX_TOOL_RESULT_TOKENS);
  });

  it("rejects a stub without source metadata", () => {
    expect(() => buildToolResultTruncatedStub("toolu_capture", "bash", undefined, "prefix"))
      .toThrow("requires truncation metadata or an output capture");
  });
});
