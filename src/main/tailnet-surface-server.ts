/**
 * Main-process lifecycle for the dedicated Tailnet observer listener.
 *
 * This listener is deliberately enabled only by an explicit boot environment
 * configuration. It does not configure Tailscale Serve, mutate tailnet policy,
 * or retain a Tailscale admin credential: those are deployment-admin actions
 * whose lifecycle must be coupled to the host application outside this process.
 */
import {
  createTailnetControllerReceiptStore,
  type TailnetControllerReceiptStore,
} from "../api/tailnet-controller-receipt-store.js";
import {
  startTailnetSurfaceServer,
  isTailnetWebOrigin,
  type TailnetSurfaceServer,
} from "../api/tailnet-surface-server.js";
import type { ConversationSurfaceRuntime } from "../engine/conversation-surface-runtime.js";
import type { ConversationCommandPort } from "./conversation-command-port.js";
import {
  createTailnetPairedSharingRuntime,
  type TailnetPairedSharingRuntime,
} from "./tailnet-paired-sharing-runtime.js";

export const DEFAULT_TAILNET_OBSERVER_PORT = 46_173;

export interface TailnetObserverConfig {
  readonly port: number;
  readonly expectedAppCapability: string;
  readonly controllerEnabled: boolean;
  readonly pairedSharingEnabled: boolean;
  readonly webOrigin?: string;
}

export interface TailnetObserverServer {
  readonly port: number;
}

interface TailnetObserverServerDependencies {
  startServer: typeof startTailnetSurfaceServer;
}

export interface StartTailnetObserverServerOptions {
  readonly conversationSurfaceRuntime: ConversationSurfaceRuntime;
  readonly getCurrentConversationId: () => string;
  readonly isConversationBusy: () => boolean;
  /** Present only in main-process composition; controller stays OFF without it. */
  readonly conversationCommandPort?: ConversationCommandPort;
  /** Host-owned durable controller receipt store; injectable only for lifecycle tests. */
  readonly tailnetControllerReceiptStore?: TailnetControllerReceiptStore;
  /**
   * Host-owned P2 pairing runtime. `null` explicitly means boot setup failed;
   * the listener must not silently construct a distinct runtime for itself.
   */
  readonly tailnetPairedSharingRuntime?: TailnetPairedSharingRuntime | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
  /** @internal deterministic lifecycle injection for tests. */
  readonly dependencies?: Partial<TailnetObserverServerDependencies>;
}

/**
 * Resolve the main-owned observer configuration.
 *
 * OFF is side-effect free. ON requires an explicit owned app-capability key;
 * the renderer never supplies this value, so a webpage cannot widen Tailnet
 * policy by editing ordinary settings.
 */
export function resolveTailnetObserverConfig(
  env: NodeJS.ProcessEnv = process.env,
): TailnetObserverConfig | null {
  if (env.LVIS_TAILNET_OBSERVER !== "1") return null;

  const expectedAppCapability = env.LVIS_TAILNET_OBSERVER_CAP;
  if (!isCapabilityKey(expectedAppCapability)) {
    throw new Error("tailnet-observer-capability-missing-or-invalid");
  }

  const rawPort = env.LVIS_TAILNET_OBSERVER_PORT;
  const port = rawPort === undefined
    ? DEFAULT_TAILNET_OBSERVER_PORT
    : parseFixedPort(rawPort);
  const rawController = env.LVIS_TAILNET_CONTROLLER;
  if (rawController !== undefined && rawController !== "1") {
    throw new Error("tailnet-controller-enable-invalid");
  }
  const rawPairedSharing = env.LVIS_TAILNET_PAIRED_SHARING;
  if (rawPairedSharing !== undefined && rawPairedSharing !== "1") {
    throw new Error("tailnet-paired-sharing-enable-invalid");
  }
  // The controller accepts remote commands that reach the user's agent, so it
  // needs the pairing boundary for the same reason the web adapter does. Without
  // this, enabling the controller alone leaves the share authorizer undefined —
  // i.e. no pairing gate at all on the native routes.
  if (rawController === "1" && rawPairedSharing !== "1") {
    throw new Error("tailnet-controller-requires-paired-sharing");
  }
  const rawWeb = env.LVIS_TAILNET_WEB;
  if (rawWeb !== undefined && rawWeb !== "1") {
    throw new Error("tailnet-web-enable-invalid");
  }
  let webOrigin: string | undefined;
  if (rawWeb === "1") {
    if (rawPairedSharing !== "1") {
      throw new Error("tailnet-web-requires-paired-sharing");
    }
    const configuredOrigin = env.LVIS_TAILNET_WEB_ORIGIN;
    if (!isTailnetWebOrigin(configuredOrigin)) {
      throw new Error("tailnet-web-origin-missing-or-invalid");
    }
    webOrigin = configuredOrigin;
  }

  return Object.freeze({
    port,
    expectedAppCapability,
    controllerEnabled: rawController === "1",
    pairedSharingEnabled: rawPairedSharing === "1",
    ...(webOrigin === undefined ? {} : { webOrigin }),
  });
}

