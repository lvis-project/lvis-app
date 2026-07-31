/**
 * Browser-safe contract for subscription-backed ACP runtime connections.
 *
 * These runtimes own their own device-code/OIDC credentials. LVIS never
 * reads credential files, account identities, or raw runtime output. A short,
 * one-time device code may be deliberately projected while a login is pending;
 * the matching dynamic verification URL always remains in the main process.
 * This is connection setup only: ACP sessions must still pass through the
 * separate LVIS tool-approval and audit bridge before they can become chat
 * providers.
 */

export const ACP_SUBSCRIPTION_PROVIDER_IDS = ["kimi-code", "grok-build"] as const;

export type AcpSubscriptionProviderId = (typeof ACP_SUBSCRIPTION_PROVIDER_IDS)[number];

export function isAcpSubscriptionProviderId(value: unknown): value is AcpSubscriptionProviderId {
  return typeof value === "string" && (ACP_SUBSCRIPTION_PROVIDER_IDS as readonly string[]).includes(value);
}

export type AcpSubscriptionRuntimeState =
  | "not-configured"
  | "unverified"
  | "ready"
  | "unavailable";

export type AcpSubscriptionConnectionState =
  | "connected"
  | "pending"
  | "signed-out"
  | "unknown";

export type AcpSubscriptionLoginMethod = "device-code";

/**
 * Prompt content types explicitly negotiated by an ACP runtime at initialize.
 * These values stay main-owned until the safe, renderer-facing runtime status
 * projection is built; absent or malformed values are always false.
 */
export interface AcpSubscriptionPromptCapabilities {
  readonly image: boolean;
  readonly embeddedContext: boolean;
}

export const DEFAULT_ACP_SUBSCRIPTION_PROMPT_CAPABILITIES: AcpSubscriptionPromptCapabilities = Object.freeze({
  image: false,
  embeddedContext: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse only the stable ACP initialize capability shape, fail closed otherwise. */
export function acpSubscriptionPromptCapabilitiesFromInitialize(
  initialize: unknown,
): AcpSubscriptionPromptCapabilities {
  const root = isRecord(initialize) ? initialize : null;
  const agentCapabilities = root && isRecord(root.agentCapabilities) ? root.agentCapabilities : null;
  const promptCapabilities = agentCapabilities && isRecord(agentCapabilities.promptCapabilities)
    ? agentCapabilities.promptCapabilities
    : null;
  if (!promptCapabilities) return DEFAULT_ACP_SUBSCRIPTION_PROMPT_CAPABILITIES;
  return Object.freeze({
    image: promptCapabilities.image === true,
    embeddedContext: promptCapabilities.embeddedContext === true,
  });
}

export interface AcpSubscriptionStatus {
  provider: AcpSubscriptionProviderId;
  /** Whether a user-approved executable is configured and has been verified. */
  runtime: AcpSubscriptionRuntimeState;
  /** Runtime-owned subscription state; no credential material is projected. */
  connection: AcpSubscriptionConnectionState;
  /** Present only while the official runtime is completing a device-code flow. */
  pendingLogin: AcpSubscriptionLoginMethod | null;
  /**
   * Strictly validated, short-lived user code from the official device flow.
   * It is never persisted and is cleared as soon as the login process exits.
   */
  pendingDeviceCode: string | null;
  /**
   * The main process holds a strictly allowlisted official verification URL.
   * The URL itself never crosses IPC; the renderer can only request that the
   * main process opens it in the user's system browser.
   */
  canOpenVerificationUrl: boolean;
  /** A bounded version string only after an explicit user-initiated verification. */
  version: string | null;
  /** Negotiated ACP prompt variants from the last successful verification. */
  promptCapabilities: AcpSubscriptionPromptCapabilities;
}

export type AcpSubscriptionErrorCode =
  | "acp-provider-not-supported"
  | "acp-runtime-not-configured"
  | "acp-runtime-invalid-executable"
  | "acp-runtime-unavailable"
  | "acp-login-in-progress"
  | "acp-login-failed"
  | "acp-verification-url-unavailable"
  | "acp-logout-not-supported"
  | "acp-operation-failed";

export type AcpSubscriptionActionResult =
  | { ok: true; status: AcpSubscriptionStatus }
  | { ok: false; error: AcpSubscriptionErrorCode; status?: AcpSubscriptionStatus };

export function acpSubscriptionStatus(
  provider: AcpSubscriptionProviderId,
  runtime: AcpSubscriptionRuntimeState,
  connection: AcpSubscriptionConnectionState,
  version: string | null = null,
  pendingLogin: AcpSubscriptionLoginMethod | null = null,
  pendingDeviceCode: string | null = null,
  canOpenVerificationUrl = false,
  promptCapabilities: AcpSubscriptionPromptCapabilities = DEFAULT_ACP_SUBSCRIPTION_PROMPT_CAPABILITIES,
): AcpSubscriptionStatus {
  return {
    provider,
    runtime,
    connection,
    pendingLogin,
    pendingDeviceCode,
    canOpenVerificationUrl,
    version,
  promptCapabilities,
  };
}
