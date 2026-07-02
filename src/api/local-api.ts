/**
 * local-api.ts — #1409 C12 in-process external-surface dispatcher.
 *
 * A transport-agnostic boundary that lets a NON-renderer origin (the local API,
 * a CLI companion, or the typed SDK facade) invoke the SAME app contract the
 * renderer uses — by routing to the pure `handle*` functions extracted in C10
 * (`src/ipc/handlers/*`). It proves the contract works over a non-renderer
 * {@link TrustOrigin} without a real network server (the localhost server is the
 * documented #1409 follow-up).
 *
 * The dispatcher is the security seam. It is FAIL-CLOSED on two independent
 * axes before it ever reaches a handler:
 *
 *   (b) GESTURE gate — a channel classified `CHANNEL_GESTURE === "required"`
 *       (the mutating permission / policy / sandbox-install family) demands a
 *       fresh user-keyboard gesture REGARDLESS of origin. api/cli/sdk have no
 *       keyboard, so they can NEVER satisfy it → rejected with
 *       {@link LOCAL_API_GESTURE_REQUIRED}. Checked BEFORE the public allowlist
 *       so the rejection is specifically the gated error (the security proof),
 *       not a generic "unknown channel".
 *
 *   (a) PUBLIC allowlist — anything not in {@link PUBLIC_CHANNELS} is internal
 *       and rejected with {@link LOCAL_API_CHANNEL_NOT_PUBLIC}.
 *
 * Deps are INJECTED — the dispatcher never constructs real services. The
 * caller wires the same {@link IpcDeps} the IPC registrars receive plus a
 * {@link ChatSendContext} (stream plumbing) for `chat send`.
 *
 * This module is part of the main tsc project (unlike preload): it must be
 * fully type-clean. It imports the contract SOT from `src/contract/` — never
 * inline `"lvis:*"` literals.
 */
import {
  CHANNELS,
  PERMISSIONS,
  CHANNEL_GESTURE,
  isPublicChannel,
  type PublicChannel,
} from "../contract/app-contract.js";
import { isExternalOrigin, type ExternalOrigin } from "../contract/trust-origin.js";
import type { IpcDeps } from "../ipc/types.js";
import type { ChatSendContext } from "../ipc/handlers/chat.js";
import {
  handleChatSend,
  handleChatSessions,
  handleChatGetHistory,
  handleChatSessionHistory,
} from "../ipc/handlers/chat.js";
import { handlePluginCards, handleMarketplaceList } from "../ipc/handlers/plugins.js";
import { handleGetMode } from "../ipc/handlers/permissions.js";
import { handleUsageSummary, handleUsageRange } from "../ipc/handlers/usage.js";

/** Rejection: the channel is not part of the externally-exposable subset. */
export const LOCAL_API_CHANNEL_NOT_PUBLIC = "channel-not-public";
/** Rejection: a gesture-gated mutating channel cannot be reached by api/cli. */
export const LOCAL_API_GESTURE_REQUIRED = "gesture-required-origin-unsupported";
/** Rejection: the request carried an origin outside the external-origin set. */
export const LOCAL_API_ORIGIN_UNSUPPORTED = "origin-unsupported";

/** The defined, fail-closed rejection codes this boundary can return. */
export type LocalApiErrorCode =
  | typeof LOCAL_API_CHANNEL_NOT_PUBLIC
  | typeof LOCAL_API_GESTURE_REQUIRED
  | typeof LOCAL_API_ORIGIN_UNSUPPORTED;

/** One inbound request to the external-surface dispatcher. */
export interface LocalApiRequest {
  /** The wire channel name (validated against the contract). */
  channel: string;
  /** The channel's argument payload (shape validated by the target handler). */
  args?: unknown;
  /** WHO is calling — never the first-party renderer (that path uses IPC). */
  origin: Exclude<ExternalOrigin, never>;
}

