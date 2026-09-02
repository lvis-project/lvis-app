/**
 * Host-owned read/write service for the Tailnet observer configuration.
 *
 * The renderer proposes; this decides. Every proposal is re-validated through
 * the same resolver the boot path uses and persisted to `~/.lvis/tailnet/`,
 * never to the settings store — the authorization boundary must stay a value a
 * webpage cannot set, which was the property the env-only resolver was
 * protecting.
 */
import {
  configureTailscaleServe,
  DEFAULT_TAILNET_OBSERVER_PORT,
  getTailnetObserverRuntimeState,
  loadTailnetObserverConfig,
  probeTailscaleEnvironment,
  readTailnetObserverConfigFile,
  restartTailnetObserverServer,
  tailnetWebOriginFor,
  tailscaleServeCommandText,
  writeTailnetObserverConfigFile,
  type TailnetObserverConfigFile,
  type TailnetObserverResolution,
  type TailscaleEnvironment,
} from "./tailnet-surface-server.js";
import {
  DEFAULT_TAILNET_OBSERVER_VIEW_PORT,
  type TailnetObserverConfigView,
  type TailnetObserverSnapshot,
  type TailnetServeResult,
  type TailscaleEnvironmentView,
} from "../shared/tailnet-observer-config.js";

export interface TailnetObserverConfigService {
  snapshot(): Promise<TailnetObserverSnapshot>;
  apply(config: TailnetObserverConfigView): Promise<void>;
  /** Run the Serve command the owner has just been shown and approved. */
  configureServe(): Promise<TailnetServeResult>;
}

export interface TailnetObserverConfigServiceOptions {
  /** Boot already knows whether paired-sharing setup failed; it cannot be re-derived. */
  readonly pairedSharingBootstrapFailed: () => boolean;
  /** @internal deterministic injection for tests. */
  readonly readConfigFile?: () => Promise<TailnetObserverConfigFile | null>;
  /** @internal deterministic injection for tests. */
  readonly writeConfigFile?: (file: TailnetObserverConfigFile) => Promise<void>;
  /** @internal deterministic injection for tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** @internal deterministic injection for tests. */
  readonly runtimeState?: typeof getTailnetObserverRuntimeState;
  /** @internal deterministic injection for tests. */
  readonly probeEnvironment?: () => Promise<TailscaleEnvironment>;
  /** @internal deterministic injection for tests. */
  readonly restartListener?: () => Promise<unknown>;
  /** @internal deterministic injection for tests. */
  readonly runServe?: typeof configureTailscaleServe;
}

/**
 * The file's own values with defaults filled in — never the merged result.
 *
 * A file that names no authorization gets the identity boundary here because
 * that is what the form offers first, not because the resolver would accept
 * the omission: `provenance.authorization` still reports `unset`, and enabling
 * the listener from such a file is refused until a choice is actually saved.
 */
function savedView(file: TailnetObserverConfigFile | null): TailnetObserverConfigView {
  return Object.freeze({
    enabled: file?.enabled === true,
    authorization: file?.authorization ?? { kind: "tailnet-identity" as const },
    port: file?.port ?? DEFAULT_TAILNET_OBSERVER_VIEW_PORT,
    controllerEnabled: file?.controllerEnabled === true,
    pairedSharingEnabled: file?.pairedSharingEnabled === true,
    webEnabled: file?.webEnabled === true,
    webOrigin: file?.webOrigin ?? "",
  });
}

/**
 * The resolved configuration as a view.
 *
 * A resolution of `null` is not an absence of information — it is the observer
 * being OFF — so it flattens to a disabled view rather than to nothing.
 */
function effectiveView(
  resolution: TailnetObserverResolution,
  saved: TailnetObserverConfigView,
): TailnetObserverConfigView {
  const config = resolution.config;
  if (config === null) {
    return Object.freeze({ ...saved, enabled: false });
  }
  return Object.freeze({
    enabled: true,
    authorization: config.authorization,
    port: config.port,
    controllerEnabled: config.controllerEnabled,
    pairedSharingEnabled: config.pairedSharingEnabled,
    webEnabled: config.webOrigin !== undefined,
    webOrigin: config.webOrigin ?? "",
  });
}

/**
 * Project a proposal onto the file schema.
 *
 * `false` and `""` become absent keys rather than persisted negatives, so the
 * file says only what was chosen — the same rule the resolver applies when it
 * projects the file onto the environment's vocabulary.
 *
 * `webOrigin` is not taken from the proposal. It is derived from the MagicDNS
 * name this desktop reports, because an origin retyped by hand is a value that
 * can disagree with the name Tailscale actually serves, and that disagreement
 * shows up as a bare `403` in a remote browser with nothing here to explain it.
 */
