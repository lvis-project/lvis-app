/**
 * Browser-safe contract for the Codex subscription connection.
 *
 * This deliberately represents connection state only. ChatGPT access and
 * refresh tokens stay inside the local Codex App Server credential store and
 * must never be added to LVIS settings, IPC payloads, telemetry, or logs.
 */

export type CodexSubscriptionConnectionState =
  | "connected"
  | "pending"
  | "signed-out";

export type CodexSubscriptionLoginMethod = "browser" | "device-code";

export interface CodexSubscriptionStatus {
  runtime: "ready" | "unavailable";
  connection: CodexSubscriptionConnectionState;
  /** Present only for Codex-managed ChatGPT authentication. */
  planType: string | null;
  /** Present while a managed login is awaiting completion. */
  pendingLogin: CodexSubscriptionLoginMethod | null;
  /**
   * Short-lived device code retained only in the main-process session so the
   * settings view can recover after a tab change. It is never an auth token.
   */
  pendingDeviceCode: string | null;
}

export type CodexSubscriptionErrorCode =
  | "codex-runtime-unavailable"
  | "codex-runtime-start-failed"
  | "codex-login-in-progress"
  | "codex-login-failed"
  | "codex-operation-failed";

export type CodexSubscriptionActionResult =
  | { ok: true; status: CodexSubscriptionStatus }
  | {
      ok: false;
      error: CodexSubscriptionErrorCode;
      status: CodexSubscriptionStatus;
    };

/** Device-code login deliberately returns the short-lived code, not its URL. */
export type CodexSubscriptionDeviceCodeResult =
  | {
      ok: true;
      status: CodexSubscriptionStatus;
      userCode: string;
    }
  | {
      ok: false;
      error: CodexSubscriptionErrorCode;
      status: CodexSubscriptionStatus;
    };

export interface CodexSubscriptionModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  inputModalities: string[];
}

export type CodexSubscriptionModelsResult =
  | {
      ok: true;
      status: CodexSubscriptionStatus;
      models: CodexSubscriptionModel[];
    }
  | {
      ok: false;
      error: CodexSubscriptionErrorCode;
      status: CodexSubscriptionStatus;
    };

export const CODEX_SUBSCRIPTION_SIGNED_OUT_STATUS: CodexSubscriptionStatus = {
  runtime: "ready",
  connection: "signed-out",
  planType: null,
  pendingLogin: null,
  pendingDeviceCode: null,
};
