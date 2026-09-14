import { createDynamicTool, type Tool } from "./base.js";
import type { GenericMessage } from "../engine/llm/types.js";
import { errorMessage } from "../shared/error-message.js";
import {
  containsUnpairedSurrogate,
  isUnicodeBoundary,
  readBoundedTextWindow,
  TOOL_RESULT_QUERY_MAX_CHARS,
  TOOL_RESULT_READ_DEFAULT_CHARS,
  TOOL_RESULT_READ_MAX_CHARS,
  TOOL_RESULT_READ_MIN_CHARS,
} from "../shared/bounded-tool-output.js";
import { estimateTokens } from "../shared/token-estimate.js";
import { MAX_TOOL_RESULT_TOKENS } from "../shared/tool-result-trim.js";
import { isValidToolUseId, MAX_TOOL_USE_ID_UTF8_BYTES } from "../shared/tool-use-id.js";
import type { ToolOutputArtifactInfo } from "../shared/tool-output-artifact.js";

export const READ_TOOL_RESULT_CHUNK_TOOL = "read_tool_result_chunk";
export const TOOL_RESULT_CHUNK_READER_METADATA_KEY = "toolResultChunkReader";

export interface ReadableToolResult {
  toolUseId: string;
  toolName?: string;
  content: string;
  isError?: boolean;
  meta?: GenericMessage["meta"];
  outputArtifact?: ToolOutputArtifactInfo;
  artifactReadUnavailable?: boolean;
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
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return raw;
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

function unavailable(message: string, details?: Record<string, unknown>): { output: string; isError: true } {
  return {
    output: JSON.stringify({ error: message, ...details }),
    isError: true,
  };
}

function boundedResponse(payload: Record<string, unknown>) {
  const output = JSON.stringify(payload);
  return estimateTokens(output) <= MAX_TOOL_RESULT_TOKENS
    ? { output, isError: false }
    : unavailable("tool result response metadata exceeds the bounded payload budget");
}

export function createReadToolResultChunkTool(): Tool {
  return createDynamicTool({
    name: READ_TOOL_RESULT_CHUNK_TOOL,
    description:
      "Reads bounded text from a previous oversized tool_result or captured shell output in the current chat session. " +
      "Pass its toolUseId and an absolute offset, or add a literal query to find the first match at or after that offset. " +
      `Continue from nextOffset when it is not null. maxChars defaults to ${TOOL_RESULT_READ_DEFAULT_CHARS}` +
      ` and accepts ${TOOL_RESULT_READ_MIN_CHARS}..${TOOL_RESULT_READ_MAX_CHARS}.` +
      " This works for builtin, plugin, and MCP tool results across LLM providers.",
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
          maxLength: MAX_TOOL_USE_ID_UTF8_BYTES,
          description: `The toolUseId shown in the host-truncated tool_result stub, up to ${MAX_TOOL_USE_ID_UTF8_BYTES} UTF-8 bytes.`,
        },
        offset: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "Absolute UTF-16 offset. Default 0. Must not split a Unicode surrogate pair.",
        },
        maxChars: {
          type: "integer",
          minimum: TOOL_RESULT_READ_MIN_CHARS,
          maximum: TOOL_RESULT_READ_MAX_CHARS,
          default: TOOL_RESULT_READ_DEFAULT_CHARS,
          description: `Maximum characters to return. Default ${TOOL_RESULT_READ_DEFAULT_CHARS}.`,
        },
        query: {
          type: "string",
          minLength: 1,
          maxLength: TOOL_RESULT_QUERY_MAX_CHARS,
          description: "Optional literal text to find at or after offset. Regular expressions are not supported.",
        },
      },
      additionalProperties: false,
    },
    execute: async (rawInput, ctx) => {
      const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? rawInput as Record<string, unknown>
        : {};
      const allowedKeys = new Set(["toolUseId", "offset", "maxChars", "query"]);
      const unknownKey = Object.keys(input).find((key) => !allowedKeys.has(key));
      if (unknownKey) {
        return unavailable(`unknown argument: ${unknownKey}`);
      }
      if (!isValidToolUseId(input.toolUseId)) {
        return unavailable(
          `toolUseId must be non-empty, contain no control characters, and use at most ${MAX_TOOL_USE_ID_UTF8_BYTES} UTF-8 bytes`,
        );
      }
      const toolUseId = input.toolUseId;

      let offset: number;
      let maxChars: number;
      try {
        offset = parseBoundedInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset");
        maxChars = parseBoundedInteger(
          input.maxChars,
          TOOL_RESULT_READ_DEFAULT_CHARS,
          TOOL_RESULT_READ_MIN_CHARS,
          TOOL_RESULT_READ_MAX_CHARS,
          "maxChars",
        );
      } catch (err) {
        return unavailable(errorMessage(err));
      }

      const reader = getReader(ctx.metadata);
      if (!reader) {
        return unavailable("tool result chunk reader is not available in this execution context");
      }
      const result = reader(toolUseId);
      if (!result) {
        return unavailable("toolUseId was not found in the current in-memory session");
      }
      const toolName = typeof result.toolName === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(result.toolName)
        ? result.toolName : null;
      const capture = result.outputArtifact;
      const captureDetails = {
        captureStatus: capture?.status ?? null,
        sourceComplete: capture ? capture.status === "complete" : null,
        capturedBytes: capture?.capturedBytes ?? null,
        observedBytes: capture?.observedBytes ?? null,
        ...(capture?.reason ? { captureReason: capture.reason } : {}),
      };
      if (capture?.status === "unavailable" || result.artifactReadUnavailable) {
        return unavailable("captured tool output is unavailable for recovery", {
          toolUseId,
          ...captureDetails,
          artifactReadUnavailable: result.artifactReadUnavailable === true,
        });
      }
      if (!capture && result.meta?.truncated === undefined && result.meta?.compactedAt === undefined) {
        return unavailable("tool result is not host-truncated or compacted");
      }
      if (
        !capture &&
        result.meta?.serializedStub === true &&
        (result.content.startsWith("[tool_result stripped:") ||
          result.content.startsWith("[tool_result truncated by host"))
      ) {
        return unavailable("verbatim tool result is no longer available; the session likely reloaded from disk");
      }

      if (offset > result.content.length) {
        return unavailable(`offset out of range; expected 0..${result.content.length}`);
      }
      if (!isUnicodeBoundary(result.content, offset)) {
        return unavailable("offset must not split a Unicode surrogate pair");
      }
      const query = input.query;
      if (query !== undefined && (
        typeof query !== "string" ||
        query.length === 0 ||
        query.length > TOOL_RESULT_QUERY_MAX_CHARS ||
        containsUnpairedSurrogate(query)
      )) {
        return unavailable(`query must be a non-empty Unicode string of at most ${TOOL_RESULT_QUERY_MAX_CHARS} characters`);
      }

      const matchOffset = typeof query === "string" ? result.content.indexOf(query, offset) : null;
      if (typeof query === "string" && matchOffset === -1) {
        return boundedResponse({
          toolUseId,
          toolName,
          query,
          found: false,
          offset,
          matchOffset: null,
          startOffset: null,
          endOffset: null,
          nextOffset: null,
          nextOffsetMeaning: "no literal match at or after offset",
          hasMore: false,
          hasMoreMeaning: "matching content remaining in the retained range, not source completeness",
          ...captureDetails,
          totalChars: result.content.length,
          chunk: "",
        });
      }

      const startOffset = matchOffset === null ? offset : matchOffset;
      let window = readBoundedTextWindow(result.content, startOffset, maxChars);
      let payloadLimited = false;
      const buildPayload = () => ({
        toolUseId,
        toolName,
        ...(typeof query === "string" ? { query, found: true, matchOffset } : {}),
        offset,
        requestedMaxChars: maxChars,
        startOffset: window.startOffset,
        endOffset: window.endOffset,
        nextOffset: window.nextOffset,
        nextOffsetMeaning: "continue after the returned context",
        hasMore: window.hasMore,
        hasMoreMeaning: "content remaining in the retained range, not source completeness",
        ...captureDetails,
        totalChars: result.content.length,
        ...(!capture ? {
          originalBytes: result.meta?.truncated?.originalBytes ?? result.content.length,
          originalLines: result.meta?.truncated?.originalLines ?? countLines(result.content),
        } : {}),
        payloadLimited,
        chunk: window.text,
      });
      while (estimateTokens(JSON.stringify(buildPayload())) > MAX_TOOL_RESULT_TOKENS && window.text.length > 1) {
        payloadLimited = true;
        window = readBoundedTextWindow(
          result.content,
          startOffset,
          Math.max(1, Math.floor(window.text.length * 0.8)),
        );
      }
      return boundedResponse(buildPayload());
    },
  });
}
