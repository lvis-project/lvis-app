/**
 * Main-process lifecycle for the dedicated Tailnet observer listener.
 *
 * This listener is deliberately enabled only by an explicit boot environment
 * configuration. It does not configure Tailscale Serve, mutate tailnet policy,
 * or retain a Tailscale admin credential: those are deployment-admin actions
 * whose lifecycle must be coupled to the host application outside this process.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  openFeatureNamespace,
  type FeatureNamespaceHandle,
} from "./storage/feature-namespace.js";
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

/** Every key the observer configuration is made of, in both of its sources. */
type TailnetObserverConfigKey =
  | "enabled"
  | "expectedAppCapability"
  | "port"
  | "controllerEnabled"
  | "pairedSharingEnabled"
  | "webEnabled"
  | "webOrigin";

/**
 * Where a key's effective value came from.
 *
 * Provenance is not decoration. A stale shell profile must not be able to
 * masquerade as the approved host-owned configuration, so every surface that
 * shows the effective config shows this beside it.
 */
type TailnetObserverConfigSource = "file" | "env-override" | "unset";

type TailnetObserverConfigProvenance =
  Readonly<Record<TailnetObserverConfigKey, TailnetObserverConfigSource>>;

export interface TailnetObserverResolution {
  readonly config: TailnetObserverConfig | null;
  readonly provenance: TailnetObserverConfigProvenance;
  /** Whether a host-owned configuration file contributed anything at all. */
  readonly fileConfigured: boolean;
}

/**
 * The host-owned observer configuration, `~/.lvis/tailnet/observer.json`.
 *
 * Deliberately NOT part of the settings store. That pipeline is renderer-
 * writable by design, and the capability key is precisely the value a webpage
 * must never be able to set — the property the env-only resolver was
 * protecting, kept intact by moving to a host-owned file instead of settings.
 */
export interface TailnetObserverConfigFile {
  readonly enabled?: boolean;
  readonly expectedAppCapability?: string;
  readonly port?: number;
  readonly controllerEnabled?: boolean;
  readonly pairedSharingEnabled?: boolean;
  readonly webEnabled?: boolean;
  readonly webOrigin?: string;
}

const TAILNET_FEATURE_NAMESPACE = "tailnet";
const TAILNET_OBSERVER_CONFIG_FILE = "observer.json";

const CONFIG_KEYS: readonly TailnetObserverConfigKey[] = [
  "enabled",
  "expectedAppCapability",
  "port",
  "controllerEnabled",
  "pairedSharingEnabled",
  "webEnabled",
  "webOrigin",
];

const ENV_KEY: Readonly<Record<TailnetObserverConfigKey, string>> = {
  enabled: "LVIS_TAILNET_OBSERVER",
  expectedAppCapability: "LVIS_TAILNET_OBSERVER_CAP",
  port: "LVIS_TAILNET_OBSERVER_PORT",
  controllerEnabled: "LVIS_TAILNET_CONTROLLER",
  pairedSharingEnabled: "LVIS_TAILNET_PAIRED_SHARING",
  webEnabled: "LVIS_TAILNET_WEB",
  webOrigin: "LVIS_TAILNET_WEB_ORIGIN",
};

const BOOLEAN_FILE_KEYS = [
  "enabled",
  "controllerEnabled",
  "pairedSharingEnabled",
  "webEnabled",
] as const;

/**
 * One layer of raw strings — the single vocabulary both sources are validated
 * in. The file is projected onto it rather than validated separately, so the
 * two sources cannot drift into two different notions of a valid port.
 */
type RawLayer = Partial<Record<TailnetObserverConfigKey, string>>;

