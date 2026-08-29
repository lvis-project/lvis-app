/**
 * Restricted inbound command boundary for provider chat bridges.
 *
 * This is deliberately a core, not a listener: a provider adapter owns its
 * credentials and HTTP server, then gives this gateway only an exact raw body
 * and headers. The adapter MUST verify its provider signature before it returns
 * a decoded envelope. The gateway never parses an unverified provider body.
 *
 * No provider is enabled by constructing this module. `enabled` defaults to
 * false, and a disabled gateway invokes neither verifier nor authorization.
 * Its only command is a text message send through the common host-owned port.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  createPlatformBridgeActor,
  type ConversationCommandPort,
} from "./conversation-command-port.js";
import type { TailnetControllerReceiptStore } from "../api/tailnet-controller-receipt-store.js";
import type { PlatformBridgeBinding, PlatformBridgeGuard } from "../shared/chat-origin.js";
import { hasNonWhitespaceControlChars } from "../shared/display-safe-text.js";
import { UUID_PATTERN } from "../shared/dlp-safe-id.js";

const SHA256_HEX = /^[a-f0-9]{64}$/;
/** Mirrors the receipt store's own owner grammar so both agree on validity. */
const DEFAULT_MAX_RAW_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 24_000;
const MAX_PROVIDER_CHARS = 64;
const DEFAULT_MAX_INBOUND_REQUESTS_PER_WINDOW = 12;
const DEFAULT_INBOUND_REQUEST_WINDOW_MS = 60_000;
const DEFAULT_MAX_TRACKED_INBOUND_AUTHORIZED_PAIRS = 128;
const MAX_IDENTIFIER_CHARS = 256;
// Tabs and line breaks are normal message text. The rest of C0 controls and
// DEL make ambiguous provider identifiers, logs, and command prefixes.

