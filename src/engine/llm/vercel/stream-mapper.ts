/**
 * Vercel AI SDK fullStream → LVIS StreamEvent mapper.
 *
 * P1 — Gemini path:
 *   - 'text-delta'      → { type: 'text_delta', text }
 *   - 'reasoning-delta' → { type: 'reasoning_delta', text } (Gemini doesn't emit)
 *   - 'tool-call'       → { type: 'tool_call', id, name, input }
 *   - 'finish'          → { type: 'message_complete', stopReason, usage }
 *   - 'error'           → { type: 'error', error }
 *
 * P3 — Claude signature capture:
 *   Anthropic extended-thinking emits reasoning-start/delta/end per block.
 *   The signature arrives on reasoning-end's providerMetadata.anthropic.signature
 *   (per Vercel AI SDK v6 — PR #11688 merged 2026-01-13, pinned ai@~6.0.168).
 *
 *   CRITICAL (per design doc §5.2 P3): signatures MUST be consumed from
 *   fullStream events, NEVER from onFinish() callbacks or result.response.messages
 *   aggregation — those paths have been observed to drop signatures (#12433).
 *
 *   Per-block accumulation: key = reasoning block id; attach signature on
 *   reasoning-end; emit thinkingBlocks[] on final `message_complete`. Blocks
 *   whose signature is missing/empty are dropped by extractSignatureSafely
 *   (log-and-skip — Anthropic rejects tampered thinking-block echoes).
 */
import type { StreamEvent, ThinkingBlock } from "../types.js";
import { extractSignatureSafely } from "./signature-shim.js";
import { createLogger } from "../../../lib/logger.js";
const log = createLogger("stream-mapper");

type AnyPart = Record<string, unknown> & { type: string };

type UsageRaw = {
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedInputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
};

export async function* fullStreamToStreamEvent(
  stream: AsyncIterable<AnyPart>,
): AsyncIterable<StreamEvent> {
  let hasToolCalls = false;

  // Per-reasoning-block accumulator. Key = block id. Value = accumulated text.
  const reasoningBuffers = new Map<string, string>();
  // Completed thinking blocks (signature verified) across the whole turn.
  const thinkingBlocks: ThinkingBlock[] = [];

  for await (const part of stream) {
    switch (part.type) {
      case "start": {
        // Generator is single-use per turn; reset sticky state defensively in
        // case an SDK wrapper restarts the stream within the same instance.
        hasToolCalls = false;
        break;
      }
      case "text-delta": {
        const text = (part as { text?: string }).text ?? "";
        if (text) yield { type: "text_delta", text };
        break;
      }
      case "reasoning-start": {
        const id = (part as { id?: string }).id ?? "";
        if (id && reasoningBuffers.has(id)) {
          // eslint-disable-next-line no-console
          log.warn(
            `duplicate reasoning-start id ${id} — deltas will merge`,
          );
        } else if (id) {
          reasoningBuffers.set(id, "");
        }
        break;
      }
      case "reasoning-delta": {
        const text = (part as { text?: string }).text ?? "";
        const id = (part as { id?: string }).id ?? "";
        if (text) yield { type: "reasoning_delta", text };
        if (id) {
          reasoningBuffers.set(id, (reasoningBuffers.get(id) ?? "") + text);
        }
        break;
      }
      case "reasoning-end": {
        const id = (part as { id?: string }).id ?? "";
        if (!reasoningBuffers.has(id)) {
          // eslint-disable-next-line no-console
          log.warn(
            `reasoning-end for unknown id ${id}`,
          );
          break;
        }
        const thinking = reasoningBuffers.get(id) ?? "";
        reasoningBuffers.delete(id);
        const signature = extractSignatureSafely(part);
        if (signature !== null) {
          thinkingBlocks.push({ thinking, signature });
        }
        // Missing-signature case: log-and-skip (already logged inside shim).
        break;
      }
      case "tool-call": {
        const p = part as unknown as {
          toolCallId: string;
          toolName: string;
          input: unknown;
        };
        hasToolCalls = true;
        yield {
          type: "tool_call",
          id: p.toolCallId,
          name: p.toolName,
          input: (p.input ?? {}) as Record<string, unknown>,
        };
        break;
      }
      case "finish": {
        const p = part as {
          finishReason?: string;
          totalUsage?: UsageRaw;
          usage?: UsageRaw;
          providerMetadata?: {
            anthropic?: {
              cacheCreationInputTokens?: number;
              cacheReadInputTokens?: number;
            };
          };
        };
        // Honor finishReason explicitly when present; fallback to sticky
        // hasToolCalls only when finishReason is missing.
        let stopReason: "tool_use" | "end_turn";
        if (p.finishReason === "tool-calls") {
          stopReason = "tool_use";
        } else if (p.finishReason) {
          stopReason = "end_turn";
        } else {
          stopReason = hasToolCalls ? "tool_use" : "end_turn";
        }
        // v5 exposes totalUsage; v4 exposed usage. Accept either and tolerate
        // both inputTokens/outputTokens (v5) and promptTokens/completionTokens (v4).
        const usageRaw = p.totalUsage ?? p.usage;
        const cacheReadTokens =
          p.providerMetadata?.anthropic?.cacheReadInputTokens ??
          usageRaw?.inputTokenDetails?.cacheReadTokens ??
          usageRaw?.cachedInputTokens;
        const cacheWriteTokens =
          p.providerMetadata?.anthropic?.cacheCreationInputTokens ??
          usageRaw?.inputTokenDetails?.cacheWriteTokens;
        const usage = usageRaw
          ? {
              inputTokens:
                usageRaw.inputTokens ?? usageRaw.promptTokens ?? 0,
              outputTokens:
                usageRaw.outputTokens ?? usageRaw.completionTokens ?? 0,
              ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
              ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
            }
          : undefined;
        yield {
          type: "message_complete",
          stopReason,
          ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
          usage,
        };
        break;
      }
      case "error": {
        const err = (part as { error?: unknown }).error;
        let msg: string;
        if (err instanceof Error) {
          msg = err.message;
        } else if (typeof err === "string") {
          msg = err;
        } else {
          // JSON.stringify can throw on circular refs / BigInt; fall back to String().
          try {
            msg = JSON.stringify(err);
          } catch {
            msg = String(err);
          }
        }
        yield { type: "error", error: msg };
        break;
      }
      default:
        // Ignore non-essential parts (start, start-step, finish-step,
        // text-start/end, tool-input-*, raw, etc.)
        break;
    }
  }
}
