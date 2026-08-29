/**
 * Host-owned conversation command entrypoint.
 *
 * Every interactive surface eventually reaches this port. It binds a trusted
 * transport actor to a closed command union, mints the input provenance that
 * actor is allowed to claim, and shares the one timeline/turn lease. A
 * surface never supplies either its actor identity or an elevated
 * `user-keyboard` provenance in a request body.
 */
import type { TurnResult } from "../engine/conversation-loop.js";
import {
  createPlatformTurnId,
  createPlatformConversationEventSink,
  type PlatformConversationEventSink,
} from "../engine/conversation-platform-protocol.js";
import type { ConversationSurfaceRuntime } from "../engine/conversation-surface-runtime.js";
import type { ConversationPublicTurnControl } from "../engine/conversation-turn-registry.js";
import {
  handleChatSend,
  type ChatSendContext,
} from "../ipc/handlers/chat.js";
import type { IpcDeps } from "../ipc/types.js";
import { isRemoteControllerAuthorityCurrent } from "../shared/chat-origin.js";
import type {
  PlatformBridgeBinding,
  PlatformBridgeGuard,
  RemoteControllerAuthority,
  TailnetPairedShareGuard,
  TailnetPairingShareBinding,
} from "../shared/chat-origin.js";
import { UUID_PATTERN } from "../shared/uuid.js";

function isPlatformBridgeActorOptions(
  value: unknown,
): value is PlatformBridgeActorOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { bridgeBinding?: unknown; bridgeGuard?: unknown };
  const binding = candidate.bridgeBinding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return false;
  }
  const bindingRecord = binding as Record<string, unknown>;
  return isTailnetOpaqueId(bindingRecord.bridgeId)
    && isPositiveEpoch(bindingRecord.bridgeEpoch)
    && isTailnetOpaqueId(bindingRecord.routeId)
    && isPositiveEpoch(bindingRecord.routeEpoch)
    && isTailnetOpaqueId(bindingRecord.scope)
    && !!candidate.bridgeGuard
    && typeof candidate.bridgeGuard === "object"
    && typeof (candidate.bridgeGuard as PlatformBridgeGuard).isCurrent === "function";
}

/** Paired external-platform authority can only be minted by a verified host adapter. */
export interface PlatformBridgeActorOptions {
  readonly bridgeBinding: PlatformBridgeBinding;
  readonly bridgeGuard: PlatformBridgeGuard;
}

/** Paired authority can only be minted by a host-owned remote adapter. */
export interface TailnetPairedControllerActorOptions {
  /** Local pairing/share binding resolved before command admission. */
  readonly pairedShare: TailnetPairingShareBinding;
  /** Host-private revocation guard; never accepted from a remote request. */
  readonly pairedShareGuard: TailnetPairedShareGuard;
}

type TailnetConversationCommandActor = {
  readonly kind: "tailnet-controller";
  readonly actorId: `tailnet:${string}`;
  readonly pairedShare?: TailnetPairingShareBinding;
  readonly pairedShareGuard?: TailnetPairedShareGuard;
};

type PlatformBridgeConversationCommandActor = {
  readonly kind: "platform-bridge";
  readonly actorId: string;
  readonly bridgeBinding: PlatformBridgeBinding;
  readonly bridgeGuard: PlatformBridgeGuard;
};

/** Actors minted by host-owned surface adapters, never parsed from a request. */
export type ConversationCommandActor =
  | { readonly kind: "desktop-owner"; readonly actorId: "desktop-local" }
  | { readonly kind: "external-surface"; readonly actorId: "loopback-local" }
  | TailnetConversationCommandActor
  | PlatformBridgeConversationCommandActor;

export const DESKTOP_CONVERSATION_ACTOR: ConversationCommandActor = Object.freeze({
  kind: "desktop-owner",
  actorId: "desktop-local",
});

export const LOOPBACK_CONVERSATION_ACTOR: ConversationCommandActor = Object.freeze({
  kind: "external-surface",
  actorId: "loopback-local",
});