/** Raw request material passed to the provider-owned verifier only. */
export interface PlatformBridgeRawWebhookRequest {
  readonly rawBody: Uint8Array;
  /** Preserved only for signature verification; never persisted by this core. */
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/**
 * The sole provider-specific ingress extension point.
 *
 * `verify` receives bytes before any body parsing performed by this module.
 * It is responsible for provider signature / timestamp / replay checks, then
 * may parse those verified bytes and return a decoded candidate envelope.
 */
export interface PlatformBridgeWebhookVerifier {
  verify(request: Readonly<PlatformBridgeRawWebhookRequest>): Promise<unknown> | unknown;
}

/** Exact normalized data a verified provider adapter may present to the host. */
export interface PlatformBridgeVerifiedEnvelope {
  /** Canonical lowercase provider tag selected by the verifier. */
  readonly provider: string;
  /** Provider delivery identifier, used only through a durable digest. */
  readonly deliveryId: string;
  /** Provider-native opaque channel identifier, never persisted in plaintext. */
  readonly channelId: string;
  /** Provider-native opaque sender identifier, never persisted in plaintext. */
  readonly senderId: string;
  /** A bounded text-only user message. Attachments and command envelopes are absent. */
  readonly text: string;
}

/**
 * Host-owned pairing result. All fields are produced locally by the pairing
 * registry, never copied from a provider webhook payload.
 */
export interface PlatformBridgeInboundAuthorization {
  /** SHA-256 identity digest for the paired provider account/channel. */
  readonly actorDigest: string;
  /** SHA-256 of the private target conversation; safe for receipt persistence. */
  readonly conversationDigest: string;
  /** Host-private durable pairing/share binding. */
  readonly bridgeBinding: PlatformBridgeBinding;
  /** Host-private revocation guard for this binding. */
  readonly bridgeGuard: PlatformBridgeGuard;
}

/** Resolve an already-verified provider envelope to a currently paired owner. */
export type PlatformBridgeInboundAuthorizer = (
  envelope: Readonly<PlatformBridgeVerifiedEnvelope>,
) => Promise<PlatformBridgeInboundAuthorization | null | undefined>
  | PlatformBridgeInboundAuthorization
  | null
  | undefined;

/** Structural compatibility contract shared with Tailnet durable receipts. */
export type PlatformBridgeReceiptStore = Pick<
  TailnetControllerReceiptStore,
  "reserve" | "releaseReserved" | "settle"
>;

/** Stable, provider-safe admission outcomes. They contain no webhook plaintext. */
export type PlatformBridgeInboundResult =
  | "accepted"
  | "duplicate"
  | "disabled"
  | "invalid-request"
  | "request-too-large"
  | "verification-failed"
  | "invalid-envelope"
  | "slash-command-rejected"
  | "authorization-denied"
  | "authorization-revoked"
  | "idempotency-conflict"
  | "streaming-active"
  | "command-outcome-unknown"
  | "receipt-unavailable"
  | "idempotency-capacity-reached"
  | "rate-limited";

export interface PlatformBridgeInboundGateway {
  /**
   * Verify first, then normalize and authorize a provider webhook delivery.
   * This method deliberately accepts neither a pre-parsed body nor a command
   * union, which prevents providers from reaching attachment/session/cancel
   * paths by construction.
   */
  handleWebhook(request: PlatformBridgeRawWebhookRequest): Promise<PlatformBridgeInboundResult>;
}

export interface CreatePlatformBridgeInboundGatewayOptions {
  readonly verifier: PlatformBridgeWebhookVerifier;
  readonly authorize: PlatformBridgeInboundAuthorizer;
  /** Reuses the existing plaintext-free durable command receipt protocol. */
  readonly receiptStore: PlatformBridgeReceiptStore;
  /** Same process-local turn lease used by Desktop, Web, CLI, and Tailnet. */
  readonly commandPort: ConversationCommandPort;
  /** Explicit opt-in only. Defaults to false. */
  readonly enabled?: boolean;
  /** Limits copied bytes before the provider verifier is invoked; defaults to 64 KiB. */
  readonly maxRawBodyBytes?: number;
  /** Limits the normalized text message; defaults to 24,000 UTF-16 code units. */
  readonly maxTextChars?: number;
  /** New, non-duplicate inbound messages per authorized pair in one fixed window. */
  readonly maxInboundRequestsPerWindow?: number;
  /** Fixed in-memory admission window for each authorized pair; defaults to one minute. */
  readonly inboundRequestWindowMs?: number;
  /** Hard cap on anonymized authorized-pair buckets retained in this process. */
  readonly maxTrackedInboundAuthorizedPairs?: number;
  /**
   * Host-minted receipt owner identity. Supply a value that outlives a single
   * gateway instance so a reservation made before a reconnect is still settled
   * by its own owner afterwards; a per-instance identity would leave that
   * record permanently `outcome-unknown`. Never provider-influenced.
   */
  readonly receiptOwnerId?: string;
  /** Host clock hook for deterministic embedding/tests; defaults to Date.now. */
  readonly now?: () => number;
  /** Fixed observability messages only; never receives webhook values. */
  readonly log?: (message: string) => void;
}

/**
 * Build one disabled-by-default, provider-neutral inbound gateway.
 *
 * The receipt state receives only SHA-256 digests of the provider delivery,
 * message intent, and target conversation. Neither text nor provider account
 * identifiers are logged or written by this module.
 */
export function createPlatformBridgeInboundGateway(
  options: CreatePlatformBridgeInboundGatewayOptions,
): PlatformBridgeInboundGateway {
  if (!options || typeof options !== "object") {
    throw new TypeError("platform-bridge-inbound-options-invalid");
  }
  if (typeof options.verifier?.verify !== "function") {
    throw new TypeError("platform-bridge-inbound-verifier-invalid");
  }
  if (typeof options.authorize !== "function") {
    throw new TypeError("platform-bridge-inbound-authorizer-invalid");
  }
  if (!isPlatformBridgeReceiptStore(options.receiptStore)) {
    throw new TypeError("platform-bridge-inbound-receipt-store-invalid");
  }
  const submit = options.commandPort?.submit;
  if (typeof submit !== "function") {
    throw new TypeError("platform-bridge-inbound-command-port-invalid");
  }
  if (options.enabled !== undefined && typeof options.enabled !== "boolean") {
    throw new TypeError("platform-bridge-inbound-enabled-invalid");
  }
  if (options.log !== undefined && typeof options.log !== "function") {
    throw new TypeError("platform-bridge-inbound-log-invalid");
  }

  const enabled = options.enabled ?? false;
  const maxRawBodyBytes = positiveInteger(
    options.maxRawBodyBytes ?? DEFAULT_MAX_RAW_BODY_BYTES,
    "max-raw-body-bytes",
  );
  const maxTextChars = positiveInteger(
    options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
    "max-text-chars",
  );
  const ownerId = receiptOwnerId(options.receiptOwnerId);
  const maxInboundRequestsPerWindow = positiveInteger(
    options.maxInboundRequestsPerWindow ?? DEFAULT_MAX_INBOUND_REQUESTS_PER_WINDOW,
    "max-inbound-requests-per-window",
  );
  const inboundRequestWindowMs = positiveInteger(
    options.inboundRequestWindowMs ?? DEFAULT_INBOUND_REQUEST_WINDOW_MS,
    "inbound-request-window-ms",
  );
  const maxTrackedInboundAuthorizedPairs = positiveInteger(
    options.maxTrackedInboundAuthorizedPairs ?? DEFAULT_MAX_TRACKED_INBOUND_AUTHORIZED_PAIRS,
    "max-tracked-inbound-authorized-pairs",
  );
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new TypeError("platform-bridge-inbound-now-invalid");
  }
  const inboundRateLimiter = createInboundRateLimiter(
    maxInboundRequestsPerWindow,
    inboundRequestWindowMs,
    maxTrackedInboundAuthorizedPairs,
    options.now ?? Date.now,
  );
  const outcomeUnknownKeys = new Set<string>();

