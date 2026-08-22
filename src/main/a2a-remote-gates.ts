import type { SettingsService } from "../data/settings-store.js";
import { resolveEnvBackedBoolean } from "../shared/env-backed-settings.js";

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
  // Same rule, same registry, same fail-closed `=== true` as the loopback
  // gates in local-api-server.ts — see resolveLoopbackRouteFamilies.
  return Object.freeze({
    outboundRouting: resolveEnvBackedBoolean(
      "features.a2aRemoteRouting",
      features?.a2aRemoteRouting === true,
      env,
      false,
    ),
    receiverProfile: resolveEnvBackedBoolean(
      "features.a2aRemoteReceiver",
      features?.a2aRemoteReceiver === true,
      env,
      false,
    ),
  });
}
