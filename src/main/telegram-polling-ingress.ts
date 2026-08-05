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
import type { TelegramControlNotice } from "./telegram-control-reply.js";
import {
  looksLikeTelegramPairingCode,
  telegramPairingCodeDigest,
} from "./telegram-pairing-code.js";
import { parseTelegramTextUpdate } from "./telegram-platform-adapter.js";
import type {
  PlatformBridgeInboundGateway,
  PlatformBridgeInboundResult,
} from "./platform-bridge-inbound.js";
import type {
  TelegramBotApiClient,
  TelegramPolledUpdate,
} from "./telegram-bot-api-client.js";

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

export type TelegramPollingFatalCode =
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
