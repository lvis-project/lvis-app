/**
 * Main-process lifecycle for the default-OFF Telegram platform bridge.
 *
 * Telegram is deliberately a separate external-platform listener. It never
 * shares the Local API, A2A, or Tailnet HTTP route family, never configures a
 * public endpoint, and never auto-registers a Telegram webhook. A deployment
 * owner connects this loopback listener to a dedicated trusted HTTPS
 * terminator after explicitly configuring the bot webhook secret.
 */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createTailnetControllerReceiptStore,
  type TailnetControllerReceiptStore,
} from "../api/tailnet-controller-receipt-store.js";
import { startTelegramWebhookServer } from "../api/telegram-webhook-server.js";
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
  createTelegramWebhookVerifier,
  type TelegramDeliveryChannel,
} from "./telegram-platform-adapter.js";
import {
  createTelegramPairedPlatformRuntime,
  createTelegramPlatformRuntime,
  type TelegramPairedRouteAuthority,
  type TelegramPlatformRoute,
  type TelegramPlatformRuntime,
} from "./telegram-platform-runtime.js";
import {
  createTelegramBotApiClient,
  type TelegramBotApiClient,
} from "./telegram-bot-api-client.js";
import {
  startTelegramPollingIngress,
  type TelegramPollingFatalCode,
} from "./telegram-polling-ingress.js";
import type { ConversationCommandPort } from "./conversation-command-port.js";
import { openFeatureNamespace } from "./storage/feature-namespace.js";

export const DEFAULT_TELEGRAM_BRIDGE_PORT = 46_175;
export const DEFAULT_TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";
const TELEGRAM_BRIDGE_FEATURE = "telegram-bridge";
const TELEGRAM_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const TELEGRAM_MAX_RAW_BODY_BYTES = 64 * 1024;
/** Telegram's Bot API limit is 4,096 Unicode scalar values per text message. */
const TELEGRAM_MAX_TEXT_CODE_POINTS = 4_096;
/** The shared ingress core bounds UTF-16 units, so it needs the emoji-safe ceiling. */
const TELEGRAM_MAX_TEXT_UTF16_UNITS = TELEGRAM_MAX_TEXT_CODE_POINTS * 2;
/** Upper bound on how long a stop waits for already-queued safe deliveries. */
const TELEGRAM_DELIVERY_DRAIN_TIMEOUT_MS = 2_000;

export interface TelegramBridgeConfig {
  readonly port: number;
  readonly webhookPath: string;
  /** Process-only credential; callers must never log or persist it. */
  readonly botToken: string;
  /** Process-only webhook verifier secret; callers must never log or persist it. */
  readonly webhookSecret: string;
  /** Canonical, explicit owner-configured personal Telegram account IDs. */
  readonly allowedUserIds: readonly string[];
  readonly routeEpoch: number;
}

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
 * The three things that differ between the environment-configured webhook
 * deployment and the owner-driven polling connection. Everything else — the
 * receipt store, the delivery adapter, the safe-projection attach, and the
 * shared inbound core — is identical, which is what keeps the two paths from
 * drifting into two security models.
 */
interface TelegramActivationPlan {
  readonly botToken: string;
  readonly botFingerprint: string;
  createRuntime(activationEpoch: number): Promise<TelegramPlatformRuntime>;
  readonly verifier: PlatformBridgeWebhookVerifier;
  startIngress(gateway: PlatformBridgeInboundGateway): Promise<TelegramIngressHandle>;
}

export interface StartTelegramBridgeServerOptions {
  readonly conversationSurfaceRuntime: ConversationSurfaceRuntime;
  readonly conversationCommandPort: ConversationCommandPort;
  readonly getCurrentConversationId: () => string;
  /** Monotonic host epoch, incremented for every active-session replacement. */
  readonly getCurrentConversationEpoch: () => number;
  readonly env?: NodeJS.ProcessEnv;
  /** Injectable only for lifecycle tests. Production uses a Telegram-only file. */
  readonly receiptStore?: PlatformBridgeReceiptStore;
  readonly log?: (message: string) => void;
  /** @internal deterministic lifecycle injection for unit tests. */
  readonly dependencies?: Partial<TelegramBridgeServerDependencies>;
}

