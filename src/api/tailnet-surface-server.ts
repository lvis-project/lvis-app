/**
 * Dedicated Tailnet observer listener with an optional narrow controller.
 *
 * This is intentionally separate from the loopback Local API and A2A
 * listeners: it has no bearer secret, no dispatcher, no owner-stream adapter,
 * and no command route unless the boot-only controller option is supplied.
 * Tailscale Serve terminates Tailnet ingress and injects
 * the identity/app-capability headers this listener verifies before exposing
 * only the bounded shared projection.
 *
 * IMPORTANT: any local process able to reach loopback can forge these headers.
 * Tailscale protects the network hop; it does not replace the local boundary.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  SHARED_CONVERSATION_PROTOCOL_VERSION,
  type SharedConversationEventEnvelope,
  type SharedConversationProjectionStore,
  type SharedConversationSnapshot,
} from "../engine/shared-conversation-projection.js";
import type {
  TailnetPairedShareAuthorization,
  TailnetPairedShareAuthorizer,
} from "../main/tailnet-paired-share-authorizer.js";
import {
  createTailnetControllerActor,
  type ConversationCommandPort,
} from "../main/conversation-command-port.js";
import type { TailnetControllerReceiptStore } from "./tailnet-controller-receipt-store.js";
import { hasControlChars } from "../shared/display-safe-text.js";
import {
  createTailnetAttachmentStagingStore,
  type TailnetAttachmentStagingStore,
} from "./tailnet-attachment-staging-store.js";
import {
  MAX_SUBSCRIPTION_ATTACHMENT_BYTES,
  MAX_SUBSCRIPTION_PROMPT_ATTACHMENTS,
} from "../main/subscription-attachment-input.js";
import {
  createTailnetWebSessionStore,
  type TailnetWebSessionAuthorization,
  type TailnetWebSessionStore,
} from "./tailnet-web-session-store.js";
import { isRecord } from "../shared/is-record.js";
import { errorMessage } from "../shared/error-message.js";

const LOOPBACK_HOST = "127.0.0.1";
const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const SSE_HEARTBEAT_MS = 15_000;
const SSE_RETRY_MS = 3_000;
const DEFAULT_SSE_MAX_LIFETIME_MS = 5 * 60_000;
const DEFAULT_MAX_CONNECTIONS = 16;
const MAX_CAPABILITY_HEADER_CHARS = 16 * 1024;
const MAX_COMMAND_BODY_BYTES = 32 * 1024;
const MAX_PAIRING_BODY_BYTES = 4 * 1024;
const MAX_TAILNET_ATTACHMENT_BYTES = MAX_SUBSCRIPTION_ATTACHMENT_BYTES;
const DEFAULT_MAX_REQUESTS_PER_WINDOW = 120;
const DEFAULT_MAX_WEB_READ_REQUESTS_PER_WINDOW = 1_280;
const DEFAULT_REQUEST_WINDOW_MS = 60_000;
const MAX_TRACKED_RATE_IDENTITIES = 128;
const WEB_COOKIE_NAME = "__Host-lvis-tailnet-v2";
const WEB_CSRF_HEADER = "x-lvis-tailnet-csrf";
const WEB_MAX_COOKIE_CHARS = 4 * 1024;
const TAILNET_ATTACHMENT_SCOPE_HEADER = "x-lvis-tailnet-scope";
const WEB_MAX_SESSION_LIFETIME_MS = 60 * 60_000;

export interface TailnetControllerOptions {
  /** Same host-owned port used by Desktop and loopback chat.send. */
  readonly commandPort: ConversationCommandPort;
  /** Durable plaintext-free idempotency fence owned by the main process. */
  readonly receiptStore: TailnetControllerReceiptStore;
  /** Ephemeral P3 image staging; defaults to a bounded in-memory store. */
  readonly attachmentStore?: TailnetAttachmentStagingStore;
}

/** One-use pairing redemption is distinct from observer/controller grants. */
export interface TailnetPairingOptions {
  claimInvitation(
    code: string,
    actorId: `tailnet:${string}`,
  ): Promise<{ readonly expiresAt: number } | null>;
}
/**
 * Same-origin browser adapter. It is intentionally opt-in and requires the
 * paired sharing boundary; v1 native routes never accept browser context headers.
 */
export interface TailnetWebOptions {
  readonly origin: string;
  readonly sessions?: TailnetWebSessionStore;
}

export interface TailnetSurfaceServerOptions {
  /** Must be the literal 127.0.0.1; a Tailnet IP is never a direct bind. */
  readonly host?: string;
  /** Dedicated nonzero fixed port so a persistent Tailscale Serve target stays valid. */
  readonly port: number;
  /** Exact app-capability key granted by the tailnet policy. */
  readonly expectedAppCapability: string;
  readonly projectionStore: SharedConversationProjectionStore;
  /** Current main session identity; owner history is never consulted. */
  readonly getCurrentConversationId: () => string;
  /** The host activity coordinator remains authoritative for busy state. */
  readonly isConversationBusy: () => boolean;
  /** Optional bounded connection cap. */
  readonly maxConnections?: number;
  /** Reconnect boundary that re-evaluates Tailnet policy/capability headers. */
  readonly maxStreamLifetimeMs?: number;
  /** Per authenticated human identity; bounds status/snapshot/command floods. */
  readonly maxRequestsPerWindow?: number;
  /** Isolated Web read budget; accommodates bounded SSE surfaces refreshing once per second. */
  readonly maxWebReadRequestsPerWindow?: number;
  /** Fixed in-memory rate window, defaults to one minute. */
  readonly requestWindowMs?: number;
  /**
   * Explicitly enabled narrow remote control. It only accepts a typed
   * `conversation.send` command; no attachment, session, policy, or approval
   * command is registered here.
   */
  readonly controller?: TailnetControllerOptions;
  /** P2 explicit pairing/share gate. Its presence disables unpaired v1 access. */
  readonly pairedSharing?: TailnetPairedShareAuthorizer;

  /** Diagnostics only; no header, capability, or identity value is passed here. */
  readonly log?: (message: string) => void;
  /** Present only with pairedSharing; enables the separate pairing-cap route. */
  readonly pairing?: TailnetPairingOptions;
  /** Explicit same-origin Tailnet browser adapter; never enables CORS. */
  readonly web?: TailnetWebOptions;

}

export interface TailnetSurfaceServer {
  readonly host: "127.0.0.1";
  readonly port: number;
  close(): Promise<void>;
}

/** Public envelope deliberately omits internal session, turn, and event ids. */
export interface TailnetObserverEvent {
  readonly version: typeof SHARED_CONVERSATION_PROTOCOL_VERSION;
  /** Anonymous cursor scoped to the current share epoch. */
  readonly cursor: number;
  readonly emittedAt: number;
  readonly event: SharedConversationEventEnvelope["event"];
  readonly scope: string;
}

/** Public snapshot deliberately omits the host's persisted conversation id. */
export interface TailnetObserverSnapshot {
  readonly version: typeof SHARED_CONVERSATION_PROTOCOL_VERSION;
  readonly cursor: number;
  readonly updatedAt: number | null;
  readonly busy: boolean;
  readonly awaitingLocalApproval: boolean;
  readonly assistantText: string;
  readonly scope: string;
}

interface TailnetObserverScope {
  readonly conversationId: string;
  /** Random public epoch; never derived from a persisted session id. */
  readonly value: string;
}

type TailnetObserverScopeReader = () => TailnetObserverScope;

type TailnetControllerCommand =
  | {
      readonly id: string;
      readonly type: "conversation.send";
      readonly input: string;
      /** One-time P3 image staging handles, never bytes or paths. */
      readonly attachmentIds?: readonly string[];
      readonly scope: string;
    }
  | {
      readonly id: string;
      readonly type: "turn.cancel-own";
      /** Opaque public handle returned for a prior paired send. */
      readonly turnId: string;
      readonly scope: string;
    };

type ControllerSubmitResult =
  | "accepted"
  | "duplicate"
  | "idempotency-conflict"
  | "streaming-active"
  | "command-outcome-unknown"
  | "receipt-unavailable"
  | "idempotency-capacity-reached"
  | "attachment-unavailable"
  | "turn-not-found";

interface TailnetControllerBroker {
  submit(
    login: string,
    command: TailnetControllerCommand,
    privateConversationId: string,
    pairedShare: TailnetPairedShareAuthorization | undefined,
  ): Promise<ControllerSubmitResult>;
  revalidatePairedTurns(): void;
}

interface TailnetRequestLimiter {
  /**
   * `login` is a client-supplied identity claim (see the header-trust note
   * at the top of this file); `socket` is the raw connection it arrived on,
   * which a caller cannot swap out mid-request. The limiter pins its bucket
   * key to whichever login a socket first authorized with, so rotating the
   * header on later requests over the same connection cannot mint new
   * tracked identities.
   */
  accept(login: string, socket: Socket): boolean;
}
interface TailnetWebRuntime {
  readonly origin: string;
  readonly sessions: TailnetWebSessionStore;
}

interface TailnetStreamSessionGuard {
  readonly isCurrent: () => boolean;
  readonly checks: Set<() => void>;
}

interface TailnetWebRequestAuthorization {
  readonly login: string;
  /** Request-local only; never stored or returned by the server. */
  readonly cookieToken: string;
  readonly pairedShare: TailnetPairedShareAuthorization;
  readonly scope: TailnetObserverScope;
  readonly session: TailnetWebSessionAuthorization;
}

type TailnetWebRequiredRole = "observe" | "control";

interface TailnetWebPageState {
  readonly csrfToken: string;
  readonly canControl: boolean;
}

/** Testable header validator for the Tailscale Serve observer contract. */
export function isAuthorizedTailnetObserver(
  headers: IncomingHttpHeaders,
  expectedAppCapability: string,
): boolean {
  return authorizedTailnetLogin(headers, expectedAppCapability, "observer") !== undefined;
}

/** Testable header validator for the explicitly enabled controller contract. */
export function isAuthorizedTailnetController(
  headers: IncomingHttpHeaders,
  expectedAppCapability: string,
): boolean {
  return authorizedTailnetLogin(headers, expectedAppCapability, "controller") !== undefined;
}

function authorizedTailnetLogin(
  headers: IncomingHttpHeaders,
  expectedAppCapability: string,
  role: "observer" | "controller" | "pairing",
): string | undefined {
  const login = singleHeader(headers, "tailscale-user-login");
  const rawCapabilities = singleHeader(headers, "tailscale-app-capabilities");
  if (
    !isSafeLogin(login)
    || !isCapabilityKey(expectedAppCapability)
    || !rawCapabilities
    || rawCapabilities.length > MAX_CAPABILITY_HEADER_CHARS
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawCapabilities);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Object.prototype.hasOwnProperty.call(parsed, expectedAppCapability)) {
    return undefined;
  }
  const grants = parsed[expectedAppCapability];
  return Array.isArray(grants) && grants.some((grant) => isRecord(grant) && grant.role === role)
    ? login
    : undefined;
}
/**
 * Accept only a canonical Tailscale HTTPS origin configured at boot. The
 * listener never derives an origin from Host or proxy headers.
 */
export function isTailnetWebOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.port === ""
      && parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.hostname !== "ts.net"
      && parsed.hostname.endsWith(".ts.net")
      && parsed.origin === value;
  } catch {
    return false;
  }
}

