/**
 * Main-process lifecycle for the default-OFF Telegram platform bridge.
 *
 * Telegram is deliberately a separate external-platform adapter. It never
 * shares the Local API, A2A, or Tailnet HTTP route family, opens no listener,
 * and never registers a Telegram webhook: updates arrive over an outbound
 * long poll owned by the desktop, activated only by the owner's stored
 * connection (`telegram-connection-service`).
 *
 * The long-poll ingress lives here too: it has no consumer other than this
 * lifecycle, and the two share the bridge's ingress handle and control-notice
 * machinery.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createTailnetControllerReceiptStore,
  type TailnetControllerReceiptStore,
} from "../api/tailnet-controller-receipt-store.js";
import type { SecretStore } from "../audit/hmac-chain.js";
import type { ConversationSurfaceRuntime } from "../engine/conversation-surface-runtime.js";
import {
  createPlatformBridgeDeliveryAdapter,
  type PlatformBridgeDeliveryAdapter,
  type PlatformBridgeDeliveryChannel,
} from "./platform-bridge-delivery.js";
import {
  createPlatformBridgeInboundGateway,
  type PlatformBridgeInboundAuthorizer,
  type PlatformBridgeInboundGateway,
  type PlatformBridgeInboundResult,
  type PlatformBridgeReceiptStore,
  type PlatformBridgeWebhookVerifier,
} from "./platform-bridge-inbound.js";
import {
  coalesceTelegramDeliveryQueue,
  createTelegramOutboundTransport,
  createTelegramPollingVerifier,
  parseTelegramCallbackQueryUpdate,
  parseTelegramTextUpdate,
  type TelegramCallbackQueryEnvelope,
  type TelegramDeliveryChannel,
} from "./telegram-platform-adapter.js";
import {
  createTelegramPairedPlatformRuntime,
  type TelegramPairedRouteAuthority,
  type TelegramPlatformRoute,
  type TelegramPlatformRuntime,
} from "./telegram-platform-runtime.js";
import {
  createTelegramRemoteApprovalCoordinator,
  type TelegramRemoteApprovalCoordinator,
  type TelegramRemoteApprovalGatePort,
} from "./telegram-remote-approval.js";
import {
  createTelegramBotApiClient,
  type TelegramBotApiClient,
  type TelegramPolledUpdate,
} from "./telegram-bot-api-client.js";
import type { TelegramControlNotice } from "./telegram-control-reply.js";
import {
  looksLikeTelegramPairingCode,
  telegramPairingCodeDigest,
} from "./telegram-pairing-code.js";
import type { ConversationCommandPort } from "./conversation-command-port.js";
import { openFeatureNamespace } from "./storage/feature-namespace.js";
import { TELEGRAM_BRIDGE_FEATURE } from "./telegram-connection-store.js";

// ─── Outbound long-poll ingress ───────────────────────────────────────────────

/**
 * Outbound long-poll ingress for the owner-driven Telegram bridge.
 *
 * Unlike the webhook listener, nothing here is reachable from the network: the
 * host fetches updates over its own authenticated HTTPS request. That is what
 * makes a desktop Connect/Disconnect control safe — there is no fixed inbound
 * port whose forwarding could outlive the bridge.
 *
 * Two properties the webhook path gets for free must be provided explicitly:
 *
 * - **Telegram's retry.** A webhook delivery is retried by Telegram when the
 *   listener reports it unavailable. A poller has no such safety net, and
 *   confirming an update by advancing the offset destroys it. So the offset
 *   advances only
 *   for outcomes that are terminal for this delivery, and every releasable
 *   outcome re-polls the same update instead.
 * - **The proxy's request cap.** The bot API client bounds the response body
 *   before parsing it; this module then hands one update at a time to the
 *   shared core, so the existing per-envelope caps still apply.
 */

/**
 * Outcomes that are terminal for this delivery. Every one of them either
 * handled the update or rejected it permanently, so re-polling it would wedge
 * the loop on a message that can never succeed.
 */
const ADVANCING_RESULTS: ReadonlySet<PlatformBridgeInboundResult> = new Set([
  "accepted",
  "duplicate",
  "invalid-request",
  "request-too-large",
  "verification-failed",
  "invalid-envelope",
  "slash-command-rejected",
  "authorization-denied",
  "idempotency-conflict",
  // The receipt is retained and replay is deliberately blocked, so retrying
  // could never resolve it either.
  "command-outcome-unknown",
]);

/**
 * Gateway outcomes decided before a verified envelope exists: the body could
 * not be copied, was over the cap, failed verification, or did not normalize.
 * Every one of them is also in {@link ADVANCING_RESULTS}, so reaching one means
 * the update was consumed and nothing was done with it.
 *
 * `satisfies` rather than a bare literal list: these are members of the shared
 * result union, and a rename there must break this file instead of silently
 * leaving a category that can never match.
 *
 * `disabled` is deliberately absent. It is pre-envelope too, but it re-polls
 * instead of advancing, so nothing is dropped and counting it would report a
 * turned-off bridge as data loss.
 */