  const settle = (keyDigest: string): void => {
    try {
      options.receiptStore.settle({ keyDigest, ownerId });
    } catch {
      outcomeUnknownKeys.add(keyDigest);
      report(options.log, "platform bridge receipt settlement failed; inbound replay is blocked");
    }
  };

  const releaseReservation = (keyDigest: string): boolean => {
    try {
      options.receiptStore.releaseReserved({ keyDigest, ownerId });
      return true;
    } catch {
      outcomeUnknownKeys.add(keyDigest);
      report(options.log, "platform bridge receipt release failed; inbound replay is blocked");
      return false;
    }
  };

  return {
    async handleWebhook(request): Promise<PlatformBridgeInboundResult> {
      // Disabled is intentionally checked before reading, copying, verifying,
      // parsing, authorizing, or durably recording any provider material.
      if (!enabled) return "disabled";

      const copiedRequest = copyRawWebhookRequest(request, maxRawBodyBytes);
      if (copiedRequest === "invalid") return "invalid-request";
      if (copiedRequest === "too-large") return "request-too-large";

      let verified: unknown;
      try {
        verified = await options.verifier.verify(copiedRequest);
      } catch {
        return "verification-failed";
      }

      const envelope = normalizeVerifiedEnvelope(verified, maxTextChars);
      if (envelope === undefined) return "invalid-envelope";
      // Slash text is never a platform command. This check is after verified
      // normalization but before pairing, receipts, and turn admission.
      if (envelope.text.trimStart().startsWith("/")) return "slash-command-rejected";

      let authorization: PlatformBridgeInboundAuthorization | undefined;
      try {
        authorization = normalizeAuthorization(await options.authorize(envelope));
      } catch {
        return "authorization-denied";
      }
      if (authorization === undefined) return "authorization-denied";
      if (!isAuthorizationCurrent(authorization)) return "authorization-revoked";

      let actor: ReturnType<typeof createPlatformBridgeActor>;
      try {
        actor = createPlatformBridgeActor(authorization.actorDigest, {
          bridgeBinding: authorization.bridgeBinding,
          bridgeGuard: authorization.bridgeGuard,
        });
      } catch {
        // A host-minted authorization that cannot mint a restricted actor is a
        // local authorization failure, not a provider-visible implementation detail.
        return "authorization-denied";
      }

      // Scope the durable delivery key to the already-hashed authorized actor.
      // A provider delivery id never crosses an authorization-pair boundary,
      // and neither a provider account nor channel is retained in plaintext.
      const keyDigest = receiptKeyDigest(envelope, authorization.actorDigest);
      let reservation;
      try {
        reservation = options.receiptStore.reserve({
          keyDigest,
          intentDigest: intentDigest(envelope),
          conversationDigest: authorization.conversationDigest,
          ownerId,
        });
      } catch {
        report(options.log, "platform bridge receipt reserve failed; inbound command was not submitted");
        return "receipt-unavailable";
      }
      try {
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
          default:
            report(options.log, "platform bridge receipt reserve returned an invalid result");
            return "receipt-unavailable";
        }
      } catch {
        report(options.log, "platform bridge receipt reserve result was unreadable");
        return "receipt-unavailable";
      }

      // Pairing can be revoked while a synchronous durable write is in
      // progress. Release rather than leave an unactioned delivery blocked.
      if (!isAuthorizationCurrent(authorization)) {
        return releaseReservation(keyDigest)
          ? "authorization-revoked"
          : "command-outcome-unknown";
      }

      // Idempotency intentionally precedes this in-memory budget: a retry of
      // an already-admitted delivery remains a stable duplicate even after the
      // pair reaches its cap. A rejected new delivery never occupies a durable
      // receipt, so it can be retried after the window recovers.
      if (!inboundRateLimiter.accept(inboundRateLimitKeyDigest(authorization))) {
        return releaseReservation(keyDigest)
          ? "rate-limited"
          : "command-outcome-unknown";
      }

      let submission;
      try {
        submission = submit.call(options.commandPort, actor, {
          kind: "message.send",
          // The envelope is text-only by type. No attachment, public-turn,
          // session, provenance, activation, persona, or cancellation field
          // can be provider-supplied on this path.
          payload: { input: envelope.text },
        });
      } catch {
        // A throw can happen after an adapter admitted work. Preserve the
        // receipt and make any retry explicitly unknown instead of replaying.
        outcomeUnknownKeys.add(keyDigest);
        report(options.log, "platform bridge command admission threw; inbound replay is blocked");
        return "command-outcome-unknown";
      }
      if (submission === null) {
        return releaseReservation(keyDigest)
          ? "streaming-active"
          : "command-outcome-unknown";
      }

      // Completion is intentionally not returned to the provider. The common
      // safe projector/delivery adapter exposes bounded progress separately.
      try {
        const completion = submission.completion;
        if (!completion || typeof completion.then !== "function") {
          throw new Error("platform-bridge-inbound-submission-invalid");
        }
        void completion.then(
          () => settle(keyDigest),
          () => settle(keyDigest),
        );
      } catch {
        // A malformed host adapter can still have admitted a turn. Keep its
        // durable reservation so a retry cannot duplicate that uncertain work.
        outcomeUnknownKeys.add(keyDigest);
        report(options.log, "platform bridge completion registration failed; inbound replay is blocked");
        return "command-outcome-unknown";
      }
      return "accepted";
    },
  };
}

