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
  chooseObserverPort,
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
  type TailnetGuidedSetupResult,
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
  /**
   * Decide and start the whole recommended configuration in one operation.
   *
   * Everything the manual form asks for has one defensible answer for a
   * first-time owner, and the two that could differ per machine — the port and
   * the web origin — are things the host can read rather than ask about.
   */
  guidedSetup(): Promise<TailnetGuidedSetupResult>;
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
  /** @internal deterministic injection for tests. */
  readonly choosePort?: typeof chooseObserverPort;
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

function guidedFailure(error: string, output: string | null = null): TailnetGuidedSetupResult {
  return Object.freeze({ ok: false as const, error, output });
}

/**
 * The kebab-case code behind a rejected write or restart.
 *
 * The resolver refuses a configuration by throwing a named code, and every one
 * of them already has a sentence on the surface that asked. Anything else is a
 * host fault the owner cannot classify, and gets the generic code rather than
 * an error message repeated verbatim.
 */
function guidedErrorCode(err: unknown): string {
  const code = err instanceof Error ? err.message : "";
  return /^[a-z0-9-]+$/.test(code) ? code : "tailnet-observer-write-failed";
}

/**
 * What guided setup writes.
 *
 * The identity boundary because the pairing code is what turns an identity into
 * a share and an app capability needs a tailnet administrator; paired sharing
 * and the web surface because they are what the owner came here for; the
 * controller off because accepting remote commands is a separate decision the
 * owner has not been asked to make. `webOrigin` is ignored downstream — it is
 * derived from MagicDNS — and is present only to satisfy the complete view.
 */
function recommendedConfig(port: number): TailnetObserverConfigView {
  return Object.freeze({
    enabled: true,
    authorization: { kind: "tailnet-identity" as const },
    port,
    controllerEnabled: false,
    pairedSharingEnabled: true,
    webEnabled: true,
    webOrigin: "",
  });
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
  const choosePort = options.choosePort ?? chooseObserverPort;

  const service: TailnetObserverConfigService = Object.freeze({
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

    async guidedSetup(): Promise<TailnetGuidedSetupResult> {
      const environment = await probeEnvironment();
      // Only `ready` can be set up. Every other state needs an action outside
      // this app — install, sign in, start the daemon — and the surface that
      // asked for this already knows the sentence for each one.
      if (environment.state !== "ready") {
        return guidedFailure("tailnet-guided-setup-not-ready");
      }

      // A damaged file is not a reason to refuse: this writes a whole
      // configuration over it, which is the same recovery the manual form
      // offers, so there is nothing in the old bytes worth failing for.
      let file: TailnetObserverConfigFile | null = null;
      try {
        file = await readConfigFile();
      } catch {
        file = null;
      }

      const preferred = file?.port ?? DEFAULT_TAILNET_OBSERVER_PORT;
      // A port this process is already listening on is not a conflict — the
      // restart below releases it — and probing it would move a working setup
      // to a new port every time the owner pressed the button.
      const port = runtimeState().listeningPort === preferred
        ? preferred
        : await choosePort(preferred);
      if (port === null) return guidedFailure("tailnet-guided-setup-port-unavailable");

      try {
        await writeConfigFile(
          proposalToFile(recommendedConfig(port), tailnetWebOriginFor(environment.dnsName)),
        );
        await restartListener();
      } catch (err) {
        return guidedFailure(guidedErrorCode(err));
      }

      // Serve already pointing at this exact port is the finished state, not a
      // reason to run a command: re-running it is harmless but asks Tailscale
      // for a certificate the owner may not be able to obtain.
      let serve: "configured" | "already-configured" = "already-configured";
      if (!(environment.serveConfigured && environment.serveTargetPort === port)) {
        const outcome = await service.configureServe();
        if (!outcome.ok) return guidedFailure(outcome.error, outcome.output);
        serve = "configured";
      }

      const snapshot = await service.snapshot();
      return Object.freeze({
        ok: true as const,
        snapshot,
        webOrigin: snapshot.derivedWebOrigin,
        port,
        serve,
      });
    },
  });

  return service;
}
