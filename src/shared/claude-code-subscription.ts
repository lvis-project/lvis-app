/**
 * Browser-safe contract for the Claude Code CLI subscription runtime.
 *
 * Credentials stay inside the official CLI home. LVIS never reads token files
 * and never projects executable paths, auth URLs, or raw CLI output to the
 * renderer. This is connection setup only; chat still requires host-side
 * safety verification and the normal LVIS tool bridge.
 */

export const CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID = "claude-code" as const;

export type ClaudeCodeSubscriptionProviderId = typeof CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID;

export function isClaudeCodeSubscriptionProviderId(
  value: unknown,
): value is ClaudeCodeSubscriptionProviderId {
  return value === CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID;
}

export type ClaudeCodeSubscriptionRuntimeState =
  | "not-configured"
  | "unverified"
  | "ready"
  | "unavailable";

export type ClaudeCodeSubscriptionConnectionState =
  | "connected"
  | "pending"
  | "signed-out"
  | "unknown";

export type ClaudeCodeSubscriptionLoginMethod = "browser";

export interface ClaudeCodeSubscriptionStatus {
  provider: ClaudeCodeSubscriptionProviderId;
  runtime: ClaudeCodeSubscriptionRuntimeState;
  connection: ClaudeCodeSubscriptionConnectionState;
  pendingLogin: ClaudeCodeSubscriptionLoginMethod | null;
  version: string | null;
}

export type ClaudeCodeSubscriptionErrorCode =
  | "claude-code-runtime-not-configured"
  | "claude-code-runtime-invalid-executable"
  | "claude-code-runtime-unavailable"
  | "claude-code-login-in-progress"
  | "claude-code-login-failed"
  | "claude-code-operation-failed";

export function claudeCodeSubscriptionStatus(
  runtime: ClaudeCodeSubscriptionRuntimeState,
  connection: ClaudeCodeSubscriptionConnectionState,
  version: string | null = null,
  pendingLogin: ClaudeCodeSubscriptionLoginMethod | null = null,
): ClaudeCodeSubscriptionStatus {
  return {
    provider: CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID,
    runtime,
    connection,
    pendingLogin,
    version,
  };
}
