export interface ToolResultTruncatedInfo {
  originalLines: number;
  originalTokens: number;
  originalBytes: number;
  trimmedAt: string;
}

export function buildToolResultStrippedStub(toolName: string | undefined, origLen: number): string {
  return `[tool_result stripped: tool=${toolName ?? "?"}, origLen=${origLen}]`;
}

export function buildToolResultTruncatedStub(
  toolUseId: string,
  toolName: string | undefined,
  info: ToolResultTruncatedInfo,
): string {
  const safeName = (toolName ?? "?").replace(/[^A-Za-z0-9_-]/g, "?");
  const safeToolUseId = toolUseId.replace(/[^A-Za-z0-9_.:-]/g, "?");
  const lineLabel = info.originalLines === -1 ? "scan-skipped" : `${info.originalLines}`;
  const tokenLabel = info.originalTokens === -1 ? "scan-skipped" : `${info.originalTokens}`;
  return (
    `[tool_result truncated by host (Issue #902):` +
    ` tool=${safeName},` +
    ` toolUseId=${safeToolUseId},` +
    ` originalLines=${lineLabel},` +
    ` originalTokens=${tokenLabel},` +
    ` originalBytes=${info.originalBytes}.` +
    ` The full response exceeded the per-result size cap` +
    ` and was dropped from provider history to protect TPM / context window.` +
    ` The current session keeps the verbatim result in a file-backed artifact.` +
    ` Call read_tool_result_chunk with toolUseId="${safeToolUseId}" and chunkIndex=0, then increment chunkIndex while hasMore=true.]`
  );
}

export function isToolResultStubContent(value: string): boolean {
  return (
    value.startsWith("[tool_result stripped:") ||
    value.startsWith("[tool_result truncated by host")
  );
}