const PRE_ENVELOPE_GATEWAY_RESULTS = [
  "invalid-request",
  "request-too-large",
  "verification-failed",
  "invalid-envelope",
] as const satisfies readonly PlatformBridgeInboundResult[];

/**
 * Why an update died before it could become an envelope. The vocabulary is
 * fixed at compile time and carries no payload material: `unparsable-update`
 * is a boolean fact about the adapter's return, and the rest are the shared
 * core's own provider-safe admission outcomes.
 */
type PreEnvelopeDropReason =
  | "unparsable-update"
  | typeof PRE_ENVELOPE_GATEWAY_RESULTS[number];

const PRE_ENVELOPE_GATEWAY_RESULT_SET: ReadonlySet<PlatformBridgeInboundResult> =
  new Set(PRE_ENVELOPE_GATEWAY_RESULTS);

function preEnvelopeGatewayReason(
  result: PlatformBridgeInboundResult,
): PreEnvelopeDropReason | undefined {
  return PRE_ENVELOPE_GATEWAY_RESULT_SET.has(result)
    ? result as PreEnvelopeDropReason
    : undefined;
}

const RETRY_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5_000;

type TelegramPollingFatalCode =
  | "telegram-bot-token-rejected"
  | "telegram-webhook-conflict"
  | "telegram-poll-conflict"
  /**
   * The durable store refused the confirmed offset. Fatal rather than ignored:
   * the write is this connection's own state, so a store that cannot take it
   * cannot record a pairing, an approval, or the error either — and continuing
   * would leave a bridge that looks connected while nothing it learns survives.
   */
  | "telegram-connection-state-unwritable";

export interface TelegramPollingIngressOptions {
  readonly client: TelegramBotApiClient;
  readonly gateway: PlatformBridgeInboundGateway;
  /** Last confirmed offset, or null before the first poll of this connection. */
  readonly pollOffset: () => number | null;
  readonly recordPollOffset: (offset: number) => Promise<void>;
  readonly hasPendingPairingCode: () => boolean;
  /** True only on a constant-time digest match against a live pending code. */
  readonly redeemPairingCode: (codeDigest: string, senderId: string) => Promise<boolean>;
  /** Terminal condition: the loop stops and the owner must act. */
  readonly onFatal: (code: TelegramPollingFatalCode) => void | Promise<void>;
  readonly onPaired?: (senderId: string) => void | Promise<void>;
  /**
   * Whether this sender is the already-paired owner. The shared core reports
   * both a stranger and an unshared owner as `authorization-denied`, so this is
   * the only way to tell them apart — and a stranger must never be answered.
   */
  readonly isPairedOwner?: (senderId: string) => boolean;
  /** Best-effort, cooldown-gated host notice. Never carries conversation data. */
  readonly notifyUnroutable?: (
    chatId: string,
    notice: TelegramControlNotice,
  ) => void | Promise<void>;
  /**
   * Handler for a verified inline-keyboard press. Absent means every
   * callback update is consumed and dropped — the loop must still advance
   * past it, so a bridge without remote approval wired cannot wedge on one.
   */
  readonly onCallbackQuery?: (
    callback: TelegramCallbackQueryEnvelope,
  ) => void | Promise<void>;
  readonly log?: (message: string) => void;
  /** Test seam; production sleeps on a timer that the abort signal cancels. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface TelegramPollingIngress {
  /** Resolves once the loop has fully exited. */
  readonly finished: Promise<void>;
  stop(): void;
}

export function startTelegramPollingIngress(
  options: TelegramPollingIngressOptions,
): TelegramPollingIngress {
  if (!options || typeof options !== "object") {
    throw new TypeError("telegram-polling-ingress-options-invalid");
  }
  for (const name of [
    "pollOffset",
    "recordPollOffset",
    "hasPendingPairingCode",
    "redeemPairingCode",
    "onFatal",
  ] as const) {
    if (typeof options[name] !== "function") {
      throw new TypeError("telegram-polling-ingress-options-invalid");
    }
  }
  if (typeof options.client?.getUpdates !== "function"
    || typeof options.gateway?.handleWebhook !== "function") {
    throw new TypeError("telegram-polling-ingress-options-invalid");
  }

  const controller = new AbortController();
  const { signal } = controller;
  const wait = options.wait ?? defaultWait;

  const finished = run(options, signal, wait).catch(() => {
    // Reached only by a throw this module did not classify. It still ends
    // ingress, so it must leave a trace rather than resolving as if the loop
    // had been asked to stop.
    options.log?.("[telegram-poll] the poll loop ended unexpectedly");
  });
  return Object.freeze({
    finished,
    stop(): void {
      controller.abort();
    },
  });
}

async function run(
  options: TelegramPollingIngressOptions,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const drops = createPreEnvelopeDropCounter(options.log);
  try {
    await poll(options, signal, wait, drops);
  } finally {
    // Every exit is an activation ending — aborted, fatal, or thrown — and the
    // final tally is the number an operator asks for after a bad session.
    drops.finish();
  }
}