/**
 * Result of a dispatch — a defined success/failure envelope (no throws).
 *
 * Generic over the failure-code union so a TRANSPORT implementation (the CLI's
 * HTTP client) can honestly extend the in-process codes with transport-level
 * ones (`unauthorized` / `server-unavailable` / …) instead of casting. The
 * default keeps every in-process consumer exactly as narrow as before.
 */
export type LocalApiResult<E extends string = LocalApiErrorCode> =
  | { ok: true; data: unknown }
  | { ok: false; error: E };

/** Injected dependencies — the same wiring the IPC registrars receive. */
export interface LocalApiDeps {
  /** Service bag shared with the IPC domain registrars. */
  ipc: IpcDeps;
  /**
   * Stream plumbing for `chat send`. The caller supplies its own sink (SSE /
   * emitter) over the same frames the renderer receives, plus the per-turn
   * stream-id allocator + in-flight turn tracker.
   */
  chatSendContext: ChatSendContext;
}

/**
 * The external-surface dispatcher contract. Generic over the failure-code
 * union (see {@link LocalApiResult}); the in-process dispatcher uses the
 * default, a transport client may widen it.
 */
export interface LocalApi<E extends string = LocalApiErrorCode> {
  dispatch(req: LocalApiRequest): Promise<LocalApiResult<E>>;
}

/**
 * Build the dispatcher over injected deps. Route logic is closed over `ipc`
 * and `chatSendContext`; no real services are constructed here.
 */
export function createLocalApi(deps: LocalApiDeps): LocalApi {
  const { ipc, chatSendContext } = deps;

  function route(channel: PublicChannel, args: unknown): unknown {
    switch (channel) {
      case CHANNELS.chat.send:
        return handleChatSend(ipc, args, chatSendContext);
      case CHANNELS.chat.sessions:
        return handleChatSessions(ipc, args as Parameters<typeof handleChatSessions>[1]);
      case CHANNELS.chat.getHistory:
        return handleChatGetHistory(ipc);
      case CHANNELS.chat.sessionHistory:
        return handleChatSessionHistory(ipc, args as string);
      case CHANNELS.plugins.cards:
        return handlePluginCards(ipc);
      case CHANNELS.plugins.marketplaceList:
        return handleMarketplaceList(ipc);
      case PERMISSIONS.getMode:
        return handleGetMode(ipc);
      case CHANNELS.usage.summary:
        return handleUsageSummary(args as Parameters<typeof handleUsageSummary>[0]);
      case CHANNELS.usage.range:
        return handleUsageRange(args as Parameters<typeof handleUsageRange>[0]);
      default: {
        // Exhaustiveness guard — every PublicChannel must be routed above.
        const _exhaustive: never = channel;
        return _exhaustive;
      }
    }
  }

  async function dispatch(req: LocalApiRequest): Promise<LocalApiResult> {
    const { channel, args, origin } = req;

    // Fail-closed: only the declared non-renderer external origins may dispatch.
    // The type already excludes `renderer`, but a bad cast at a JS call site
    // could smuggle one in — reject anything outside the external-origin set.
    if (!isExternalOrigin(origin)) {
      return { ok: false, error: LOCAL_API_ORIGIN_UNSUPPORTED };
    }

    // (b) Gesture-gated mutating channels can never be satisfied by api/cli
    //     (no user-keyboard gesture). Checked first so the rejection is the
    //     specific gated error rather than a generic not-public one.
    if (CHANNEL_GESTURE[channel] === "required") {
      return { ok: false, error: LOCAL_API_GESTURE_REQUIRED };
    }

    // (a) Fail-closed public allowlist — anything not explicitly public is
    //     internal and unreachable from an external surface.
    if (!isPublicChannel(channel)) {
      return { ok: false, error: LOCAL_API_CHANNEL_NOT_PUBLIC };
    }

    const data = await route(channel, args);
    return { ok: true, data };
  }

  return { dispatch };
}
