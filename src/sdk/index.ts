/**
 * sdk/index.ts — #1409 C12 narrow typed {@link LvisClient} facade.
 *
 * A DELIBERATELY NARROW two-tier facade (not a broad barrel re-export) over the
 * in-process {@link LocalApi} dispatcher. It exposes only the read + send
 * subset of the public contract, typed against the C10 handler return shapes,
 * so an in-process SDK consumer gets renderer-parity data without touching the
 * electron transport.
 *
 * MUTATING gesture-gated operations (policy set, sandbox-install, …) are
 * INTENTIONALLY ABSENT from this facade. api/cli/sdk origins have no
 * user-keyboard gesture, so those channels can never be satisfied — the
 * dispatcher fails them closed with `gesture-required-origin-unsupported`.
 * Rather than surface a method that can only ever throw, the facade omits
 * them entirely.
 *
 * ONE EXCEPTION (US-104): {@link LvisClient.setPermissionMode} — the
 * approval-mediated external mutation (`PERMISSIONS.setMode`, the sole entry
 * in the contract's `EXTERNAL_MUTATION_CHANNELS` allowlist, landed #1409). It
 * routes through the SAME dispatcher channel; the dispatcher surfaces an
 * in-app ApprovalGate consent to the user BEFORE applying the mutation, and a
 * decline / timeout resolves as the dispatcher's `external-mutation-denied`
 * code — which this facade throws as a normal {@link LvisClientError}, exactly
 * like every other rejected dispatch.
 *
 * Part of the main tsc project — fully type-clean, contract-typed, no `as any`.
 */
import {
  CHANNELS,
  PERMISSIONS,
} from "../contract/app-contract.js";
import type { ExternalOrigin } from "../contract/trust-origin.js";
import type { ChatSendPayload } from "../shared/chat-origin.js";
import type { LocalApi } from "../api/local-api.js";
import type {
  handleChatSessions,
  handleChatGetHistory,
  handleChatSessionHistory,
  handleChatSend,
} from "../ipc/handlers/chat.js";
import type { handlePluginCards, handleMarketplaceList } from "../ipc/handlers/plugins.js";
import type { handleGetMode, handleSetPermissionMode } from "../ipc/handlers/permissions.js";
import type { handleUsageSummary, handleUsageRange } from "../ipc/handlers/usage.js";

// ─── Contract-derived result + query types ──────────────────────────────────
// Derived from the C10 handler signatures so the facade stays in lockstep with
// the contract: if a handler's shape changes, these types change with it.

/** Paginated session list + active session id ({@link handleChatSessions}). */
export type ListSessionsResult = ReturnType<typeof handleChatSessions>;
/** Optional pagination/kind query for {@link LvisClient.listSessions}. */
export type ListSessionsQuery = Parameters<typeof handleChatSessions>[1];
/** Active session serialized history ({@link handleChatGetHistory}). */
export type ActiveHistoryResult = ReturnType<typeof handleChatGetHistory>;
/** Any-session serialized history by id ({@link handleChatSessionHistory}). */
export type SessionHistoryResult = ReturnType<typeof handleChatSessionHistory>;
/** One streamed conversation turn result ({@link handleChatSend}). */
export type SendMessageResult = Awaited<ReturnType<typeof handleChatSend>>;
/** Installed plugin cards ({@link handlePluginCards}). */
export type ListPluginsResult = Awaited<ReturnType<typeof handlePluginCards>>;
/** Marketplace catalog listing ({@link handleMarketplaceList}). */
export type ListMarketplaceResult = Awaited<ReturnType<typeof handleMarketplaceList>>;
/** Current permission mode, read-only ({@link handleGetMode}). */
export type PermissionModeResult = ReturnType<typeof handleGetMode>;
/** Applied permission mode after an approval-mediated set ({@link handleSetPermissionMode}). */
export type SetPermissionModeResult = Awaited<ReturnType<typeof handleSetPermissionMode>>;
/** Rolling usage summary ({@link handleUsageSummary}). */
export type UsageSummaryResult = Awaited<ReturnType<typeof handleUsageSummary>>;
/** Usage aggregated over an explicit date range ({@link handleUsageRange}). */
export type UsageRangeResult = Awaited<ReturnType<typeof handleUsageRange>>;
/** Explicit date range for {@link LvisClient.getUsageRange}. */
export type UsageRangeQuery = Parameters<typeof handleUsageRange>[0];