function copyRawWebhookRequest(
  value: unknown,
  maxRawBodyBytes: number,
): PlatformBridgeRawWebhookRequest | "invalid" | "too-large" {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  try {
    const candidate = value as { rawBody?: unknown; headers?: unknown };
    if (!(candidate.rawBody instanceof Uint8Array)) return "invalid";
    if (candidate.rawBody.byteLength > maxRawBodyBytes) return "too-large";
    const headers = copyWebhookHeaders(candidate.headers);
    if (headers === "invalid") return "invalid";
    // The verifier receives an immutable-by-caller copy. It may parse this
    // copy only after provider verification; the core never parses raw bytes.
    return Object.freeze({
      rawBody: new Uint8Array(candidate.rawBody),
      ...(headers === undefined
        ? {}
        : { headers }),
    });
  } catch {
    return "invalid";
  }
}

function copyWebhookHeaders(
  value: unknown,
): PlatformBridgeRawWebhookRequest["headers"] | "invalid" | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return "invalid";
    const copy: Record<string, string | readonly string[] | undefined> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return "invalid";
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || descriptor.enumerable !== true
      ) {
        return "invalid";
      }
      const headerValue = descriptor.value;
      if (typeof headerValue === "string" || headerValue === undefined) {
        copy[key] = headerValue;
        continue;
      }
      if (Array.isArray(headerValue) && headerValue.every((item) => typeof item === "string")) {
        copy[key] = Object.freeze([...headerValue]);
        continue;
      }
      return "invalid";
    }
    return Object.freeze(copy);
  } catch {
    return "invalid";
  }
}