/** Build a non-forgeable-at-the-wire Tailnet controller actor from a host digest. */
export function createTailnetControllerActor(
  identityDigest: string,
  paired?: TailnetPairedControllerActorOptions,
): ConversationCommandActor {
  if (!/^[a-f0-9]{64}$/.test(identityDigest)) {
    throw new Error("tailnet-controller-identity-invalid");
  }
  if (paired !== undefined && !isPairedControllerActorOptions(paired)) {
    throw new Error("tailnet-paired-share-invalid");
  }
  const actor: ConversationCommandActor = {
    kind: "tailnet-controller",
    actorId: `tailnet:${identityDigest}`,
    ...(paired === undefined
      ? {}
      : {
          pairedShare: Object.freeze({ ...paired.pairedShare }),
          pairedShareGuard: paired.pairedShareGuard,
        }),
  };
  return Object.freeze(actor);

}

/** Build a paired external-platform actor from a verified host identity digest. */
export function createPlatformBridgeActor(
  identityDigest: string,
  paired: PlatformBridgeActorOptions,
): ConversationCommandActor {
  if (!/^[a-f0-9]{64}$/.test(identityDigest)) {
    throw new Error("platform-bridge-identity-invalid");
  }
  if (!isPlatformBridgeActorOptions(paired)) {
    throw new Error("platform-bridge-pairing-invalid");
  }
  return Object.freeze({
    kind: "platform-bridge" as const,
    actorId: "bridge:" + identityDigest,
    bridgeBinding: Object.freeze({ ...paired.bridgeBinding }),
    bridgeGuard: paired.bridgeGuard,
  });
}

/**
 * Host-private cancellation capability added by a remote adapter only after it
 * has persisted the corresponding public turn handle. It never crosses a wire
 * payload and cannot be minted by a renderer, CLI JSON body, or webhook.
 */
export interface HostOwnedPublicTurn {
  readonly turnId: string;
  readonly abortController: AbortController;
}

/** Closed command vocabulary. New commands require an explicit actor policy. */
export type ConversationCommand =
  | {
      readonly kind: "message.send";
      readonly payload: unknown;
      readonly publicTurn?: HostOwnedPublicTurn;
    }
  | {
      readonly kind: "turn.cancel-own";
      readonly turnId: string;
    };

export type ConversationCommandResult =
  | TurnResult
  | { readonly ok: true; readonly cancelled: true }
  | { readonly ok: false; readonly error: string };

/** A turn lease already acquired by the command port, with async completion. */
export interface ConversationCommandSubmission {
  readonly completion: Promise<ConversationCommandResult>;
  /** Returned only for a host-minted remote public turn. */
  readonly publicTurnId?: string;
}

export interface ConversationCommandPort {
  execute(
    actor: ConversationCommandActor,
    command: ConversationCommand,
  ): Promise<ConversationCommandResult>;
  /**
   * Reserve the common turn lease synchronously and return its completion.
   * Optional to keep existing test-only Local API adapters source-compatible;
   * production ports always provide it for remote command adapters.
   */
  submit?(
    actor: ConversationCommandActor,
    command: ConversationCommand,
  ): ConversationCommandSubmission | null;
  /** Recheck active paired-share guards after durable pairing/share changes. */
  revalidatePublicTurns?(): void;

}

/**
 * Create the command port over the active main conversation. Production makes
 * exactly one and injects it into Electron and loopback API composition; the
 * constructor stays exportable so isolated tests can use the same boundary.
 */
