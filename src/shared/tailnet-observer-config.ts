/**
 * Shared vocabulary for the local-owner Tailnet observer configuration surface.
 *
 * The observer used to be configurable only through boot environment
 * variables, which a packaged app has no way to set — the capability existed
 * and no user could reach it. This is the contract that lets the Settings tab
 * read and propose that configuration without becoming a way for a webpage to
 * widen Tailnet policy: every mutation still crosses the host, carries a fresh
 * local keyboard intent, and is persisted to a host-owned file rather than to
 * the renderer-writable settings store.
 */

import { isRecord } from "./is-record.js";

/** Where a key's effective value came from. */
type TailnetObserverConfigSourceView = "file" | "env-override" | "unset";

export const TAILNET_OBSERVER_CONFIG_KEYS = [
  "enabled",
  "expectedAppCapability",
  "port",
  "controllerEnabled",
  "pairedSharingEnabled",
  "webEnabled",
  "webOrigin",
] as const;

export type TailnetObserverConfigKeyView = (typeof TAILNET_OBSERVER_CONFIG_KEYS)[number];

/**
 * A complete configuration with defaults filled in.
 *
 * Unset strings are `""` rather than absent: this crosses an IPC boundary into
 * form state, and a field that is sometimes missing is a field every consumer
 * has to re-decide the default for.
 */
export interface TailnetObserverConfigView {
  readonly enabled: boolean;
  readonly expectedAppCapability: string;
  readonly port: number;
  readonly controllerEnabled: boolean;
  readonly pairedSharingEnabled: boolean;
  readonly webEnabled: boolean;
  readonly webOrigin: string;
}

/**
 * What this desktop's Tailscale install actually says about itself.
 *
 * Every one of these values used to be something the person had to read out of
 * a terminal or an admin console and retype into this app, which is precisely
 * where the setup went wrong without telling anyone. Each state is named: there
 * is no "assume it is fine" reading, and no invented tailnet or MagicDNS name.
 */
const TAILSCALE_ENVIRONMENT_STATES = [
  /** The node is up, signed in, and answering. */
  "ready",
  /** Tailscale is installed but this node has no login. */
  "logged-out",
  /** Tailscale is installed and logged in, but the backend is not running. */
  "stopped",
  /** No Tailscale CLI on this desktop. */
  "cli-not-found",
  /** The CLI ran and did not answer with a status this app can read. */
  "cli-failed",
] as const;

type TailscaleEnvironmentState = (typeof TAILSCALE_ENVIRONMENT_STATES)[number];

export interface TailscaleEnvironmentView {
  readonly state: TailscaleEnvironmentState;
  /** The Tailscale account this node is signed in as, when it is signed in. */
  readonly login: string | null;
  /** This node's MagicDNS name without the trailing dot, or null when it has none. */
  readonly dnsName: string | null;
  readonly tailnetName: string | null;
  /** Whether `tailscale serve` already fronts something on this node. */
  readonly serveConfigured: boolean;
  /** The loopback port Serve forwards to, when it forwards to one. */
  readonly serveTargetPort: number | null;
  /**
   * What the CLI printed when it could not answer.
   *
   * Carried verbatim on purpose: "Tailscale said no" with the sentence removed
   * is the failure this surface exists to end.
   */
  readonly detail: string | null;
}

export interface TailnetObserverSnapshot {
  /** What the host-owned file holds, defaults filled in. */
  readonly saved: TailnetObserverConfigView;
  /** File plus environment overrides — what the next boot would resolve. */
  readonly effective: TailnetObserverConfigView;
  readonly provenance: Readonly<
    Record<TailnetObserverConfigKeyView, TailnetObserverConfigSourceView>
  >;
  /** The port the listener actually bound, or null when nothing is listening. */
  readonly listeningPort: number | null;
  /** Kebab-case code of the last failed start, or null. */
  readonly lastStartError: string | null;
  /** Whether paired-sharing setup failed at boot, leaving owner controls off. */
  readonly pairedSharingBootstrapFailed: boolean;
  /** What this desktop's Tailscale install says about itself. */
  readonly environment: TailscaleEnvironmentView;
  /** The web origin derived from this node's MagicDNS name; never typed in. */
  readonly derivedWebOrigin: string | null;
  /**
   * The exact `tailscale serve` command this app would run, or null when there
   * is nothing to put behind Serve yet. Shown before it runs, never after.
   */
  readonly serveCommand: string | null;
  /**
   * Named reason the saved configuration could not be read, or null.
   *
   * A damaged file used to make the whole surface fail, leaving a Refresh
   * button and no way to save over it. The reason is reported instead, and the
   * form stays reachable so the owner can write a good configuration on top.
   */
  readonly configFileError: string | null;
}

type TailnetObserverErrorCode =
  | "tailnet-observer-unavailable"
  | "tailnet-observer-input-invalid"
  | "tailnet-observer-keyboard-intent-required"
  | "tailnet-observer-unauthorized"
  | "tailnet-observer-write-failed"
  | (string & {});

export type TailnetObserverSnapshotResult =
  | { readonly ok: true; readonly snapshot: TailnetObserverSnapshot }
  | { readonly ok: false; readonly error: TailnetObserverErrorCode };

export type TailnetObserverMutationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: TailnetObserverErrorCode };

/**
 * The outcome of running `tailscale serve` on the owner's behalf.
 *
 * Success hands back the reachable URL so nobody has to assemble it. Failure
 * carries what the command printed, because "could not be completed" is what
 * made the terminal unavoidable in the first place.
 */
export type TailnetServeResult =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly error: TailnetObserverErrorCode;
      readonly output: string | null;
    };

