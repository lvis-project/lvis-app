import type { SettingsService } from "../data/settings-store.js";

export interface A2ARemoteGateSnapshot {
  outboundRouting: boolean;
  receiverProfile: boolean;
}

/** Boot-only immutable snapshot; neither gate widens the ph3 loopback gate. */
export function snapshotA2ARemoteGates(
  settings: Pick<SettingsService, "get">,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<A2ARemoteGateSnapshot> {
  const features = settings.get("features");
  return Object.freeze({
    outboundRouting: features?.a2aRemoteRouting === true || env.LVIS_A2A_REMOTE === "1",
    receiverProfile: features?.a2aRemoteReceiver === true || env.LVIS_A2A_REMOTE_RECEIVER === "1",
  });
}
