import {
  buildHeadTailPreview,
  TOOL_RESULT_READ_DEFAULT_CHARS,
  TOOL_RESULT_READ_MAX_CHARS,
  TOOL_RESULT_READ_MIN_CHARS,
  TOOL_RESULT_WIRE_MAX_CHARS,
  TOOL_RESULT_WIRE_PREVIEW_CHARS,
} from "./bounded-tool-output.js";
import { estimateTokens } from "./token-estimate.js";
import { MAX_TOOL_RESULT_TOKENS } from "./tool-result-trim.js";
import type { ToolOutputArtifactInfo } from "./tool-output-artifact.js";

export interface ToolResultTruncatedInfo {
  originalLines: number;
  originalTokens: number;
  originalBytes: number;
  trimmedAt: string;
}

export interface ToolResultArtifactUnavailableInfo {
  reason: "artifact-too-large";
  maxBytes: number;
}

export function buildToolResultStrippedStub(toolName: string | undefined, origLen: number): string {
  return `[tool_result stripped: tool=${toolName ?? "?"}, origLen=${origLen}]`;
}

export function buildToolResultTruncatedStub(
  toolUseId: string,
  toolName: string | undefined,
  info: ToolResultTruncatedInfo | undefined,
  content: string | null,
  options?: {
    artifactUnavailable?: ToolResultArtifactUnavailableInfo;
    outputArtifact?: ToolOutputArtifactInfo;
  },
): string {
  const capture = options?.outputArtifact;
  if (!capture && !info) throw new Error("tool result stub requires truncation metadata or an output capture");
  const normalizedName = (toolName ?? "?").replace(/[^A-Za-z0-9_-]/g, "?");
  const safeName = normalizedName.length > 128 ? `${normalizedName.slice(0, 127)}?` : normalizedName;
  const quotedToolUseId = JSON.stringify(toolUseId);
  const heading =
    `[tool_result truncated by host:` +
    ` tool=${safeName},` +
    ` toolUseId=${quotedToolUseId},`;
  const base = capture
    ? heading + ` captureStatus=${capture.status}, capturedBytes=${capture.capturedBytes},` +
      ` observedBytes=${capture.observedBytes}, capturedChars=${capture.capturedChars}` +
      `${capture.reason ? `, reason=${capture.reason}` : ""}.`
    : heading +
      ` originalLines=${info!.originalLines === -1 ? "scan-skipped" : info!.originalLines},` +
      ` originalTokens=${info!.originalTokens === -1 ? "scan-skipped" : info!.originalTokens},` +
      ` originalChars=${content?.length ?? info!.originalBytes},` +
      ` originalBytes=${info!.originalBytes}.`;
  const readInstructions =
    ` Call read_tool_result_chunk with toolUseId=${quotedToolUseId} and offset=0.` +
    ` maxChars defaults to ${TOOL_RESULT_READ_DEFAULT_CHARS} and accepts` +
    ` ${TOOL_RESULT_READ_MIN_CHARS}..${TOOL_RESULT_READ_MAX_CHARS}.` +
    ` Continue from nextOffset, or pass a literal query with an offset to search.`;
  let recovery: string;
  if (capture?.status === "unavailable") {
    recovery = " The captured output is unavailable; no artifact can be recovered.";
  } else if (capture?.status === "partial") {
    recovery = " Only the retained portion is available; the complete command output was not captured." +
      readInstructions + " hasMore describes the retained range, not source completeness.";
  } else if (capture) {
    recovery = " The complete captured output is available." + readInstructions;
  } else if (options?.artifactUnavailable) {
    recovery = ` The verbatim artifact was not retained because it exceeded the host artifact storage cap` +
      ` (${options.artifactUnavailable.maxBytes} bytes).`;
  } else {
    recovery = " The verbatim result remains available." + readInstructions;
  }
  const previewLabel = capture ? "Preview of displayed output" : "Preview of original output";
  const previewEnvelope = `\n${previewLabel}:\n<head>\n</head>\n<tail>\n</tail>\n<0000000000 chars omitted>`;
  let previewBudget = Math.max(
    0,
    Math.min(
      TOOL_RESULT_WIRE_PREVIEW_CHARS,
      TOOL_RESULT_WIRE_MAX_CHARS - base.length - recovery.length - previewEnvelope.length - 1,
    ),
  );
  const formatPreview = (): string => {
    const preview = content === null ? null : buildHeadTailPreview(content, previewBudget);
    if (preview === null) return "";
    if (preview.tail.length === 0) {
      return `\n${previewLabel}:\n<head>\n${preview.head}\n</head>`;
    }
    return `\n${previewLabel}:\n<head>\n${preview.head}\n</head>` +
      `\n<${preview.omittedChars} chars omitted>` +
      `\n<tail>\n${preview.tail}\n</tail>`;
  };
  const buildStub = (): string => `${base}${formatPreview()}${recovery}]`;
  let stub = buildStub();
  const excess = stub.length - TOOL_RESULT_WIRE_MAX_CHARS;
  if (excess > 0) {
    previewBudget = Math.max(0, previewBudget - excess);
    stub = buildStub();
  }
  while (
    estimateTokens(JSON.stringify({
      role: "tool_result",
      toolUseId,
      toolName: toolName ?? "",
      content: stub,
      isError: false,
    })) > MAX_TOOL_RESULT_TOKENS &&
    previewBudget > 0
  ) {
    previewBudget = Math.floor(previewBudget * 0.8);
    stub = buildStub();
  }
  return stub;
}

export function isToolResultStubContent(value: string): boolean {
  return (
    value.startsWith("[tool_result stripped:") ||
    value.startsWith("[tool_result truncated by host")
  );
}
