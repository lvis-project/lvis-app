import { createHash } from "node:crypto";

interface PluginOperationAccountResolver {
  getPluginOperationAccountIdentity(
    pluginId: string,
    generationId: string,
  ): {
    readonly identityHash: string;
    readonly principalHash: string;
  } | undefined;
}

export interface ResolvedPluginOperationAccount {
  /** Revocable principal for one authenticated or anonymous generation session. */
  readonly accountHash: string;
  /** Stable, non-secret account identity used only for cross-generation serialization. */
  readonly accountScopeHash: string;
}

/**
 * Bind app-origin operation policy to a Host-owned principal.
 *
 * Authenticated plugins receive both a revocable per-login principal and the
 * stable hash of the account identity reported by the manifest-owned status
 * Tool. Authless plugins receive a generation-bound principal plus a stable
 * plugin-owned anonymous scope. The stable scope never grants authority; it
 * only prevents reauthentication, update, or rollback from bypassing
 * serialization and fail-closed poison.
 */
export function resolvePluginOperationAccount(
  resolver: PluginOperationAccountResolver,
  manifest: { readonly auth?: unknown } | undefined,
  pluginId: string,
  generationId: string,
): ResolvedPluginOperationAccount | undefined {
  const authenticated = resolver.getPluginOperationAccountIdentity(
    pluginId,
    generationId,
  );
  if (authenticated) {
    return {
      accountHash: authenticated.principalHash,
      accountScopeHash: authenticated.identityHash,
    };
  }
  if (manifest?.auth) return undefined;
  const accountScopeHash = createHash("sha256")
    .update("plugin-operation-anonymous-scope/v1\0")
    .update(pluginId)
    .digest("hex");
  const accountHash = createHash("sha256")
    .update("plugin-operation-anonymous/v1\0")
    .update(pluginId)
    .update("\0")
    .update(generationId)
    .digest("hex");
  return { accountHash, accountScopeHash };
}
