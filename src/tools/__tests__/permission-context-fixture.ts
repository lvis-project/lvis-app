/**
 * The permission context a tool call carries when a person typed the turn.
 *
 * Every ToolExecutor suite starts from this one shape and overrides a field
 * or two; eight of them declared it locally. One owner keeps "what a
 * user-keyboard context looks like" from drifting between suites.
 */
import type { ToolPermissionContext } from "../executor.js";

export function userPermissionContext(
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return { trustOrigin: "user-keyboard", ...overrides };
}