async function poll(
  options: TelegramPollingIngressOptions,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void>,
  drops: PreEnvelopeDropCounter,
): Promise<void> {
  let offset = options.pollOffset();
  let backoffMs = 0;

  while (!signal.aborted) {
    if (backoffMs > 0) {
      try {
        await wait(backoffMs, signal);
      } catch {
        return;
      }
      backoffMs = 0;
      if (signal.aborted) return;
    }

    if (offset === null) {
      const seeded = await seedOffset(options, signal);
      if (seeded === "fatal") return;
      if (seeded === "retry") {
        backoffMs = RETRY_BACKOFF_MS;
        continue;
      }
      offset = seeded;
      if (!await confirmOffset(options, offset)) return;
      continue;
    }

    const result = await options.client.getUpdates({ offset, signal });
    if (signal.aborted) return;
    if (!result.ok) {
      const next = await handleFailure(options, result.reason, result.retryAfterMs, signal);
      if (next === "stop") return;
      backoffMs = next;
      continue;
    }

    // Strictly sequential. The shared core holds no mutex and the turn lease is
    // single-holder, so a concurrent fan-out would silently drop all but one
    // message as `streaming-active`.
    for (const update of result.value) {
      if (signal.aborted) return;
      const disposition = await handleUpdate(options, update, drops);
      if (disposition === "retry") {
        backoffMs = RETRY_BACKOFF_MS;
        break;
      }
      offset = update.updateId + 1;
      if (!await confirmOffset(options, offset)) return;
    }
  }
}

/**
 * Confirm the offset durably, or end the activation saying why.
 *
 * This is the one injected callback whose failure used to escape the loop
 * unclassified: the throw unwound past every handler here and was swallowed by
 * the caller's `catch`, so ingress died while the owner surface still read
 * `connected` and egress stayed attached. Routing it through the same fatal
 * path as a rejected token makes the stop visible and, because that path tears
 * the activation down, leaves the bridge startable again.
 */
async function confirmOffset(
  options: TelegramPollingIngressOptions,
  offset: number,
): Promise<boolean> {
  try {
    await options.recordPollOffset(offset);
    return true;
  } catch {
    options.log?.("[telegram-poll] the poll offset could not be saved; stopping");
    await safeFatal(options, "telegram-connection-state-unwritable");
    return false;
  }
}

/**
 * Skip whatever accumulated before this connection existed. Replaying a day of
 * backlog as live turns would produce a burst of model calls and local approval
 * prompts the owner never asked for.
 */
async function seedOffset(
  options: TelegramPollingIngressOptions,
  signal: AbortSignal,
): Promise<number | "retry" | "fatal"> {
  const result = await options.client.getUpdates({
    offset: -1,
    limit: 1,
    timeoutSeconds: 0,
    signal,
  });
  if (!result.ok) {
    const next = await handleFailure(options, result.reason, result.retryAfterMs, signal);
    return next === "stop" ? "fatal" : "retry";
  }
  const last = result.value[result.value.length - 1];
  return last === undefined ? 0 : last.updateId + 1;
}

type UpdateDisposition = "advance" | "retry";

/**
 * Runtime-only tally of updates consumed before an envelope existed.
 *
 * The gap it closes: those updates are the one class the merged notice path
 * cannot reach. A notice needs a sender to answer, and these die before the
 * host knows who sent them, so a schema change on Telegram's side turns every
 * message into a silent no-op that looks exactly like a bot nobody is talking
 * to. A counter distinguishes the two: zero means nothing arrived, climbing
 * means updates are arriving and this host cannot read any of them.
 *
 * In memory and per activation by construction — the state is a closure created
 * inside {@link run}, so it cannot be persisted, cannot enter the connection
 * store, and has nothing to send to the renderer.
 *
 * Bounded output on purpose. Anyone who can message the bot can drive the
 * count, so a line per drop would hand them the desktop log. Lines are emitted
 * only when a reason is seen for the first time this activation, when the total
 * crosses a power of ten, and once on exit — at most a dozen lines however many
 * updates arrive.
 */
interface PreEnvelopeDropCounter {
  record(reason: PreEnvelopeDropReason): void;
  /** Final tally for an activation that ended between milestones. */
  finish(): void;
}

function createPreEnvelopeDropCounter(
  log: ((message: string) => void) | undefined,
): PreEnvelopeDropCounter {
  const counts = new Map<PreEnvelopeDropReason, number>();
  let total = 0;
  // The first drop of every reason already logs, so the first milestone that
  // adds anything is ten.
  let nextMilestone = 10;

  const report = (prefix: string): void => {
    const breakdown = [...counts]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([reason, count]) => `${reason}=${count}`)
      .join(" ");
    log?.(`[telegram-poll] ${prefix} total=${total} ${breakdown}`);
  };

  return {
    record(reason: PreEnvelopeDropReason): void {
      const seen = counts.get(reason);
      counts.set(reason, (seen ?? 0) + 1);
      total += 1;
      if (seen === undefined) {
        report("pre-envelope drop, first of this kind:");
        return;
      }
      if (total >= nextMilestone) {
        report("pre-envelope drops:");
        nextMilestone *= 10;
      }
    },
    finish(): void {
      if (total === 0) return;
      report("pre-envelope drops for this activation:");
    },
  };
}

