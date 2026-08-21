/**
 * Env-surface policy gate.
 *
 * The rule this enforces: an environment variable that configures the app for
 * the person using it must ALSO be reachable from Settings. A packaged app is
 * launched by double-clicking it — there is no shell to export anything in —
 * so a capability whose only switch is an env var is a capability that user
 * does not have. Several already shipped that way before anyone noticed.
 *
 * The gate cannot decide which variables are user configuration and which are
 * scaffolding, so it does not try. It requires every `LVIS_*` variable the
 * source actually READS to be classified here, in exactly one bucket, and it
 * refuses to let the unfinished bucket grow. What it buys is that the next
 * variable of this kind is a decision someone makes on purpose, in a diff, and
 * not a surface that quietly never existed.
 *
 * Buckets:
 *   development — meaningful only running from source, in tests, or in E2E.
 *                 Packaged builds ignore or scrub these (see `dev-flags.ts`).
 *   internal    — part of a host↔child protocol or the packaging layout. The
 *                 app writes it; nobody configures it.
 *   settings    — has a control the user can reach. Cross-checked below.
 *   pending     — SHOULD have a control and does not yet. Shrink-only.
 *
 * Usage: node --import tsx scripts/check-env-surface-policy.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_BACKED_SETTINGS } from "../src/shared/env-backed-settings.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/** Only meaningful outside a packaged build. */
const DEVELOPMENT: readonly string[] = [
  "LVIS_ADMISSION_OFFLINE",
  "LVIS_ALLOW_LINKED_PLUGIN_ENTRY",
  "LVIS_ALLOW_TEST_MARKETPLACE_KEYS",
  "LVIS_ASRT_TEST_HOME",
  "LVIS_DEBUG_STREAM",
  "LVIS_DEV",
  "LVIS_DEV_CONSOLE",
  "LVIS_DEV_NO_SANDBOX",
  "LVIS_DEV_PREFLIGHT_OVERRIDE",
  "LVIS_DEV_PROMPT_SOURCE_DUMP",
  "LVIS_DEV_RELOAD",
  "LVIS_E2E",
  "LVIS_E2E_WHITELIST_PUBLIC_KEY",
  "LVIS_LOG_FILE",
  "LVIS_PLUGINS_DIR",
  "LVIS_REQUIRE_SANDBOX_CASES",
  "LVIS_RESOURCE_ROOT",
  "LVIS_REVOCATION_OFFLINE",
  "LVIS_RUN_PROBES",
  "LVIS_SECRET_PROBE",
  "LVIS_TEST_NODE_EXEC_PATH",
  "LVIS_TRACE",
  "LVIS_WHITELIST_OFFLINE",
  "LVIS_WIN_NO_SANDBOX",
];

/** The app sets these for something it launched; they are not configuration. */
const INTERNAL: readonly string[] = [
  "LVIS_HOOK_EVENT",
  "LVIS_HOOK_SESSION",
  "LVIS_SUBSCRIPTION_TOOL_BRIDGE_TOKEN",
];

/**
 * Reachable from Settings today.
 *
 * The tailnet group is listed by name rather than through
 * {@link ENV_BACKED_SETTINGS} because its control writes a host-owned file
 * instead of the settings store — the capability it carries must stay
 * unsettable by a renderer. Same surface obligation, different backing.
 */
const SETTINGS_BACKED: readonly string[] = [
  ...ENV_BACKED_SETTINGS.map((entry) => entry.envVar),
  "LVIS_TAILNET_CONTROLLER",
  "LVIS_TAILNET_OBSERVER",
  "LVIS_TAILNET_OBSERVER_CAP",
  "LVIS_TAILNET_OBSERVER_PORT",
  "LVIS_TAILNET_PAIRED_SHARING",
  "LVIS_TAILNET_WEB",
  "LVIS_TAILNET_WEB_ORIGIN",
];

/**
 * Configuration a user could need, with no way to reach it yet.
 *
 * Shrink-only: {@link PENDING_CEILING} must come DOWN as these get surfaces,
 * and a new entry here fails the gate until the ceiling is deliberately
 * raised in the same diff that adds it. "Pending" is not the answer for a new
 * variable — building the control is.
 */
const PENDING: readonly string[] = [
  "LVIS_CORP_CA_CN",
  "LVIS_CORP_CA_DEBUG",
  "LVIS_HOME",
  "LVIS_KEEP_GPU",
  "LVIS_LOG_FORMAT",
  "LVIS_MARKETPLACE_UPDATE_CHECK",
  "LVIS_MARKETPLACE_USE_CACHE",
  "LVIS_PRICING_OVERRIDE",
  "LVIS_SENTRY_DSN",
  "LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS",
  "LVIS_SHUTDOWN_TIMEOUT_MS",
  "LVIS_SKIP_CORP_CA",
  "LVIS_SUBSCRIPTION_TOOL_BRIDGE_URL",
  "LVIS_TELEMETRY_ALLOWLIST",
];

const PENDING_CEILING = 14;

