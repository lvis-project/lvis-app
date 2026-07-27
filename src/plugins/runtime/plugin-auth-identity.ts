import { createHash } from "node:crypto";

/** Host-private revocation tuple. Hash and minting generation are inseparable. */
export type PluginAuthInvalidation = Readonly<{
  invalidatedAccountHash: string;
  invalidatedAccountGenerationId: string;
}>;

export type PluginAuthObservation = Readonly<{
  invalidatedAccountHash?: string;
  invalidatedAccountGenerationId?: string;
}>;
export type PluginAuthOperationAccount = Readonly<{
  /** Stable scope shared with ordinary account operations for FIFO serialization. */
  accountScopeHash: string;
  /**
   * Host-private synthetic principal used only by a manifest auth Tool's
   * operation-policy path. It is never a cached authenticated account.
   */
  accountHash: string;
}>;
export type PluginAuthInvocation = PluginAuthObservation & Readonly<{
  epoch: number;
  accountTransitionScopeHash: string;
  operationAccount: PluginAuthOperationAccount;
}>;

export function fallbackPluginAuthTransitionScope(pluginId: string): string {
  return createHash("sha256")
    .update("plugin-auth-transition/v1\0")
    .update(pluginId)
    .digest("hex");
}

export function pluginAuthOperationAccount(
  pluginId: string,
  generationId: string,
  appSessionId: string | undefined,
  accountScopeHash: string,
): PluginAuthOperationAccount {
  const effectiveSessionId = appSessionId || `plugin-auth-${pluginId}-${generationId}`;
  return Object.freeze({
    accountScopeHash,
    accountHash: createHash("sha256")
      .update("plugin-auth-operation-principal/v1\0")
      .update(pluginId)
      .update("\0")
      .update(generationId)
      .update("\0")
      .update(effectiveSessionId)
      .update("\0")
      .update(accountScopeHash)
      .digest("hex"),
  });
}

export function pluginAccountIdentityHash(account: string): string {
  return createHash("sha256")
    .update("plugin-account-identity/v1\0")
    .update(account.trim().toLowerCase())
    .digest("hex");
}

export function pluginAccountPrincipalHash(identityHash: string, sessionNonce: string): string {
  return createHash("sha256")
    .update("plugin-account-session/v1\0")
    .update(identityHash)
    .update("\0")
    .update(sessionNonce)
    .digest("hex");
}

export function authInvalidation(
  current: { readonly principalHash: string } | undefined,
  currentGenerationId: string,
  retained: { readonly principalHash: string; readonly generationId: string } | undefined,
): PluginAuthInvalidation | undefined {
  if (current) {
    return {
      invalidatedAccountHash: current.principalHash,
      invalidatedAccountGenerationId: currentGenerationId,
    };
  }
  return retained
    ? {
        invalidatedAccountHash: retained.principalHash,
        invalidatedAccountGenerationId: retained.generationId,
      }
    : undefined;
}
