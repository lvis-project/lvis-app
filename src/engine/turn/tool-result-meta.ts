import type { MessageMeta } from "../llm/types.js";
import type { ToolCallMeta, ToolResult } from "../../tools/executor.js";
import type { PermissionReviewEvent } from "../../shared/permission-review-status.js";

/** A knowledge-cap blocked result — no execution, so no timing or verdict. */
type BlockedToolResult = { tool_use_id: string; content: string; is_error: boolean };

/**
 * Renderer metadata for one persisted tool_result: display fields for the tool
 * row plus the permission verdict for that call. Both are what a reloaded
 * transcript rebuilds the row from, so they are assembled in one place.
 */
export function toolResultMeta(
  result: ToolResult | BlockedToolResult,
  callMeta: ToolCallMeta | undefined,
  review: PermissionReviewEvent | undefined,
): MessageMeta | undefined {
  const toolDisplay = "durationMs" in result
    ? {
        durationMs: result.durationMs,
        ...(callMeta?.source ? { source: callMeta.source } : {}),
        ...(callMeta?.category ? { category: callMeta.category } : {}),
        ...(callMeta?.pluginId ? { pluginId: callMeta.pluginId } : {}),
        ...(callMeta?.mcpServerId ? { mcpServerId: callMeta.mcpServerId } : {}),
        ...(callMeta?.cancelled ? { cancelled: true } : {}),
        ...("uiPayload" in result && result.uiPayload ? { uiPayload: result.uiPayload } : {}),
      }
    : undefined;
  const permissionReview = review
    ? {
        status: review.status,
        ...(review.verdictLevel ? { verdictLevel: review.verdictLevel } : {}),
        ...(review.reason ? { reason: review.reason } : {}),
      }
    : undefined;
  if (!toolDisplay && !permissionReview) return undefined;
  return {
    ...(toolDisplay ? { toolDisplay } : {}),
    ...(permissionReview ? { permissionReview } : {}),
  };
}