/** The private `window.lvisApi.tailnetObserver` namespace. */
export interface TailnetObserverConfigApi {
  snapshot(): Promise<TailnetObserverSnapshotResult>;
  apply(config: TailnetObserverConfigView): Promise<TailnetObserverMutationResult>;
  /** Put the running listener behind Tailscale Serve, after the owner approved the command. */
  configureServe(): Promise<TailnetServeResult>;
}

export const DEFAULT_TAILNET_OBSERVER_VIEW_PORT = 46_173;

/** Validate a config view crossing a trust boundary in either direction. */
export function parseTailnetObserverConfigView(
  value: unknown,
): TailnetObserverConfigView | null {
  if (!isRecord(value)) return null;
  const {
    enabled,
    expectedAppCapability,
    port,
    controllerEnabled,
    pairedSharingEnabled,
    webEnabled,
    webOrigin,
  } = value;
  if (
    typeof enabled !== "boolean"
    || typeof controllerEnabled !== "boolean"
    || typeof pairedSharingEnabled !== "boolean"
    || typeof webEnabled !== "boolean"
    || typeof expectedAppCapability !== "string"
    || typeof webOrigin !== "string"
    || typeof port !== "number"
    || !Number.isSafeInteger(port)
  ) {
    return null;
  }
  return Object.freeze({
    enabled,
    expectedAppCapability,
    port,
    controllerEnabled,
    pairedSharingEnabled,
    webEnabled,
    webOrigin,
  });
}

function parseProvenance(
  value: unknown,
): TailnetObserverSnapshot["provenance"] | null {
  if (!isRecord(value)) return null;
  const provenance = {} as Record<
    TailnetObserverConfigKeyView,
    TailnetObserverConfigSourceView
  >;
  for (const key of TAILNET_OBSERVER_CONFIG_KEYS) {
    const source = value[key];
    if (source !== "file" && source !== "env-override" && source !== "unset") return null;
    provenance[key] = source;
  }
  return Object.freeze(provenance);
}

function isOptionalPort(value: unknown): value is number | null {
  return value === null
    || (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65_535);
}

function isOptionalText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseTailscaleEnvironmentView(
  value: unknown,
): TailscaleEnvironmentView | null {
  if (!isRecord(value)) return null;
  const { state, login, dnsName, tailnetName, serveConfigured, serveTargetPort, detail } = value;
  if (
    typeof state !== "string"
    || !(TAILSCALE_ENVIRONMENT_STATES as readonly string[]).includes(state)
    || !isOptionalText(login)
    || !isOptionalText(dnsName)
    || !isOptionalText(tailnetName)
    || typeof serveConfigured !== "boolean"
    || !isOptionalPort(serveTargetPort)
    || !isOptionalText(detail)
  ) {
    return null;
  }
  return Object.freeze({
    state: state as TailscaleEnvironmentState,
    login,
    dnsName,
    tailnetName,
    serveConfigured,
    serveTargetPort,
    detail,
  });
}

export function parseTailnetObserverSnapshot(
  value: unknown,
): TailnetObserverSnapshot | null {
  if (!isRecord(value)) return null;
  const saved = parseTailnetObserverConfigView(value.saved);
  const effective = parseTailnetObserverConfigView(value.effective);
  const provenance = parseProvenance(value.provenance);
  const environment = parseTailscaleEnvironmentView(value.environment);
  const {
    listeningPort,
    lastStartError,
    pairedSharingBootstrapFailed,
    derivedWebOrigin,
    serveCommand,
    configFileError,
  } = value;
  if (
    saved === null
    || effective === null
    || provenance === null
    || environment === null
    || !(listeningPort === null || (typeof listeningPort === "number" && Number.isSafeInteger(listeningPort)))
    || !isOptionalText(lastStartError)
    || typeof pairedSharingBootstrapFailed !== "boolean"
    || !isOptionalText(derivedWebOrigin)
    || !isOptionalText(serveCommand)
    || !isOptionalText(configFileError)
  ) {
    return null;
  }
  return Object.freeze({
    saved,
    effective,
    provenance,
    listeningPort,
    lastStartError,
    pairedSharingBootstrapFailed,
    environment,
    derivedWebOrigin,
    serveCommand,
    configFileError,
  });
}

export function parseTailnetObserverSnapshotResult(
  value: unknown,
): TailnetObserverSnapshotResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) {
    const snapshot = parseTailnetObserverSnapshot(value.snapshot);
    return snapshot === null ? null : Object.freeze({ ok: true as const, snapshot });
  }
  if (value.ok === false && typeof value.error === "string") {
    return Object.freeze({ ok: false as const, error: value.error });
  }
  return null;
}

export function parseTailnetObserverMutationResult(
  value: unknown,
): TailnetObserverMutationResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) return Object.freeze({ ok: true as const });
  if (value.ok === false && typeof value.error === "string") {
    return Object.freeze({ ok: false as const, error: value.error });
  }
  return null;
}

export function parseTailnetServeResult(value: unknown): TailnetServeResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) {
    return typeof value.url === "string" && value.url.length > 0
      ? Object.freeze({ ok: true as const, url: value.url })
      : null;
  }
  // A gate that rejected before the command was reached — an unauthorized
  // frame, a missing keyboard intent — has no command output to carry. That is
  // a valid failure with `output: null`, not an unparseable one.
  const output = value.output === undefined ? null : value.output;
  if (value.ok === false && typeof value.error === "string" && isOptionalText(output)) {
    return Object.freeze({ ok: false as const, error: value.error, output });
  }
  return null;
}
