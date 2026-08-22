/**
 * Settings keys the boot environment can also decide.
 *
 * Every entry pairs a settings key with the environment variable the host
 * reads beside it. The settings side is the one a packaged-app user can reach;
 * the env side is what a launcher script or a shell profile can force. When
 * the two disagree the environment wins, so a control that rendered only the
 * saved value would be telling the user something that is not true of the
 * running app. The surfaces that render these controls ask the host which
 * variables are deciding and say so.
 *
 * The override is NOT always `settings || env`. Most of these variables can
 * only force a setting on, one can only force it off, and one decides in both
 * directions. Each entry therefore carries the rule itself as
 * {@link EnvBackedSetting.forcedValue} — and the resolver that reads the pair
 * calls that same function, so the two cannot drift into disagreeing about
 * what the environment is doing.
 */

export interface EnvBackedSetting {
  /** Dotted path into the settings object, as `updateSettings` nests it. */
  readonly settingsPath: string;
  readonly envVar: string;
  /**
   * What the environment forces this setting to, given the variable's current
   * value — or `undefined` when the environment leaves the decision to the
   * setting. `undefined` covers both "unset" and "set to something this gate
   * does not act on".
   */
  readonly forcedValue: (envValue: string | undefined) => boolean | undefined;
}

/**
 * The historical shape: one exact value turns the setting on, anything else
 * (including unset) leaves it to the saved value. `settings || env`.
 */
function forcesOnAt(onValue: string) {
  return (envValue: string | undefined): boolean | undefined =>
    envValue === onValue ? true : undefined;
}

/** Values of `LVIS_MARKETPLACE_UPDATE_CHECK` that turn the update check off. */
const UPDATE_CHECK_OFF_RE = /^(0|false)$/i;

/** Values of `LVIS_MARKETPLACE_USE_CACHE` that mean ON; anything else set means OFF. */
const USE_CACHE_ON_RE = /^(1|true|yes|on)$/i;

export const ENV_BACKED_SETTINGS: readonly EnvBackedSetting[] = Object.freeze([
  // The loopback HTTP surface and the A2A route family on it are independently
  // opt-in: either one alone starts the server (`resolveLoopbackRouteFamilies`).
  { settingsPath: "system.localApiServer", envVar: "LVIS_LOCAL_API", forcedValue: forcesOnAt("1") },
  { settingsPath: "features.a2aLoopbackServer", envVar: "LVIS_A2A", forcedValue: forcesOnAt("1") },
  // Outbound routing and the receiver profile are two more separate gates
  // (`snapshotA2ARemoteGates`); neither widens the loopback family above.
  { settingsPath: "features.a2aRemoteRouting", envVar: "LVIS_A2A_REMOTE", forcedValue: forcesOnAt("1") },
  {
    settingsPath: "features.a2aRemoteReceiver",
    envVar: "LVIS_A2A_REMOTE_RECEIVER",
    forcedValue: forcesOnAt("1"),
  },
  // Already has a control (Permissions → OS tool sandbox); it is here because
  // the same environment trap applies to it.
  { settingsPath: "features.osToolSandbox", envVar: "LVIS_SANDBOX_ENABLED", forcedValue: forcesOnAt("1") },
  // Chromium's GPU process. Read once, before `app.whenReady()`, so neither
  // side of this pair can change the running app — the control says "next
  // launch" for the same reason the resolver has to read the settings file
  // directly instead of asking SettingsService, which does not exist yet.
  { settingsPath: "system.hardwareAcceleration", envVar: "LVIS_KEEP_GPU", forcedValue: forcesOnAt("1") },
  // The marketplace pair. Neither of these is `settings || env`:
  //
  //   LVIS_MARKETPLACE_UPDATE_CHECK can only turn the check OFF — the host
  //   reads it as `(setting ?? true) && env`, so an ON value changes nothing
  //   and the setting still decides.
  //
  //   LVIS_MARKETPLACE_USE_CACHE decides in BOTH directions once it is set. It
  //   was the only control before the setting existed, and a deployment that
  //   pinned it keeps that pin rather than having a profile quietly override
  //   it.
  //
  // `isUpdateCheckEnabled` and `isOfflineCacheEnabled` call these functions, so
  // the rule the UI reports is the rule the host applies.
  {
    settingsPath: "marketplace.updateCheckEnabled",
    envVar: "LVIS_MARKETPLACE_UPDATE_CHECK",
    forcedValue: (envValue: string | undefined) =>
      envValue !== undefined && UPDATE_CHECK_OFF_RE.test(envValue) ? false : undefined,
  },
  {
    settingsPath: "marketplace.offlineCacheEnabled",
    envVar: "LVIS_MARKETPLACE_USE_CACHE",
    forcedValue: (envValue: string | undefined) =>
      envValue === undefined ? undefined : USE_CACHE_ON_RE.test(envValue.trim()),
  },
].map((entry) => Object.freeze(entry)));

const KNOWN_PATHS: ReadonlySet<string> = Object.freeze(
  new Set(ENV_BACKED_SETTINGS.map((entry) => entry.settingsPath)),
);

/**
 * Which of the listed settings the environment is currently deciding.
 *
 * A variable that is set but not to a value its gate acts on is NOT in this
 * list: the setting still decides there, which is what the resolvers do. The
 * DIRECTION is deliberately not in the payload — each control states what its
 * own variable does, because the three shapes read differently to a person and
 * one generic sentence would be wrong for two of them.
 */
export function envForcedSettingsPaths(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return Object.freeze(
    ENV_BACKED_SETTINGS
      .filter((entry) => entry.forcedValue(env[entry.envVar]) !== undefined)
      .map((entry) => entry.settingsPath),
  );
}

/**
 * What the environment forces `settingsPath` to right now, or `undefined` when
 * it is leaving that setting to the saved value. Resolvers call this instead of
 * re-deriving the rule from `process.env` themselves.
 */
export function envForcedValueForSettingsPath(
  settingsPath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  const entry = ENV_BACKED_SETTINGS.find((item) => item.settingsPath === settingsPath);
  if (entry === undefined) return undefined;
  return entry.forcedValue(env[entry.envVar]);
}

/** The variable a surface should name when it reports a forced setting. */
export function envVarForSettingsPath(settingsPath: string): string | null {
  return ENV_BACKED_SETTINGS.find((entry) => entry.settingsPath === settingsPath)?.envVar ?? null;
}

/**
 * Validate a forced-paths list arriving over IPC.
 *
 * The renderer decides what to tell the user from this, so an unrecognized
 * path is dropped rather than displayed: the list is a claim about keys this
 * build knows, and anything else is drift, not news.
 */
export function parseEnvForcedSettingsPaths(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const paths = value.filter(
    (item): item is string => typeof item === "string" && KNOWN_PATHS.has(item),
  );
  return Object.freeze(paths);
}
