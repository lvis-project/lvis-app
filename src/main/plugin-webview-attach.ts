/**
 * Main-process enforcement of the plugin `<webview>`'s security preferences.
 *
 * The renderer sets `webpreferences="contextIsolation=yes,nodeIntegration=no,
 * sandbox=yes"` on the element. That is a REQUEST. Until this guard existed it
 * was also the only control, and it has two failure modes that produce no
 * error at all:
 *
 *  - it is a string. A mistyped key or value is ignored by Electron and the
 *    preference silently falls back to its default. Nothing logs, nothing
 *    throws, and the plugin frame comes up weaker than the attribute claims.
 *  - it is a DOM attribute in the host renderer, so it is only as trustworthy
 *    as the host renderer. Code running there can rewrite it before attach.
 *
 * The side-browser webview never depended on the attribute: its attach handler
 * overwrites the preferences in main. Plugin partitions took the early
 * `"ignored"` return from that handler and so had no equivalent — the pattern
 * existed, it just did not cover the frame that hosts third-party code.
 *
 * Overwrites rather than validates. Rejecting a bad request would leave the
 * decision with the caller; setting the value means the answer does not depend
 * on what was asked for.
 */
import { isPluginPartitionName } from "../shared/plugin-partition.js";

export type PluginWebviewAttachResult = "ignored" | "enforced";

export function configurePluginWebviewAttach(input: {
  webPreferences: Record<string, unknown>;
  params: Record<string, string>;
}): PluginWebviewAttachResult {
  if (!isPluginPartitionName(input.params.partition ?? "")) return "ignored";

  // Node reachability, in every form it comes in. `nodeIntegration` alone
  // leaves workers and subframes, which are separate preferences.
  input.webPreferences.nodeIntegration = false;
  input.webPreferences.nodeIntegrationInWorker = false;
  input.webPreferences.nodeIntegrationInSubFrames = false;

  // The isolated world is what keeps the plugin's page scripts away from the
  // `lvisPlugin` bridge object and its closure over `ipcRenderer`.
  input.webPreferences.contextIsolation = true;
  input.webPreferences.sandbox = true;
  input.webPreferences.webSecurity = true;

  // A plugin frame has no business embedding further guest views; allowing it
  // would let a plugin attach a webview whose preferences this guard has no
  // handler for.
  input.webPreferences.webviewTag = false;

  return "enforced";
}
