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
  /**
   * Whether the running process reflects the saved configuration.
   *
   * The observer is started once per boot and its shutdown path is a latch, so
   * a change applies at the next launch. Saying so is the whole point of this
   * field: a toggle that silently does nothing until relaunch is the failure
   * this surface exists to end.
   */
  readonly restartRequired: boolean;
  /** Whether paired-sharing setup failed at boot, leaving owner controls off. */
  readonly pairedSharingBootstrapFailed: boolean;
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

/** The private `window.lvisApi.tailnetObserver` namespace. */
export interface TailnetObserverConfigApi {
  snapshot(): Promise<TailnetObserverSnapshotResult>;
  apply(config: TailnetObserverConfigView): Promise<TailnetObserverMutationResult>;
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

export function parseTailnetObserverSnapshot(
  value: unknown,
): TailnetObserverSnapshot | null {
  if (!isRecord(value)) return null;
  const saved = parseTailnetObserverConfigView(value.saved);
  const effective = parseTailnetObserverConfigView(value.effective);
  const provenance = parseProvenance(value.provenance);
  const { listeningPort, lastStartError, restartRequired, pairedSharingBootstrapFailed } = value;
  if (
    saved === null
    || effective === null
    || provenance === null
    || !(listeningPort === null || (typeof listeningPort === "number" && Number.isSafeInteger(listeningPort)))
    || !(lastStartError === null || typeof lastStartError === "string")
    || typeof restartRequired !== "boolean"
    || typeof pairedSharingBootstrapFailed !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({
    saved,
    effective,
    provenance,
    listeningPort,
    lastStartError,
    restartRequired,
    pairedSharingBootstrapFailed,
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