async function handleUpdate(
  options: TelegramPollingIngressOptions,
  update: TelegramPolledUpdate,
  drops: PreEnvelopeDropCounter,
): Promise<UpdateDisposition> {
  const envelope = parseTelegramTextUpdate(update.rawBody);
  // Anything that is not a private text message from a human — a channel post,
  // a membership change, an attachment — is permanently uninteresting. Not
  // advancing here would wedge the loop forever on the first such update.
  //
  // Counted anyway, and this is the bucket that matters: the adapter applies a
  // strict key allow-list, so the day Telegram adds a field to `message` every
  // real message lands here instead of in the routine sticker/channel-post
  // trickle. The count is what separates those two, since the reason itself
  // cannot — telling them apart would mean reading the payload.
  if (envelope === undefined) {
    // A button press is the one non-message update this loop acts on. It is
    // parsed HERE, at the same parse point as messages, by the same
    // fail-closed adapter posture — never routed through the conversation
    // gateway, because a decision signal is not conversation input. Consumed
    // whether or not a handler is wired: an unhandled press can never
    // resolve anything, so re-polling it could never help.
    const callback = parseTelegramCallbackQueryUpdate(update.rawBody);
    if (callback !== undefined) {
      if (options.onCallbackQuery !== undefined) {
        try {
          await options.onCallbackQuery(callback);
        } catch {
          options.log?.("[telegram-poll] callback handling failed");
        }
      }
      return "advance";
    }
    drops.record("unparsable-update");
    return "advance";
  }

  if (looksLikeTelegramPairingCode(envelope.text)) {
    // Consumed and dropped whether or not it matches, so a near-miss
    // credential can never land in the conversation transcript.
    await redeemPairing(options, envelope.text.trim(), envelope.senderId);
    return "advance";
  }

  const result = await options.gateway.handleWebhook({ rawBody: update.rawBody });
  // The shared core already draws the line this counter needs: everything in
  // PRE_ENVELOPE_GATEWAY_RESULTS is returned before `normalizeVerifiedEnvelope`
  // produces anything, and every later outcome had an envelope to refuse. The
  // pairing branch above is not counted — that update is consumed on purpose,
  // not lost.
  const preEnvelope = preEnvelopeGatewayReason(result);
  if (preEnvelope !== undefined) drops.record(preEnvelope);
  // The update is consumed either way. Without a notice the paired owner sees
  // nothing at all, which reads as a dead bot rather than an idle surface.
  //
  // Both outcomes below are "we understood you and are deliberately not acting":
  // an unshared conversation, and a slash message the core refuses by policy.
  // Anything else is either handled or retried, and must stay silent.
  if (SILENTLY_CONSUMED_RESULTS.has(result)) {
    await notifyIfPairedOwner(options, envelope.senderId, noticeFor(result));
  }
  return ADVANCING_RESULTS.has(result) ? "advance" : "retry";
}

/**
 * Outcomes where the paired owner's message is consumed and nothing is done
 * with it. Each needs a different sentence, because "nothing is shared" and
 * "commands are not supported" are different problems for the owner to fix.
 */
const SILENTLY_CONSUMED_RESULTS: ReadonlySet<PlatformBridgeInboundResult> = new Set([
  "authorization-denied",
  "slash-command-rejected",
]);

function noticeFor(result: PlatformBridgeInboundResult): TelegramControlNotice {
  return result === "slash-command-rejected"
    ? "commands-not-supported"
    : "conversation-not-shared";
}

async function notifyIfPairedOwner(
  options: TelegramPollingIngressOptions,
  senderId: string,
  notice: TelegramControlNotice,
): Promise<void> {
  if (options.isPairedOwner === undefined || options.notifyUnroutable === undefined) return;
  try {
    // Silence for anyone who is not the paired owner: answering a stranger
    // would confirm that this bot is attached to a live desktop.
    if (!options.isPairedOwner(senderId)) return;
    await options.notifyUnroutable(senderId, notice);
  } catch {
    options.log?.("[telegram-poll] control notice failed");
  }
}

async function redeemPairing(
  options: TelegramPollingIngressOptions,
  candidate: string,
  senderId: string,
): Promise<void> {
  let pending: boolean;
  try {
    pending = options.hasPendingPairingCode();
  } catch {
    return;
  }
  // Nothing to redeem: stay silent rather than confirm to an unknown sender
  // that this bot is attached to a live desktop.
  if (!pending) return;

  const codeDigest = telegramPairingCodeDigest(candidate);
  if (codeDigest === null) return;
  try {
    if (await options.redeemPairingCode(codeDigest, senderId)) {
      await options.onPaired?.(senderId);
    }
    // No second charge here. The durable store already debits the attempt when
    // it rejects a digest, and it is the only place that can tell a wrong code
    // apart from a code that expired between the check above and this call.
    // Charging from here too spent the budget twice per wrong code, so the
    // advertised five attempts were really about three.
  } catch {
    options.log?.("[telegram-poll] pairing redemption failed");
  }
}

