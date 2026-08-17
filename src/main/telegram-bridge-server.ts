/**
 * Main-process lifecycle for the default-OFF Telegram platform bridge.
 *
 * Telegram is deliberately a separate external-platform adapter. It never
 * shares the Local API, A2A, or Tailnet HTTP route family, opens no listener,
 * and never registers a Telegram webhook: updates arrive over an outbound
 * long poll owned by the desktop, activated only by the owner's stored
 * connection (`telegram-connection-service`).
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
  type PlatformBridgeReceiptStore,
  type PlatformBridgeWebhookVerifier,
} from "./platform-bridge-inbound.js";
import {
  coalesceTelegramDeliveryQueue,
  createTelegramOutboundTransport,
  createTelegramPollingVerifier,
  type TelegramDeliveryChannel,
} from "./telegram-platform-adapter.js";
import {
  createTelegramPairedPlatformRuntime,
  type TelegramPairedRouteAuthority,
  type TelegramPlatformRoute,
  type TelegramPlatformRuntime,
} from "./telegram-platform-runtime.js";
import {
  createTelegramBotApiClient,
  type TelegramBotApiClient,
} from "./telegram-bot-api-client.js";
import type { TelegramControlNotice } from "./telegram-control-reply.js";
import {
  startTelegramPollingIngress,
  type TelegramPollingFatalCode,
} from "./telegram-polling-ingress.js";
import type { ConversationCommandPort } from "./conversation-command-port.js";
import { openFeatureNamespace } from "./storage/feature-namespace.js";

const TELEGRAM_BRIDGE_FEATURE = "telegram-bridge";
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
  startIngress(gateway: PlatformBridgeInboundGateway): Promise<TelegramIngressHandle>;
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
    startIngress: (gateway) => {
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

  let ingress: TelegramIngressHandle;
  try {
    ingress = await plan.startIngress(gateway);
  } catch (error) {
    delivery.close();
    runtime.dispose();
    throw error;
  }
  if (generation !== lifecycleGeneration) {
    runtime.dispose();
    delivery.close();
    await ingress.close();
    return null;
  }

  activeBridge = { ingress, runtime, delivery, deliveryDestinations, channels };
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