export function createConversationCommandPort(
  deps: IpcDeps,
  runtime: ConversationSurfaceRuntime,
): ConversationCommandPort {
  const context: ChatSendContext = {
    createStreamEventSink: (streamId): PlatformConversationEventSink => (
      createPlatformConversationEventSink(runtime.timeline, {
        conversationId: deps.conversationLoop.getSessionId(),
        turnId: createPlatformTurnId(streamId),
      })
    ),
    allocateStreamId: () => runtime.activity.allocateStreamId(),
    trackStreamTurn: (factory) => runtime.activity.trackTurn(factory),
  };
  // `submit` already owns the activity lease. Re-entering `trackStreamTurn`
  // from handleChatSend would reject its own reservation as streaming-active.
  const reservedContext: ChatSendContext = {
    ...context,
    trackStreamTurn: (factory) => factory(),
  };

  const executeCommand = (
    actor: ConversationCommandActor,
    command: ConversationCommand,
    commandContext: ChatSendContext,
  ): Promise<ConversationCommandResult> => {
    assertKnownActor(actor);
    switch (command.kind) {
      case "message.send": {
        const remoteControllerAuthority = remoteControllerAuthorityFor(actor);
        // `submit()` reserves the shared lease before its deferred factory runs.
        // Pairing/route state can therefore change after ingress admission but
        // before this command reaches the chat executor. Fence that gap here;
        // `handleChatSend` repeats the check at its async/effect boundaries.
        if (!isRemoteControllerAuthorityCurrent(remoteControllerAuthority)) {
          return Promise.resolve({ ok: false, error: "remote-controller-revoked" });
        }
        const publicTurn = publicTurnControlFor(actor, command);
        const abortableContext = publicTurn === undefined
          ? commandContext
          : { ...commandContext, abortSignal: publicTurn.abortController.signal };
        return handleChatSend(
          deps,
          bindMessageSendPayload(actor, command.payload),
          remoteControllerAuthority === undefined
            ? abortableContext
            : { ...abortableContext, remoteControllerAuthority },
        );
      }
      case "turn.cancel-own": {
        const ownerKey = tailnetPublicTurnOwnerKey(actor);
        if (ownerKey === undefined || !isPublicTurnId(command.turnId)) {
          return Promise.resolve({ ok: false, error: "turn-not-found" });
        }
        return Promise.resolve(
          runtime.turns.cancelOwned(ownerKey, command.turnId) === "cancel-requested"
            ? { ok: true, cancelled: true }
            : { ok: false, error: "turn-not-found" },
        );
      }
    }
  };

  return {
    execute: (actor, command): Promise<ConversationCommandResult> =>
      executeCommand(actor, command, context),
    submit: (actor, command): ConversationCommandSubmission | null => {
      assertKnownActor(actor);
      if (command.kind !== "message.send") return null;
      const publicTurn = publicTurnControlFor(actor, command);
      const registration = publicTurn === undefined
        ? undefined
        : runtime.turns.register(publicTurn);
      if (publicTurn !== undefined && registration === null) return null;

      const completion = runtime.activity.tryTrackTurn(
        () => executeCommand(actor, command, reservedContext),
      );
      if (completion === null) {
        registration?.complete();
        return null;
      }
      if (registration !== null && registration !== undefined) {
        void completion.then(
          () => registration.complete(),
          () => registration.complete(),
        );
      }
      return Object.freeze({
        completion,
        ...(publicTurn === undefined ? {} : { publicTurnId: publicTurn.turnId }),
      });
    },
    revalidatePublicTurns: () => runtime.turns.invalidateStale(),
  };
}

/**
 * Bind external message content to its host-minted provenance. Exported for
 * focused boundary tests; callers should use {@link ConversationCommandPort}.
 */
export function bindMessageSendPayload(
  actor: ConversationCommandActor,
  raw: unknown,
): unknown {
  assertKnownActor(actor);
  if (actor.kind === "desktop-owner") return raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;

  const candidate = raw as Record<string, unknown>;
  return {
    input: candidate.input,
    ...(candidate.attachments === undefined ? {} : { attachments: candidate.attachments }),
    // Deliberately ignore inputOrigin, userActivation, personaPromptId, and
    // every future privilege-bearing field supplied by this transport.
    inputOrigin: actor.kind === "tailnet-controller"
      ? "tailnet-surface"
      : actor.kind === "platform-bridge" ? "platform-bridge" : "surface-user",
  };
}

function remoteControllerAuthorityFor(
  actor: ConversationCommandActor,
): RemoteControllerAuthority | undefined {
  if (actor.kind === "tailnet-controller") {
    return Object.freeze({
      kind: "tailnet-controller",
      actorId: actor.actorId,
      ...(actor.pairedShare === undefined
        ? {}
        : {
            pairedShare: actor.pairedShare,
            pairedShareGuard: actor.pairedShareGuard,
          }),
    });
  }
  if (actor.kind === "platform-bridge") {
    return Object.freeze({
      kind: "platform-bridge",
      actorId: actor.actorId,
      bridgeBinding: actor.bridgeBinding,
      bridgeGuard: actor.bridgeGuard,
    });
  }
  return undefined;
}

/**
 * Validate a public-turn cancellation capability only at the host boundary.
 * P3 deliberately requires a current paired share; legacy unpaired P1
 * controllers retain send-only behavior and cannot mint or cancel a handle.
 */
