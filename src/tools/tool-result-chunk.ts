import { createDynamicTool, type Tool } from "./base.js";
import type { GenericMessage } from "../engine/llm/types.js";

export const READ_TOOL_RESULT_CHUNK_TOOL = "read_tool_result_chunk";
export const TOOL_RESULT_CHUNK_READER_METADATA_KEY = "toolResultChunkReader";

export const TOOL_RESULT_CHUNK_DEFAULT_CHARS = 3_000;
export const TOOL_RESULT_CHUNK_MIN_CHARS = 500;
export const TOOL_RESULT_CHUNK_MAX_CHARS = 5_000;

export interface ReadableToolResult {
  toolUseId: string;
  toolName?: string;
  content: string;
  isError?: boolean;
  meta?: GenericMessage["meta"];
}

export type ToolResultChunkReader = (toolUseId: string) => ReadableToolResult | null;

function parseBoundedInteger(
  raw: unknown,
  defaultValue: number,
  min: number,
  max: number,
  label: string,
): number {
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return Math.floor(n);
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

function getReader(metadata: Record<string, unknown>): ToolResultChunkReader | null {
  const candidate = metadata[TOOL_RESULT_CHUNK_READER_METADATA_KEY];
  return typeof candidate === "function" ? candidate as ToolResultChunkReader : null;
}

function unavailable(message: string): { output: string; isError: true } {
  return {
    output: JSON.stringify({ error: message }),
    isError: true,
  };
}

export function createReadToolResultChunkTool(): Tool {
  return createDynamicTool({
    name: READ_TOOL_RESULT_CHUNK_TOOL,
    description:
      "Reads a bounded chunk from a previous oversized tool_result in the current chat session. " +
      "Use only when a prior tool result says it was truncated by the host and includes a toolUseId. " +
      "Pass that toolUseId, then increase chunkIndex while hasMore=true. This works for builtin, plugin, and MCP tool results across LLM providers.",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["toolUseId"],
      properties: {
        toolUseId: {
          type: "string",
          minLength: 1,
          maxLength: 160,
          description: "The toolUseId shown in the host-truncated tool_result stub.",
        },
        chunkIndex: {
          type: "integer",
          minimum: 0,
          description: "0-based chunk index. Start with 0, then increment while hasMore is true.",
        },
        maxChars: {
          type: "integer",
          minimum: TOOL_RESULT_CHUNK_MIN_CHARS,
          maximum: TOOL_RESULT_CHUNK_MAX_CHARS,
          description: `Maximum characters to return in this chunk. Default ${TOOL_RESULT_CHUNK_DEFAULT_CHARS}.`,
        },
      },
      additionalProperties: false,
    },
    execute: async (rawInput, ctx) => {
      const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? rawInput as Record<string, unknown>
        : {};
      const toolUseId = typeof input.toolUseId === "string" ? input.toolUseId.trim() : "";
      if (!toolUseId) {
        return unavailable("toolUseId is required");
      }

      let chunkIndex: number;
      let maxChars: number;
      try {
        chunkIndex = parseBoundedInteger(input.chunkIndex, 0, 0, Number.MAX_SAFE_INTEGER, "chunkIndex");
        maxChars = parseBoundedInteger(
          input.maxChars,
          TOOL_RESULT_CHUNK_DEFAULT_CHARS,
          TOOL_RESULT_CHUNK_MIN_CHARS,
          TOOL_RESULT_CHUNK_MAX_CHARS,
          "maxChars",
        );
      } catch (err) {
        return unavailable(err instanceof Error ? err.message : String(err));
      }

      const reader = getReader(ctx.metadata);
      if (!reader) {
        return unavailable("tool result chunk reader is not available in this execution context");
      }
      const result = reader(toolUseId);
      if (!result) {
        return unavailable("toolUseId was not found in the current in-memory session");
      }
      if (result.meta?.truncated === undefined && result.meta?.compactedAt === undefined) {
        return unavailable("tool result is not host-truncated or compacted");
      }
      if (
        result.content.startsWith("[tool_result stripped:") ||
        result.content.startsWith("[tool_result truncated by host")
      ) {
        return unavailable("verbatim tool result is no longer available; the session likely reloaded from disk");
      }

      const chunkCount = Math.max(1, Math.ceil(result.content.length / maxChars));
      if (chunkIndex >= chunkCount) {
        return unavailable(`chunkIndex out of range; expected 0..${chunkCount - 1}`);
      }
      const start = chunkIndex * maxChars;
      const end = Math.min(result.content.length, start + maxChars);
      const chunk = result.content.slice(start, end);
      return {
        output: JSON.stringify({
          toolUseId,
          toolName: result.toolName ?? null,
          chunkIndex,
          chunkCount,
          maxChars,
          startChar: start,
          endChar: end,
          hasMore: end < result.content.length,
          originalBytes: result.meta?.truncated?.originalBytes ?? result.content.length,
          originalLines: result.meta?.truncated?.originalLines ?? countLines(result.content),
          chunk,
        }),
        isError: false,
      };
    },
  });
}
