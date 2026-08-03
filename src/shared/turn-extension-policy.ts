/**
 * Turn-scoped policy for extension code that can perform effects outside the
 * host's normal conversation state transition.
 *
 * The policy is carried in AsyncLocalStorage rather than as a mutable
 * ConversationLoop field: a hook can be reached through the executor, a
 * compaction helper, or an asynchronous lifecycle callback, and those paths
 * must not accidentally lose the originating controller boundary.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { RemoteControllerAuthority } from "./chat-origin.js";

export interface TurnExtensionPolicy {
  /** Whether trusted extension hooks may execute for the current turn. */
  readonly allowExternalHooks: boolean;
}

const DEFAULT_TURN_EXTENSION_POLICY: TurnExtensionPolicy = Object.freeze({
  allowExternalHooks: true,
});

const REMOTE_CONTROLLER_EXTENSION_POLICY: TurnExtensionPolicy = Object.freeze({
  // A remote controller may request a conversation turn, but it cannot make
  // owner-configured scripts or in-process extension hooks an implicit effect
  // of that request. Exact local tool approval remains a separate boundary.
  allowExternalHooks: false,
});

/** Ambient host-owned policy for every async operation causally inside a turn. */
export const turnExtensionPolicyContext = new AsyncLocalStorage<TurnExtensionPolicy>();

/** Derive policy only from a host-minted authority, never an input-origin string. */
export function resolveTurnExtensionPolicy(
  authority: RemoteControllerAuthority | undefined,
): TurnExtensionPolicy {
  return authority !== undefined
    ? REMOTE_CONTROLLER_EXTENSION_POLICY
    : DEFAULT_TURN_EXTENSION_POLICY;
}

/** Defaults to allow outside a controlled remote turn for full back-compatibility. */
export function areExternalTurnHooksAllowed(): boolean {
  return turnExtensionPolicyContext.getStore()?.allowExternalHooks ?? true;
}
