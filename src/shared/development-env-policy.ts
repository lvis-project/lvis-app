/**
 * Canonical inventory of environment variables that are meaningful only for
 * source runs, tests, E2E, or developer diagnostics.
 *
 * Consumers have different jobs but share this inventory:
 * - the env-surface gate classifies the `LVIS_*` entries as development-only;
 * - packaged boot removes every entry before child processes inherit it.
 *
 * Keep retired names as explicit tombstones when an older launcher may still
 * provide them. A tombstone is never a compatibility path: it is scrubbed and
 * audited so a packaged build cannot revive removed development behaviour.
 */
export const DEVELOPMENT_ENV_POLICY = [
  { name: "LVIS_ADMISSION_OFFLINE", lifecycle: "active", packaged: "scrub" },
  // Removed development bypasses retained as one-way packaged scrub tombstones.
  { name: "LVIS_ALLOW_LINKED_PLUGIN_ENTRY", lifecycle: "tombstone", packaged: "scrub" },
  { name: "LVIS_ALLOW_TEST_MARKETPLACE_KEYS", lifecycle: "tombstone", packaged: "scrub" },
  { name: "LVIS_ASRT_TEST_HOME", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_DEBUG_STREAM", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_DEV", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_DEV_CONSOLE", lifecycle: "active", packaged: "scrub" },
  // Renamed to LVIS_WIN_NO_SANDBOX; stale launchers must not revive it.
  { name: "LVIS_DEV_NO_SANDBOX", lifecycle: "tombstone", packaged: "scrub" },
  { name: "LVIS_DEV_PREFLIGHT_OVERRIDE", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_DEV_PROMPT_SOURCE_DUMP", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_DEV_RELOAD", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_E2E", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_E2E_WHITELIST_PUBLIC_KEY", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_LOG_FILE", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_LOG_FORMAT", lifecycle: "active", packaged: "scrub" },
  // Removed from plugin path resolution; retained as a scrub/audit tombstone.
  { name: "LVIS_PLUGINS_DIR", lifecycle: "tombstone", packaged: "scrub" },
  { name: "LVIS_REQUIRE_SANDBOX_CASES", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_RESOURCE_ROOT", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_REVOCATION_OFFLINE", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_RUN_PROBES", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_SECRET_PROBE", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_TEST_NODE_EXEC_PATH", lifecycle: "active", packaged: "scrub" },
  // Explicitly source/test-only; packaged builds do not accept this env switch.
  { name: "LVIS_TRACE", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_WHITELIST_OFFLINE", lifecycle: "active", packaged: "scrub" },
  { name: "LVIS_WIN_NO_SANDBOX", lifecycle: "active", packaged: "scrub" },
  // Renderer-build development flag: deliberately covered despite not using
  // the LVIS_ namespace scanned by the env-surface policy gate.
  { name: "VITE_DEBUG_STREAM", lifecycle: "active", packaged: "scrub" },
] as const;

type DevelopmentEnvPolicyEntry = (typeof DEVELOPMENT_ENV_POLICY)[number];
type ActiveDevelopmentEnvPolicyEntry = Extract<
  DevelopmentEnvPolicyEntry,
  { lifecycle: "active" }
>;
type DevelopmentEnvTombstonePolicyEntry = Extract<
  DevelopmentEnvPolicyEntry,
  { lifecycle: "tombstone" }
>;

export type DevelopmentEnvVar = ActiveDevelopmentEnvPolicyEntry["name"];
export type DevelopmentEnvTombstone = DevelopmentEnvTombstonePolicyEntry["name"];
export type DevelopmentEnvPolicyName = DevelopmentEnvPolicyEntry["name"];

export const ACTIVE_DEVELOPMENT_ENV_VARS: readonly DevelopmentEnvVar[] =
  DEVELOPMENT_ENV_POLICY
    .filter((entry): entry is ActiveDevelopmentEnvPolicyEntry => entry.lifecycle === "active")
    .map((entry) => entry.name);

export const DEVELOPMENT_ENV_TOMBSTONES: readonly DevelopmentEnvTombstone[] =
  DEVELOPMENT_ENV_POLICY
    .filter(
      (entry): entry is DevelopmentEnvTombstonePolicyEntry => entry.lifecycle === "tombstone",
    )
    .map((entry) => entry.name);

export const PACKAGED_DEVELOPMENT_ENV_VARS: readonly DevelopmentEnvPolicyName[] =
  DEVELOPMENT_ENV_POLICY
    .filter((entry) => entry.packaged === "scrub")
    .map((entry) => entry.name);

/**
 * Prefixes denied in packaged builds even before a newly introduced exact
 * name is added to the inventory and classified by the env-surface gate.
 */
const DEVELOPMENT_ENV_PREFIXES = ["LVIS_DEV"] as const;

const DEVELOPMENT_ENV_VAR_SET: ReadonlySet<string> = new Set(PACKAGED_DEVELOPMENT_ENV_VARS);

export function isDevelopmentOnlyEnvVar(name: string): boolean {
  return (
    DEVELOPMENT_ENV_VAR_SET.has(name)
    || DEVELOPMENT_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

export function readDevelopmentOnlyEnvVar(
  name: DevelopmentEnvVar,
  env: NodeJS.ProcessEnv,
  packaged: boolean,
): string | undefined {
  if (!isDevelopmentOnlyEnvVar(name)) {
    throw new Error(`Unknown development-only environment variable: ${name}`);
  }
  return packaged ? undefined : Reflect.get(env, name) as string | undefined;
}