interface TailnetObserverServerDependencies {
  startServer: typeof startTailnetSurfaceServer;
  /**
   * How the host-owned configuration file is read. Injected by the lifecycle
   * tests so their matrix stays an environment question and does not depend on
   * whether the developer running them happens to have an observer configured.
   */
  readConfigFile: () => Promise<TailnetObserverConfigFile | null>;
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

function envLayer(env: NodeJS.ProcessEnv): RawLayer {
  const layer: RawLayer = {};
  for (const key of CONFIG_KEYS) {
    const value = env[ENV_KEY[key]];
    if (value !== undefined) layer[key] = value;
  }
  return layer;
}

/**
 * Project the file onto the raw vocabulary. `false` becomes an ABSENT key
 * rather than `"0"`: every boolean below accepts `"1"` or absence and rejects
 * anything else, and a file saying "controller off" has to mean the same thing
 * as a file that never mentioned the controller.
 */
function fileLayer(file: TailnetObserverConfigFile): RawLayer {
  const layer: RawLayer = {};
  for (const key of BOOLEAN_FILE_KEYS) {
    if (file[key] === true) layer[key] = "1";
  }
  if (file.expectedAppCapability !== undefined) {
    layer.expectedAppCapability = file.expectedAppCapability;
  }
  if (file.port !== undefined) layer.port = String(file.port);
  if (file.webOrigin !== undefined) layer.webOrigin = file.webOrigin;
  return layer;
}

/**
 * Validate the file's shape before it reaches {@link fileLayer}.
 *
 * Fail-closed: a malformed file is an error the caller surfaces, never a
 * silently-ignored file that boots the observer on a half-applied config.
 */
export function parseTailnetObserverConfigFile(raw: unknown): TailnetObserverConfigFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("tailnet-observer-config-file-invalid");
  }
  const source = raw as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error("tailnet-observer-config-file-invalid");
    }
  }
  const file: Record<string, unknown> = {};
  for (const key of BOOLEAN_FILE_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new Error("tailnet-observer-config-file-invalid");
    file[key] = value;
  }
  for (const key of ["expectedAppCapability", "webOrigin"] as const) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error("tailnet-observer-config-file-invalid");
    file[key] = value;
  }
  if (source.port !== undefined) {
    if (typeof source.port !== "number") throw new Error("tailnet-observer-config-file-invalid");
    file.port = source.port;
  }
  return Object.freeze(file) as TailnetObserverConfigFile;
}

function provenanceOf(file: RawLayer, env: RawLayer): TailnetObserverConfigProvenance {
  const provenance = {} as Record<TailnetObserverConfigKey, TailnetObserverConfigSource>;
  for (const key of CONFIG_KEYS) {
    provenance[key] = env[key] !== undefined
      ? "env-override"
      : file[key] !== undefined ? "file" : "unset";
  }
  return Object.freeze(provenance);
}

/**
 * Resolve the merged layers.
 *
 * Env wins per key over the host-owned file. A principal that can set the
 * environment already owns the process, so refusing the override would only
 * pretend otherwise; what it must not do is win *silently*, which is what the
 * returned provenance is for.
 *
 * OFF is side-effect free. ON requires an explicit owned app-capability key;
 * the renderer never supplies this value, so a webpage cannot widen Tailnet
 * policy by editing ordinary settings.
 */
function resolveFromLayers(file: RawLayer, env: RawLayer): TailnetObserverResolution {
  const merged: RawLayer = { ...file, ...env };
  const provenance = provenanceOf(file, env);
  const fileConfigured = Object.keys(file).length > 0;
  if (merged.enabled !== "1") return { config: null, provenance, fileConfigured };

  const expectedAppCapability = merged.expectedAppCapability;
  if (!isCapabilityKey(expectedAppCapability)) {
    throw new Error("tailnet-observer-capability-missing-or-invalid");
  }

  const rawPort = merged.port;
  const port = rawPort === undefined
    ? DEFAULT_TAILNET_OBSERVER_PORT
    : parseFixedPort(rawPort);
  const rawController = merged.controllerEnabled;
  if (rawController !== undefined && rawController !== "1") {
    throw new Error("tailnet-controller-enable-invalid");
  }
  const rawPairedSharing = merged.pairedSharingEnabled;
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
  const rawWeb = merged.webEnabled;
  if (rawWeb !== undefined && rawWeb !== "1") {
    throw new Error("tailnet-web-enable-invalid");
  }
  let webOrigin: string | undefined;
  if (rawWeb === "1") {
    if (rawPairedSharing !== "1") {
      throw new Error("tailnet-web-requires-paired-sharing");
    }
    const configuredOrigin = merged.webOrigin;
    if (!isTailnetWebOrigin(configuredOrigin)) {
      throw new Error("tailnet-web-origin-missing-or-invalid");
    }
    webOrigin = configuredOrigin;
  }

  return {
    config: Object.freeze({
      port,
      expectedAppCapability,
      controllerEnabled: rawController === "1",
      pairedSharingEnabled: rawPairedSharing === "1",
      ...(webOrigin === undefined ? {} : { webOrigin }),
    }),
    provenance,
    fileConfigured,
  };
}

/**
 * The environment layer on its own.
 *
 * {@link loadTailnetObserverConfig} is what production boots through; this is
 * the same resolution with no file underneath, for callers that hold only an
 * environment and for the contract tests that pin the env vocabulary.
 */
export function resolveTailnetObserverConfig(
  env: NodeJS.ProcessEnv = process.env,
): TailnetObserverConfig | null {
  return resolveFromLayers({}, envLayer(env)).config;
}