/**
 * `process.env.NAME`, `process.env["NAME"]`, and the same two through a passed
 * `env` parameter — which is how most of the resolvers here take it, so a
 * `process.env`-only scan would miss nearly every gate that matters.
 *
 * Deliberately NOT a bare `LVIS_[A-Z_]+` scan: many such names are ordinary
 * TypeScript constants (`LVIS_TOKEN_NAMES`, `LVIS_LOGO_PATH`), and a gate that
 * demanded those be classified as configuration would be asking for nonsense.
 */
const READ_RE =
  /(?:process\.)?env\s*(?:\.\s*(LVIS_[A-Z0-9_]+)|\[\s*["'`](LVIS_[A-Z0-9_]+)["'`]\s*\])/g;

/**
 * An env lookup whose key is an expression rather than a literal — `env[KEY[k]]`,
 * `env[name]`. The resolvers that carry the most configuration are written this
 * way (one table of key→variable, one loop), and {@link READ_RE} cannot see a
 * single one of their variables: the names live in the table, not at the lookup.
 * The tailnet group went invisible to this gate the moment its server adopted
 * that shape, which is exactly the direction a policy gate must not fail in.
 */
const DYNAMIC_LOOKUP_RE = /(?:process\.)?env\s*\[\s*(?!["'`])/;

/**
 * In a file that does a dynamic lookup, a quoted variable name IS the read —
 * it is the table entry the lookup resolves through.
 *
 * Two deliberate narrowings, because outside that context a quoted `LVIS_*` is
 * usually not a variable at all:
 *   - tests are excluded; a name quoted in a test is a fixture it sets, and the
 *     production read that gives it meaning is already counted where it lives.
 *   - a trailing underscore marks a PREFIX (`LVIS_DEMO_`, matched by the
 *     packaged-env scrub), which is a family of variables and not one of them.
 */
const TABLE_ENTRY_RE = /["'`](LVIS_[A-Z0-9_]*[A-Z0-9])["'`]/g;
const TEST_FILE_RE = /(^|[\\/])__tests__[\\/]|\.test\.[cm]?tsx?$/;

function scan(dir: string, found: Map<string, string>): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      scan(path, found);
      continue;
    }
    if (!/\.(ts|tsx|mts|cts)$/.test(name)) continue;
    const text = readFileSync(path, "utf-8");
    const where = relative(ROOT, path).replaceAll("\\", "/");
    const patterns = [READ_RE];
    if (!TEST_FILE_RE.test(where) && DYNAMIC_LOOKUP_RE.test(text)) {
      patterns.push(TABLE_ENTRY_RE);
    }
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const variable = match[1] ?? match[2]!;
        if (!found.has(variable)) found.set(variable, where);
      }
    }
  }
}

/** Every `LVIS_*` variable the source reads, mapped to the first file reading it. */
export function scanEnvReads(root: string = SRC): Map<string, string> {
  const found = new Map<string, string>();
  scan(root, found);
  return found;
}

export const BUCKETS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["development", DEVELOPMENT],
  ["internal", INTERNAL],
  ["settings", SETTINGS_BACKED],
  ["pending", PENDING],
];

/**
 * The whole policy, as a pure function of what was found and what was declared
 * — so the gate's own failure modes can be exercised without a repository that
 * violates them. A gate nobody has ever seen fail is a gate nobody knows works.
 */
export function evaluate(
  found: ReadonlyMap<string, string>,
  buckets: ReadonlyArray<readonly [string, readonly string[]]> = BUCKETS,
  pending: readonly string[] = PENDING,
  pendingCeiling: number = PENDING_CEILING,
): readonly string[] {
  const failures: string[] = [];

  // Classified in more than one bucket: the two claims contradict each other,
  // and whichever the reader believes is a coin flip.
  const seen = new Map<string, string>();
  for (const [bucket, names] of buckets) {
    for (const name of names) {
      const previous = seen.get(name);
      if (previous !== undefined) {
        failures.push(`${name}: classified as both "${previous}" and "${bucket}"`);
      }
      seen.set(name, bucket);
    }
  }

  for (const [variable, where] of [...found].sort()) {
    if (!seen.has(variable)) {
      failures.push(
        `${variable} (${where}): read by the source and classified nowhere. `
        + `Add it to one bucket in scripts/check-env-surface-policy.ts — and if it `
        + `configures the app for the person using it, build the control instead of `
        + `listing it as pending.`,
      );
    }
  }

  for (const [bucket, names] of buckets) {
    for (const name of names) {
      if (!found.has(name)) {
        failures.push(`${name}: listed under "${bucket}" but nothing reads it any more — drop the entry.`);
      }
    }
  }

  if (pending.length > pendingCeiling) {
    failures.push(
      `pending list grew to ${pending.length} (ceiling ${pendingCeiling}). The ceiling only moves down.`,
    );
  }

  return failures;
}

/** Direct invocation runs the real scan; importing the module does not. */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = scanEnvReads();
  const failures = evaluate(found);
  if (failures.length > 0) {
    console.error(`[env-surface] ${failures.length} problem(s)`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(
    `[env-surface] OK — ${found.size} variable(s) read: `
    + `${SETTINGS_BACKED.length} with a control, ${PENDING.length} pending (ceiling ${PENDING_CEILING}), `
    + `${DEVELOPMENT.length} development, ${INTERNAL.length} internal`,
  );
}
