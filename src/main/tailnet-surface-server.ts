/**
 * Main-process lifecycle for the dedicated Tailnet observer listener.
 *
 * The listener is off until the local owner turns it on, and it never mutates
 * tailnet policy or retains a Tailscale admin credential. It does read this
 * desktop's own Tailscale state, and — only when the owner approves the exact
 * command first — puts its own loopback port behind `tailscale serve`, because
 * asking a person to retype a name the CLI already knows is where the setup
 * silently went wrong.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { platform as hostPlatform } from "node:process";
import { promisify } from "node:util";
import {
  createTailnetControllerReceiptStore,
  type TailnetControllerReceiptStore,
} from "../api/tailnet-controller-receipt-store.js";
import {
  startTailnetSurfaceServer,
  isTailnetWebOrigin,
  type TailnetSurfaceServer,
} from "../api/tailnet-surface-server.js";
import {
  isTailnetAppCapabilityKey,
  parseTailnetAuthorization,
  type TailnetAuthorization,
} from "../shared/tailnet-observer-config.js";
import type { ConversationSurfaceRuntime } from "../engine/conversation-surface-runtime.js";
import { isRecord } from "../shared/is-record.js";
import type { TailscaleEnvironmentView } from "../shared/tailnet-observer-config.js";
import type { ConversationCommandPort } from "./conversation-command-port.js";
import {
  openFeatureNamespace,
  type FeatureNamespaceHandle,
} from "./storage/feature-namespace.js";
import {
  createTailnetPairedSharingRuntime,
  type TailnetPairedSharingRuntime,
} from "./tailnet-paired-sharing-runtime.js";
import type {
  TailnetPairingShareStore,
  TailnetShareActorId,
} from "./tailnet-pairing-share-store.js";

export const DEFAULT_TAILNET_OBSERVER_PORT = 46_173;

export interface TailnetObserverConfig {
  readonly port: number;
  readonly authorization: TailnetAuthorization;
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
  | "authorization"
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
 * writable by design, and the authorization boundary is precisely the value a
 * webpage must never be able to set — the property the env-only resolver was
 * protecting, kept intact by moving to a host-owned file instead of settings.
 */
export interface TailnetObserverConfigFile {
  readonly enabled?: boolean;
  readonly authorization?: TailnetAuthorization;
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
  "authorization",
  "port",
  "controllerEnabled",
  "pairedSharingEnabled",
  "webEnabled",
  "webOrigin",
];