function publicTurnControlFor(
  actor: ConversationCommandActor,
  command: Extract<ConversationCommand, { readonly kind: "message.send" }>,
): ConversationPublicTurnControl | undefined {
  const publicTurn = command.publicTurn;
  if (publicTurn === undefined) return undefined;
  const ownerKey = tailnetPublicTurnOwnerKey(actor);
  if (
    ownerKey === undefined
    || !isPublicTurnId(publicTurn.turnId)
    || !(publicTurn.abortController instanceof AbortController)
  ) {
    throw new Error("tailnet-public-turn-invalid");
  }
  return Object.freeze({
    turnId: publicTurn.turnId,
    actorId: ownerKey,
    abortController: publicTurn.abortController,
    isCurrent: () => tailnetPublicTurnOwnerKey(actor) === ownerKey,
  });
}

/** Exact actor plus P2 binding, never serialised or accepted from a request. */
function tailnetPublicTurnOwnerKey(actor: ConversationCommandActor): string | undefined {
  if (
    actor.kind !== "tailnet-controller"
    || actor.pairedShare === undefined
    || actor.pairedShareGuard === undefined
  ) {
    return undefined;
  }
  try {
    if (actor.pairedShareGuard.isCurrent(actor.pairedShare) !== true) return undefined;
  } catch {
    return undefined;
  }
  const binding = actor.pairedShare;
  return [
    actor.actorId,
    binding.pairingId,
    String(binding.pairingEpoch),
    binding.shareId,
    String(binding.shareEpoch),
    binding.scope,
  ].join("\u0000");
}

function isPublicTurnId(value: unknown): value is string {
  return typeof value === "string" && /^tailnet-turn_[A-Za-z0-9_-]{43}$/.test(value);
}


function assertKnownActor(actor: ConversationCommandActor): void {
  if (
    (actor.kind === "desktop-owner" && actor.actorId === "desktop-local")
    || (actor.kind === "external-surface" && actor.actorId === "loopback-local")
    || (
      actor.kind === "tailnet-controller"
      && /^tailnet:[a-f0-9]{64}$/.test(actor.actorId)
      && isPairedControllerActor(actor)
    )
    || (
      actor.kind === "platform-bridge"
      && /^bridge:[a-f0-9]{64}$/.test(actor.actorId)
      && isPlatformBridgeActorOptions(actor)
    )
  ) {
    return;
  }
  throw new Error("conversation-command-actor-unsupported");
}

function isPairedControllerActor(
  actor: TailnetConversationCommandActor,
): boolean {
  const pairing = actor.pairedShare;
  const guard = actor.pairedShareGuard;
  if (pairing === undefined && guard === undefined) return true;
  return pairing !== undefined
    && guard !== undefined
    && isPairedControllerActorOptions({
      pairedShare: pairing,
      pairedShareGuard: guard,
    });
}

function isPairedControllerActorOptions(
  value: unknown,
): value is TailnetPairedControllerActorOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as {
    pairedShare?: unknown;
    pairedShareGuard?: unknown;
  };
  return isTailnetPairingShareBinding(candidate.pairedShare)
    && !!candidate.pairedShareGuard
    && typeof candidate.pairedShareGuard === "object"
    && typeof (candidate.pairedShareGuard as TailnetPairedShareGuard).isCurrent === "function";
}

function isTailnetPairingShareBinding(
  value: unknown,
): value is TailnetPairingShareBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return isTailnetOpaqueId(candidate.pairingId)
    && isPositiveEpoch(candidate.pairingEpoch)
    && isTailnetOpaqueId(candidate.shareId)
    && isPositiveEpoch(candidate.shareEpoch)
    && isTailnetOpaqueId(candidate.scope);
}

function isTailnetOpaqueId(value: unknown): value is string {
  // Versions 1-8: Tailnet bindings are random v4, but the Telegram paired
  // runtime deliberately mints DETERMINISTIC v8 bindings
  // (`deterministicUuid`, telegram-platform-runtime.ts). A `[1-5]` nibble here
  // rejected every real paired-lane inbound as `platform-bridge-pairing-invalid`
  // — a gap no unit suite saw because each side was tested against a mock of
  // the other.
  return typeof value === "string"
    && UUID_PATTERN.test(value);
}

function isPositiveEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