let activePairedSharingRuntime: TailnetPairedSharingRuntime | null = null;
let activeServer: TailnetSurfaceServer | null = null;
let startPromise: Promise<TailnetObserverServer | null> | null = null;
let activeStartAttempt: number | null = null;
let startAttemptSequence = 0;
let stopPromise: Promise<void> | null = null;
let lifecycleGeneration = 0;
let stopped = false;

/** The main-owned P2 runtime is intentionally never exposed to a remote surface. */
export function getTailnetPairedSharingRuntime(): TailnetPairedSharingRuntime | null {
  return activePairedSharingRuntime;
}
function dependencies(
  overrides: Partial<TailnetObserverServerDependencies> | undefined,
): TailnetObserverServerDependencies {
  return {
    startServer: startTailnetSurfaceServer,
    ...overrides,
  };
}

async function startForBoot(
  options: StartTailnetObserverServerOptions,
  generation: number,
): Promise<TailnetObserverServer | null> {
  // This must run before listener construction. A disabled observer opens no
  // port and starts no Tailnet-specific transport side effect.
  const config = resolveTailnetObserverConfig(options.env);
  if (!config) return null;
  if (config.controllerEnabled && options.conversationCommandPort === undefined) {
    throw new Error("tailnet-controller-command-port-unavailable");
  }
  const receiptStore = config.controllerEnabled
    ? options.tailnetControllerReceiptStore ?? createTailnetControllerReceiptStore()
    : undefined;
  const injectedPairedSharingRuntime = options.tailnetPairedSharingRuntime;
  if (config.pairedSharingEnabled && injectedPairedSharingRuntime === null) {
    throw new Error("tailnet-paired-sharing-runtime-unavailable");
  }
  const pairedSharingRuntime = config.pairedSharingEnabled
    ? injectedPairedSharingRuntime ?? await createTailnetPairedSharingRuntime({
        getCurrentConversationId: options.getCurrentConversationId,
      })
    : undefined;

  const server = await dependencies(options.dependencies).startServer({
    host: "127.0.0.1",
    port: config.port,
    expectedAppCapability: config.expectedAppCapability,
    projectionStore: options.conversationSurfaceRuntime.sharedProjection,
    getCurrentConversationId: options.getCurrentConversationId,
    isConversationBusy: options.isConversationBusy,
    ...(pairedSharingRuntime === undefined ? {} : { pairedSharing: pairedSharingRuntime.authorizer }),
    ...(pairedSharingRuntime === undefined
      ? {}
      : {
          pairing: {
            claimInvitation: pairedSharingRuntime.store.claimInvitation.bind(pairedSharingRuntime.store),
          },
        }),
    ...(config.controllerEnabled
      ? {
          controller: {
            commandPort: options.conversationCommandPort!,
            receiptStore: receiptStore!,
          },
        }
      : {}),
    ...(config.webOrigin === undefined ? {} : { web: { origin: config.webOrigin } }),
    log: (message) => options.log?.("[tailnet-observer] " + message),
  });
  if (generation !== lifecycleGeneration) {
    await server.close();
    return null;
  }

  activeServer = server;
  activePairedSharingRuntime = pairedSharingRuntime ?? null;
  options.log?.(
    "[tailnet-observer] listener ready on 127.0.0.1:" + server.port + "; configure Serve separately",
  );
  return Object.freeze({ port: server.port });
}

/** Idempotently start the explicitly configured observer for this app boot. */
export async function maybeStartTailnetObserverServer(
  options: StartTailnetObserverServerOptions,
): Promise<TailnetObserverServer | null> {
  if (stopped) return null;
  if (stopPromise) {
    await stopPromise;
    return null;
  }
  if (activeServer) return Object.freeze({ port: activeServer.port });
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

async function stopForShutdown(): Promise<void> {
  stopped = true;
  lifecycleGeneration += 1;
  activePairedSharingRuntime = null;
  const pending = startPromise;
  const current = takeActiveServer();
  if (current) await current.close();
  if (pending) await pending.catch(() => undefined);

  // A listener may finish starting after the generation check raced shutdown.
  const late = takeActiveServer();
  if (late) await late.close();
}

function takeActiveServer(): TailnetSurfaceServer | null {
  const current = activeServer;
  activeServer = null;
  return current;
}

/** Close live observer streams before the owning application runtime is disposed. */
export function stopTailnetObserverServer(): Promise<void> {
  if (stopPromise) return stopPromise;
  const pending = stopForShutdown();
  const tracked = pending.finally(() => {
    if (stopPromise === tracked) stopPromise = null;
  });
  stopPromise = tracked;
  return tracked;
}

/** @internal Test-only reset; production has one immutable boot snapshot. */
export function resetTailnetObserverServerForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("tailnet-observer-test-reset-outside-test");
  }
  if (activeServer || startPromise || stopPromise || activeStartAttempt !== null) {
    throw new Error("tailnet-observer-test-reset-while-active");
  }
  lifecycleGeneration += 1;
  stopped = false;
  activePairedSharingRuntime = null;
}

function parseFixedPort(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("tailnet-observer-port-invalid");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("tailnet-observer-port-invalid");
  }
  return port;
}

function isCapabilityKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value !== "__proto__"
    && value !== "constructor"
    && value !== "prototype"
    && !/[\u0000-\u0020\u007f]/.test(value);
}