const ENV_KEY: Readonly<Record<TailnetObserverConfigKey, string>> = {
  enabled: "LVIS_TAILNET_OBSERVER",
  authorization: "LVIS_TAILNET_OBSERVER_AUTHORIZATION",
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
  /**
   * How this desktop's own Tailscale state is read when a remote asks whether
   * it is the owner's own device. Injected for the same reason as the config
   * file: the question must not become "is Tailscale running on the machine
   * the tests happen to run on".
   */
  probeEnvironment: () => Promise<TailscaleEnvironment>;
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
  if (file.authorization !== undefined) {
    layer.authorization = authorizationLayerValue(file.authorization);
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
  if (source.webOrigin !== undefined) {
    if (typeof source.webOrigin !== "string") {
      throw new Error("tailnet-observer-config-file-invalid");
    }
    file.webOrigin = source.webOrigin;
  }
  if (source.authorization !== undefined) {
    const authorization = parseTailnetAuthorization(source.authorization);
    if (authorization === null) throw new Error("tailnet-observer-config-file-invalid");
    file.authorization = authorization;
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
 * OFF is side-effect free. ON requires an explicitly named authorization
 * boundary — a tailnet identity or an owned app-capability key — with no
 * implicit default, and the file it comes from is host-owned, so a webpage
 * cannot widen Tailnet policy by editing ordinary settings.
 */
function resolveFromLayers(file: RawLayer, env: RawLayer): TailnetObserverResolution {
  const merged: RawLayer = { ...file, ...env };
  const provenance = provenanceOf(file, env);
  const fileConfigured = Object.keys(file).length > 0;
  if (merged.enabled !== "1") return { config: null, provenance, fileConfigured };

  const authorization = parseAuthorizationLayerValue(merged.authorization);

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
      authorization,
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
/**
 * What this process was composed with.
 *
 * Kept so a configuration saved from the Settings tab can be applied to the
 * running process. Without it the listener was a boot-once latch and every
 * change — including turning the feature on for the first time — waited for
 * the next launch, which is the step people did not know they had to take.
 */
let compositionOptions: StartTailnetObserverServerOptions | null = null;
/** Serializes restarts against each other; boot's own latch handles the first. */
let lifecycleChain: Promise<unknown> = Promise.resolve();

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
    probeEnvironment: () => probeTailscaleEnvironment(),
    ...overrides,
  };
}

/**
 * Pair a device that is signed in to this desktop's own Tailscale account,
 * without a code.
 *
 * Serve fills the login header from the tailnet, and the probe says which login
 * this desktop itself is signed in as. When they are the same account, carrying
 * a 56-character code from one of the owner's screens to another proves nothing
 * the tailnet has not already proved. Approval is not what this skips: the
 * invitation minted here is claimed the ordinary way, so the pairing lands
 * `pending` and the desktop still has to activate it.
 */
async function claimOwnTailnetDevice(input: {
  readonly store: TailnetPairingShareStore;
  readonly probeEnvironment: () => Promise<TailscaleEnvironment>;
  readonly login: string;
  readonly actorId: TailnetShareActorId;
}): Promise<boolean> {
  const environment = await input.probeEnvironment();
  // Neither login is logged or echoed; this comparison is all they are read for.
  // A probe that could not read one leaves `login` null, which matches nothing,
  // and the remote is asked for a code — the correct answer, not a fallback:
  // without the probe nothing has established whose device this is.
  if (environment.login !== input.login) return false;
  // A pairing this actor already has is the answer; minting a second invitation
  // on every five-second reload would spend the invitation budget and then be
  // refused by `claimInvitation` for being already paired.
  if (input.store.currentPairing(input.actorId) !== null) return true;
  const invitation = await input.store.createInvitation();
  return await input.store.claimInvitation(invitation.code, input.actorId) !== null;
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
    authorization: config.authorization,
    projectionStore: options.conversationSurfaceRuntime.sharedProjection,
    getCurrentConversationId: options.getCurrentConversationId,
    isConversationBusy: options.isConversationBusy,
    ...(pairedSharingRuntime === undefined ? {} : { pairedSharing: pairedSharingRuntime.authorizer }),
    ...(pairedSharingRuntime === undefined
      ? {}
      : {
          pairing: {
            claimInvitation: pairedSharingRuntime.store.claimInvitation.bind(pairedSharingRuntime.store),
            claimOwnDevice: (login: string, actorId: TailnetShareActorId) => claimOwnTailnetDevice({
              store: pairedSharingRuntime.store,
              probeEnvironment: resolved.probeEnvironment,
              login,
              actorId,
            }),
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
  compositionOptions = options;
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

/**
 * Bring the listener back up on the configuration that is saved right now.
 *
 * Stop, advance the lifecycle generation so a start still in flight cannot
 * install itself afterwards, then resolve and start again with the options this
 * process was composed with. The generation bump is what makes this safe to
 * call while a boot start is still resolving.
 */
async function restartOnce(): Promise<TailnetObserverServer | null> {
  if (stopped) throw new Error("tailnet-observer-stopped");
  const options = compositionOptions;
  if (options === null) throw new Error("tailnet-observer-not-composed");
  if (startPromise) await startPromise.catch(() => undefined);
  if (stopPromise) await stopPromise.catch(() => undefined);
  if (stopped) throw new Error("tailnet-observer-stopped");

  lifecycleGeneration += 1;
  const generation = lifecycleGeneration;
  activeConfig = null;
  activePairedSharingRuntime = null;
  const current = takeActiveServer();
  if (current) await current.close();

  try {
    const started = await startForBoot(options, generation);
    lastStartError = null;
    return started;
  } catch (err) {
    lastStartError = err instanceof Error ? err.message : "tailnet-observer-start-failed";
    throw err;
  }
}

/**
 * Apply a saved configuration to the running process.
 *
 * Callers are the owner-facing configuration service; a restart is the whole
 * reason "takes effect the next time the app starts" is gone.
 */
export function restartTailnetObserverServer(): Promise<TailnetObserverServer | null> {
  const next = lifecycleChain.then(restartOnce, restartOnce);
  lifecycleChain = next.then(() => undefined, () => undefined);
  return next;
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
  compositionOptions = null;
  lifecycleChain = Promise.resolve();
}

// ─── Tailscale environment ──────────────────────────────────────────────────

/**
 * The macOS app keeps its CLI inside the bundle and does not put it on PATH,
 * so a PATH-only lookup reports "not installed" on the platform where it is
 * most often installed.
 */
const MACOS_TAILSCALE_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const TAILSCALE_CLI_TIMEOUT_MS = 5_000;
const TAILSCALE_CLI_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** How much CLI output is carried to the surface that shows it verbatim. */
const TAILSCALE_DETAIL_MAX_CHARS = 2_000;

const execFileAsync = promisify(execFile);

/**
 * How a Tailscale CLI invocation is run.
 *
 * Injected by the tests so their matrix is a question about what the CLI says,
 * not about whether the machine running them happens to have Tailscale
 * installed, logged in, and serving.
 */
export type TailscaleCommandResult =
  | { readonly kind: "ran"; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly detail: string };

export type TailscaleCommandRunner = (
  cliPath: string,
  args: readonly string[],
) => Promise<TailscaleCommandResult>;

/** The probe's own view plus the binary it spoke to, which never leaves main. */
export interface TailscaleEnvironment extends TailscaleEnvironmentView {
  readonly cliPath: string | null;
}

function tailscaleCliPath(platformName: NodeJS.Platform): string {
  return platformName === "darwin" && existsSync(MACOS_TAILSCALE_CLI)
    ? MACOS_TAILSCALE_CLI
    : "tailscale";
}

async function runTailscaleCommand(
  cliPath: string,
  args: readonly string[],
): Promise<TailscaleCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cliPath, [...args], {
      encoding: "utf8",
      timeout: TAILSCALE_CLI_TIMEOUT_MS,
      maxBuffer: TAILSCALE_CLI_MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    return { kind: "ran", code: 0, stdout, stderr };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    if (error.code === "ENOENT") return { kind: "not-found" };
    if (typeof error.code === "number") {
      return {
        kind: "ran",
        code: error.code,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      };
    }
    return { kind: "failed", detail: error.message };
  }
}

/** Trim CLI output to what a person can read, without rewording it. */
function cliDetail(...candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed.length > 0) return trimmed.slice(0, TAILSCALE_DETAIL_MAX_CHARS);
  }
  return null;
}

function environmentOf(
  partial: Partial<TailscaleEnvironment> & Pick<TailscaleEnvironment, "state">,
): TailscaleEnvironment {
  return Object.freeze({
    state: partial.state,
    cliPath: partial.cliPath ?? null,
    login: partial.login ?? null,
    dnsName: partial.dnsName ?? null,
    tailnetName: partial.tailnetName ?? null,
    serveConfigured: partial.serveConfigured === true,
    serveTargetPort: partial.serveTargetPort ?? null,
    detail: partial.detail ?? null,
  });
}

function selfDnsName(status: Record<string, unknown>): string | null {
  const self = status.Self;
  if (!isRecord(self) || typeof self.DNSName !== "string") return null;
  const name = self.DNSName.replace(/\.$/, "");
  return name.length === 0 ? null : name;
}

function selfLogin(status: Record<string, unknown>): string | null {
  const self = status.Self;
  const users = status.User;
  if (!isRecord(self) || !isRecord(users)) return null;
  const userId = self.UserID;
  if (typeof userId !== "number" && typeof userId !== "string") return null;
  const user = users[String(userId)];
  if (!isRecord(user) || typeof user.LoginName !== "string" || user.LoginName.length === 0) {
    return null;
  }
  return user.LoginName;
}

function currentTailnetName(status: Record<string, unknown>): string | null {
  const tailnet = status.CurrentTailnet;
  if (!isRecord(tailnet) || typeof tailnet.Name !== "string" || tailnet.Name.length === 0) {
    return null;
  }
  return tailnet.Name;
}

function loopbackProxyPort(proxy: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(proxy);
  } catch {
    return null;
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return null;
  const port = Number(parsed.port);
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

/** What `tailscale serve status --json` says about the web handlers in place. */
function readServeStatus(raw: unknown): { configured: boolean; targetPort: number | null } {
  if (!isRecord(raw) || !isRecord(raw.Web)) return { configured: false, targetPort: null };
  let configured = false;
  for (const hostPort of Object.values(raw.Web)) {
    if (!isRecord(hostPort) || !isRecord(hostPort.Handlers)) continue;
    for (const handler of Object.values(hostPort.Handlers)) {
      if (!isRecord(handler)) continue;
      configured = true;
      if (typeof handler.Proxy !== "string") continue;
      const port = loopbackProxyPort(handler.Proxy);
      if (port !== null) return { configured: true, targetPort: port };
    }
  }
  return { configured, targetPort: null };
}

/**
 * Read this desktop's own Tailscale state.
 *
 * Every outcome is a named state. There is no reading that invents a tailnet
 * name, a MagicDNS name, or a port when the CLI did not supply one — those are
 * exactly the values the old flow asked a person to retype, and a guess here
 * would fail later at the remote end with a bare 401.
 */
export async function probeTailscaleEnvironment(options: {
  readonly runCommand?: TailscaleCommandRunner;
  readonly platform?: NodeJS.Platform;
} = {}): Promise<TailscaleEnvironment> {
  const run = options.runCommand ?? runTailscaleCommand;
  const cliPath = tailscaleCliPath(options.platform ?? hostPlatform);

  const status = await run(cliPath, ["status", "--json"]);
  if (status.kind === "not-found") return environmentOf({ state: "cli-not-found" });
  if (status.kind === "failed") {
    return environmentOf({ state: "cli-failed", cliPath, detail: cliDetail(status.detail) });
  }
  if (status.code !== 0) {
    return environmentOf({
      state: "cli-failed",
      cliPath,
      detail: cliDetail(status.stderr, status.stdout),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(status.stdout);
  } catch {
    return environmentOf({ state: "cli-failed", cliPath, detail: cliDetail(status.stdout) });
  }
  if (!isRecord(parsed)) {
    return environmentOf({ state: "cli-failed", cliPath, detail: cliDetail(status.stdout) });
  }

  const backendState = typeof parsed.BackendState === "string" ? parsed.BackendState : "";
  if (backendState === "NeedsLogin" || backendState === "NoState") {
    return environmentOf({ state: "logged-out", cliPath });
  }
  if (backendState !== "Running") {
    return environmentOf({ state: "stopped", cliPath, detail: cliDetail(backendState) });
  }

  const serve = await run(cliPath, ["serve", "status", "--json"]);
  let serveStatus = { configured: false, targetPort: null as number | null };
  if (serve.kind === "ran" && serve.code === 0) {
    try {
      serveStatus = readServeStatus(JSON.parse(serve.stdout));
    } catch {
      // Serve reports "nothing configured" as output this app cannot parse on
      // some versions. That is not a reason to call the node unusable, and it
      // stays visible: `serveConfigured` remains false until Serve says so.
      serveStatus = { configured: false, targetPort: null };
    }
  }

  return environmentOf({
    state: "ready",
    cliPath,
    login: selfLogin(parsed),
    dnsName: selfDnsName(parsed),
    tailnetName: currentTailnetName(parsed),
    serveConfigured: serveStatus.configured,
    serveTargetPort: serveStatus.targetPort,
  });
}

/**
 * The origin a MagicDNS name implies.
 *
 * Derived, never typed: an origin that does not match the name Tailscale serves
 * fails as `403 same-origin-required` at the remote browser, with nothing on
 * the desktop saying why.
 */
export function tailnetWebOriginFor(dnsName: string | null): string | null {
  if (dnsName === null) return null;
  const origin = "https://" + dnsName;
  return isTailnetWebOrigin(origin) ? origin : null;
}

/** The argv `tailscale serve` is run with — the single source of the shown command. */
function tailscaleServeArgs(port: number): readonly string[] {
  return ["serve", "--bg", "--https=443", "http://127.0.0.1:" + port];
}

function shellWord(value: string): string {
  return /[\s"'\\]/.test(value) ? JSON.stringify(value) : value;
}

/**
 * The command, as text, for the confirmation step that shows it before it runs.
 *
 * Built from the same argv the run uses, so the sentence on screen cannot drift
 * from what actually executes.
 */
export function tailscaleServeCommandText(cliPath: string, port: number): string {
  return [cliPath, ...tailscaleServeArgs(port)].map(shellWord).join(" ");
}

export type TailscaleServeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "cli-not-found" | "command-failed"; readonly output: string | null };

/**
 * Put a loopback port behind Tailscale Serve.
 *
 * Running a binary for the owner is a real capability, so the caller is
 * responsible for having shown this exact command and taken an approval first.
 * A failure returns what Tailscale printed rather than a classification of it:
 * the HTTPS-certificate case in particular needs Tailscale's own sentence.
 */
export async function configureTailscaleServe(options: {
  readonly cliPath: string;
  readonly port: number;
  readonly runCommand?: TailscaleCommandRunner;
}): Promise<TailscaleServeOutcome> {
  const run = options.runCommand ?? runTailscaleCommand;
  const result = await run(options.cliPath, tailscaleServeArgs(options.port));
  if (result.kind === "not-found") {
    return Object.freeze({ ok: false as const, reason: "cli-not-found" as const, output: null });
  }
  if (result.kind === "failed") {
    return Object.freeze({
      ok: false as const,
      reason: "command-failed" as const,
      output: cliDetail(result.detail),
    });
  }
  if (result.code !== 0) {
    return Object.freeze({
      ok: false as const,
      reason: "command-failed" as const,
      output: cliDetail(result.stderr, result.stdout),
    });
  }
  return Object.freeze({ ok: true as const });
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

/**
 * The raw-layer spelling of an authorization choice.
 *
 * The file and the environment are merged in one vocabulary of strings, so the
 * union has to survive a round trip through that vocabulary rather than get a
 * second, file-only representation the environment could not express.
 */
function authorizationLayerValue(authorization: TailnetAuthorization): string {
  return authorization.kind === "tailnet-identity"
    ? "tailnet-identity"
    : "app-capability:" + authorization.capability;
}

function parseAuthorizationLayerValue(raw: string | undefined): TailnetAuthorization {
  if (raw === "tailnet-identity") return Object.freeze({ kind: "tailnet-identity" as const });
  const capability = raw?.startsWith("app-capability:") === true
    ? raw.slice("app-capability:".length)
    : undefined;
  if (!isTailnetAppCapabilityKey(capability)) {
    throw new Error("tailnet-observer-authorization-missing-or-invalid");
  }
  return Object.freeze({ kind: "app-capability" as const, capability });
}
