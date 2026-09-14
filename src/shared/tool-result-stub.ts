import {
  buildHeadTailPreview,
  TOOL_RESULT_READ_DEFAULT_CHARS,
  TOOL_RESULT_READ_MAX_CHARS,
  TOOL_RESULT_READ_MIN_CHARS,
  TOOL_RESULT_WIRE_MAX_CHARS,
  TOOL_RESULT_WIRE_PREVIEW_CHARS,
} from "./bounded-tool-output.js";

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
  info: ToolResultTruncatedInfo,
  content: string | null,
  options?: { artifactUnavailable?: ToolResultArtifactUnavailableInfo },
): string {
  const normalizedName = (toolName ?? "?").replace(/[^A-Za-z0-9_-]/g, "?");
  const safeName = normalizedName.length > 128 ? `${normalizedName.slice(0, 127)}?` : normalizedName;
  const quotedToolUseId = JSON.stringify(toolUseId);
  const lineLabel = info.originalLines === -1 ? "scan-skipped" : `${info.originalLines}`;
  const tokenLabel = info.originalTokens === -1 ? "scan-skipped" : `${info.originalTokens}`;
  const originalChars = content?.length ?? info.originalBytes;
  const base =
    `[tool_result truncated by host:` +
    ` tool=${safeName},` +
    ` toolUseId=${quotedToolUseId},` +
    ` originalLines=${lineLabel},` +
    ` originalTokens=${tokenLabel},` +
    ` originalChars=${originalChars},` +
    ` originalBytes=${info.originalBytes}.`;
  const recovery = options?.artifactUnavailable
    ? ` The verbatim artifact was not retained because it exceeded the host artifact storage cap` +
      ` (${options.artifactUnavailable.maxBytes} bytes).`
    : ` The verbatim result remains available.` +
      ` Call read_tool_result_chunk with toolUseId=${quotedToolUseId} and offset=0.` +
      ` maxChars defaults to ${TOOL_RESULT_READ_DEFAULT_CHARS} and accepts` +
      ` ${TOOL_RESULT_READ_MIN_CHARS}..${TOOL_RESULT_READ_MAX_CHARS}.` +
      ` Continue from nextOffset, or pass a literal query with an offset to search.`;
  const previewEnvelope = "\nPreview of original output:\n<head>\n</head>\n<tail>\n</tail>\n<0000000000 chars omitted>";
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
      return `\nPreview of original output:\n<head>\n${preview.head}\n</head>`;
    }
    return `\nPreview of original output:\n<head>\n${preview.head}\n</head>` +
      `\n<${preview.omittedChars} chars omitted>` +
      `\n<tail>\n${preview.tail}\n</tail>`;
  };
  let previewText = formatPreview();
  const excess = base.length + previewText.length + recovery.length + 1 - TOOL_RESULT_WIRE_MAX_CHARS;
  if (excess > 0) {
    previewBudget = Math.max(0, previewBudget - excess);
    previewText = formatPreview();
  }
  return `${base}${previewText}${recovery}]`;
}

export function isToolResultStubContent(value: string): boolean {
  return (
    value.startsWith("[tool_result stripped:") ||
    value.startsWith("[tool_result truncated by host")
  );
}
