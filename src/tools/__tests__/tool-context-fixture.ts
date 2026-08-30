/**
 * The contexts a tool call carries in the executor suites.
 *
 * The permission context is what a call carries when a person typed the turn.
 *
 * Every ToolExecutor suite starts from this one shape and overrides a field
 * or two; eight of them declared it locally. One owner keeps "what a
 * user-keyboard context looks like" from drifting between suites.
 */
import type { ToolPermissionContext } from "../executor.js";
import type { ToolExecutionContext } from "../base.js";

export function userPermissionContext(
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return { trustOrigin: "user-keyboard", ...overrides };
}

/** A bare execution context rooted at /tmp with no extra allowed directories. */
export function toolExecutionContext(): ToolExecutionContext {
  return { cwd: "/tmp", extraAllowedDirectories: [], metadata: {} };
}