interface TelegramBridgeServerDependencies {
  readonly createRuntime: typeof createTelegramPlatformRuntime;
  readonly createReceiptStore: () => TailnetControllerReceiptStore;
  readonly startServer: typeof startTelegramWebhookServer;
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

/**
 * Resolve the immutable launch configuration. Disabled is a zero-side-effect
 * result; all sensitive values remain process-only and are intentionally not
 * written to settings, logs, feature namespaces, or delivery records.
 */
export function resolveTelegramBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): TelegramBridgeConfig | null {
  const enabled = env.LVIS_TELEGRAM_BRIDGE;
  if (enabled === undefined || enabled === "0") return null;
  if (enabled !== "1") throw new Error("telegram-bridge-enable-invalid");

  const botToken = env.LVIS_TELEGRAM_BOT_TOKEN;
  if (!isBotToken(botToken)) throw new Error("telegram-bridge-bot-token-missing-or-invalid");

  const webhookSecret = env.LVIS_TELEGRAM_WEBHOOK_SECRET;
  if (!isWebhookSecret(webhookSecret)) {
    throw new Error("telegram-bridge-webhook-secret-missing-or-invalid");
  }

  const allowedUserIds = parseAllowedUserIds(env.LVIS_TELEGRAM_ALLOWED_USER_IDS);
  const port = env.LVIS_TELEGRAM_PORT === undefined
    ? DEFAULT_TELEGRAM_BRIDGE_PORT
    : parseFixedPort(env.LVIS_TELEGRAM_PORT);
  const webhookPath = env.LVIS_TELEGRAM_WEBHOOK_PATH === undefined
    ? DEFAULT_TELEGRAM_WEBHOOK_PATH
    : parseWebhookPath(env.LVIS_TELEGRAM_WEBHOOK_PATH);
  const routeEpoch = env.LVIS_TELEGRAM_ROUTE_EPOCH === undefined
    ? 1
    : parsePositiveInteger(env.LVIS_TELEGRAM_ROUTE_EPOCH, "telegram-bridge-route-epoch-invalid");

  return Object.freeze({
    port,
    webhookPath,
    botToken,
    webhookSecret,
    allowedUserIds: Object.freeze(allowedUserIds),
    routeEpoch,
  });
}

function dependencies(
  overrides: Partial<TelegramBridgeServerDependencies> | undefined,
): TelegramBridgeServerDependencies {
  return {
    createRuntime: createTelegramPlatformRuntime,
    createReceiptStore: createTelegramBridgeReceiptStore,
    startServer: startTelegramWebhookServer,
    ...overrides,
  };
}

