/**
 * Schema-relevant input normalization shared by the host approval surface and
 * the final native shell permit. This module intentionally imports neither
 * approval-gate nor the permit module, so the two host boundaries never form a
 * runtime cycle.
 */
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

export interface ParsedHostShellExecutionInput {
  readonly command: string;
  readonly cwd: string | undefined;
  readonly timeoutSeconds: number;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Normalize exactly the execution-relevant subset shared by BashTool and
 * PowerShellTool. Undefined means the value cannot represent a native spawn.
 */
export function parseHostShellExecutionInput(
  input: unknown,
): ParsedHostShellExecutionInput | undefined {
  if (!isRecord(input) || typeof input.command !== "string" || input.command.length === 0) {
    return undefined;
  }
  const cwd = input.cwd;
  if (cwd !== undefined && typeof cwd !== "string") return undefined;
  const timeoutSeconds = input.timeoutSeconds ??
    TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > TOOL_TIMEOUT_POLICY.shellMaxMs / 1000
  ) {
    return undefined;
  }
  return Object.freeze({ command: input.command, cwd, timeoutSeconds });
}
