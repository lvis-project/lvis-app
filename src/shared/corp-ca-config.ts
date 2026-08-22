/**
 * How the corporate root CA settings combine with the environment.
 *
 * Pure: no filesystem, no Electron. It sits in `shared/` because the boot-time
 * reader (`main/persisted-corp-ca.ts`) and the TLS runtime
 * (`main/corp-ca-runtime.ts`) both need the shape and the precedence rule, and
 * the runtime must not drag the settings-store module into the pre-boot path
 * just to learn what "enabled" means.
 */
import {
  envForcedBooleanForSettingsPath,
  envForcedStringForSettingsPath,
} from "./env-backed-settings.js";
import {
  DEFAULT_CORP_CA_COMMON_NAME,
  normalizeCorpCaCommonName,
} from "./corp-ca-common-name.js";

export interface CorpCaConfig {
  /** Whether to acquire and inject a corporate CA at all. */
  readonly enabled: boolean;
  /** The certificate common name to look for in the system trust store. */
  readonly commonName: string;
  /** Whether to log the paths that are skipped rather than staying silent. */
  readonly debugLog: boolean;
}

export interface CorpCaSettings {
  readonly enabled?: boolean;
  readonly commonName?: string;
  readonly debugLog?: boolean;
}

/**
 * Combine the persisted settings with the environment.
 *
 * The environment wins where it is set — `LVIS_SKIP_CORP_CA=1` still forces
 * the whole pipeline off, `LVIS_CORP_CA_DEBUG=1` still forces the logging on,
 * and `LVIS_CORP_CA_CN` still supplies the name — because those are what a
 * managed-deployment launcher script pins, and a profile must not quietly
 * override an MDM decision. Which way each one forces is declared once, in
 * ENV_BACKED_SETTINGS, so the notice the settings surface shows a user is
 * derived from the same rule this resolver applies.
 */
export function resolveCorpCaConfig(
  settings: CorpCaSettings = {},
  env: NodeJS.ProcessEnv = process.env,
): CorpCaConfig {
  const forcedEnabled = envForcedBooleanForSettingsPath("system.corpCaEnabled", env);
  const forcedDebug = envForcedBooleanForSettingsPath("system.corpCaDebugLog", env);
  const forcedName = envForcedStringForSettingsPath("system.corpCaCommonName", env);
  const commonName =
    normalizeCorpCaCommonName(forcedName)
    ?? normalizeCorpCaCommonName(settings.commonName)
    ?? DEFAULT_CORP_CA_COMMON_NAME;
  return {
    enabled: forcedEnabled ?? settings.enabled ?? true,
    commonName,
    debugLog: forcedDebug ?? settings.debugLog ?? false,
  };
}
