/**
 * Host-owned read/write service for the Tailnet observer configuration.
 *
 * The renderer proposes; this decides. Every proposal is re-validated through
 * the same resolver the boot path uses and persisted to `~/.lvis/tailnet/`,
 * never to the settings store — the capability key must stay a value a webpage
 * cannot set, which was the property the env-only resolver was protecting.
 */
import {
  DEFAULT_TAILNET_OBSERVER_PORT,
  getTailnetObserverRuntimeState,
  loadTailnetObserverConfig,
  readTailnetObserverConfigFile,
  writeTailnetObserverConfigFile,
  type TailnetObserverConfigFile,
  type TailnetObserverResolution,
} from "./tailnet-surface-server.js";
import {
  DEFAULT_TAILNET_OBSERVER_VIEW_PORT,
  type TailnetObserverConfigView,
  type TailnetObserverSnapshot,
} from "../shared/tailnet-observer-config.js";

export interface TailnetObserverConfigService {
  snapshot(): Promise<TailnetObserverSnapshot>;
  apply(config: TailnetObserverConfigView): Promise<void>;
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
}

/** The file's own values with defaults filled in — never the merged result. */
function savedView(file: TailnetObserverConfigFile | null): TailnetObserverConfigView {
  return Object.freeze({
    enabled: file?.enabled === true,
    expectedAppCapability: file?.expectedAppCapability ?? "",
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
    expectedAppCapability: config.expectedAppCapability,
    port: config.port,
    controllerEnabled: config.controllerEnabled,
    pairedSharingEnabled: config.pairedSharingEnabled,
    webEnabled: config.webOrigin !== undefined,
    webOrigin: config.webOrigin ?? "",
  });
}

/**
 * Whether the running listener reflects the saved configuration.
 *
 * Compared against what the resolver would produce now, not against the file
 * alone: an environment override is part of what the next boot will do, and a
 * surface that ignored it would report "up to date" for a process that is not.
 */
function restartRequired(
  effective: TailnetObserverConfigView,
  listeningPort: number | null,
  active: ReturnType<typeof getTailnetObserverRuntimeState>["activeConfig"],
): boolean {
  if (!effective.enabled) return listeningPort !== null;
  if (active === null || listeningPort === null) return true;
  return active.port !== effective.port
    || active.expectedAppCapability !== effective.expectedAppCapability
    || active.controllerEnabled !== effective.controllerEnabled
    || active.pairedSharingEnabled !== effective.pairedSharingEnabled
    || (active.webOrigin ?? "") !== effective.webOrigin;
}

/**
 * Project a proposal onto the file schema.
 *
 * `false` and `""` become absent keys rather than persisted negatives, so the
 * file says only what was chosen — the same rule the resolver applies when it
 * projects the file onto the environment's vocabulary.
 */
function proposalToFile(config: TailnetObserverConfigView): TailnetObserverConfigFile {
  return {
    ...(config.enabled ? { enabled: true } : {}),
    ...(config.expectedAppCapability === ""
      ? {}
      : { expectedAppCapability: config.expectedAppCapability }),
    ...(config.port === DEFAULT_TAILNET_OBSERVER_PORT ? {} : { port: config.port }),
    ...(config.controllerEnabled ? { controllerEnabled: true } : {}),
    ...(config.pairedSharingEnabled ? { pairedSharingEnabled: true } : {}),
    ...(config.webEnabled ? { webEnabled: true } : {}),
    ...(config.webOrigin === "" ? {} : { webOrigin: config.webOrigin }),
  };
}

export function createTailnetObserverConfigService(
  options: TailnetObserverConfigServiceOptions,
): TailnetObserverConfigService {
  const readConfigFile = options.readConfigFile ?? (() => readTailnetObserverConfigFile());
  const writeConfigFile = options.writeConfigFile
    ?? ((file: TailnetObserverConfigFile) => writeTailnetObserverConfigFile(file));
  const runtimeState = options.runtimeState ?? getTailnetObserverRuntimeState;

  return Object.freeze({
    async snapshot(): Promise<TailnetObserverSnapshot> {
      const file = await readConfigFile();
      const saved = savedView(file);
      const resolution = await loadTailnetObserverConfig({
        ...(options.env === undefined ? {} : { env: options.env }),
        readConfigFile: async () => file,
      });
      const effective = effectiveView(resolution, saved);
      const state = runtimeState();
      return Object.freeze({
        saved,
        effective,
        provenance: resolution.provenance,
        listeningPort: state.listeningPort,
        lastStartError: state.lastStartError,
        restartRequired: restartRequired(effective, state.listeningPort, state.activeConfig),
        pairedSharingBootstrapFailed: options.pairedSharingBootstrapFailed(),
      });
    },

    async apply(config: TailnetObserverConfigView): Promise<void> {
      await writeConfigFile(proposalToFile(config));
    },
  });
}