async function startForBoot(
  options: StartTelegramBridgeServerOptions,
  generation: number,
): Promise<TelegramBridgeServer | null> {
  // This must precede secret-store access, runtime creation, receipt setup,
  // provider transport construction, and listener construction. OFF means no
  // Telegram side effect at all.
  const config = resolveTelegramBridgeConfig(options.env);
  if (config === null) return null;

  const deps = dependencies(options.dependencies);
  const plan: TelegramActivationPlan = {
    botToken: config.botToken,
    botFingerprint: botFingerprint(config.botToken),
    createRuntime: async (activationEpoch) => await deps.createRuntime({
      allowedUserIds: config.allowedUserIds,
      botFingerprint: botFingerprint(config.botToken),
      getCurrentConversationId: options.getCurrentConversationId,
      getCurrentConversationEpoch: options.getCurrentConversationEpoch,
      routeEpoch: config.routeEpoch,
      activationEpoch,
    }),
    verifier: createTelegramWebhookVerifier({ secretToken: config.webhookSecret }),
    startIngress: async (gateway) => {
      const server = await deps.startServer({
        host: "127.0.0.1",
        port: config.port,
        path: config.webhookPath,
        gateway,
        maxBodyBytes: TELEGRAM_MAX_RAW_BODY_BYTES,
        log: (message) => options.log?.("[telegram-bridge] " + message),
      });
      return { port: server.port, close: () => server.close() };
    },
  };
  return await startActivation(plan, options, generation);
}

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
  readonly consumePairingAttempt: () => Promise<void>;
  readonly onFatal: (code: TelegramPollingFatalCode) => void | Promise<void>;
  readonly onPaired?: (senderId: string) => void | Promise<void>;
  readonly receiptStore?: PlatformBridgeReceiptStore;
  readonly log?: (message: string) => void;
  /** Test-only injection; production builds a real Bot API client. */
  readonly createBotApiClient?: (botToken: string) => TelegramBotApiClient;
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
        consumePairingAttempt: options.consumePairingAttempt,
        onFatal: options.onFatal,
        ...(options.onPaired ? { onPaired: options.onPaired } : {}),
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
    getCurrentConversationEpoch: () => 0,
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
  const deps = dependencies(options.dependencies);
  // Consumed only past the disabled check, so a boot with the bridge off leaves
  // the first real activation at epoch 1.
  const activationEpoch = ++activationSequence;
  const runtime = await plan.createRuntime(activationEpoch);
  if (generation !== lifecycleGeneration) {
    runtime.dispose();
    return null;
  }

  const receiptStore = options.receiptStore ?? deps.createReceiptStore();
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
      isChannelCurrent: (channel, generation) => {
        const lease = channel.deliveryLease;
        if (lease === undefined) return false;
        const active = deliveryDestinations.get(lease);
        if (active === undefined || active.channel !== channel) return false;
        if (active.generation === undefined) active.generation = generation;
        return active.generation === generation && runtime.isRouteCurrent(active.route);
      },
    }),
    maxTextChars: TELEGRAM_MAX_TEXT_CODE_POINTS,
    coalesceQueuedMessages: coalesceTelegramDeliveryQueue,
    onBackpressure: (channel) => {
      releaseDeliveryDestination(channel);
      options.log?.("[telegram-bridge] safe delivery closed after backpressure");
    },
    onDeliveryFailure: (channel) => {
      releaseDeliveryDestination(channel);
      options.log?.("[telegram-bridge] safe delivery closed after provider failure");
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
    // PlatformBridgeInboundGateway uses UTF-16 code units; Telegram's verifier
    // separately enforces the stricter 4,096 Unicode-code-point contract.
    maxTextChars: TELEGRAM_MAX_TEXT_UTF16_UNITS,
    receiptOwnerId: installationReceiptOwnerId,
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
  options.log?.(
    ingress.port === null
      ? "[telegram-bridge] receiving updates over an outbound connection"
      : "[telegram-bridge] loopback listener ready on 127.0.0.1:"
        + ingress.port
        + "; configure the HTTPS webhook externally",
  );
  return Object.freeze({ port: ingress.port });
}

/** Idempotently start the explicitly configured Telegram bridge activation. */
export async function maybeStartTelegramBridgeServer(
  options: StartTelegramBridgeServerOptions,
): Promise<TelegramBridgeServer | null> {
  if (shutdownRequested) return null;
  if (stopPromise) {
    // Wait for the owner's disconnect to finish, then start a real reconnect.
    // Returning null here would silently swallow a connect issued in the same
    // tick as the preceding disconnect.
    await stopPromise;
    if (shutdownRequested) return null;
  }
  if (activeBridge) return Object.freeze({ port: activeBridge.ingress.port });
  if (startPromise) return await startPromise;

  const attempt = ++startAttemptSequence;
  activeStartAttempt = attempt;
  const pending = startForBoot(options, lifecycleGeneration);
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

function botFingerprint(token: string): string {
  return createHash("sha256")
    .update("lvis/telegram-bridge/bot-fingerprint/v1\0", "utf8")
    .update(token, "utf8")
    .digest("hex");
}

function isBotToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{16,256}$/.test(value);
}

function isWebhookSecret(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

function parseAllowedUserIds(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    throw new Error("telegram-bridge-allowed-users-missing-or-invalid");
  }
  const ids = value.split(",");
  if (ids.length > 128 || ids.some((id) => !isCanonicalTelegramUserId(id))) {
    throw new Error("telegram-bridge-allowed-users-missing-or-invalid");
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("telegram-bridge-allowed-users-missing-or-invalid");
  }
  return ids;
}

function parseFixedPort(value: string): number {
  return parsePositiveInteger(value, "telegram-bridge-port-invalid", 65_535);
}

function parseWebhookPath(value: string): string {
  if (
    value.length > 128
    || !/^\/(?:[A-Za-z0-9][A-Za-z0-9_-]*)(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(value)
  ) {
    throw new Error("telegram-bridge-webhook-path-invalid");
  }
  return value;
}

function parsePositiveInteger(value: string, error: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(error);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) throw new Error(error);
  return parsed;
}

function isCanonicalTelegramUserId(value: string): boolean {
  if (!/^[1-9]\d*$/.test(value)) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && String(numeric) === value;
}
