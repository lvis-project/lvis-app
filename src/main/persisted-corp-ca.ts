/**
 * Boot-time read of the corporate root CA settings for this profile.
 *
 * The CA is injected into the TLS stack before `bootstrap()` runs — it has to
 * be, or the first outbound request goes without it — so, exactly like
 * {@link readPersistedHardwareAccelerationSync}, these values come straight off
 * the settings file rather than from `SettingsService`, which does not exist
 * yet. That is also why the controls say "next launch": nothing here can be
 * re-applied to a process that has already opened connections.
 *
 * Until these settings existed the three environment variables were the ONLY
 * way to configure any of it, and a packaged app is launched by double-clicking
 * it. On a machine whose corporate CA has a different common name, that meant
 * TLS failures with no reachable fix.
 */
import { resolveCorpCaConfig, type CorpCaConfig } from "../shared/corp-ca-config.js";
import {
  readPersistedSystemBooleanSync,
  readPersistedSystemStringSync,
} from "./persisted-settings-sync.js";

/** {@link resolveCorpCaConfig} against the settings file for this profile. */
export function readPersistedCorpCaConfigSync(
  userDataPath: string,
  env: NodeJS.ProcessEnv = process.env,
): CorpCaConfig {
  return resolveCorpCaConfig(
    {
      enabled: readPersistedSystemBooleanSync(userDataPath, "corpCaEnabled"),
      commonName: readPersistedSystemStringSync(userDataPath, "corpCaCommonName"),
      debugLog: readPersistedSystemBooleanSync(userDataPath, "corpCaDebugLog"),
    },
    env,
  );
}
