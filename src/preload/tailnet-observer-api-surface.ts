/**
 * Narrow host-renderer bridge for the local-owner Tailnet observer configuration.
 *
 * A leaf, like the sharing bridge: plugin frames and public surfaces never
 * receive it, and `apply` mints its own live keyboard intent here so a renderer
 * cannot replay or fabricate one.
 */
import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import {
  parseTailnetGuidedSetupResult,
  parseTailnetObserverMutationResult,
  parseTailnetObserverSnapshotResult,
  parseTailnetServeResult,
  type TailnetGuidedSetupResult,
  type TailnetObserverConfigApi,
  type TailnetObserverConfigView,
  type TailnetObserverMutationResult,
  type TailnetObserverSnapshotResult,
  type TailnetServeResult,
} from "../shared/tailnet-observer-config.js";
import { ipcUserKeyboardIntent } from "./gesture-intent.js";

function unavailableSnapshot(): TailnetObserverSnapshotResult {
  return Object.freeze({ ok: false, error: "tailnet-observer-unavailable" });
}

function unavailableMutation(): TailnetObserverMutationResult {
  return Object.freeze({ ok: false, error: "tailnet-observer-unavailable" });
}

function unavailableServe(): TailnetServeResult {
  return Object.freeze({ ok: false, error: "tailnet-observer-unavailable", output: null });
}

function unavailableGuidedSetup(): TailnetGuidedSetupResult {
  return Object.freeze({ ok: false, error: "tailnet-observer-unavailable" });
}

/** Build the private `window.lvisApi.tailnetObserver` namespace. */
export function buildTailnetObserverApiSurface(): TailnetObserverConfigApi {
  return Object.freeze({
    async snapshot(): Promise<TailnetObserverSnapshotResult> {
      try {
        return parseTailnetObserverSnapshotResult(
          await ipcRenderer.invoke(CHANNELS.tailnetObserver.snapshot),
        ) ?? unavailableSnapshot();
      } catch {
        return unavailableSnapshot();
      }
    },

    async apply(config: TailnetObserverConfigView): Promise<TailnetObserverMutationResult> {
      try {
        return parseTailnetObserverMutationResult(
          await ipcRenderer.invoke(CHANNELS.tailnetObserver.apply, {
            config,
            intent: ipcUserKeyboardIntent(),
          }),
        ) ?? unavailableMutation();
      } catch {
        return unavailableMutation();
      }
    },

    async configureServe(): Promise<TailnetServeResult> {
      try {
        return parseTailnetServeResult(
          await ipcRenderer.invoke(CHANNELS.tailnetObserver.configureServe, {
            intent: ipcUserKeyboardIntent(),
          }),
        ) ?? unavailableServe();
      } catch {
        return unavailableServe();
      }
    },

    async guidedSetup(): Promise<TailnetGuidedSetupResult> {
      try {
        return parseTailnetGuidedSetupResult(
          await ipcRenderer.invoke(CHANNELS.tailnetObserver.guidedSetup, {
            intent: ipcUserKeyboardIntent(),
          }),
        ) ?? unavailableGuidedSetup();
      } catch {
        return unavailableGuidedSetup();
      }
    },
  });
}