function proposalToFile(
  config: TailnetObserverConfigView,
  derivedWebOrigin: string | null,
): TailnetObserverConfigFile {
  if (config.webEnabled && derivedWebOrigin === null) {
    throw new Error("tailnet-web-origin-underivable");
  }
  const web = config.webEnabled && derivedWebOrigin !== null
    ? { webEnabled: true, webOrigin: derivedWebOrigin }
    : {};
  return {
    ...(config.enabled ? { enabled: true } : {}),
    // Authorization is always a chosen value, never a negative: the form has no
    // "no boundary" position, so persisting it is persisting what was picked.
    authorization: config.authorization,
    ...(config.port === DEFAULT_TAILNET_OBSERVER_PORT ? {} : { port: config.port }),
    ...(config.controllerEnabled ? { controllerEnabled: true } : {}),
    ...(config.pairedSharingEnabled ? { pairedSharingEnabled: true } : {}),
    ...web,
  };
}

/** Drop the CLI path: the renderer sees the command, never a bare binary path. */
function environmentView(environment: TailscaleEnvironment): TailscaleEnvironmentView {
  return Object.freeze({
    state: environment.state,
    login: environment.login,
    dnsName: environment.dnsName,
    tailnetName: environment.tailnetName,
    serveConfigured: environment.serveConfigured,
    serveTargetPort: environment.serveTargetPort,
    detail: environment.detail,
  });
}

function serveFailure(error: string, output: string | null): TailnetServeResult {
  return Object.freeze({ ok: false as const, error, output });
}

export function createTailnetObserverConfigService(
  options: TailnetObserverConfigServiceOptions,
): TailnetObserverConfigService {
  const readConfigFile = options.readConfigFile ?? (() => readTailnetObserverConfigFile());
  const writeConfigFile = options.writeConfigFile
    ?? ((file: TailnetObserverConfigFile) => writeTailnetObserverConfigFile(file));
  const runtimeState = options.runtimeState ?? getTailnetObserverRuntimeState;
  const probeEnvironment = options.probeEnvironment ?? (() => probeTailscaleEnvironment());
  const restartListener = options.restartListener ?? restartTailnetObserverServer;
  const runServe = options.runServe ?? configureTailscaleServe;

  return Object.freeze({
    async snapshot(): Promise<TailnetObserverSnapshot> {
      // A damaged file is reported, not thrown. Throwing left the section with
      // a Refresh button and no draft, so the one action that would have fixed
      // it — saving a good configuration over the bad bytes — was unreachable.
      let file: TailnetObserverConfigFile | null = null;
      let configFileError: string | null = null;
      try {
        file = await readConfigFile();
      } catch (err) {
        configFileError = err instanceof Error && /^[a-z0-9-]+$/.test(err.message)
          ? err.message
          : "tailnet-observer-config-file-unreadable";
      }
      const saved = savedView(file);
      const resolution = await loadTailnetObserverConfig({
        ...(options.env === undefined ? {} : { env: options.env }),
        readConfigFile: async () => file,
      });
      const effective = effectiveView(resolution, saved);
      const state = runtimeState();
      const environment = await probeEnvironment();
      return Object.freeze({
        saved,
        effective,
        provenance: resolution.provenance,
        listeningPort: state.listeningPort,
        lastStartError: state.lastStartError,
        pairedSharingBootstrapFailed: options.pairedSharingBootstrapFailed(),
        environment: environmentView(environment),
        derivedWebOrigin: tailnetWebOriginFor(environment.dnsName),
        serveCommand: environment.cliPath === null || state.listeningPort === null
          ? null
          : tailscaleServeCommandText(environment.cliPath, state.listeningPort),
        configFileError,
      });
    },

    async apply(config: TailnetObserverConfigView): Promise<void> {
      const environment = await probeEnvironment();
      await writeConfigFile(proposalToFile(config, tailnetWebOriginFor(environment.dnsName)));
      // The listener used to wait for the next launch, which is the step nobody
      // knew to take: a toggle that does nothing for an hour reads as broken.
      await restartListener();
    },

    async configureServe(): Promise<TailnetServeResult> {
      const { listeningPort } = runtimeState();
      if (listeningPort === null) return serveFailure("tailnet-serve-not-listening", null);
      const environment = await probeEnvironment();
      if (environment.state !== "ready" || environment.cliPath === null) {
        return serveFailure("tailnet-serve-tailscale-" + environment.state, environment.detail);
      }
      if (environment.dnsName === null) {
        return serveFailure("tailnet-serve-magic-dns-missing", null);
      }
      const outcome = await runServe({ cliPath: environment.cliPath, port: listeningPort });
      if (!outcome.ok) {
        return serveFailure("tailnet-serve-" + outcome.reason, outcome.output);
      }
      return Object.freeze({ ok: true as const, url: "https://" + environment.dnsName + "/" });
    },
  });
}