function normalizeVerifiedEnvelope(
  value: unknown,
  maxTextChars: number,
): PlatformBridgeVerifiedEnvelope | undefined {
  const record = exactDataRecord(value, ["provider", "deliveryId", "channelId", "senderId", "text"]);
  if (record === undefined) return undefined;
  const provider = record.provider;
  const deliveryId = record.deliveryId;
  const channelId = record.channelId;
  const senderId = record.senderId;
  const text = record.text;
  if (
    typeof provider !== "string"
    || !/^[a-z][a-z0-9-]{0,63}$/.test(provider)
    || provider.length > MAX_PROVIDER_CHARS
    || !isOpaqueIdentifier(deliveryId)
    || !isOpaqueIdentifier(channelId)
    || !isOpaqueIdentifier(senderId)
    || !isSafeText(text, maxTextChars)
  ) {
    return undefined;
  }
  return Object.freeze({ provider, deliveryId, channelId, senderId, text });
}

function normalizeAuthorization(value: unknown): PlatformBridgeInboundAuthorization | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const candidate = value as Partial<PlatformBridgeInboundAuthorization>;
    if (
      typeof candidate.actorDigest !== "string"
      || !SHA256_HEX.test(candidate.actorDigest)
      || typeof candidate.conversationDigest !== "string"
      || !SHA256_HEX.test(candidate.conversationDigest)
      || !candidate.bridgeBinding
      || typeof candidate.bridgeBinding !== "object"
      || Array.isArray(candidate.bridgeBinding)
      || !candidate.bridgeGuard
      || typeof candidate.bridgeGuard !== "object"
      || typeof candidate.bridgeGuard.isCurrent !== "function"
    ) {
      return undefined;
    }
    return Object.freeze({
      actorDigest: candidate.actorDigest,
      conversationDigest: candidate.conversationDigest,
      bridgeBinding: candidate.bridgeBinding,
      bridgeGuard: candidate.bridgeGuard,
    });
  } catch {
    return undefined;
  }
}

function isAuthorizationCurrent(authorization: PlatformBridgeInboundAuthorization): boolean {
  try {
    return authorization.bridgeGuard.isCurrent(authorization.bridgeBinding) === true;
  } catch {
    return false;
  }
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== expectedKeys.length
      || !expectedKeys.every((key) => ownKeys.includes(key))
    ) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const normalized: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || descriptor.enumerable !== true
      ) {
        return undefined;
      }
      normalized[key] = descriptor.value;
    }
    return Object.freeze(normalized);
  } catch {
    return undefined;
  }
}

function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_CHARS
    && value.trim().length > 0
    && !hasNonWhitespaceControlChars(value);
}