/** Read the host-owned file, distinguishing "absent" from "unreadable". */
export async function readTailnetObserverConfigFile(
  namespace: FeatureNamespaceHandle = openFeatureNamespace(TAILNET_FEATURE_NAMESPACE),
): Promise<TailnetObserverConfigFile | null> {
  let text: string;
  try {
    text = await readFile(join(namespace.dir, TAILNET_OBSERVER_CONFIG_FILE), "utf8");
  } catch (err) {
    // Absent is the default-OFF state and must stay side-effect free. Anything
    // else is a configuration the host cannot read, which is not the same thing
    // and must not resolve to "the user never enabled this".
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("tailnet-observer-config-file-unreadable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("tailnet-observer-config-file-invalid");
  }
  return parseTailnetObserverConfigFile(parsed);
}

/**
 * Persist the host-owned configuration, after proving it resolves.
 *
 * The dry run is the point: a configuration that would make the next boot throw
 * must be refused at the moment it is proposed, while there is still a person
 * to tell. It runs with no environment layer, because the file has to stand on
 * its own — an override that happens to be set in this shell is not a reason to
 * persist a file that would fail without it.
 */
export async function writeTailnetObserverConfigFile(
  file: TailnetObserverConfigFile,
  namespace: FeatureNamespaceHandle = openFeatureNamespace(TAILNET_FEATURE_NAMESPACE),
): Promise<void> {
  resolveFromLayers(fileLayer(parseTailnetObserverConfigFile(file)), {});
  await namespace.writeJson(TAILNET_OBSERVER_CONFIG_FILE, file);
}

/**
 * Resolve the observer configuration the way production boots it: the
 * host-owned file first, the environment as an override layer on top.
 */
export async function loadTailnetObserverConfig(options: {
  readonly env?: NodeJS.ProcessEnv;
  /** @internal deterministic injection; production reads the host-owned file. */
  readonly readConfigFile?: () => Promise<TailnetObserverConfigFile | null>;
} = {}): Promise<TailnetObserverResolution> {
  const read = options.readConfigFile ?? (() => readTailnetObserverConfigFile());
  const file = await read();
  return resolveFromLayers(
    file === null ? {} : fileLayer(file),
    envLayer(options.env ?? process.env),
  );
}

let activePairedSharingRuntime: TailnetPairedSharingRuntime | null = null;
let activeServer: TailnetSurfaceServer | null = null;
let startPromise: Promise<TailnetObserverServer | null> | null = null;
let activeStartAttempt: number | null = null;
let startAttemptSequence = 0;
let stopPromise: Promise<void> | null = null;
let lifecycleGeneration = 0;
let stopped = false;

let activeConfig: TailnetObserverConfig | null = null;
let lastStartError: string | null = null;

/** The main-owned P2 runtime is intentionally never exposed to a remote surface. */
export function getTailnetPairedSharingRuntime(): TailnetPairedSharingRuntime | null {
  return activePairedSharingRuntime;
}

export interface TailnetObserverRuntimeState {
  /** The port the listener actually bound, or null when nothing is listening. */
  readonly listeningPort: number | null;
  /** The configuration the running listener booted with. */
  readonly activeConfig: TailnetObserverConfig | null;
  /**
   * The kebab-case code of the last failed start.
   *
   * Boot logs this and continues, which is why "the observer is not up and I
   * cannot tell why" used to require reading the main-process log. It is kept
   * here so a diagnostics surface can answer the question in the app.
   */
  readonly lastStartError: string | null;
}

export function getTailnetObserverRuntimeState(): TailnetObserverRuntimeState {
  return Object.freeze({
    listeningPort: activeServer?.port ?? null,
    activeConfig,
    lastStartError,
  });
}
function dependencies(
  overrides: Partial<TailnetObserverServerDependencies> | undefined,
): TailnetObserverServerDependencies {
  return {
    startServer: startTailnetSurfaceServer,
    readConfigFile: () => readTailnetObserverConfigFile(),
    ...overrides,
  };
}

async function startForBoot(
  options: StartTailnetObserverServerOptions,
  generation: number,
): Promise<TailnetObserverServer | null> {
  // This must run before listener construction. A disabled observer opens no
  // port and starts no Tailnet-specific transport side effect.
  const resolved = dependencies(options.dependencies);
  const { config } = await loadTailnetObserverConfig({
    ...(options.env === undefined ? {} : { env: options.env }),
    readConfigFile: resolved.readConfigFile,
  });
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

  const server = await resolved.startServer({
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
  activeConfig = config;
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
  // Record why a start failed. Boot logs the throw and carries on, so without
  // this the only account of a misconfigured observer is a main-process log
  // line the user of a packaged app never sees.
  const pending = startForBoot(options, lifecycleGeneration).then(
    (started) => {
      lastStartError = null;
      return started;
    },
    (err: unknown) => {
      lastStartError = err instanceof Error ? err.message : "tailnet-observer-start-failed";
      throw err;
    },
  );
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
  activeConfig = null;
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
  activeConfig = null;
  lastStartError = null;
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
