/**
 * Settings keys the boot environment can also turn on.
 *
 * Every entry pairs a settings key with the environment variable the host
 * reads beside it — the resolvers are all `settings || env`. The settings side
 * is the one a packaged-app user can reach; the env side is what a launcher
 * script or a shell profile can force. When the two disagree the environment
 * wins, so a control that rendered only the saved value would be telling the
 * user something that is not true of the running app. The surfaces that render
 * these controls ask the host which variables are set and say so.
 *
 * Listing a gate here creates no behaviour. It records a pairing that already
 * exists inside the resolver that reads both, in one place a control surface
 * and a policy test can both read.
 */

export interface EnvBackedSetting {
  /** Dotted path into the settings object, as `updateSettings` nests it. */
  readonly settingsPath: string;
  readonly envVar: string;
  /** The exact environment value the resolver treats as ON. */
  readonly onValue: string;
}

export const ENV_BACKED_SETTINGS: readonly EnvBackedSetting[] = Object.freeze([
  // The loopback HTTP surface and the A2A route family on it are independently
  // opt-in: either one alone starts the server (`resolveLoopbackRouteFamilies`).
  { settingsPath: "system.localApiServer", envVar: "LVIS_LOCAL_API", onValue: "1" },
  { settingsPath: "features.a2aLoopbackServer", envVar: "LVIS_A2A", onValue: "1" },
  // Outbound routing and the receiver profile are two more separate gates
  // (`snapshotA2ARemoteGates`); neither widens the loopback family above.
  { settingsPath: "features.a2aRemoteRouting", envVar: "LVIS_A2A_REMOTE", onValue: "1" },
  {
    settingsPath: "features.a2aRemoteReceiver",
    envVar: "LVIS_A2A_REMOTE_RECEIVER",
    onValue: "1",
  },
  // Already has a control (Permissions → OS tool sandbox); it is here because
  // the same environment trap applies to it.
  { settingsPath: "features.osToolSandbox", envVar: "LVIS_SANDBOX_ENABLED", onValue: "1" },
].map((entry) => Object.freeze(entry)));

const KNOWN_PATHS: ReadonlySet<string> = Object.freeze(
  new Set(ENV_BACKED_SETTINGS.map((entry) => entry.settingsPath)),
);

/**
 * Which of the listed settings the environment is currently forcing ON.
 *
 * Only the exact ON value counts: an unrelated value leaves the setting in the
 * user's hands, which is what the resolvers do.
 */
export function envForcedSettingsPaths(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return Object.freeze(
    ENV_BACKED_SETTINGS
      .filter((entry) => env[entry.envVar] === entry.onValue)
      .map((entry) => entry.settingsPath),
  );
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