function isSafeText(value: unknown, maxTextChars: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxTextChars
    && value.trim().length > 0
    && !hasNonWhitespaceControlChars(value);
}

function receiptKeyDigest(
  envelope: PlatformBridgeVerifiedEnvelope,
  actorDigest: string,
): string {
  return sha256([
    "platform-bridge-receipt-v2",
    actorDigest,
    envelope.provider,
    envelope.deliveryId,
  ].join("\u0000"));
}

/**
 * This map key is an additional digest over host-owned pairing material.
 * It never retains a provider login, provider channel, raw delivery id, or
 * even the actor digest by itself. A changed local bridge/route generation
 * receives a separate bounded bucket.
 */
function inboundRateLimitKeyDigest(
  authorization: PlatformBridgeInboundAuthorization,
): string {
  const binding = authorization.bridgeBinding;
  return sha256([
    "platform-bridge-inbound-rate-v1",
    authorization.actorDigest,
    authorization.conversationDigest,
    binding.bridgeId,
    String(binding.bridgeEpoch),
    binding.routeId,
    String(binding.routeEpoch),
    binding.scope,
  ].join("\u0000"));
}

interface InboundRateLimiter {
  /** Accept one new reserved delivery for an anonymized authorized pair. */
  accept(authorizedPairDigest: string): boolean;
}

function createInboundRateLimiter(
  maxRequestsPerWindow: number,
  windowMs: number,
  maxTrackedAuthorizedPairs: number,
  now: () => number,
): InboundRateLimiter {
  const buckets = new Map<string, { startedAt: number; count: number }>();
  return {
    accept(authorizedPairDigest): boolean {
      const timestamp = readRateLimitTimestamp(now);
      // A broken clock must fail closed; admitting unbounded remote work is
      // worse than temporarily rejecting a webhook delivery.
      if (timestamp === undefined) return false;

      // The map contains only a domain-separated digest. Expired entries are
      // removed before capacity is checked, keeping retained state bounded.
      for (const [key, bucket] of buckets) {
        if (timestamp - bucket.startedAt >= windowMs) buckets.delete(key);
      }
      const current = buckets.get(authorizedPairDigest);
      if (current === undefined) {
        if (buckets.size >= maxTrackedAuthorizedPairs) return false;
        buckets.set(authorizedPairDigest, { startedAt: timestamp, count: 1 });
        return true;
      }
      if (timestamp - current.startedAt >= windowMs) {
        buckets.set(authorizedPairDigest, { startedAt: timestamp, count: 1 });
        return true;
      }
      if (current.count >= maxRequestsPerWindow) return false;
      current.count += 1;
      return true;
    },
  };
}

function readRateLimitTimestamp(now: () => number): number | undefined {
  try {
    const value = now();
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function intentDigest(envelope: PlatformBridgeVerifiedEnvelope): string {
  return sha256(JSON.stringify({
    provider: envelope.provider,
    deliveryId: envelope.deliveryId,
    channelId: envelope.channelId,
    senderId: envelope.senderId,
    text: envelope.text,
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The receipt store admits only a UUID owner, and rejects the whole file when
 * it sees anything else. Validate here so a bad host value fails at gateway
 * construction instead of at the first reservation.
 */
function receiptOwnerId(value: string | undefined): string {
  if (value === undefined) return randomUUID();
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError("platform-bridge-inbound-receipt-owner-invalid");
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`platform-bridge-inbound-${name}-invalid`);
  }
  return value;
}

function isPlatformBridgeReceiptStore(value: unknown): value is PlatformBridgeReceiptStore {
  return typeof value === "object" && value !== null
    && typeof (value as { reserve?: unknown }).reserve === "function"
    && typeof (value as { releaseReserved?: unknown }).releaseReserved === "function"
    && typeof (value as { settle?: unknown }).settle === "function";
}

function report(log: ((message: string) => void) | undefined, message: string): void {
  try {
    log?.(message);
  } catch {
    // Observability must never change webhook admission or replay posture.
  }
}