async function handleFailure(
  options: TelegramPollingIngressOptions,
  reason: "unauthorized" | "conflict" | "rate-limited" | "unreachable" | "invalid-response",
  retryAfterMs: number | undefined,
  signal: AbortSignal,
): Promise<number | "stop"> {
  if (reason === "unauthorized") {
    await safeFatal(options, "telegram-bot-token-rejected");
    return "stop";
  }
  if (reason === "conflict") {
    // Classify by asking Telegram what it thinks is configured, never by
    // parsing the 409 description: its contents are explicitly not stable.
    const info = await options.client.getWebhookInfo(signal);
    const code: TelegramPollingFatalCode = info.ok && info.value.hasWebhook
      ? "telegram-webhook-conflict"
      : "telegram-poll-conflict";
    await safeFatal(options, code);
    return "stop";
  }
  if (reason === "rate-limited") {
    return Math.min(retryAfterMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS, MAX_BACKOFF_MS);
  }
  options.log?.("[telegram-poll] provider response was unusable; backing off");
  return RETRY_BACKOFF_MS;
}

async function safeFatal(
  options: TelegramPollingIngressOptions,
  code: TelegramPollingFatalCode,
): Promise<void> {
  try {
    await options.onFatal(code);
  } catch {
    options.log?.("[telegram-poll] fatal handler failed");
  }
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("telegram-polling-ingress-aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("telegram-polling-ingress-aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ─── Bridge lifecycle ─────────────────────────────────────────────────────────

const TELEGRAM_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const TELEGRAM_MAX_RAW_BODY_BYTES = 64 * 1024;
/**
 * Telegram's Bot API limit is 4,096 UTF-16 code units per text message, the
 * same unit `String.length` and the shared ingress core count. A code-point
 * bound is not stricter, it is up to twice as permissive: 4,096 emoji are
 * 8,192 units, which the Bot API rejects outright.
 */
const TELEGRAM_MAX_TEXT_UTF16_UNITS = 4_096;
/** Upper bound on how long a stop waits for already-queued safe deliveries. */
const TELEGRAM_DELIVERY_DRAIN_TIMEOUT_MS = 2_000;

export interface TelegramBridgeServer {
  /** Loopback port for the webhook path; null when updates are polled. */
  readonly port: number | null;
}

/** How one activation receives updates, and how that reception is torn down. */
interface TelegramIngressHandle {
  readonly port: number | null;
  close(): Promise<void>;
}

/**
 * What one activation supplies to the shared core: its runtime, its inbound
 * verifier, and how updates are received. The receipt store, the delivery
 * adapter, the safe-projection attach, and the inbound gateway are identical
 * for every activation, which is what keeps a future second ingress from
 * drifting into a second security model.
 */
interface TelegramActivationPlan {
  readonly botToken: string;
  readonly botFingerprint: string;
  createRuntime(activationEpoch: number): Promise<TelegramPlatformRuntime>;
  readonly verifier: PlatformBridgeWebhookVerifier;
  startIngress(
    gateway: PlatformBridgeInboundGateway,
    onCallbackQuery?: (callback: TelegramCallbackQueryEnvelope) => Promise<void>,
  ): Promise<TelegramIngressHandle>;
  /**
   * Optional remote-approval attachment for this activation. It takes the
   * activation's own runtime so the coordinator's egress fence is the same
   * route-currency check the delivery path uses; absent means approvals stay
   * desk-only, which is every activation without a wired approval gate.
   */
  createRemoteApproval?(runtime: TelegramPlatformRuntime): TelegramRemoteApprovalCoordinator;
}

interface StartTelegramBridgeServerOptions {
  readonly conversationSurfaceRuntime: ConversationSurfaceRuntime;
  readonly conversationCommandPort: ConversationCommandPort;
  readonly getCurrentConversationId: () => string;
  readonly receiptStore?: PlatformBridgeReceiptStore;
  readonly log?: (message: string) => void;
}

interface ActiveTelegramDeliveryDestination {
  readonly route: TelegramPlatformRoute;
  readonly channel: TelegramDeliveryChannel;
  generation: number | undefined;
}

interface ActiveTelegramBridge {
  readonly ingress: TelegramIngressHandle;
  readonly runtime: TelegramPlatformRuntime;
  readonly delivery: PlatformBridgeDeliveryAdapter<TelegramDeliveryChannel>;
  readonly deliveryDestinations: Map<string, ActiveTelegramDeliveryDestination>;
  /** Retained so a stop can drain open sends before the adapter is closed. */
  readonly channels: Map<string, PlatformBridgeDeliveryChannel>;
  readonly remoteApproval: TelegramRemoteApprovalCoordinator | undefined;
}

let activeBridge: ActiveTelegramBridge | null = null;
let startPromise: Promise<TelegramBridgeServer | null> | null = null;
let activeStartAttempt: number | null = null;
let startAttemptSequence = 0;
let stopPromise: Promise<void> | null = null;
let lifecycleGeneration = 0;
/**
 * Only app shutdown is terminal. An owner-initiated stop returns this module to
 * a startable state so a later connect is a real reconnect rather than a silent
 * permanent null.
 */
let shutdownRequested = false;
let activationSequence = 0;

/**
 * Stable for the lifetime of this process, deliberately not per activation and
 * deliberately not reset between activations. A receipt reserved before a
 * disconnect is settled by the same owner after the reconnect; a per-gateway
 * identity would leave that record `outcome-unknown` forever, and those records
 * are never TTL-pruned, so they would accumulate against the receipt cap.
 */
const installationReceiptOwnerId = randomUUID();

export interface StartTelegramConnectionBridgeOptions {
  readonly conversationSurfaceRuntime: ConversationSurfaceRuntime;
  readonly conversationCommandPort: ConversationCommandPort;
  readonly getCurrentConversationId: () => string;
  /** Process-held credential from the owner's encrypted store. */
  readonly botToken: string;
  readonly botFingerprint: string;
  readonly authority: TelegramPairedRouteAuthority;
  readonly pollOffset: () => number | null;
  readonly recordPollOffset: (offset: number) => Promise<void>;
  readonly hasPendingPairingCode: () => boolean;
  readonly redeemPairingCode: (codeDigest: string, senderId: string) => Promise<boolean>;
  readonly onFatal: (code: TelegramPollingFatalCode) => void | Promise<void>;
  readonly onPaired?: (senderId: string) => void | Promise<void>;
  /** Distinguishes an unshared owner from a stranger; only the former is answered. */
  readonly isPairedOwner?: (senderId: string) => boolean;
  readonly notifyUnroutable?: (
    chatId: string,
    notice: TelegramControlNotice,
  ) => void | Promise<void>;
  readonly receiptStore?: PlatformBridgeReceiptStore;
  readonly log?: (message: string) => void;
  /**
   * The host approval gate, exposed only through the narrow remote-approval
   * port. Present means the paired owner may decide parked tool approvals
   * from a button card; absent keeps approvals desk-only.
   */
  readonly approvalGate?: TelegramRemoteApprovalGatePort;
  /** Test-only injection; production builds a real Bot API client. */
  readonly createBotApiClient?: (botToken: string) => TelegramBotApiClient;
  /**
   * The store the actor secret is derived from. Threaded rather than defaulted
   * here so the caller's digester and this runtime read one secret: two
   * independently-defaulted stores would mint actor digests that disagree.
   */
  readonly secretStore?: SecretStore;
}

/**
 * Start the owner-driven connection: the same core, receiving over an outbound
 * long poll instead of a loopback listener. It opens no port, so a desktop
 * Disconnect control cannot leave a forwarding target behind.
 */
export async function maybeStartTelegramConnectionBridge(
  options: StartTelegramConnectionBridgeOptions,
): Promise<TelegramBridgeServer | null> {
  if (shutdownRequested) return null;
  if (stopPromise) {
    await stopPromise;
    if (shutdownRequested) return null;
  }
  if (activeBridge) return Object.freeze({ port: activeBridge.ingress.port });
  if (startPromise) return await startPromise;

  const client = (options.createBotApiClient ?? defaultBotApiClient)(options.botToken);
  const plan: TelegramActivationPlan = {
    botToken: options.botToken,
    botFingerprint: options.botFingerprint,
    createRuntime: (activationEpoch) => Promise.resolve(createTelegramPairedPlatformRuntime({
      botFingerprint: options.botFingerprint,
      authority: options.authority,
      getCurrentConversationId: options.getCurrentConversationId,
      activationEpoch,
      ...(options.secretStore ? { secretStore: options.secretStore } : {}),
    })),
    verifier: createTelegramPollingVerifier(),
    startIngress: (gateway, onCallbackQuery) => {
      const poll = startTelegramPollingIngress({
        client,
        gateway,
        pollOffset: options.pollOffset,
        recordPollOffset: options.recordPollOffset,
        hasPendingPairingCode: options.hasPendingPairingCode,
        redeemPairingCode: options.redeemPairingCode,
        onFatal: options.onFatal,
        ...(options.onPaired ? { onPaired: options.onPaired } : {}),
        ...(options.isPairedOwner ? { isPairedOwner: options.isPairedOwner } : {}),
        ...(options.notifyUnroutable ? { notifyUnroutable: options.notifyUnroutable } : {}),
        ...(onCallbackQuery ? { onCallbackQuery } : {}),
        ...(options.log ? { log: options.log } : {}),
      });
      return Promise.resolve({
        port: null,
        close: async () => {
          poll.stop();
          await poll.finished;
        },
      });
    },
    // Remote approval exists only when BOTH the gate seam and the paired-owner
    // predicate are wired: without the predicate no press could ever be
    // attributed, so offering cards would mint tokens nothing may consume.
    ...(options.approvalGate === undefined || options.isPairedOwner === undefined
      ? {}
      : {
        createRemoteApproval: (runtime: TelegramPlatformRuntime) =>
          createTelegramRemoteApprovalCoordinator({
            client,
            gate: options.approvalGate!,
            // The same currency the delivery fence enforces: the approval's
            // conversation must be the route's bound conversation AND that
            // route must still be current (paired, shared, on screen).
            routeChatIdForConversation: (conversationId) => {
              for (const route of runtime.routes) {
                if (route.conversationId === conversationId && runtime.isRouteCurrent(route)) {
                  return route.chatId;
                }
              }
              return null;
            },
            isPairedOwner: options.isPairedOwner!,
            ...(options.log ? { log: options.log } : {}),
          }),
      }),
  };

  const attempt = ++startAttemptSequence;
  activeStartAttempt = attempt;
  const pending = startActivation(plan, {
    conversationSurfaceRuntime: options.conversationSurfaceRuntime,
    conversationCommandPort: options.conversationCommandPort,
    getCurrentConversationId: options.getCurrentConversationId,
    ...(options.receiptStore ? { receiptStore: options.receiptStore } : {}),
    ...(options.log ? { log: options.log } : {}),
  }, lifecycleGeneration);
  startPromise = pending;
  try {
    return await pending;
  } finally {
    if (activeStartAttempt === attempt) {
      startPromise = null;
      activeStartAttempt = null;
    }
  }
}

function defaultBotApiClient(botToken: string): TelegramBotApiClient {
  return createTelegramBotApiClient({ botToken });
}

async function startActivation(
  plan: TelegramActivationPlan,
  options: StartTelegramBridgeServerOptions,
  generation: number,
): Promise<TelegramBridgeServer | null> {
  // Consumed only past the start checks, so a boot without a stored
  // connection leaves the first real activation at epoch 1.
  const activationEpoch = ++activationSequence;
  const runtime = await plan.createRuntime(activationEpoch);
  if (generation !== lifecycleGeneration) {
    runtime.dispose();
    return null;
  }

  const receiptStore = options.receiptStore ?? createTelegramBridgeReceiptStore();
  const deliveryDestinations = new Map<string, ActiveTelegramDeliveryDestination>();
  const releaseDeliveryDestination = (channel: TelegramDeliveryChannel): void => {
    const lease = channel.deliveryLease;
    if (lease === undefined) return;
    const active = deliveryDestinations.get(lease);
    if (active?.channel === channel) deliveryDestinations.delete(lease);
  };
  const delivery = createPlatformBridgeDeliveryAdapter<TelegramDeliveryChannel>({
    transport: createTelegramOutboundTransport({
      botToken: plan.botToken,
      // Egress failures classify themselves into this sink (network / HTTP
      // status / Bot API error code only); without it a failed send is
      // indistinguishable from a delivered one.
      ...(options.log ? { log: options.log } : {}),
      isChannelCurrent: (channel, generation) => {
        const lease = channel.deliveryLease;
        if (lease === undefined) return false;
        const active = deliveryDestinations.get(lease);
        if (active === undefined || active.channel !== channel) return false;
        if (active.generation === undefined) active.generation = generation;
        return active.generation === generation && runtime.isRouteCurrent(active.route);
      },
    }),
    maxTextChars: TELEGRAM_MAX_TEXT_UTF16_UNITS,
    coalesceQueuedMessages: coalesceTelegramDeliveryQueue,
    onBackpressure: (channel) => {
      releaseDeliveryDestination(channel);
      options.log?.("[telegram-bridge] safe delivery closed after backpressure");
    },
    onDeliveryFailure: (channel, reason) => {
      releaseDeliveryDestination(channel);
      options.log?.(
        `[telegram-bridge] safe delivery closed after provider failure${
          reason !== undefined ? ` (${reason})` : ""
        }`,
      );
    },
  });
  const channels = new Map<string, PlatformBridgeDeliveryChannel>();
  const attachRoute = (route: TelegramPlatformRoute): void => {
    if (!runtime.isRouteCurrent(route)) return;
    const key = route.binding.routeId;
    const existing = channels.get(key);
    if (existing && !existing.state().closed) return;
    if (existing) channels.delete(key);
    for (const [lease, destination] of deliveryDestinations) {
      if (destination.route === route) deliveryDestinations.delete(lease);
    }
    const destination = Object.freeze({
      chatId: route.chatId,
      deliveryLease: randomUUID(),
    } satisfies TelegramDeliveryChannel);
    const channel = delivery.openChannel(destination, route.conversationId);
    deliveryDestinations.set(destination.deliveryLease!, { route, channel: destination, generation: undefined });
    channels.set(key, channel);
    channel.attach(
      options.conversationSurfaceRuntime.sharedProjection,
      () => ({ busy: options.conversationSurfaceRuntime.activity.isBusy() }),
    );
  };
  const authorize: PlatformBridgeInboundAuthorizer = (envelope) => {
    const authorization = runtime.authorize(envelope);
    if (authorization !== null && authorization !== undefined) {
      // Bots cannot start a user conversation themselves. A verified, paired
      // user message is the earliest point at which a route may receive its
      // safe snapshot and future safe projection.
      const route = runtime.routeForEnvelope(envelope);
      if (route !== null) attachRoute(route);
    }
    return authorization;
  };
  const gateway = createPlatformBridgeInboundGateway({
    enabled: true,
    verifier: plan.verifier,
    authorize,
    receiptStore,
    commandPort: options.conversationCommandPort,
    maxRawBodyBytes: TELEGRAM_MAX_RAW_BODY_BYTES,
    // The gateway and Telegram's own verifier bound the same unit, so the core
    // cannot admit a message the provider boundary would reject.
    maxTextChars: TELEGRAM_MAX_TEXT_UTF16_UNITS,
    receiptOwnerId: installationReceiptOwnerId,
    // Without this, every receipt reserve/settle/release failure and every
    // submit or completion-registration throw is silent — exactly the states
    // in which an inbound message is permanently lost.
    ...(options.log ? { log: options.log } : {}),
  });

  // Created before ingress so the first polled press already has a handler,
  // and disposed on every teardown path below so no card can outlive the
  // activation that minted its tokens.
  const remoteApproval = plan.createRemoteApproval?.(runtime);
  let ingress: TelegramIngressHandle;
  try {
    ingress = await plan.startIngress(
      gateway,
      remoteApproval === undefined
        ? undefined
        : (callback) => remoteApproval.handleCallbackQuery(callback),
    );
  } catch (error) {
    remoteApproval?.dispose();
    delivery.close();
    runtime.dispose();
    throw error;
  }
  if (generation !== lifecycleGeneration) {
    remoteApproval?.dispose();
    runtime.dispose();
    delivery.close();
    await ingress.close();
    return null;
  }

  activeBridge = { ingress, runtime, delivery, deliveryDestinations, channels, remoteApproval };
  options.log?.("[telegram-bridge] receiving updates over an outbound connection");
  return Object.freeze({ port: ingress.port });
}

async function stopActivation(): Promise<void> {
  lifecycleGeneration += 1;
  const pending = startPromise;
  const current = takeActiveBridge();
  if (current) await closeBridge(current);
  if (pending) await pending.catch(() => undefined);
  const late = takeActiveBridge();
  if (late) await closeBridge(late);
}

function takeActiveBridge(): ActiveTelegramBridge | null {
  const current = activeBridge;
  activeBridge = null;
  return current;
}

async function closeBridge(bridge: ActiveTelegramBridge): Promise<void> {
  // Invalidate first: an in-flight webhook that already passed header parsing
  // cannot reserve a new command or publish a queued provider send afterwards.
  // The remote-approval detach is part of the same invalidation — a press
  // arriving mid-teardown must find no live token.
  bridge.remoteApproval?.dispose();
  bridge.deliveryDestinations.clear();
  bridge.runtime.dispose();
  // Drain before closing, not after: waitForIdle resolves immediately once a
  // channel is closed, so the order decides whether this waits at all. The
  // bound exists because an already-dispatched Bot API request owns its own
  // timeout and cannot be recalled.
  await drainOpenChannels(bridge.channels);
  bridge.delivery.close();
  await bridge.ingress.close();
}

async function drainOpenChannels(
  channels: ReadonlyMap<string, PlatformBridgeDeliveryChannel>,
): Promise<void> {
  const open = [...channels.values()].filter((channel) => !channel.state().closed);
  if (open.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, TELEGRAM_DELIVERY_DRAIN_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([
      Promise.all(open.map((channel) => channel.waitForIdle())),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Close Telegram ingress and egress. `"shutdown"` is terminal for the process;
 * `"user"` leaves this module startable so the owner can reconnect.
 */
export function stopTelegramBridgeServer(
  reason: "shutdown" | "user" = "shutdown",
): Promise<void> {
  // Latch synchronously at the entry point: a shutdown arriving while an
  // owner-initiated stop is already in flight must still be terminal.
  if (reason === "shutdown") shutdownRequested = true;
  if (stopPromise) return stopPromise;
  const pending = stopActivation();
  const tracked = pending.finally(() => {
    if (stopPromise === tracked) stopPromise = null;
  });
  stopPromise = tracked;
  return tracked;
}

/** @internal Test-only reset; production uses one immutable boot snapshot. */
export function resetTelegramBridgeServerForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("telegram-bridge-test-reset-outside-test");
  }
  if (activeBridge || startPromise || stopPromise || activeStartAttempt !== null) {
    throw new Error("telegram-bridge-test-reset-while-active");
  }
  lifecycleGeneration += 1;
  activationSequence = 0;
  shutdownRequested = false;
}

function createTelegramBridgeReceiptStore(): TailnetControllerReceiptStore {
  const namespace = openFeatureNamespace(TELEGRAM_BRIDGE_FEATURE);
  return createTailnetControllerReceiptStore({
    filePath: join(namespace.dir, "command-receipts.json"),
    ttlMs: TELEGRAM_RECEIPT_TTL_MS,
  });
}