/** Start the dedicated literal-loopback Tailnet observer listener. */
export function startTailnetSurfaceServer(
  options: TailnetSurfaceServerOptions,
): Promise<TailnetSurfaceServer> {
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    return Promise.reject(new Error("tailnet surface server host must be literal 127.0.0.1"));
  }
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) {
    return Promise.reject(new Error("tailnet surface server port must be a nonzero TCP port"));
  }
  if (!isCapabilityKey(options.expectedAppCapability)) {
    return Promise.reject(new Error("tailnet surface server requires a valid expected app capability"));
  }
  if (
    options.controller !== undefined &&
    (typeof options.controller.commandPort.submit !== "function"
      || !isTailnetControllerReceiptStore(options.controller.receiptStore)
      || (
        options.controller.attachmentStore !== undefined
        && !isTailnetAttachmentStagingStore(options.controller.attachmentStore)
      ))
  ) {
    return Promise.reject(new Error("tailnet controller requires a reservable conversation command port"));
  }
  if (
    options.pairing !== undefined
    && (options.pairedSharing === undefined || typeof options.pairing.claimInvitation !== "function")
  ) {
    return Promise.reject(new Error("tailnet pairing requires paired sharing and a claim store"));
  }
  if (
    options.web !== undefined
    && (
      options.pairedSharing === undefined
      || !isTailnetWebOrigin(options.web.origin)
      || (options.web.sessions !== undefined && !isTailnetWebSessionStore(options.web.sessions))
    )
  ) {
    return Promise.reject(new Error("tailnet web requires paired sharing, a canonical origin, and a session store"));
  }
  const webRuntime: TailnetWebRuntime | undefined = options.web === undefined
    ? undefined
    : Object.freeze({
        origin: options.web.origin,
        sessions: options.web.sessions ?? createTailnetWebSessionStore(),
      });

  const maxConnections = positiveInteger(options.maxConnections ?? DEFAULT_MAX_CONNECTIONS, "maxConnections");
  const maxStreamLifetimeMs = positiveInteger(
    options.maxStreamLifetimeMs ?? DEFAULT_SSE_MAX_LIFETIME_MS,
    "maxStreamLifetimeMs",
  );
  const maxRequestsPerWindow = positiveInteger(
    options.maxRequestsPerWindow ?? DEFAULT_MAX_REQUESTS_PER_WINDOW,
    "maxRequestsPerWindow",
  );
  const requestWindowMs = positiveInteger(options.requestWindowMs ?? DEFAULT_REQUEST_WINDOW_MS, "requestWindowMs");
  const maxWebReadRequestsPerWindow = positiveInteger(
    options.maxWebReadRequestsPerWindow ?? DEFAULT_MAX_WEB_READ_REQUESTS_PER_WINDOW,
    "maxWebReadRequestsPerWindow",
  );
  const webReadRequestLimiter = createTailnetRequestLimiter(maxWebReadRequestsPerWindow, requestWindowMs);
  const requestLimiter = createTailnetRequestLimiter(maxRequestsPerWindow, requestWindowMs);
  const attachmentStore = options.controller === undefined
    ? undefined
    : options.controller.attachmentStore ?? createTailnetAttachmentStagingStore();
  const controllerBroker = options.controller === undefined
    ? undefined
    : createTailnetControllerBroker(
        options.controller.commandPort,
        options.controller.receiptStore,
        attachmentStore!,
        options.log,
      );
  // The Runtime owns this bounded projection. Starting is idempotent, but a
  // transport closing must never stop a future SNS/CLI adapter's subscription.
  options.projectionStore.start();
  const currentScope = createScopeTracker(options.getCurrentConversationId);

  const liveStreams = new Set<() => void>();
  const pairedShareStreamChecks = new Set<() => void>();
  const webSessionStreamChecks = new Set<() => void>();
  const unsubscribeWebSessions = webRuntime?.sessions.subscribe(() => {
    for (const check of [...webSessionStreamChecks]) check();
  });

  const unsubscribePairedSharing = options.pairedSharing?.subscribe(() => {
    controllerBroker?.revalidatePairedTurns();
    attachmentStore?.discardStale();
    for (const check of [...pairedShareStreamChecks]) check();
  });

  const server: Server = createServer((req, res) => {
    void route(
      req,
      res,
      options,
      liveStreams,
      pairedShareStreamChecks,
      webSessionStreamChecks,
      maxConnections,
      maxStreamLifetimeMs,
      currentScope,
      controllerBroker,
      attachmentStore,
      requestLimiter,
      webReadRequestLimiter,
      webRuntime,
    ).catch((error) => {
      options.log?.(`tailnet observer routing error: ${errorMessage(error)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: "internal-error" });
      } else if (!res.destroyed) {
        res.end();
      }
    });
  });
  // Bound incomplete headers/request bodies and total sockets without adding a
  // second, transport-specific application API.
  server.maxConnections = maxConnections + DEFAULT_MAX_CONNECTIONS;
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;

  return new Promise<TailnetSurfaceServer>((resolve, reject) => {
    let settled = false;
    let closing: Promise<void> | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      server.removeListener("error", onError);
      // This path is normally an EADDRINUSE before listen completes. Keep the
      // unexpected-bound-port path leak-free as well.
      if (server.listening) server.close();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    server.on("error", onError);
    server.listen(options.port, host, () => {
      if (settled) return;
      const boundPort = (server.address() as AddressInfo | null)?.port;
      if (boundPort !== options.port) {
        fail(new Error("tailnet surface server bound an unexpected port"));
        return;
      }
      settled = true;
      server.removeListener("error", onError);
      options.log?.(`tailnet observer listening on ${LOOPBACK_HOST}:${boundPort}`);
      resolve({
        host: LOOPBACK_HOST,
        port: boundPort,
        close: () => {
          closing ??= new Promise<void>((resolveClose, rejectClose) => {
            for (const endStream of [...liveStreams]) endStream();
            unsubscribePairedSharing?.();
            unsubscribeWebSessions?.();
            server.closeAllConnections();
            server.close((error) => {
              if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
                resolveClose();
                return;
              }
              rejectClose(error);
            });
          });
          return closing;
        },
      });
    });
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: TailnetSurfaceServerOptions,
  liveStreams: Set<() => void>,
  pairedShareStreamChecks: Set<() => void>,
  webSessionStreamChecks: Set<() => void>,
  maxConnections: number,
  maxStreamLifetimeMs: number,
  currentScope: TailnetObserverScopeReader,
  controllerBroker: TailnetControllerBroker | undefined,
  attachmentStore: TailnetAttachmentStagingStore | undefined,
  requestLimiter: TailnetRequestLimiter,
  webReadRequestLimiter: TailnetRequestLimiter,
  web: TailnetWebRuntime | undefined,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://tailnet-observer.invalid");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const observerRoute = path === "/tailnet/v1/status"
    || path === "/tailnet/v1/conversation/snapshot"
    || path === "/tailnet/v1/conversation/events";
  const controllerRoute = path === "/tailnet/v1/commands";
  const attachmentRoute = path === "/tailnet/v3/attachments";
  const pairingRoute = path === "/tailnet/v2/pairing/claim";
  const pairingEnabled = pairingRoute && options.pairing !== undefined && options.pairedSharing !== undefined;
  const webDocumentRoute = path === "/tailnet/v2/web";
  const webSnapshotRoute = path === "/tailnet/v2/web/snapshot";
  const webEventsRoute = path === "/tailnet/v2/web/events";
  const webCommandRoute = path === "/tailnet/v2/web/commands";
  const webAttachmentRoute = path === "/tailnet/v3/web/attachments";
  const webLogoutRoute = path === "/tailnet/v2/web/logout";
  const webRoute = webDocumentRoute || webSnapshotRoute || webEventsRoute || webCommandRoute || webAttachmentRoute || webLogoutRoute;
  if (
    !observerRoute
    && !(controllerRoute && controllerBroker)
    && !(attachmentRoute && controllerBroker && attachmentStore)
    && !pairingEnabled
    && !(webRoute && web !== undefined)
  ) {
    // Drain an unknown write request before replying so it cannot retain one
    // of the bounded loopback sockets until the server request timeout.
    if (method !== "GET") req.resume();
    sendJson(res, 404, { ok: false, error: "not-found" });
    return;
  }
  if (webRoute && web !== undefined) {
    await routeTailnetWeb(
      req,
      res,
      url,
      path,
      options,
      web,
      currentScope,
      controllerBroker,
      attachmentStore,
      webReadRequestLimiter,
      requestLimiter,
      liveStreams,
      pairedShareStreamChecks,
      webSessionStreamChecks,
      maxConnections,
      maxStreamLifetimeMs,
    );
    return;
  }

  if (pairingRoute) {
    await routePairingClaim(req, res, options, requestLimiter);
    return;
  }
  if (controllerRoute) {
    await routeControllerCommand(req, res, options, currentScope, controllerBroker!, requestLimiter);
    return;
  }
  if (attachmentRoute) {
    await routeTailnetAttachmentUpload(
      req,
      res,
      options,
      currentScope,
      attachmentStore!,
      requestLimiter,
    );
    return;
  }
  // The native observer endpoints are for CLI/adapter use only. A browser must
  // use the session + CSRF v2 Web boundary and cannot bypass it via injected
  // Tailscale Serve headers.
  if (isTailnetNativeBrowserRequest(req.headers)) {
    req.resume();
    sendJson(res, 403, { ok: false, error: "browser-observer-not-ready" });
    return;
  }

  if (method !== "GET") {
    sendJson(res, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  if (hasRequestBody(req)) {
    // Never leave a chunked GET body consuming a bounded observer socket.
    res.setHeader("connection", "close");
    req.resume();
    sendJson(res, 400, { ok: false, error: "request-body-not-allowed" });
    return;
  }
  const login = authorizedTailnetLogin(req.headers, options.expectedAppCapability, "observer");
  if (login === undefined) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  if (!requestLimiter.accept(login, req.socket)) {
    sendJson(res, 429, { ok: false, error: "tailnet-rate-limited" });
    return;
  }

  const scope = currentScope();
  const conversationId = scope.conversationId;
  const pairedShare = resolvePairedShare(options.pairedSharing, login, conversationId, "observe");
  if (pairedShare === null) {
    sendJson(res, 403, { ok: false, error: "pairing-share-required" });
    return;
  }

  const busy = options.isConversationBusy();
  if (path === "/tailnet/v1/status") {
    const snapshot = options.projectionStore.snapshot(conversationId, { busy });
    sendJson(res, 200, {
      ok: true,
      protocolVersion: SHARED_CONVERSATION_PROTOCOL_VERSION,
      mode: "observer",
      conversation: {
        scope: scope.value,
        cursor: snapshot.cursor,
        busy: snapshot.busy,
        awaitingLocalApproval: snapshot.awaitingLocalApproval,
      },
    });
    return;
  }
  if (path === "/tailnet/v1/conversation/snapshot") {
    sendJson(res, 200, {
      ok: true,
      snapshot: toTailnetObserverSnapshot(options.projectionStore.snapshot(conversationId, { busy }), scope.value),
    });
    return;
  }

  const afterCursor = resolveAfterCursor(url.searchParams.get("afterCursor"), singleHeader(req.headers, "last-event-id"));
  const requestedScope = parseScope(url.searchParams.get("scope"));
  if (afterCursor === "invalid" || requestedScope === "invalid") {
    sendJson(res, 400, { ok: false, error: "invalid-after-cursor" });
    return;
  }
  if (afterCursor !== undefined && requestedScope === undefined) {
    sendSnapshotRequired(res, scope.value, options.projectionStore.snapshot(conversationId, { busy }).cursor);
    return;
  }
  if (requestedScope !== undefined && requestedScope !== scope.value) {
    sendSnapshotRequired(res, scope.value, options.projectionStore.snapshot(conversationId, { busy }).cursor);
    return;
  }
  if (liveStreams.size >= maxConnections) {
    sendJson(res, 429, { ok: false, error: "observer-capacity-reached" });
    return;
  }
  handleEvents(
    req,
    res,
    options.projectionStore,
    conversationId,
    afterCursor,
    liveStreams,
    pairedShare,
    pairedShareStreamChecks,
    scope,
    currentScope,
    maxStreamLifetimeMs,
  );
}
async function routeTailnetWeb(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  options: TailnetSurfaceServerOptions,
  web: TailnetWebRuntime,
  currentScope: TailnetObserverScopeReader,
  controllerBroker: TailnetControllerBroker | undefined,
  attachmentStore: TailnetAttachmentStagingStore | undefined,
  webReadRequestLimiter: TailnetRequestLimiter,
  mutationRequestLimiter: TailnetRequestLimiter,
  liveStreams: Set<() => void>,
  pairedShareStreamChecks: Set<() => void>,
  webSessionStreamChecks: Set<() => void>,
  maxConnections: number,
  maxStreamLifetimeMs: number,
): Promise<void> {
  if (path === "/tailnet/v2/web") {
    routeTailnetWebDocument(req, res, options, web, currentScope, controllerBroker, mutationRequestLimiter);
    return;
  }
  if (path === "/tailnet/v2/web/snapshot") {
    routeTailnetWebSnapshot(req, res, options, web, currentScope, webReadRequestLimiter);
    return;
  }
  if (path === "/tailnet/v2/web/events") {
    routeTailnetWebEvents(
      req,
      res,
      url,
      options,
      web,
      currentScope,
      webReadRequestLimiter,
      liveStreams,
      pairedShareStreamChecks,
      webSessionStreamChecks,
      maxConnections,
      maxStreamLifetimeMs,
    );
    return;
  }
  if (path === "/tailnet/v2/web/commands") {
    if (controllerBroker === undefined) {
      req.resume();
      sendTailnetWebJson(res, web, 404, { ok: false, error: "controller-disabled" });
      return;
    }
    await routeTailnetWebCommand(
      req,
      res,
      options,
      web,
      currentScope,
      controllerBroker,
      mutationRequestLimiter,
    );
    return;
  }
  if (path === "/tailnet/v3/web/attachments") {
    if (attachmentStore === undefined) {
      req.resume();
      sendTailnetWebJson(res, web, 404, { ok: false, error: "controller-disabled" });
      return;
    }
    await routeTailnetWebAttachmentUpload(
      req,
      res,
      options,
      web,
      currentScope,
      attachmentStore,
      mutationRequestLimiter,
    );
    return;
  }
  if (path === "/tailnet/v2/web/logout") {
    routeTailnetWebLogout(req, res, web);
    return;
  }
  req.resume();
  sendTailnetWebJson(res, web, 404, { ok: false, error: "not-found" });
}

function routeTailnetWebDocument(
  req: IncomingMessage,
  res: ServerResponse,
  options: TailnetSurfaceServerOptions,
  web: TailnetWebRuntime,
  currentScope: TailnetObserverScopeReader,
  controllerBroker: TailnetControllerBroker | undefined,
  requestLimiter: TailnetRequestLimiter,
): void {
  if ((req.method ?? "GET") !== "GET") {
    req.resume();
    sendTailnetWebJson(res, web, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  if (hasRequestBody(req)) {
    res.setHeader("connection", "close");
    req.resume();
    sendTailnetWebJson(res, web, 400, { ok: false, error: "request-body-not-allowed" });
    return;
  }
  if (!isTailnetWebDocumentNavigation(req.headers, web.origin)) {
    sendTailnetWebJson(res, web, 403, { ok: false, error: "same-origin-required" });
    return;
  }
  const login = authorizedTailnetLogin(req.headers, options.expectedAppCapability, "observer");
  if (login === undefined) {
    sendTailnetWebJson(res, web, 401, { ok: false, error: "unauthorized" });
    return;
  }
  if (!requestLimiter.accept(login, req.socket)) {
    sendTailnetWebJson(res, web, 429, { ok: false, error: "tailnet-rate-limited" });
    return;
  }
  let scope: TailnetObserverScope;
  try {
    scope = currentScope();
  } catch {
    sendTailnetWebJson(res, web, 503, { ok: false, error: "conversation-unavailable" });
    return;
  }
  const pairedShare = resolvePairedShare(
    options.pairedSharing,
    login,
    scope.conversationId,
    "observe",
  );
  if (pairedShare === null || pairedShare === undefined) {
    sendTailnetWebJson(res, web, 403, { ok: false, error: "pairing-share-required" });
    return;
  }

  // Tabs share the HttpOnly cookie but retain their own page-local CSRF token.
  // Only a stale or differently authorized existing cookie is replaced.
  const previousCookie = readTailnetWebCookie(req.headers);
  let issued;
  try {
    const previous = previousCookie === undefined ? null : web.sessions.resolve(previousCookie);
    if (
      previousCookie !== undefined
      && previous !== null
      && sameTailnetWebSessionAuthority(previous, pairedShare)
    ) {
      issued = web.sessions.issuePageCsrf(previousCookie, {
        actorId: pairedShare.actorId,
        pairedShare: pairedShare.pairedShare,
      });
    } else {
      if (previousCookie !== undefined && previous !== null) web.sessions.revoke(previousCookie);
      issued = web.sessions.issue({
        actorId: pairedShare.actorId,
        pairedShare: pairedShare.pairedShare,
      });
    }
  } catch {
    sendTailnetWebJson(res, web, 503, { ok: false, error: "web-session-unavailable" });
    return;
  }
  if (issued === null) {
    sendTailnetWebJson(res, web, 503, { ok: false, error: "web-session-capacity-reached" });
    return;
  }
  const canControl = controllerBroker !== undefined
    && pairedShare.permission === "control"
    && authorizedTailnetLogin(req.headers, options.expectedAppCapability, "controller") !== undefined;
  sendTailnetWebDocumentResponse(res, web, issued, {
    csrfToken: issued.csrfToken,
    canControl,
  });
}

function routeTailnetWebSnapshot(
  req: IncomingMessage,
  res: ServerResponse,
  options: TailnetSurfaceServerOptions,
  web: TailnetWebRuntime,
  currentScope: TailnetObserverScopeReader,
  requestLimiter: TailnetRequestLimiter,
): void {
  if ((req.method ?? "GET") !== "GET") {
    req.resume();
    sendTailnetWebJson(res, web, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  if (hasRequestBody(req)) {
    res.setHeader("connection", "close");
    req.resume();
    sendTailnetWebJson(res, web, 400, { ok: false, error: "request-body-not-allowed" });
    return;
  }
  const authorization = authorizeTailnetWebRequest(
    req,
    res,
    options,
    web,
    currentScope,
    requestLimiter,
    "observe",
    true,
  );
  if (authorization === null) return;
  sendTailnetWebJson(res, web, 200, {
    ok: true,
    snapshot: toTailnetObserverSnapshot(
      options.projectionStore.snapshot(authorization.scope.conversationId, {
        busy: options.isConversationBusy(),
      }),
      authorization.scope.value,
    ),
  });
}

function routeTailnetWebEvents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: TailnetSurfaceServerOptions,
  web: TailnetWebRuntime,
  currentScope: TailnetObserverScopeReader,
  requestLimiter: TailnetRequestLimiter,
  liveStreams: Set<() => void>,
  pairedShareStreamChecks: Set<() => void>,
  webSessionStreamChecks: Set<() => void>,
  maxConnections: number,
  maxStreamLifetimeMs: number,
): void {
  if ((req.method ?? "GET") !== "GET") {
    req.resume();
    sendTailnetWebJson(res, web, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  if (hasRequestBody(req)) {
    res.setHeader("connection", "close");
    req.resume();
    sendTailnetWebJson(res, web, 400, { ok: false, error: "request-body-not-allowed" });
    return;
  }
  const authorization = authorizeTailnetWebRequest(
    req,
    res,
    options,
    web,
    currentScope,
    requestLimiter,
    "observe",
    true,
  );
  if (authorization === null) return;
  const afterCursor = resolveAfterCursor(
    url.searchParams.get("afterCursor"),
    singleHeader(req.headers, "last-event-id"),
  );
  const requestedScope = parseScope(url.searchParams.get("scope"));
  const snapshot = options.projectionStore.snapshot(authorization.scope.conversationId, {
    busy: options.isConversationBusy(),
  });
  if (afterCursor === "invalid" || requestedScope === "invalid") {
    sendTailnetWebJson(res, web, 400, { ok: false, error: "invalid-after-cursor" });
    return;
  }
  if (
    (afterCursor !== undefined && requestedScope === undefined)
    || (requestedScope !== undefined && requestedScope !== authorization.scope.value)
  ) {
    sendTailnetWebSnapshotRequired(res, web, authorization.scope.value, snapshot.cursor);
    return;
  }
  if (liveStreams.size >= maxConnections) {
    sendTailnetWebJson(res, web, 429, { ok: false, error: "observer-capacity-reached" });
    return;
  }
  const remainingSessionLifetimeMs = authorization.session.expiresAt - Date.now();
  if (!Number.isSafeInteger(remainingSessionLifetimeMs) || remainingSessionLifetimeMs < 1) {
    web.sessions.revoke(authorization.cookieToken);
    sendTailnetWebJson(res, web, 401, { ok: false, error: "web-session-expired" }, true);
    return;
  }
  applyTailnetWebSecurityHeaders(res, web.origin);
  handleEvents(
    req,
    res,
    options.projectionStore,
    authorization.scope.conversationId,
    afterCursor,
    liveStreams,
    authorization.pairedShare,
    pairedShareStreamChecks,
    authorization.scope,
    currentScope,
    Math.min(maxStreamLifetimeMs, remainingSessionLifetimeMs, WEB_MAX_SESSION_LIFETIME_MS),
    {
      isCurrent: () => {
        try {
          return web.sessions.resolve(authorization.cookieToken) !== null;
        } catch {
          return false;
        }
      },
      checks: webSessionStreamChecks,
    },
    "reconnect",
  );
}

async function routeTailnetWebCommand(
  req: IncomingMessage,
  res: ServerResponse,
  options: TailnetSurfaceServerOptions,
  web: TailnetWebRuntime,
  currentScope: TailnetObserverScopeReader,
  broker: TailnetControllerBroker,
  requestLimiter: TailnetRequestLimiter,
): Promise<void> {
  if ((req.method ?? "GET") !== "POST") {
    req.resume();
    sendTailnetWebJson(res, web, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  const authorization = authorizeTailnetWebRequest(
    req,
    res,
    options,
    web,
    currentScope,
    requestLimiter,
    "control",
    true,
  );
  if (authorization === null) return;
  const decoded = await readTailnetControllerCommand(req);
  if (!decoded.ok) {
    sendTailnetWebJson(res, web, decoded.status, { ok: false, error: decoded.error });
    return;
  }
  // Body reads can race an owner revocation or active-conversation switch. A
  // second session + Tailnet + P2 check precedes the only side effect.
  const reauthorized = authorizeTailnetWebRequest(
    req,
    res,
    options,
    web,
    currentScope,
    requestLimiter,
    "control",
    false,
  );
  if (reauthorized === null) return;
  if (decoded.command.scope !== reauthorized.scope.value) {
    sendTailnetWebSnapshotRequired(
      res,
      web,
      reauthorized.scope.value,
      options.projectionStore.snapshot(reauthorized.scope.conversationId, {
        busy: options.isConversationBusy(),
      }).cursor,
    );
    return;
  }
  switch (await broker.submit(
    reauthorized.login,
    decoded.command,
    reauthorized.scope.conversationId,
    reauthorized.pairedShare,
  )) {
    case "accepted":
      sendTailnetWebJson(res, web, 202, {
        ok: true,
        accepted: true,
        command: { id: decoded.command.id, scope: reauthorized.scope.value },
        ...publicTurnResponse(decoded.command, reauthorized.pairedShare),
      });
      return;
    case "duplicate":
      sendTailnetWebJson(res, web, 202, {
        ok: true,
        accepted: true,
        duplicate: true,
        command: { id: decoded.command.id, scope: reauthorized.scope.value },
        ...publicTurnResponse(decoded.command, reauthorized.pairedShare),
      });
      return;
    case "idempotency-conflict":
      sendTailnetWebJson(res, web, 409, { ok: false, error: "idempotency-conflict" });
      return;
    case "streaming-active":
      sendTailnetWebJson(res, web, 409, { ok: false, error: "streaming-active" });
      return;
    case "command-outcome-unknown":
      sendTailnetWebJson(res, web, 409, { ok: false, error: "command-outcome-unknown" });
      return;
    case "idempotency-capacity-reached":
      sendTailnetWebJson(res, web, 503, { ok: false, error: "idempotency-capacity-reached" });
      return;
    case "receipt-unavailable":
      sendTailnetWebJson(res, web, 503, { ok: false, error: "receipt-unavailable" });
      return;
    case "attachment-unavailable":
      sendTailnetWebJson(res, web, 409, { ok: false, error: "attachment-unavailable" });
      return;
    case "turn-not-found":
      sendTailnetWebJson(res, web, 404, { ok: false, error: "turn-not-found" });
      return;
  }
}

function routeTailnetWebLogout(
  req: IncomingMessage,
  res: ServerResponse,
  web: TailnetWebRuntime,
): void {
  if ((req.method ?? "GET") !== "POST") {
    req.resume();
    sendTailnetWebJson(res, web, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  if (hasRequestBody(req)) {
    res.setHeader("connection", "close");
    req.resume();
    sendTailnetWebJson(res, web, 400, { ok: false, error: "request-body-not-allowed" });
    return;
  }
  if (!isSameOriginTailnetWebRequest(req.headers, web.origin)) {
    sendTailnetWebJson(res, web, 403, { ok: false, error: "same-origin-required" });
    return;
  }
  const cookieToken = readTailnetWebCookie(req.headers);
  const csrfToken = singleHeader(req.headers, WEB_CSRF_HEADER);
  if (cookieToken === undefined) {
    sendTailnetWebJson(res, web, 401, { ok: false, error: "web-session-required" }, true);
    return;
  }
  const session = web.sessions.resolve(cookieToken);
  if (session === null) {
    sendTailnetWebJson(res, web, 401, { ok: false, error: "web-session-required" }, true);
    return;
  }
  if (csrfToken === undefined || web.sessions.resolveMutation(cookieToken, csrfToken) === null) {
    sendTailnetWebJson(res, web, 403, { ok: false, error: "csrf-required" });
    return;
  }
  web.sessions.revoke(cookieToken);
  sendTailnetWebJson(res, web, 200, { ok: true }, true);
}
function authorizeTailnetWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: TailnetSurfaceServerOptions,
  web: TailnetWebRuntime,
  currentScope: TailnetObserverScopeReader,
  requestLimiter: TailnetRequestLimiter,
  required: TailnetWebRequiredRole,
  consumeRateLimit: boolean,
): TailnetWebRequestAuthorization | null {
  if (!isSameOriginTailnetWebRequest(req.headers, web.origin)) {
    req.resume();
    sendTailnetWebJson(res, web, 403, { ok: false, error: "same-origin-required" });
    return null;
  }
  const cookieToken = readTailnetWebCookie(req.headers);
  if (cookieToken === undefined) {
    req.resume();
    sendTailnetWebJson(res, web, 401, { ok: false, error: "web-session-required" }, true);
    return null;
  }
  const session = web.sessions.resolve(cookieToken);
  if (session === null) {
    req.resume();
    sendTailnetWebJson(res, web, 401, { ok: false, error: "web-session-required" }, true);
    return null;
  }
  const csrfToken = singleHeader(req.headers, WEB_CSRF_HEADER);
  if (csrfToken === undefined || web.sessions.resolveMutation(cookieToken, csrfToken) === null) {
    req.resume();
    sendTailnetWebJson(res, web, 403, { ok: false, error: "csrf-required" });
    return null;
  }
  const login = authorizedTailnetLogin(req.headers, options.expectedAppCapability, required === "control" ? "controller" : "observer");
  if (login === undefined) {
    req.resume();
    sendTailnetWebJson(res, web, 403, { ok: false, error: "tailnet-role-required" });
    return null;
  }
  if (consumeRateLimit && !requestLimiter.accept(login, req.socket)) {
    req.resume();
    sendTailnetWebJson(res, web, 429, { ok: false, error: "tailnet-rate-limited" });
    return null;
  }
  let scope: TailnetObserverScope;
  try {
    scope = currentScope();
  } catch {
    req.resume();
    sendTailnetWebJson(res, web, 503, { ok: false, error: "conversation-unavailable" });
    return null;
  }
  const pairedShare = resolvePairedShare(options.pairedSharing, login, scope.conversationId, required);
  if (
    pairedShare === null
    || pairedShare === undefined
    || !sameTailnetWebSessionAuthority(session, pairedShare)
  ) {
    web.sessions.revoke(cookieToken);
    req.resume();
    sendTailnetWebJson(res, web, 401, { ok: false, error: "web-session-revoked" }, true);
    return null;
  }
  return {
    cookieToken,
    login,
    pairedShare,
    scope,
    session,
  };
}

function sameTailnetWebSessionAuthority(
  session: TailnetWebSessionAuthorization,
  pairedShare: TailnetPairedShareAuthorization,
): boolean {
  const binding = session.pairedShare;
  const fresh = pairedShare.pairedShare;
  return session.actorId === pairedShare.actorId
    && binding.pairingId === fresh.pairingId
    && binding.pairingEpoch === fresh.pairingEpoch
    && binding.shareId === fresh.shareId
    && binding.shareEpoch === fresh.shareEpoch
    && binding.scope === fresh.scope;
}

function isTailnetNativeBrowserRequest(headers: IncomingHttpHeaders): boolean {
  // Undici-based CLIs attach sec-fetch-mode: cors. Browser-context fields,
  // unlike that transport hint alone, are sufficient to reject ambient access.
  return hasHeader(headers, "origin")
    || hasHeader(headers, "sec-fetch-site")
    || hasHeader(headers, "sec-fetch-dest")
    || hasHeader(headers, "sec-fetch-user");
}

function isTailnetWebDocumentNavigation(headers: IncomingHttpHeaders, origin: string): boolean {
  const requestOrigin = singleHeader(headers, "origin");
  if (requestOrigin !== undefined && requestOrigin !== origin) return false;
  const site = singleHeader(headers, "sec-fetch-site");
  return (site === "none" || site === "same-origin")
    && singleHeader(headers, "sec-fetch-dest") === "document"
    && singleHeader(headers, "sec-fetch-mode") === "navigate";
}

function isSameOriginTailnetWebRequest(headers: IncomingHttpHeaders, origin: string): boolean {
  if (singleHeader(headers, "sec-fetch-site") !== "same-origin") return false;
  const requestOrigin = singleHeader(headers, "origin");
  if (requestOrigin !== undefined) return requestOrigin === origin;
  const referer = singleHeader(headers, "referer");
  if (referer === undefined) return false;
  try {
    return new URL(referer).origin === origin;
  } catch {
    return false;
  }
}

function readTailnetWebCookie(headers: IncomingHttpHeaders): string | undefined {
  const raw = singleHeader(headers, "cookie");
  if (raw === undefined || raw.length === 0 || raw.length > WEB_MAX_COOKIE_CHARS) return undefined;
  let result: string | undefined;
  for (const fragment of raw.split(";")) {
    const candidate = fragment.trim();
    const delimiter = candidate.indexOf("=");
    if (delimiter < 1 || candidate.slice(0, delimiter) !== WEB_COOKIE_NAME) continue;
    const value = candidate.slice(delimiter + 1);
    if (result !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
    result = value;
  }
  return result;
}

function sendTailnetWebSnapshotRequired(
  res: ServerResponse,
  web: TailnetWebRuntime,
  scope: string,
  latestCursor: number,
): void {
  sendTailnetWebJson(res, web, 409, {
    ok: false,
    error: "snapshot-required",
    scope,
    latestCursor,
  });
}

function sendTailnetWebJson(
  res: ServerResponse,
  _web: TailnetWebRuntime,
  status: number,
  payload: unknown,
  clearSession = false,
): void {
  sendJson(res, status, payload, {
    ...tailnetWebSecurityHeaders(),
    ...(clearSession ? { "set-cookie": clearTailnetWebCookie() } : {}),
  });
}

function applyTailnetWebSecurityHeaders(res: ServerResponse, _origin: string): void {
  for (const [name, value] of Object.entries(tailnetWebSecurityHeaders())) {
    res.setHeader(name, value);
  }
}

function tailnetWebSecurityHeaders(): Readonly<Record<string, string>> {
  return {
    "cache-control": "no-store, no-transform",
    "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function sendTailnetWebDocumentResponse(
  res: ServerResponse,
  _web: TailnetWebRuntime,
  issued: Readonly<{ cookieToken: string; expiresAt: number }>,
  state: TailnetWebPageState,
): void {
  const nonce = randomBytes(16).toString("base64url");
  const remainingSeconds = Math.max(
    1,
    Math.min(
      Math.ceil((issued.expiresAt - Date.now()) / 1_000),
      Math.ceil(WEB_MAX_SESSION_LIFETIME_MS / 1_000),
    ),
  );
  res.writeHead(200, {
    ...tailnetWebSecurityHeaders(),
    "cache-control": "no-store, no-transform",
    "content-security-policy": [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'none'",
      "script-src 'nonce-" + nonce + "'",
      "style-src 'nonce-" + nonce + "'",
    ].join("; "),
    "content-type": "text/html; charset=utf-8",
    "set-cookie": WEB_COOKIE_NAME + "=" + issued.cookieToken
      + "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=" + remainingSeconds,
  });
  res.end(renderTailnetWebDocument(nonce, state));
}

function clearTailnetWebCookie(): string {
  return WEB_COOKIE_NAME + "=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0";
}
function renderTailnetWebDocument(nonce: string, state: TailnetWebPageState): string {
  const bootstrap = JSON.stringify({
    csrfToken: state.csrfToken,
    canControl: state.canControl,
  });
  return [
    "<!doctype html>",
    "<html lang=\"ko\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>LVIS Tailnet</title>",
    "<style nonce=\"" + nonce + "\">",
    ":root { color-scheme: dark; font-family: system-ui, sans-serif; }",
    "body { margin: 0; background: #101216; color: #f5f7fb; }",
    "main { max-width: 52rem; margin: 0 auto; padding: 1.5rem; }",
    "header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }",
    "button, textarea, input { font: inherit; }",
    "button { cursor: pointer; }",
    "textarea { box-sizing: border-box; min-height: 6rem; width: 100%; resize: vertical; }",
    "#assistant { min-height: 8rem; overflow-wrap: anywhere; white-space: pre-wrap; }",
    ".muted { color: #abb4c3; }",
    ".row { display: flex; gap: .75rem; align-items: center; }",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    "<header><h1>LVIS Tailnet</h1><button id=\"logout\" type=\"button\">연결 해제</button></header>",
    "<p id=\"status\" class=\"muted\" aria-live=\"polite\">연결 중…</p>",
    "<section aria-labelledby=\"assistant-heading\">",
    "<h2 id=\"assistant-heading\">Assistant</h2>",
    "<pre id=\"assistant\"></pre>",
    "</section>",
    "<form id=\"command\" hidden>",
    "<label for=\"input\">메시지</label>",
    "<textarea id=\"input\" autocomplete=\"off\" maxlength=\"24000\"></textarea>",
    "<label for=\"attachments\">이미지 (PNG, JPEG, GIF, WebP, BMP; 최대 5개)</label>",
    "<input id=\"attachments\" type=\"file\" accept=\"image/png,image/jpeg,image/gif,image/webp,image/bmp\" multiple>",
    "<div class=\"row\"><button id=\"send\" type=\"submit\">보내기</button><button id=\"cancel-turn\" type=\"button\" hidden>내 요청 취소</button><span id=\"command-status\" class=\"muted\" aria-live=\"polite\"></span></div>",
    "</form>",
    "</main>",
    "<script nonce=\"" + nonce + "\">",
    "(() => {",
    "  const boot = " + bootstrap + ";",
    "  const endpoint = \"/tailnet/v2/web\";",
    "  const status = document.getElementById(\"status\");",
    "  const assistant = document.getElementById(\"assistant\");",
    "  const command = document.getElementById(\"command\");",
    "  const input = document.getElementById(\"input\");",
    "  const attachments = document.getElementById(\"attachments\");",
    "  const cancelTurn = document.getElementById(\"cancel-turn\");",
    "  const commandStatus = document.getElementById(\"command-status\");",
    "  const logout = document.getElementById(\"logout\");",
    "  const ACCEPTED_IMAGE_TYPES = new Set([\"image/png\", \"image/jpeg\", \"image/gif\", \"image/webp\", \"image/bmp\"]);",
    "  let activeTurnId = null;",
    "  let snapshot = null;",
    "  let stream = null;",
    "  let activeScope = null;",
    "  let refreshInFlight = false;",
    "  let refreshPending = false;",
    "  let refreshRestart = false;",
    "  let refreshTimer = null;",
    "  let lastSnapshotRefreshAt = 0;",
    "  const MIN_SNAPSHOT_REFRESH_MS = 1000;",
    "  function setStatus(value) { status.textContent = value; }",
    "  function request(path, init) {",
    "    const headers = new Headers((init && init.headers) || undefined);",
    "    headers.set(\"x-lvis-tailnet-csrf\", boot.csrfToken);",
    "    return fetch(path, Object.assign({ cache: \"no-store\", credentials: \"same-origin\" }, init || {}, { headers }));",
    "  }",
    "  async function stageSelectedImages(scope) {",
    "    const files = Array.from(attachments.files || []);",
    "    if (files.length > 5) throw new Error(\"too many images\");",
    "    const ids = [];",
    "    for (const file of files) {",
    "      if (!(file instanceof File) || !ACCEPTED_IMAGE_TYPES.has(file.type) || file.size <= 0) throw new Error(\"unsupported image\");",
    "      const response = await request(\"/tailnet/v3/web/attachments\", {",
    "        method: \"POST\",",
    "        headers: { \"content-type\": file.type, \"x-lvis-tailnet-scope\": scope },",
    "        body: file,",
    "      });",
    "      const body = await response.json();",
    "      if (!response.ok || !body.ok || !body.attachment || typeof body.attachment.id !== \"string\" || body.attachment.scope !== scope) {",
    "        throw new Error(body.error || \"image upload failed\");",
    "      }",
    "      ids.push(body.attachment.id);",
    "    }",
    "    return ids;",
    "  }",
    "  function stopStream() {",
    "    if (stream !== null) stream.abort();",
    "    stream = null;",
    "    activeScope = null;",
    "  }",
    "  async function refresh(restart) {",
    "    try {",
    "      const response = await request(endpoint + \"/snapshot\");",
    "      const body = await response.json();",
    "      if (!response.ok || !body.ok) throw new Error(body.error || \"snapshot failed\");",
    "      snapshot = body.snapshot;",
    "      assistant.textContent = snapshot.assistantText || \"아직 응답이 없습니다.\";",
    "      setStatus(snapshot.busy ? \"응답 생성 중\" : \"연결됨\");",
    "      if (!snapshot.busy) activeTurnId = null;",
    "      cancelTurn.hidden = activeTurnId === null || !snapshot.busy;",
    "      if (boot.canControl) command.hidden = false;",
    "      if (restart || activeScope !== snapshot.scope) startEvents(snapshot.scope, snapshot.cursor);",
    "    } catch (error) {",
    "      stopStream();",
    "      setStatus(\"연결을 다시 확인하세요: \" + (error instanceof Error ? error.message : \"요청 실패\"));",
    "    }",
    "  }",
    "  function scheduleRefresh(restart, delay) {",
    "    refreshRestart = refreshRestart || restart;",
    "    refreshPending = true;",
    "    if (refreshInFlight || refreshTimer !== null) return;",
    "    const wait = delay === undefined",
    "      ? Math.max(0, MIN_SNAPSHOT_REFRESH_MS - (Date.now() - lastSnapshotRefreshAt))",
    "      : delay;",
    "    refreshTimer = window.setTimeout(() => {",
    "      refreshTimer = null;",
    "      if (!refreshPending) return;",
    "      refreshPending = false;",
    "      const restartNow = refreshRestart;",
    "      refreshRestart = false;",
    "      refreshInFlight = true;",
    "      lastSnapshotRefreshAt = Date.now();",
    "      void refresh(restartNow).finally(() => {",
    "        refreshInFlight = false;",
    "        if (refreshPending) scheduleRefresh(false);",
    "      });",
    "    }, wait);",
    "  }",
    "",
    "  function eventName(frame) {",
    "    for (const line of frame.split(/\\r?\\n/)) {",
    "      if (line.startsWith(\"event:\")) return line.slice(6).trim();",
    "    }",
    "    return \"message\";",
    "  }",
    "",
    "  async function startEvents(scope, cursor) {",
    "    if (stream !== null && activeScope === scope) return;",
    "    stopStream();",
    "    const controller = new AbortController();",
    "    stream = controller;",
    "    activeScope = scope;",
    "    try {",
    "      const response = await request(endpoint + \"/events?scope=\" + encodeURIComponent(scope) + \"&afterCursor=\" + cursor, { signal: controller.signal });",
    "      if (response.status === 409) { const retry = !controller.signal.aborted; stopStream(); if (retry) scheduleRefresh(true, 0); return; }",
    "      if (!response.ok || response.body === null) throw new Error(\"stream failed\");",
    "      const reader = response.body.getReader();",
    "      const decoder = new TextDecoder();",
    "      let buffer = \"\";",
    "      while (!controller.signal.aborted) {",
    "        const chunk = await reader.read();",
    "        if (chunk.done) break;",
    "        buffer += decoder.decode(chunk.value, { stream: true });",
    "        let boundary;",
    "        while ((boundary = buffer.indexOf(\"\\n\\n\")) >= 0) {",
    "          const frame = buffer.slice(0, boundary);",
    "          buffer = buffer.slice(boundary + 2);",
    "          const type = eventName(frame);",
    "          if (type === \"reauthorize-required\") {",
    "            setStatus(\"공유가 만료되었거나 철회되었습니다.\");",
    "            stopStream();",
    "            return;",
    "          }",
    "          if (type === \"resync-required\" || type === \"reconnect-required\") {",
    "            const retry = !controller.signal.aborted;",
    "            stopStream();",
    "            if (retry) scheduleRefresh(true, 0);",
    "            return;",
    "          }",
    "          if (type === \"conversation\" && !controller.signal.aborted) scheduleRefresh(false);",
    "        }",
    "      }",
    "      if (!controller.signal.aborted) {",
    "        setStatus(\"스트림을 갱신하는 중…\");",
    "        stopStream();",
    "        scheduleRefresh(true, 0);",
    "      }",
    "    } catch (error) {",
    "      if (!controller.signal.aborted) {",
    "        setStatus(\"스트림이 끊어졌습니다. 재연결 중…\");",
    "        stopStream(); window.setTimeout(() => scheduleRefresh(true, 0), 1500);",
    "      }",
    "    }",
    "  }",
    "  command.addEventListener(\"submit\", async (event) => {",
    "    event.preventDefault();",
    "    if (snapshot === null) return;",
    "    const text = input.value.trim();",
    "    if (!text) return;",
    "    commandStatus.textContent = \"전송 중…\";",
    "    try {",
    "      const attachmentIds = await stageSelectedImages(snapshot.scope);",
    "      const id = typeof crypto.randomUUID === \"function\"",
    "        ? crypto.randomUUID()",
    "        : String(Date.now()) + \"-\" + Math.random().toString(36).slice(2);",
    "      const response = await request(endpoint + \"/commands\", {",
    "        method: \"POST\",",
    "        headers: { \"content-type\": \"application/json\" },",
    "        body: JSON.stringify({",
    "          id, type: \"conversation.send\", input: text, scope: snapshot.scope,",
    "          ...(attachmentIds.length === 0 ? {} : { attachmentIds }),",
    "        }),",
    "      });",
    "      const body = await response.json();",
    "      if (!response.ok || !body.ok) throw new Error(body.error || \"command failed\");",
    "      activeTurnId = body.turn && typeof body.turn.id === \"string\" ? body.turn.id : null;",
    "      cancelTurn.hidden = activeTurnId === null;",
    "      input.value = \"\";",
    "      attachments.value = \"\";",
    "      commandStatus.textContent = body.duplicate ? \"이미 접수된 요청입니다.\" : \"접수되었습니다.\";",
    "      scheduleRefresh(false, 0);",
    "    } catch (error) {",
    "      commandStatus.textContent = error instanceof Error ? error.message : \"전송 실패\";",
    "    }",
    "  });",
    "  cancelTurn.addEventListener(\"click\", async () => {",
    "    if (snapshot === null || activeTurnId === null) return;",
    "    commandStatus.textContent = \"취소 요청 중…\";",
    "    try {",
    "      const id = typeof crypto.randomUUID === \"function\"",
    "        ? crypto.randomUUID()",
    "        : String(Date.now()) + \"-\" + Math.random().toString(36).slice(2);",
    "      const response = await request(endpoint + \"/commands\", {",
    "        method: \"POST\",",
    "        headers: { \"content-type\": \"application/json\" },",
    "        body: JSON.stringify({ id, type: \"turn.cancel-own\", turnId: activeTurnId, scope: snapshot.scope }),",
    "      });",
    "      const body = await response.json();",
    "      if (!response.ok || !body.ok) throw new Error(body.error || \"cancel failed\");",
    "      activeTurnId = null;",
    "      cancelTurn.hidden = true;",
    "      commandStatus.textContent = \"취소를 요청했습니다.\";",
    "      scheduleRefresh(false, 0);",
    "    } catch (error) {",
    "      commandStatus.textContent = error instanceof Error ? error.message : \"취소 실패\";",
    "    }",
    "  });",
    "  logout.addEventListener(\"click\", async () => {",
    "    try { await request(endpoint + \"/logout\", { method: \"POST\" }); } finally {",
    "      stopStream();",
    "      document.body.textContent = \"Tailnet 브라우저 세션이 종료되었습니다.\";",
    "    }",
    "  });",
    "  scheduleRefresh(true, 0);",
    "})();",
    "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * Narrow native-controller ingress. Browser control deliberately waits for a
 * separate same-origin UI + CSRF session; accepting an Origin header here
 * would make a Tailnet capability vulnerable to ambient browser requests.
 */
async function routeControllerCommand(
  req: IncomingMessage,
  res: ServerResponse,
  options: TailnetSurfaceServerOptions,
  currentScope: TailnetObserverScopeReader,
  broker: TailnetControllerBroker,
  requestLimiter: TailnetRequestLimiter,
): Promise<void> {
  if ((req.method ?? "GET") !== "POST") {
    req.resume();
    sendJson(res, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  if (isTailnetNativeBrowserRequest(req.headers)) {
    req.resume();
    sendJson(res, 403, { ok: false, error: "browser-controller-not-ready" });
    return;
  }

  const login = authorizedTailnetLogin(req.headers, options.expectedAppCapability, "controller");
  if (login === undefined) {
    req.resume();
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  if (!requestLimiter.accept(login, req.socket)) {
    req.resume();
    sendJson(res, 429, { ok: false, error: "tailnet-rate-limited" });
    return;
  }
  if (isTailnetNativeBrowserRequest(req.headers)) {
    req.resume();
    sendJson(res, 403, { ok: false, error: "browser-controller-not-ready" });
    return;
  }
  const decoded = await readTailnetControllerCommand(req);
  if (!decoded.ok) {
    sendJson(res, decoded.status, { ok: false, error: decoded.error });
    return;
  }
  const scope = currentScope();
  const pairedShare = resolvePairedShare(options.pairedSharing, login, scope.conversationId, "control");
  if (pairedShare === null) {
    sendJson(res, 403, { ok: false, error: "pairing-share-required" });
    return;
  }

  if (decoded.command.scope !== scope.value) {
    sendSnapshotRequired(
      res,
      scope.value,
      options.projectionStore.snapshot(scope.conversationId, { busy: options.isConversationBusy() }).cursor,
    );
    return;
  }
  switch (await broker.submit(login, decoded.command, scope.conversationId, pairedShare)) {
    case "accepted":
      sendJson(res, 202, {
        ...publicTurnResponse(decoded.command, pairedShare),
        ok: true,
        accepted: true,
        command: { id: decoded.command.id, scope: scope.value },
      });
      return;
    case "duplicate":
      sendJson(res, 202, {
        ok: true,
        ...publicTurnResponse(decoded.command, pairedShare),
        accepted: true,
        duplicate: true,
        command: { id: decoded.command.id, scope: scope.value },
      });
      return;
    case "idempotency-conflict":
      sendJson(res, 409, { ok: false, error: "idempotency-conflict" });
      return;
    case "streaming-active":
      sendJson(res, 409, { ok: false, error: "streaming-active" });
      return;
    case "command-outcome-unknown":
      sendJson(res, 409, { ok: false, error: "command-outcome-unknown" });
      return;
    case "idempotency-capacity-reached":
      sendJson(res, 503, { ok: false, error: "idempotency-capacity-reached" });
      return;
    case "receipt-unavailable":
      sendJson(res, 503, { ok: false, error: "receipt-unavailable" });
      return;
    case "attachment-unavailable":
      sendJson(res, 409, { ok: false, error: "attachment-unavailable" });
      return;
    case "turn-not-found":
      sendJson(res, 404, { ok: false, error: "turn-not-found" });
      return;
  }
}
/**
/**
 * Native P3 image ingress. This route is deliberately separate from the JSON
 * command endpoint so command receipts and safe projections never contain raw
 * binary, filenames, local paths, or content-type parameters.
 */
async function routeTailnetAttachmentUpload(
  req: IncomingMessage,
  res: ServerResponse,
  options: TailnetSurfaceServerOptions,
  currentScope: TailnetObserverScopeReader,
  attachmentStore: TailnetAttachmentStagingStore,
  requestLimiter: TailnetRequestLimiter,
): Promise<void> {
  if ((req.method ?? "GET") !== "POST") {
    req.resume();
    sendJson(res, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  // Native routes never accept an ambient browser request, even when a caller
  // can arrange Tailnet headers in that browser context.
  if (isTailnetNativeBrowserRequest(req.headers)) {
    req.resume();
    sendJson(res, 403, { ok: false, error: "browser-controller-not-ready" });
    return;
  }
  const login = authorizedTailnetLogin(req.headers, options.expectedAppCapability, "controller");
  if (login === undefined) {
    req.resume();
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  if (!requestLimiter.accept(login, req.socket)) {
    req.resume();
    sendJson(res, 429, { ok: false, error: "tailnet-rate-limited" });
    return;
  }
  const requestedScope = parseScope(singleHeader(req.headers, TAILNET_ATTACHMENT_SCOPE_HEADER) ?? null);
  const mimeType = tailnetAttachmentMimeType(singleHeader(req.headers, "content-type"));
  if (requestedScope === undefined || requestedScope === "invalid") {
    req.resume();
    sendJson(res, 400, { ok: false, error: "invalid-attachment-scope" });
    return;
  }
  if (mimeType === undefined) {
    req.resume();
    sendJson(res, 415, { ok: false, error: "image-content-type-required" });
    return;
  }

  let scope: TailnetObserverScope;
  try {
    scope = currentScope();
  } catch {
    req.resume();
    sendJson(res, 503, { ok: false, error: "conversation-unavailable" });
    return;
  }
  const pairedShare = resolvePairedShare(options.pairedSharing, login, scope.conversationId, "control");
  if (pairedShare === null || pairedShare === undefined) {
    req.resume();
    sendJson(res, 403, { ok: false, error: "pairing-share-required" });
    return;
  }
  if (requestedScope !== scope.value) {
    req.resume();
    sendSnapshotRequired(
      res,
      scope.value,
      options.projectionStore.snapshot(scope.conversationId, { busy: options.isConversationBusy() }).cursor,
    );
    return;
  }

  const body = await readTailnetAttachmentBody(req);
  if (!body.ok) {
    sendJson(res, body.status, {
      ok: false,
      error: body.status === 413 ? "attachment-body-too-large" : "invalid-attachment",
    });
    return;
  }

  // Body reads are deliberately followed by the same authoritative pairing and
  // scope checks. A revoke/conversation switch while a client uploads cannot
  // leave a usable staged object behind.
  let latestScope: TailnetObserverScope;
  try {
    latestScope = currentScope();
  } catch {
    sendJson(res, 503, { ok: false, error: "conversation-unavailable" });
    return;
  }
  const latestPairedShare = resolvePairedShare(
    options.pairedSharing,
    login,
    latestScope.conversationId,
    "control",
  );
  if (latestPairedShare === null || latestPairedShare === undefined) {
    sendJson(res, 403, { ok: false, error: "pairing-share-required" });
    return;
  }
  if (requestedScope !== latestScope.value) {
    sendSnapshotRequired(
      res,
      latestScope.value,
      options.projectionStore.snapshot(latestScope.conversationId, {
        busy: options.isConversationBusy(),
      }).cursor,
    );
    return;
  }
  const staged = attachmentStore.stage({
    ownerKey: pairedAttachmentOwnerKey(latestPairedShare),
    isCurrent: () => isTailnetAttachmentCurrent(latestPairedShare, currentScope, latestScope),
    mimeType,
    bytes: body.bytes,
  });
  if (staged === null) {
    sendJson(res, 409, { ok: false, error: "attachment-unavailable" });
    return;
  }
  sendJson(res, 202, {
    ok: true,
    attachment: {
      id: staged.id,
      expiresAt: staged.expiresAt,
      scope: latestScope.value,
    },
  });
}

/** Same staging boundary as native upload, behind the paired Web CSRF session. */
async function routeTailnetWebAttachmentUpload(
  req: IncomingMessage,
  res: ServerResponse,
  options: TailnetSurfaceServerOptions,
  web: TailnetWebRuntime,
  currentScope: TailnetObserverScopeReader,
  attachmentStore: TailnetAttachmentStagingStore,
  requestLimiter: TailnetRequestLimiter,
): Promise<void> {
  if ((req.method ?? "GET") !== "POST") {
    req.resume();
    sendTailnetWebJson(res, web, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  const authorization = authorizeTailnetWebRequest(
    req,
    res,
    options,
    web,
    currentScope,
    requestLimiter,
    "control",
    true,
  );
  if (authorization === null) return;
  const requestedScope = parseScope(singleHeader(req.headers, TAILNET_ATTACHMENT_SCOPE_HEADER) ?? null);
  const mimeType = tailnetAttachmentMimeType(singleHeader(req.headers, "content-type"));
  if (requestedScope === undefined || requestedScope === "invalid") {
    req.resume();
    sendTailnetWebJson(res, web, 400, { ok: false, error: "invalid-attachment-scope" });
    return;
  }
  if (mimeType === undefined) {
    req.resume();
    sendTailnetWebJson(res, web, 415, { ok: false, error: "image-content-type-required" });
    return;
  }
  if (requestedScope !== authorization.scope.value) {
    req.resume();
    sendTailnetWebSnapshotRequired(
      res,
      web,
      authorization.scope.value,
      options.projectionStore.snapshot(authorization.scope.conversationId, {
        busy: options.isConversationBusy(),
      }).cursor,
    );
    return;
  }
  const body = await readTailnetAttachmentBody(req);
  if (!body.ok) {
    sendTailnetWebJson(res, web, body.status, {
      ok: false,
      error: body.status === 413 ? "attachment-body-too-large" : "invalid-attachment",
    });
    return;
  }
  const reauthorized = authorizeTailnetWebRequest(
    req,
    res,
    options,
    web,
    currentScope,
    requestLimiter,
    "control",
    false,
  );
  if (reauthorized === null) return;
  if (requestedScope !== reauthorized.scope.value) {
    sendTailnetWebSnapshotRequired(
      res,
      web,
      reauthorized.scope.value,
      options.projectionStore.snapshot(reauthorized.scope.conversationId, {
        busy: options.isConversationBusy(),
      }).cursor,
    );
    return;
  }
  const staged = attachmentStore.stage({
    ownerKey: pairedAttachmentOwnerKey(reauthorized.pairedShare),
    isCurrent: () => isTailnetAttachmentCurrent(
      reauthorized.pairedShare,
      currentScope,
      reauthorized.scope,
    ),
    mimeType,
    bytes: body.bytes,
  });
  if (staged === null) {
    sendTailnetWebJson(res, web, 409, { ok: false, error: "attachment-unavailable" });
    return;
  }
  sendTailnetWebJson(res, web, 202, {
    ok: true,
    attachment: {
      id: staged.id,
      expiresAt: staged.expiresAt,
      scope: reauthorized.scope.value,
    },
  });
}

function isTailnetAttachmentCurrent(
  pairedShare: TailnetPairedShareAuthorization,
  currentScope: TailnetObserverScopeReader,
  expectedScope: TailnetObserverScope,
): boolean {
  if (!isPairedShareCurrent(pairedShare)) return false;
  try {
    const latest = currentScope();
    return latest.conversationId === expectedScope.conversationId && latest.value === expectedScope.value;
  } catch {
    return false;
  }
}

/**
 * Pairing remains a separate capability from observing or controlling a
 * conversation. Redeeming a code only creates a pending record; a local owner
 * must still activate it and create a scoped share.
 */
async function routePairingClaim(
  req: IncomingMessage,
  res: ServerResponse,
  options: TailnetSurfaceServerOptions,
  requestLimiter: TailnetRequestLimiter,
): Promise<void> {
  if ((req.method ?? "GET") !== "POST") {
    req.resume();
    sendJson(res, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  // Reject this ambient browser request before it consumes a capability bucket.
  if (isTailnetNativeBrowserRequest(req.headers)) {
    req.resume();
    sendJson(res, 403, { ok: false, error: "browser-pairing-not-ready" });
    return;
  }

  const login = authorizedTailnetLogin(req.headers, options.expectedAppCapability, "pairing");
  if (login === undefined) {
    req.resume();
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  if (!requestLimiter.accept(login, req.socket)) {
    req.resume();
    sendJson(res, 429, { ok: false, error: "tailnet-rate-limited" });
    return;
  }
  // This native/CLI exchange must not become an ambient browser capability.
  if (isTailnetNativeBrowserRequest(req.headers)) {
    req.resume();
    sendJson(res, 403, { ok: false, error: "browser-pairing-not-ready" });
    return;
  }
  const decoded = await readTailnetPairingClaim(req);
  if (!decoded.ok) {
    sendJson(res, decoded.status, { ok: false, error: decoded.error });
    return;
  }
  const actorId = options.pairedSharing?.actorIdFor(login);
  if (actorId === null || actorId === undefined || options.pairing === undefined) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  let claim: { readonly expiresAt: number } | null;
  try {
    claim = await options.pairing.claimInvitation(decoded.code, actorId);
  } catch {
    sendJson(res, 503, { ok: false, error: "pairing-store-unavailable" });
    return;
  }
  if (claim === null) {
    sendJson(res, 409, { ok: false, error: "pairing-code-unavailable" });
    return;
  }
  sendJson(res, 202, {
    ok: true,
    pending: true,
    expiresAt: claim.expiresAt,
  });
}

type DecodedTailnetControllerCommand =
  | { readonly ok: true; readonly command: TailnetControllerCommand }
  | {
    readonly ok: false;
    readonly status: 400 | 413 | 415;
    readonly error: "invalid-command" | "command-body-too-large" | "content-type-required";
  };

async function readTailnetControllerCommand(
  req: IncomingMessage,
): Promise<DecodedTailnetControllerCommand> {
  const body = await readTailnetJsonBody(req, MAX_COMMAND_BODY_BYTES);
  if (!body.ok) {
    return {
      ok: false,
      status: body.status,
      error: body.status === 415
        ? "content-type-required"
        : body.status === 413
          ? "command-body-too-large"
          : "invalid-command",
    };
  }
  const command = parseTailnetControllerCommand(body.value);
  return command === undefined
    ? { ok: false, status: 400, error: "invalid-command" }
    : { ok: true, command };
}
type DecodedTailnetJsonBody =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: 400 | 413 | 415 };

async function readTailnetJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<DecodedTailnetJsonBody> {
  if (!isJsonContentType(singleHeader(req.headers, "content-type"))) {
    req.resume();
    return { ok: false, status: 415 };
  }
  const declaredLength = parseContentLength(singleHeader(req.headers, "content-length"));
  if (declaredLength === "invalid") {
    req.resume();
    return { ok: false, status: 400 };
  }
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    req.resume();
    return { ok: false, status: 413 };
  }

  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > maxBytes) {
        req.resume();
        return { ok: false, status: 413 };
      }
      chunks.push(bytes);
    }
  } catch {
    return { ok: false, status: 400 };
  }
  if (length === 0) return { ok: false, status: 400 };

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks, length).toString("utf8")) };
  } catch {
    return { ok: false, status: 400 };
  }
}

type DecodedTailnetAttachmentBody =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly status: 400 | 413 };

async function readTailnetAttachmentBody(
  req: IncomingMessage,
): Promise<DecodedTailnetAttachmentBody> {
  const declaredLength = parseContentLength(singleHeader(req.headers, "content-length"));
  if (declaredLength === "invalid") {
    req.resume();
    return { ok: false, status: 400 };
  }
  if (declaredLength !== undefined && declaredLength > MAX_TAILNET_ATTACHMENT_BYTES) {
    req.resume();
    return { ok: false, status: 413 };
  }

  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_TAILNET_ATTACHMENT_BYTES) {
        req.resume();
        return { ok: false, status: 413 };
      }
      chunks.push(bytes);
    }
  } catch {
    return { ok: false, status: 400 };
  }
  return length === 0
    ? { ok: false, status: 400 }
    : { ok: true, bytes: Buffer.concat(chunks, length) };
}

type DecodedTailnetPairingClaim =
  | { readonly ok: true; readonly code: string }
  | {
    readonly ok: false;
    readonly status: 400 | 413 | 415;
    readonly error: "invalid-pairing-claim" | "pairing-body-too-large" | "content-type-required";
  };

async function readTailnetPairingClaim(
  req: IncomingMessage,
): Promise<DecodedTailnetPairingClaim> {
  const body = await readTailnetJsonBody(req, MAX_PAIRING_BODY_BYTES);
  if (!body.ok) {
    return {
      ok: false,
      status: body.status,
      error: body.status === 415
        ? "content-type-required"
        : body.status === 413
          ? "pairing-body-too-large"
          : "invalid-pairing-claim",
    };
  }
  if (
    !isRecord(body.value)
    || !hasExactOwnKeys(body.value, ["code"])
    || !isPairingInvitationCode(body.value.code)
  ) {
    return { ok: false, status: 400, error: "invalid-pairing-claim" };
  }
  return { ok: true, code: body.value.code };
}

function isPairingInvitationCode(value: unknown): value is string {
  return typeof value === "string" && /^lvis-pair-v1\.[A-Za-z0-9_-]{43}$/.test(value);
}

function parseTailnetControllerCommand(value: unknown): TailnetControllerCommand | undefined {
  if (!isRecord(value) || !isControllerCommandId(value.id)) return undefined;
  const scope = parseScope(typeof value.scope === "string" ? value.scope : null);
  if (scope === undefined || scope === "invalid") return undefined;

  if (value.type === "conversation.send") {
    const hasAttachments = Object.prototype.hasOwnProperty.call(value, "attachmentIds");
    if (
      !hasExactOwnKeys(
        value,
        hasAttachments
          ? ["id", "type", "input", "attachmentIds", "scope"]
          : ["id", "type", "input", "scope"],
      )
      || typeof value.input !== "string"
      || value.input.trim().length === 0
      || value.input.length > 24_000
    ) {
      return undefined;
    }
    const attachmentIds = value.attachmentIds;
    if (
      attachmentIds !== undefined
      && (
        !Array.isArray(attachmentIds)
        || attachmentIds.length === 0
        || attachmentIds.length > MAX_SUBSCRIPTION_PROMPT_ATTACHMENTS
        || !attachmentIds.every((id) => isTailnetAttachmentId(id))
        || new Set(attachmentIds).size !== attachmentIds.length
      )
    ) {
      return undefined;
    }
    return {
      id: value.id,
      type: value.type,
      input: value.input,
      ...(attachmentIds === undefined ? {} : { attachmentIds: Object.freeze([...attachmentIds]) }),
      scope,
    };
  }

  if (
    value.type !== "turn.cancel-own"
    || !hasExactOwnKeys(value, ["id", "type", "turnId", "scope"])
    || !isTailnetPublicTurnId(value.turnId)
  ) {
    return undefined;
  }
  return { id: value.id, type: value.type, turnId: value.turnId, scope };
}

function createTailnetControllerBroker(
  commandPort: ConversationCommandPort,
  receiptStore: TailnetControllerReceiptStore,
  attachmentStore: TailnetAttachmentStagingStore,
  log: ((message: string) => void) | undefined,
): TailnetControllerBroker {
  const submit = commandPort.submit;
  if (typeof submit !== "function" || typeof commandPort.execute !== "function") {
    throw new Error("tailnet controller requires a reservable conversation command port");
  }
  const ownerId = randomUUID();
  // A persistence failure after reserve must remain blocked for this broker
  // too. The durable state is intentionally left reserved, so a restart also
  // returns outcome-unknown rather than replaying a possibly executed command.
  const outcomeUnknownKeys = new Set<string>();
  const settle = (keyDigest: string): void => {
    try {
      receiptStore.settle({ keyDigest, ownerId });
    } catch {
      outcomeUnknownKeys.add(keyDigest);
      log?.("controller receipt settlement failed; replay is blocked");
    }
  };
  const releaseReceipt = (keyDigest: string): boolean => {
    try {
      receiptStore.releaseReserved({ keyDigest, ownerId });
      return true;
    } catch {
      outcomeUnknownKeys.add(keyDigest);
      log?.("controller receipt release failed; replay is blocked");
      return false;
    }
  };

  return {
    async submit(login, command, privateConversationId, pairedShare): Promise<ControllerSubmitResult> {
      // P1 direct grants intentionally remain send-only. P3 public handles,
      // ownership cancellation, and binary staging are all paired-share-only.
      if (command.type === "turn.cancel-own" && pairedShare === undefined) {
        return "turn-not-found";
      }
      if (command.type === "conversation.send" && command.attachmentIds !== undefined && pairedShare === undefined) {
        return "attachment-unavailable";
      }

      const actor = pairedShare === undefined
        ? createTailnetControllerActor(identityDigest(login))
        : createTailnetControllerActor(
          pairedShare.actorId.slice("tailnet:".length),
          {
            pairedShare: pairedShare.pairedShare,
            pairedShareGuard: pairedShare.pairedShareGuard,
          },
        );
      const keyDigest = controllerReceiptKeyDigest(actor.actorId, command.id);
      let reservation;
      try {
        reservation = receiptStore.reserve({
          keyDigest,
          intentDigest: commandDigest(command),
          conversationDigest: privateConversationDigest(privateConversationId),
          ownerId,
        });
      } catch {
        log?.("controller receipt reserve failed; command was not submitted");
        return "receipt-unavailable";
      }
      switch (reservation.kind) {
        case "duplicate":
          return outcomeUnknownKeys.has(keyDigest)
            ? "command-outcome-unknown"
            : "duplicate";
        case "outcome-unknown":
          return "command-outcome-unknown";
        case "conflict":
          return "idempotency-conflict";
        case "capacity-exhausted":
          return "idempotency-capacity-reached";
        case "reserved":
          break;
      }

      if (command.type === "turn.cancel-own") {
        try {
          const cancellation = await commandPort.execute(actor, {
            kind: "turn.cancel-own",
            turnId: command.turnId,
          });
          if (
            "ok" in cancellation
            && cancellation.ok === true
            && "cancelled" in cancellation
            && cancellation.cancelled === true
          ) {
            settle(keyDigest);
            return "accepted";
          }
        } catch {
          // The command port may have reached the process-local abort edge before
          // an adapter fault. Preserve its receipt rather than risk a replay.
          outcomeUnknownKeys.add(keyDigest);
          log?.("controller cancellation admission threw; replay is blocked");
          return "command-outcome-unknown";
        }
        return releaseReceipt(keyDigest) ? "turn-not-found" : "command-outcome-unknown";
      }

      let claim;
      if (command.attachmentIds !== undefined) {
        claim = attachmentStore.reserve(
          pairedAttachmentOwnerKey(pairedShare!),
          command.attachmentIds,
        );
        if (claim === null) {
          return releaseReceipt(keyDigest) ? "attachment-unavailable" : "command-outcome-unknown";
        }
      }

      const publicTurn = pairedShare === undefined
        ? undefined
        : {
          turnId: tailnetPublicTurnId(actor.actorId, command.id),
          abortController: new AbortController(),
        };
      let submission;
      try {
        submission = submit.call(commandPort, actor, {
          kind: "message.send",
          // The remote wire type cannot claim provenance, persona, activation,
          // session selection, path access, or raw bytes. The host mints all of
          // those boundaries and accepts only one-time staged image parts.
          payload: {
            input: command.input,
            ...(claim === undefined ? {} : { attachments: claim.attachments }),
          },
          ...(publicTurn === undefined ? {} : { publicTurn }),
        });
      } catch {
        // We cannot prove a thrown adapter did not admit the lease, so preserve
        // the reserved receipt and block a replay rather than duplicating work.
        if (claim !== undefined) attachmentStore.release(claim);
        outcomeUnknownKeys.add(keyDigest);
        log?.("controller command admission threw; replay is blocked");
        return "command-outcome-unknown";
      }
      if (submission === null) {
        if (claim !== undefined) attachmentStore.release(claim);
        return releaseReceipt(keyDigest) ? "streaming-active" : "command-outcome-unknown";
      }

      try {
        if (claim !== undefined) attachmentStore.commit(claim);
      } catch {
        // The turn may already own copied canonical parts, so do not make the
        // receipt replayable if staging cleanup itself faults.
        outcomeUnknownKeys.add(keyDigest);
        log?.("controller attachment commit failed; replay is blocked");
        return "command-outcome-unknown";
      }
      // The safe timeline carries completion/failure. Both are known outcomes;
      // only a failed durable settlement becomes outcome-unknown on replay.
      void submission.completion.then(
        () => settle(keyDigest),
        () => settle(keyDigest),
      );
      return "accepted";
    },

    revalidatePairedTurns(): void {
      try {
        commandPort.revalidatePublicTurns?.();
      } catch {
        log?.("controller public-turn revalidation failed");
      }
    },
  };
}

function resolvePairedShare(
  authorizer: TailnetPairedShareAuthorizer | undefined,
  login: string,
  conversationId: string,
  required: "observe" | "control",
): TailnetPairedShareAuthorization | null | undefined {
  if (authorizer === undefined) return undefined;
  try {
    const authority = authorizer.authorize(login, conversationId, required);
    return authority !== null && isPairedShareCurrent(authority) ? authority : null;
  } catch {
    return null;
  }
}

function isPairedShareCurrent(authority: TailnetPairedShareAuthorization): boolean {
  try {
    return authority.pairedShareGuard.isCurrent(authority.pairedShare);
  } catch {
    return false;
  }
}

function pairedAttachmentOwnerKey(authority: TailnetPairedShareAuthorization): string {
  const binding = authority.pairedShare;
  return createHash("sha256").update([
    "tailnet-attachment-v1",
    authority.actorId,
    binding.pairingId,
    String(binding.pairingEpoch),
    binding.shareId,
    String(binding.shareEpoch),
    binding.scope,
  ].join("\u0000"), "utf8").digest("hex");
}

function identityDigest(login: string): string {
  return createHash("sha256").update(login, "utf8").digest("hex");
}

function createTailnetRequestLimiter(
  maxRequestsPerWindow: number,
  windowMs: number,
): TailnetRequestLimiter {
  const buckets = new Map<string, { startedAt: number; count: number }>();
  // A raw TCP connection is not something a caller can forge or swap out
  // mid-request, unlike the Tailscale-User-Login header. Pinning the bucket
  // key to whichever login a socket first authorized with means later
  // requests on that same connection cannot mint additional tracked
  // identities by sending a different header value -- the number of
  // distinct identities one caller can register is bounded by how many
  // sockets it holds open, which the listener already caps separately via
  // maxConnections. The map holds only digests, never raw logins.
  const pinnedIdentity = new WeakMap<Socket, string>();
  return {
    accept(login, socket): boolean {
      const now = Date.now();
      // The map never retains a login, and stale buckets are evicted before a
      // new identity can consume one of the fixed slots.
      for (const [key, bucket] of buckets) {
        if (now - bucket.startedAt >= windowMs) buckets.delete(key);
      }
      let key = pinnedIdentity.get(socket);
      if (key === undefined) {
        key = identityDigest(login);
        pinnedIdentity.set(socket, key);
      }
      const current = buckets.get(key);
      if (current === undefined) {
        if (buckets.size >= MAX_TRACKED_RATE_IDENTITIES) {
          // Refusing every caller here would itself be a self-inflicted
          // outage: capacity is now bounded by real distinct connections,
          // not by how many header values a caller can send, so a flood of
          // genuinely new identities still deserves service. Evict the
          // longest-tracked bucket (Map iteration order is insertion order)
          // to make room -- the accepted cost is that identity's window
          // resets a little early, never that a caller earning a fresh
          // bucket is turned away outright.
          const oldestKey = buckets.keys().next().value;
          if (oldestKey !== undefined) buckets.delete(oldestKey);
        }
        buckets.set(key, { startedAt: now, count: 1 });
        return true;
      }
      if (now - current.startedAt >= windowMs) {
        buckets.set(key, { startedAt: now, count: 1 });
        return true;
      }
      if (current.count >= maxRequestsPerWindow) return false;
      current.count += 1;
      return true;
    },
  };
}

function commandDigest(command: TailnetControllerCommand): string {
  const semantic = command.type === "conversation.send"
    ? {
      type: command.type,
      input: command.input,
      attachmentIds: command.attachmentIds ?? [],
    }
    : {
      type: command.type,
      turnId: command.turnId,
    };
  return createHash("sha256").update(JSON.stringify(semantic), "utf8").digest("hex");
}

function publicTurnResponse(
  command: TailnetControllerCommand,
  pairedShare: TailnetPairedShareAuthorization | undefined,
): Readonly<Record<string, unknown>> {
  return command.type === "conversation.send" && pairedShare !== undefined
    ? {
      turn: {
        id: tailnetPublicTurnId(pairedShare.actorId, command.id),
      },
    }
    : {};
}

function controllerReceiptKeyDigest(actorId: string, commandId: string): string {
  return createHash("sha256").update(`${actorId}\u0000${commandId}`, "utf8").digest("hex");
}

function tailnetPublicTurnId(actorId: string, commandId: string): string {
  const digest = controllerReceiptKeyDigest(actorId, commandId);
  return "tailnet-turn_" + Buffer.from(digest, "hex").toString("base64url");
}
function privateConversationDigest(conversationId: string): string {
  return createHash("sha256").update(conversationId, "utf8").digest("hex");
}

function isTailnetControllerReceiptStore(value: unknown): value is TailnetControllerReceiptStore {
  return typeof value === "object" && value !== null
    && typeof (value as { reserve?: unknown }).reserve === "function"
    && typeof (value as { releaseReserved?: unknown }).releaseReserved === "function"
    && typeof (value as { settle?: unknown }).settle === "function";
}

function isTailnetAttachmentStagingStore(value: unknown): value is TailnetAttachmentStagingStore {
  return typeof value === "object" && value !== null
    && typeof (value as { stage?: unknown }).stage === "function"
    && typeof (value as { reserve?: unknown }).reserve === "function"
    && typeof (value as { commit?: unknown }).commit === "function"
    && typeof (value as { release?: unknown }).release === "function"
    && typeof (value as { discardStale?: unknown }).discardStale === "function"
    && typeof (value as { clear?: unknown }).clear === "function";
}

function isTailnetWebSessionStore(value: unknown): value is TailnetWebSessionStore {
  return typeof value === "object"
    && value !== null
    && typeof (value as { issue?: unknown }).issue === "function"
    && typeof (value as { issuePageCsrf?: unknown }).issuePageCsrf === "function"
    && typeof (value as { resolve?: unknown }).resolve === "function"
    && typeof (value as { resolveMutation?: unknown }).resolveMutation === "function"
    && typeof (value as { revoke?: unknown }).revoke === "function"
    && typeof (value as { clear?: unknown }).clear === "function"
    && typeof (value as { subscribe?: unknown }).subscribe === "function";
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/** Exact image media types only; parameters belong to neither the wire nor the SOT normalizer. */
function tailnetAttachmentMimeType(value: string | undefined): string | undefined {
  const mimeType = value?.trim().toLowerCase();
  return mimeType === "image/png"
    || mimeType === "image/jpeg"
    || mimeType === "image/gif"
    || mimeType === "image/webp"
    || mimeType === "image/bmp"
    ? mimeType
    : undefined;
}
function parseContentLength(value: string | undefined): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) return "invalid";
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

function isControllerCommandId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value);
}

function isTailnetAttachmentId(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isTailnetPublicTurnId(value: unknown): value is string {
  return typeof value === "string" && /^tailnet-turn_[A-Za-z0-9_-]{43}$/.test(value);
}

function hasExactOwnKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  store: SharedConversationProjectionStore,
  conversationId: string,
  afterCursor: number | undefined,
  liveStreams: Set<() => void>,
  pairedShare: TailnetPairedShareAuthorization | undefined,
  pairedShareStreamChecks: Set<() => void>,
  scope: TailnetObserverScope,
  currentScope: TailnetObserverScopeReader,
  maxStreamLifetimeMs: number,
  sessionGuard: TailnetStreamSessionGuard | undefined = undefined,
  lifetimeAction: "reauthorize" | "reconnect" = "reauthorize",
): void {
  let cleaned = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let scopeCheck: ReturnType<typeof setInterval> | undefined;
  let maximumLifetime: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let endStream: () => void = () => {};

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (scopeCheck) {
      clearInterval(scopeCheck);
      scopeCheck = undefined;
    }
    if (maximumLifetime) {
      clearTimeout(maximumLifetime);
      maximumLifetime = undefined;
    }
    unsubscribe?.();
    unsubscribe = undefined;
    liveStreams.delete(endStream);
    pairedShareStreamChecks.delete(reauthorizeIfPairingShareChanged);
    sessionGuard?.checks.delete(reauthorizeIfSessionChanged);
    req.off("close", cleanup);
    res.off("close", cleanup);
  };

  const writeOrClose = (frame: string): boolean => {
    if (cleaned || res.destroyed || res.writableEnded) {
      cleanup();
      return false;
    }
    try {
      if (res.write(frame)) return true;
    } catch {
      // The peer may close between writable state observation and write().
    }
    cleanup();
    if (!res.destroyed) res.destroy();
    return false;
  };

  endStream = () => {
    cleanup();
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  const reauthorizeIfPairingShareChanged = (): boolean => {
    if (pairedShare === undefined || isPairedShareCurrent(pairedShare)) return false;
    if (!writeOrClose(formatReauthorizeRequiredEvent(scope.value))) return true;
    endStream();
    return true;
  };

  const reauthorizeIfSessionChanged = (): boolean => {
    if (sessionGuard === undefined) return false;
    let current = false;
    try {
      current = sessionGuard.isCurrent();
    } catch {
      // Session-store faults are an authorization failure, never a bypass.
    }
    if (current) return false;
    if (!writeOrClose(formatReauthorizeRequiredEvent(scope.value))) return true;
    endStream();
    return true;
  };

  const resyncIfScopeChanged = (): boolean => {
    let latest: TailnetObserverScope;
    try {
      latest = currentScope();
    } catch {
      endStream();
      return true;
    }
    if (latest.value === scope.value) return false;
    if (!writeOrClose(formatResyncRequiredEvent(latest.value))) return true;
    endStream();
    return true;
  };

  req.on("close", cleanup);
  res.on("close", cleanup);

  const onEvent = (event: SharedConversationEventEnvelope) => {
    if (reauthorizeIfSessionChanged()) return;
    if (reauthorizeIfPairingShareChanged()) return;
    if (resyncIfScopeChanged()) return;
    writeOrClose(formatSseEvent(event, scope.value));
  };
  const subscription = afterCursor === undefined
    ? store.subscribe(conversationId, onEvent)
    : store.subscribe(conversationId, onEvent, { afterCursor });
  if (subscription.replay.snapshotRequired) {
    subscription.unsubscribe();
    cleanup();
    sendSnapshotRequired(res, scope.value, subscription.replay.latestCursor);
    return;
  }
  unsubscribe = subscription.unsubscribe;
  liveStreams.add(endStream);
  if (pairedShare !== undefined) pairedShareStreamChecks.add(reauthorizeIfPairingShareChanged);
  if (sessionGuard !== undefined) sessionGuard.checks.add(reauthorizeIfSessionChanged);

  try {
    res.writeHead(200, {
      "content-type": SSE_CONTENT_TYPE,
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    });
    res.socket?.setNoDelay(true);
    if (!writeOrClose(`retry: ${SSE_RETRY_MS}\n: connected\n\n`)) return;
    if (reauthorizeIfSessionChanged()) return;
    if (reauthorizeIfPairingShareChanged()) return;
    for (const event of subscription.replay.events) {
      if (reauthorizeIfSessionChanged()) return;
      if (resyncIfScopeChanged()) return;
      if (reauthorizeIfPairingShareChanged()) return;
      if (!writeOrClose(formatSseEvent(event, scope.value))) return;
    }
  } catch {
    cleanup();
    if (!res.destroyed) res.destroy();
    return;
  }
  heartbeat = setInterval(() => {
    if (reauthorizeIfSessionChanged() || reauthorizeIfPairingShareChanged()) return;
    writeOrClose(": ping\n\n");
  }, SSE_HEARTBEAT_MS);
  scopeCheck = setInterval(() => {
    if (reauthorizeIfSessionChanged()) return;
    resyncIfScopeChanged();
  }, SSE_HEARTBEAT_MS);
  scopeCheck.unref();
  heartbeat.unref();
  maximumLifetime = setTimeout(() => {
    if (cleaned) return;
    if (!writeOrClose(lifetimeAction === "reconnect"
      ? formatReconnectRequiredEvent(scope.value)
      : formatReauthorizeRequiredEvent(scope.value))) return;
    endStream();
  }, maxStreamLifetimeMs);
  maximumLifetime.unref();
}

function formatSseEvent(event: SharedConversationEventEnvelope, scope: string): string {
  return `id: ${event.cursor}\nevent: conversation\ndata: ${JSON.stringify(toTailnetObserverEvent(event, scope))}\n\n`;
}

function toTailnetObserverEvent(
  event: SharedConversationEventEnvelope,
  scope: string,
): TailnetObserverEvent {
  return {
    version: event.version,
    cursor: event.cursor,
    emittedAt: event.emittedAt,
    event: event.event,
    scope,
  };
}

function toTailnetObserverSnapshot(
  snapshot: SharedConversationSnapshot,
  scope: string,
): TailnetObserverSnapshot {
  return {
    version: snapshot.version,
    cursor: snapshot.cursor,
    updatedAt: snapshot.updatedAt,
    busy: snapshot.busy,
    awaitingLocalApproval: snapshot.awaitingLocalApproval,
    assistantText: snapshot.assistantText,
    scope,
  };
}

function formatResyncRequiredEvent(scope: string): string {
  return `event: resync-required\ndata: ${JSON.stringify({ scope })}\n\n`;
}

function formatReauthorizeRequiredEvent(scope: string): string {
  return `event: reauthorize-required\ndata: ${JSON.stringify({ scope })}\n\n`;
}

function formatReconnectRequiredEvent(scope: string): string {
  return `event: reconnect-required\ndata: ${JSON.stringify({ scope })}\n\n`;
}

function sendSnapshotRequired(res: ServerResponse, scope: string, latestCursor: number): void {
  sendJson(res, 409, {
    ok: false,
    error: "snapshot-required",
    scope,
    latestCursor,
  });
}
function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    "content-type": JSON_CONTENT_TYPE,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function resolveAfterCursor(
  query: string | null,
  lastEventId: string | undefined,
): number | undefined | "invalid" {
  const fromQuery = parseAfterCursor(query);
  const fromHeader = parseAfterCursor(lastEventId === "" ? undefined : lastEventId);
  if (fromQuery === "invalid" || fromHeader === "invalid") return "invalid";
  if (fromQuery !== undefined && fromHeader !== undefined && fromQuery !== fromHeader) return "invalid";
  return fromQuery ?? fromHeader;
}

function parseScope(raw: string | null): string | undefined | "invalid" {
  if (raw === null) return undefined;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
    ? raw
    : "invalid";
}

function hasRequestBody(req: IncomingMessage): boolean {
  const contentLength = singleHeader(req.headers, "content-length");
  return (contentLength !== undefined && contentLength !== "0")
    || singleHeader(req.headers, "transfer-encoding") !== undefined;
}

function createScopeTracker(getCurrentConversationId: () => string): TailnetObserverScopeReader {
  let currentConversationId: string | undefined;
  let scope = "";
  return () => {
    const conversationId = getCurrentConversationId();
    if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
      throw new Error("tailnet observer current conversation id unavailable");
    }
    if (conversationId !== currentConversationId) {
      currentConversationId = conversationId;
      scope = randomUUID();
    }
    return { conversationId, value: scope };
  };
}
function parseAfterCursor(raw: string | null | undefined): number | undefined | "invalid" {
  if (raw === null || raw === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return "invalid";
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}
function hasHeader(headers: IncomingHttpHeaders, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function singleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  let found: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value !== "string" || found !== undefined) return undefined;
    found = value;
  }
  return found;
}

function isSafeLogin(value: string | undefined): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value.trim().length > 0
    && !hasControlChars(value);
}

function isCapabilityKey(value: string): boolean {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value !== "__proto__"
    && value !== "constructor"
    && value !== "prototype"
    && !hasControlChars(value)
    // A capability key is a token spliced into grant strings, so a SPACE in one
    // would split it in two. Stricter than the shared class on purpose.
    && !value.includes(" ");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}
