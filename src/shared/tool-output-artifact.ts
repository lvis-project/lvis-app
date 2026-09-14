import { UUID_PATTERN } from "./uuid.js";

/** Room for the 12,000-character shell preview and bounded completion annotations. */
export const MAX_TOOL_OUTPUT_PREVIEW_CHARS = 16_384;
export const MAX_TOOL_RESULT_ARTIFACT_BYTES = 5_000_000;
export const MAX_SESSION_TOOL_OUTPUT_BYTES = 20_000_000;
export const MAX_TOOL_OUTPUT_PENDING_BYTES = 262_144;

export interface ToolOutputArtifactInfo {
  version: 1;
  captureId: string;
  status: "complete" | "partial" | "unavailable";
  reason?: "artifact-limit" | "session-limit" | "write-failed" | "queue-limit" | "interrupted";
  capturedBytes: number;
  observedBytes: number;
  capturedChars: number;
  sha256?: string;
}

export interface ToolOutputCapture {
  /** Available before publication so the session owner can pin the reference. */
  readonly captureId: string;
  /** Session owner releases an output which will not enter durable history. */
  abandon?(): void;
  /** False asks the caller to pause both streams until waitForDrain settles. */
  append(chunk: Uint8Array): boolean;
  waitForDrain(): Promise<void>;
  finish(interrupted?: boolean): Promise<ToolOutputArtifactInfo>;
}

export type ToolOutputCaptureFactory = (toolUseId: string) => ToolOutputCapture;

const INFO_KEYS = new Set([
  "version", "captureId", "status", "reason", "capturedBytes", "observedBytes", "capturedChars", "sha256",
]);
const REASONS = new Set(["artifact-limit", "session-limit", "write-failed", "queue-limit", "interrupted"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Copies only the closed, bounded reference contract from persisted metadata. */
export function normalizeToolOutputArtifactInfo(value: unknown): ToolOutputArtifactInfo | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const info = value as Record<string, unknown>;
    if (Object.keys(info).some((key) => !INFO_KEYS.has(key))
      || info.version !== 1
      || typeof info.captureId !== "string" || !UUID_PATTERN.test(info.captureId)
      || !isByteCount(info.capturedBytes) || info.capturedBytes > MAX_TOOL_RESULT_ARTIFACT_BYTES
      || !isByteCount(info.observedBytes) || info.observedBytes < info.capturedBytes
      || !isByteCount(info.capturedChars) || info.capturedChars > info.capturedBytes
    ) return null;
    if (info.status === "complete") {
      if (info.reason !== undefined || info.capturedBytes !== info.observedBytes) return null;
    } else if (info.status === "partial" || info.status === "unavailable") {
      if (typeof info.reason !== "string" || !REASONS.has(info.reason)) return null;
      if (info.status === "partial" && info.capturedBytes === 0) return null;
    } else return null;
    if (info.status === "unavailable") {
      if (info.capturedBytes !== 0 || info.capturedChars !== 0 || info.sha256 !== undefined) return null;
    } else if (typeof info.sha256 !== "string" || !SHA256_PATTERN.test(info.sha256)) return null;
    return {
      version: 1,
      captureId: info.captureId,
      status: info.status,
      ...(info.reason === undefined ? {} : { reason: info.reason as ToolOutputArtifactInfo["reason"] }),
      capturedBytes: info.capturedBytes,
      observedBytes: info.observedBytes,
      capturedChars: info.capturedChars,
      ...(info.sha256 === undefined ? {} : { sha256: info.sha256 as string }),
    };
  } catch {
    return null;
  }
}