/**
 * Raised when the dispatcher rejects a facade call (non-public channel, gated
 * mutating channel, or unsupported origin). Carries the defined error code and
 * the channel so callers can branch without string-matching messages.
 */
export class LvisClientError extends Error {
  constructor(
    readonly code: string,
    readonly channel: string,
  ) {
    super(`lvis-client: channel '${channel}' rejected: ${code}`);
    this.name = "LvisClientError";
  }
}

/** Narrow, contract-typed read/send facade over the local-api dispatcher. */
export interface LvisClient {
  /** The origin this client dispatches as (`local-api` or `cli`). */
  readonly origin: ExternalOrigin;
  /** List recent chat sessions (+ active session id). */
  listSessions(opts?: ListSessionsQuery): Promise<ListSessionsResult>;
  /**
   * Load serialized history. With no `sessionId`, returns the ACTIVE session's
   * history; with a `sessionId`, returns that session's history by id (read;
   * never changes the active session).
   */
  getHistory(sessionId?: string): Promise<ActiveHistoryResult | SessionHistoryResult>;
  /** Send one chat message and drive a streamed turn. */
  sendMessage(payload: ChatSendPayload): Promise<SendMessageResult>;
  /** List installed plugin cards. */
  listPlugins(): Promise<ListPluginsResult>;
  /** List the marketplace catalog. */
  listMarketplace(): Promise<ListMarketplaceResult>;
  /** Read the current permission mode (mutation is not on this facade). */
  getPermissionMode(): Promise<PermissionModeResult>;
  /**
   * Set the permission mode (US-104). APPROVAL-GATED: the host shows an
   * in-app ApprovalGate consent dialog to the user before the mutation is
   * applied. If the user declines, or the request times out, the dispatcher
   * rejects with the `external-mutation-denied` code, which surfaces here as
   * a thrown {@link LvisClientError} (same as every other rejected dispatch).
   */
  setPermissionMode(mode: string): Promise<SetPermissionModeResult>;
  /** Rolling usage summary over `days` (default handler value applies). */
  getUsageSummary(days?: number): Promise<UsageSummaryResult>;
  /** Usage aggregated over an explicit date range. */
  getUsageRange(range: UsageRangeQuery): Promise<UsageRangeResult>;
}

/**
 * Wrap a {@link LocalApi} dispatcher as a typed {@link LvisClient}. `origin`
 * defaults to `local-api` (the in-process SDK surface); the CLI constructs a
 * client with `cli`. The parameter accepts any failure-code union
 * (`LocalApi<string>`) so both the in-process dispatcher (narrow codes) and a
 * transport client (widened codes) plug in without casts — the facade only
 * ever reads `.error` as a string to build {@link LvisClientError}.
 */
export function createLvisClient(api: LocalApi<string>, origin: ExternalOrigin = "local-api"): LvisClient {
  async function call(channel: string, args?: unknown): Promise<unknown> {
    const result = await api.dispatch({ channel, args, origin });
    if (!result.ok) throw new LvisClientError(result.error, channel);
    return result.data;
  }

  return {
    origin,
    async listSessions(opts) {
      return (await call(CHANNELS.chat.sessions, opts)) as ListSessionsResult;
    },
    async getHistory(sessionId) {
      if (sessionId === undefined) {
        return (await call(CHANNELS.chat.getHistory)) as ActiveHistoryResult;
      }
      return (await call(CHANNELS.chat.sessionHistory, sessionId)) as SessionHistoryResult;
    },
    async sendMessage(payload) {
      return (await call(CHANNELS.chat.send, payload)) as SendMessageResult;
    },
    async listPlugins() {
      return (await call(CHANNELS.plugins.cards)) as ListPluginsResult;
    },
    async listMarketplace() {
      return (await call(CHANNELS.plugins.marketplaceList)) as ListMarketplaceResult;
    },
    async getPermissionMode() {
      return (await call(PERMISSIONS.getMode)) as PermissionModeResult;
    },
    async setPermissionMode(mode) {
      return (await call(PERMISSIONS.setMode, { mode })) as SetPermissionModeResult;
    },
    async getUsageSummary(days) {
      return (await call(CHANNELS.usage.summary, days)) as UsageSummaryResult;
    },
    async getUsageRange(range) {
      return (await call(CHANNELS.usage.range, range)) as UsageRangeResult;
    },
  };
}
