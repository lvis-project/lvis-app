/**
 * Tool pipeline — display/DLP masking + callback emission + approval-cache key.
 *
 * Pure helpers factored out of `executor.ts` (C7 decomposition). These mask the
 * tool input shown to the renderer/audit, derive the per-invocation approval
 * cache key, and fan tool-start / permission-review events out to the executor
 * callbacks. No executor state is touched.
 */
import { maskSensitiveData } from "../../audit/dlp-filter.js";
import type { PermissionReviewEvent } from "../../shared/permission-review-status.js";
import type { Tool } from "../base.js";
import type {
  ToolCallMeta,
  ToolExecutorCallbacks,
} from "../executor.js";

function maskDisplayValue(value: unknown): unknown {
  if (typeof value === "string") {
    return maskSensitiveData(value).masked;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskDisplayValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, maskDisplayValue(item)]),
    );
  }
  return value;
}

export function maskToolInputForDisplay(input: Record<string, unknown>): Record<string, unknown> {
  return maskDisplayValue(input) as Record<string, unknown>;
}

export function summarizeInputForDeferred(input: Record<string, unknown>): string {
  try {
    return maskSensitiveData(JSON.stringify(input)).masked.slice(0, 1000);
  } catch {
    return "[unserializable input]";
  }
}

export function approvalCacheKeyFor(
  tool: Tool,
  input: Record<string, unknown>,
  cwd: string,
): string | undefined {
  const rawKey = tool.approvalCacheKey?.(input, { cwd });
  if (rawKey === undefined) return undefined;
  const key = rawKey.trim();
  if (!key) {
    throw new Error(`approvalCacheKey for ${tool.name} returned an empty key`);
  }
  return `${tool.name}:${key}`;
}

export function emitToolStart(
  callbacks: ToolExecutorCallbacks | undefined,
  name: string,
  input: Record<string, unknown>,
  meta: ToolCallMeta,
): void {
  callbacks?.onToolStart?.(name, maskToolInputForDisplay(input), meta);
}

export function emitPermissionReview(
  callbacks: ToolExecutorCallbacks | undefined,
  event: PermissionReviewEvent,
): void {
  callbacks?.onPermissionReview?.(event);
}
