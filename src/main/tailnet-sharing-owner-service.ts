/**
 * Main-only local-owner facade for Tailnet pairing and conversation shares.
 *
 * Renderers never receive the durable store or a conversation id. This facade
 * chooses the active conversation at the moment a share is created, projects
 * only renderer-safe summaries, and keeps duration choices in the shared wire
 * contract rather than in a UI component.
 */
import {
  isTailnetInvitationDurationPreset,
  isTailnetShareDurationPreset,
  isTailnetSharePermission,
  isTailnetSharingId,
  parseTailnetSharingCreatedInvitation,
  parseTailnetSharingSnapshot,
  type TailnetInvitationDurationPreset,
  type TailnetShareDurationPreset,
  type TailnetSharePermission,
  type TailnetSharingCreatedInvitation,
  type TailnetSharingSnapshot,
} from "../shared/tailnet-sharing.js";
import type { TailnetPairedSharingRuntime } from "./tailnet-paired-sharing-runtime.js";

const INVITATION_DURATION_MS: Readonly<Record<TailnetInvitationDurationPreset, number>> = Object.freeze({
  "10m": 10 * 60 * 1_000,
  "1h": 60 * 60 * 1_000,
  "24h": 24 * 60 * 60 * 1_000,
});

const SHARE_DURATION_MS: Readonly<Record<TailnetShareDurationPreset, number>> = Object.freeze({
  "1h": 60 * 60 * 1_000,
  "8h": 8 * 60 * 60 * 1_000,
  "24h": 24 * 60 * 60 * 1_000,
});

export interface TailnetSharingOwnerService {
  snapshot(): TailnetSharingSnapshot;
  createInvitation(
    duration?: TailnetInvitationDurationPreset,
  ): Promise<TailnetSharingCreatedInvitation>;
  activatePairing(id: string): Promise<boolean>;
  createCurrentConversationShare(
    pairingId: string,
    permission: TailnetSharePermission,
    duration?: TailnetShareDurationPreset,
  ): Promise<boolean>;
  revokeShare(id: string): Promise<boolean>;
  revokePairing(id: string): Promise<boolean>;
  subscribe(listener: () => void): () => void;
}

export interface CreateTailnetSharingOwnerServiceOptions {
  readonly runtime: TailnetPairedSharingRuntime;
  /** Read immediately before a mutation; a renderer can never choose this id. */
  readonly getCurrentConversationId: () => string;
}

/**
 * Keep local-owner mutation logic at one main-process boundary. The public
 * Tailnet listener receives only runtime.authorizer and store.claimInvitation;
 * it never receives this facade or a renderer payload.
 */
export function createTailnetSharingOwnerService(
  options: CreateTailnetSharingOwnerServiceOptions,
): TailnetSharingOwnerService {
  if (
    !options
    || typeof options !== "object"
    || !isRuntime(options.runtime)
    || typeof options.getCurrentConversationId !== "function"
  ) {
    throw new Error("tailnet-sharing-owner-service-invalid");
  }

  const currentConversationId = (): string | null => {
    try {
      const candidate = options.getCurrentConversationId();
      return validCurrentConversationId(candidate) ? candidate : null;
    } catch {
      return null;
    }
  };

  return Object.freeze({
    snapshot(): TailnetSharingSnapshot {
      const snapshot = parseTailnetSharingSnapshot(options.runtime.store.ownerSnapshot());
      if (snapshot === null) throw new Error("tailnet-sharing-owner-snapshot-invalid");
      return snapshot;
    },

    async createInvitation(
      duration?: TailnetInvitationDurationPreset,
    ): Promise<TailnetSharingCreatedInvitation> {
      if (duration !== undefined && !isTailnetInvitationDurationPreset(duration)) {
        throw new Error("tailnet-sharing-owner-input-invalid");
      }
      const invitation = await options.runtime.store.createInvitation(
        duration === undefined ? undefined : INVITATION_DURATION_MS[duration],
      );
      const projection = parseTailnetSharingCreatedInvitation(invitation);
      if (projection === null) throw new Error("tailnet-sharing-owner-invitation-invalid");
      return projection;
    },

    activatePairing(id: string): Promise<boolean> {
      return isTailnetSharingId(id)
        ? options.runtime.store.activatePairing(id)
        : Promise.resolve(false);
    },

    async createCurrentConversationShare(
      pairingId: string,
      permission: TailnetSharePermission,
      duration?: TailnetShareDurationPreset,
    ): Promise<boolean> {
      if (
        !isTailnetSharingId(pairingId)
        || !isTailnetSharePermission(permission)
        || (duration !== undefined && !isTailnetShareDurationPreset(duration))
      ) {
        return false;
      }
      const conversationId = currentConversationId();
      if (conversationId === null) return false;
      const authority = await options.runtime.store.createShare({
        pairingId,
        conversationId,
        permission,
        ...(duration === undefined ? {} : { ttlMs: SHARE_DURATION_MS[duration] }),
      });
      return authority !== null;
    },

    revokeShare(id: string): Promise<boolean> {
      return isTailnetSharingId(id)
        ? options.runtime.store.revokeShare(id)
        : Promise.resolve(false);
    },

    revokePairing(id: string): Promise<boolean> {
      return isTailnetSharingId(id)
        ? options.runtime.store.revokePairing(id)
        : Promise.resolve(false);
    },

    subscribe(listener: () => void): () => void {
      if (typeof listener !== "function") throw new Error("tailnet-sharing-owner-listener-invalid");
      return options.runtime.store.subscribe(listener);
    },
  });
}

function isRuntime(value: unknown): value is TailnetPairedSharingRuntime {
  return typeof value === "object"
    && value !== null
    && typeof (value as TailnetPairedSharingRuntime).store?.ownerSnapshot === "function"
    && typeof (value as TailnetPairedSharingRuntime).store?.createInvitation === "function"
    && typeof (value as TailnetPairedSharingRuntime).store?.createShare === "function"
    && typeof (value as TailnetPairedSharingRuntime).store?.subscribe === "function"
    && typeof (value as TailnetPairedSharingRuntime).authorizer?.authorize === "function";
}

function validCurrentConversationId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4_096
    && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(value);
}
