/**
 * Route one plugin out of the main process, and confine it there
 * (`docs/blueprints/plugin-process-isolation.md` §4, §5, §7).
 *
 * Two things land here together because §4 says they have to. The process
 * boundary alone buys a great deal — no shared heap, no `electron`, one
 * structural chokepoint, a separate crash domain — and buys NO filesystem or
 * network confinement at all: a Node child still has `fs`, `net` and
 * `child_process` unless something wraps its argv. Shipping the boundary
 * without the wrap would advertise a protection that is not there, so the spawn
 * goes through `spawnConfinedChild` and nowhere else.
 *
 * THERE IS NO UNCONFINED PATH. `wrapWorkerCommand` throws when ASRT is not
 * active, and nothing here catches it: a plugin that cannot be confined fails
 * to load. That is the fail-closed rule, and it is enforced by the ABSENCE of a
 * branch rather than by one — there is no place to add "continue anyway"
 * without deleting a line rather than adding one.
 *
 * WHAT THIS SEAM IS. The host's contract with a plugin is
 * `RuntimePluginFactory`, so that is what the isolated path produces: a factory
 * that spawns a child and returns a `RuntimePlugin` whose handlers and
 * lifecycle hooks are round trips. Everything above it — the method map, the
 * permission manager, the effect gate, the generation lease, the loopback MCP
 * projection — is untouched and cannot tell the difference, which is exactly
 * why the five plugins that are not the pilot keep loading as they did.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { createLogger } from "../../lib/logger.js";
import { mainDir } from "../../main/main-paths.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { RAW_RESULT_META } from "../../mcp/protocol-constants.js";
import { spawnConfinedChild } from "../../permissions/confined-child.js";
import { createSandboxProcessHome } from "../../permissions/sandbox-process-home.js";
import { cleanupAsrtSandboxAfterCommand } from "../../permissions/asrt-sandbox.js";
import { buildSafeChildEnv } from "../../tools/safe-env.js";
// The allowlist is READ where it is declared rather than mirrored here. It is
// the host's answer to "which preferences may a plugin see", and a second copy
// of that list would be a second answer to a security question.
import { HOST_PUBLIC_PREFERENCE_KEYS } from "../../boot/steps/plugin-runtime/app-preference.js";
import { subscribeAppPreferenceChange } from "../config-change-bus.js";
import {
  isPathAllowed,
  sanitizeAllowedDirectories,
} from "../../permissions/allowed-directories.js";
import { readPermissionSettings } from "../../permissions/permission-settings-store.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "../../permissions/sensitive-paths.js";
import { lvisHome } from "../../shared/lvis-home.js";
import type {
  PluginHostApi,
  PluginManifest,
  PluginRuntimeContext,
  PluginToolHandler,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
import {
  HOSTAPI_DISPATCH_TABLE,
  createConfigSubscriptionHostApiPaths,
  createInteractionHostApiPaths,
  createServiceHostApiPaths,
  createStorageHostApiPaths,
  type DelegatedWorkerConfinement,
  type HostApiPathHandler,
} from "./host-api-dispatcher.js";
import { HOST_API_WIRE_VERSION, type HostApiPath } from "./host-api-wire.js";
import {
  PLUGIN_INSTANCE_METHODS,
  PLUGIN_INSTANCE_WIRE_VERSION,
  type PluginConstructParams,
  type PluginConstructResult,
  type ReadUiResourceResult,
} from "./plugin-instance-wire.js";
import {
  PluginChildTransport,
  type ChildLink,
} from "./plugin-child-transport.js";
import type { PluginChildContext } from "./plugin-child-runtime.js";

const log = createLogger("out-of-process-plugin");

/**
 * The `hostApi` members this path needs to bind, as the union of the four
 * groups' own narrowings.
 *
 * Stated as an intersection of what each group asks for rather than as
 * `PluginHostApi`, so a group that widens its needs widens this too — and a
 * caller cannot satisfy the assembly with an object that happens to have the
 * right shape for three groups and not the fourth.
 */
export type DispatchableHostApi = Parameters<typeof createStorageHostApiPaths>[0] &
  Parameters<typeof createConfigSubscriptionHostApiPaths>[0] &
  Parameters<typeof createInteractionHostApiPaths>[0] &
  Parameters<typeof createServiceHostApiPaths>[0] &
  /**
   * `getInstalledPluginIds` belongs to no group because it is DISPATCHED BY
   * NOBODY: its contract is `child-local` and the table refuses it if it ever
   * arrives. The host still calls it — to build the snapshot the child answers
   * from — so it is named here rather than inside a group whose job is binding
   * handlers.
   */
  Pick<PluginHostApi, "getInstalledPluginIds">
  /**
   * `getAppPreference` joins it for the same reason and stays OPTIONAL, because
   * it is optional on `PluginHostApi`. A host that does not implement it
   * publishes no preference snapshot at all, and the child's member then throws
   * instead of answering `undefined` — see `PluginChildContext.appPreferences`.
   */
  & Pick<PluginHostApi, "getAppPreference">;

/**
 * Bind every dispatched member to ONE plugin incarnation's `hostApi`.
 *
 * The instance passed here must be the one the host handed the factory —
 * `context.hostApi`, which `buildHostApiIncarnation` has already wrapped in the
 * effect recorder, the effect gate and the active-incarnation proxy. Binding a
 * freshly built hostApi instead would produce a boundary that works in every
 * test and records nothing in the field: the recorder's ledger is per-wrapper,
 * so effects would be attributed to a wrapper no one reads.
 *
 * The four spreads are applied over the shipped table rather than replacing it,
 * so a member no group claims keeps its throwing default instead of becoming
 * absent. `Record<HostApiPath, …>` makes a missing key a compile error either
 * way; this makes an UNBOUND key a loud runtime refusal.
 */
export function createBoundHostApiDispatchTable(
  hostApi: DispatchableHostApi,
  /**
   * The roots the child's own ASRT wrap grants it, so `spawnWorker` can refuse
   * a delegated worker that would reach further. It is the SAME value
   * `spawnConfinedPluginChild` passes to the wrap — one
   * {@link derivePluginChildEnvelope} result, held by the factory — because a
   * boundary that checked against a differently-derived envelope would be
   * checking against something other than the jail.
   */
  confinement: DelegatedWorkerConfinement,
): Record<HostApiPath, HostApiPathHandler> {
  return {
    ...HOSTAPI_DISPATCH_TABLE,
    ...createStorageHostApiPaths(hostApi),
    ...createConfigSubscriptionHostApiPaths(hostApi),
    ...createInteractionHostApiPaths(hostApi),
    ...createServiceHostApiPaths(hostApi, confinement),
  };
}

/**
 * Every config key the host can resolve for this plugin.
 *
 * `config.get` merges schema defaults, the manifest's own config, a host
 * wildcard slot and the user's saved settings, and `PluginHostApi` publishes no
 * way to enumerate the result — so the key set is assembled from the three
 * sources the host DOES hold: the schema's declared properties, the manifest's
 * config, and the construction snapshot (which is the merge, as it stood when
 * the plugin started). Their union is what the settings surface can change,
 * which is what a re-push has to cover.
 */
function resolvableConfigKeys(
  manifest: PluginManifest,
  constructionConfig: Record<string, unknown> | undefined,
): readonly string[] {
  return [
    ...new Set([
      ...Object.keys(manifest.configSchema?.properties ?? {}),
      ...Object.keys(manifest.config ?? {}),
      ...Object.keys(constructionConfig ?? {}),
    ]),
  ];
}

/**
 * Where the child's entry module lives.
 *
 * Resolved from `mainDir`, NOT from this module's own `import.meta.url`: the
 * main process is an esbuild bundle with code splitting, so this file executes
 * from `main.js` or from a hashed `chunks/*.js` and has no fixed relationship
 * to any emitted sibling. `main-paths.ts` is the one place that answers "where
 * are the runtime assets", and `plugin-child-main` is registered as its own
 * esbuild entry point so an actual file exists there to run.
 */
function resolvePluginChildEntryPath(): string {
  return join(mainDir, "plugin-child-main.js");
}

/**
 * One directory the HOST has decided a named plugin's child may reach beyond
 * its own two.
 *
 * The two shapes are not interchangeable, and the difference is the whole
 * safety argument:
 *
 *  - `hostDirectory` names a LITERAL location under `~/.lvis`, written out in
 *    this file and changed only by a reviewed commit. Nothing outside the host
 *    can influence which path it resolves to. It is granted READ, and the only
 *    reason a read grant is not inert is that ASRT's read model is deny-only:
 *    `allowRead` re-allows a region inside a covering deny (`asrt-sandbox.ts`
 *    documents this, and `confined-plugin-child.test.ts` proves it against the
 *    real sandbox). So a host directory the deny floor covers — `certs` — can
 *    be re-opened for exactly one plugin, and a host directory the floor does
 *    NOT cover — `runtime` — is readable anyway and appears here because the
 *    delegated-worker check compares against this list rather than against the
 *    floor.
 *
 *  - `userChosenDirectory` names a CONFIG KEY, never a path. The host reads the
 *    key, and admits the value only if it lies inside the plugin's own writable
 *    root or inside a directory the USER approved through the host's
 *    workspace-root flow — and, either way, only if it lies outside every root
 *    {@link ceilingSubtractions} names. The plugin can therefore choose WHERE
 *    under the user's ceiling it works, and cannot raise the ceiling:
 *    `config.set(key, "/")` produces a refusal at the next spawn, not a wider
 *    jail. It is granted WRITE, and read alongside it, because a read-only
 *    grant here would be inert — an ordinary user directory is on no deny list.
 *    The read half is added by the same line that adds the write half, which is
 *    what keeps the two lists in the relation `DelegatedWorkerConfinement`
 *    describes.
 *
 *  KEEPING A READ GRANT FROM BECOMING A WRITE GRANT IS DONE BY SUBTRACTING THE
 *  ROWS, not by reasoning about their shape. {@link ceilingSubtractions} puts
 *  the directory every `hostDirectory` row in this table resolves to into the
 *  set a `userChosenDirectory` value is refused for naming, and the comparison
 *  is canonical on both sides.
 *
 *  Subtracting `lvisHome()` alone is NOT the same thing, and the difference is
 *  easy to miss because in a home made only of real directories the two
 *  coincide. A row is a LEXICAL join onto the home; a granted directory that is
 *  itself a symlink out of the home has a canonical form the home does not
 *  contain, and the comparison then misses. `confined-plugin-child.test.ts` pins that case for the `runtime`
 *  row — the interpreter tree moved to another volume, the volume approved as
 *  a workspace root — asked with the linked spelling and with the target's own
 *  spelling; with the home entry alone, both spellings reached
 *  `envelope.write`.
 *
 *  WHAT IS NOT CLAIMED is that this holds for all time. Each row is resolved
 *  when the envelope is derived; a link swapped between that moment and the
 *  child's use of the grant is a residual this does not close, and it is the
 *  same check-time/use-time residual the delegated-worker grant check carries.
 */
type PluginEnvelopeGrant =
  | {
      readonly kind: "hostDirectory";
      /** Path segments under `lvisHome()`. */
      readonly segments: readonly string[];
      readonly why: string;
    }
  | {
      readonly kind: "userChosenDirectory";
      /** The `config.get` key the host reads the directory out of. */
      readonly configKey: string;
      readonly why: string;
    };

/**
 * Which plugin's child gets which extra reach.
 *
 * A HOST-OWNED TABLE, and every word of that matters. It is not the manifest,
 * because a manifest field would let the plugin assert its own envelope — the
 * one party that must not have a say. It is not an environment variable or a
 * settings key either, because the SHAPE of a plugin's reach would then change
 * under a user with no record of it. A plugin's child reaches further when a
 * reviewed commit adds a row here, which means the widening is visible in a
 * diff and revertable by a revert — the same discipline the routing SOT
 * (`out-of-process-plugins.ts`) applies to the boundary itself.
 *
 * A `userChosenDirectory` row is not an exception to that. What the row decides
 * is that this plugin may hold ONE directory named by that key at all; which
 * directory it turns out to be is the user's, bounded by their own approvals.
 *
 * Said precisely, because the value and the bound are different questions:
 * `config.get` merges the plugin's own `manifest.config` and `configSchema`
 * defaults under the user's saved setting, and `config.set` is a member the
 * plugin holds — so the plugin CAN put any value there. Moving the CEILING that
 * value is checked against is a different reach, and it is
 * {@link resolveUserChosenDirectory} that has to deny it, which is why that
 * function owns the whole safety argument and why its ceiling is compared in
 * canonical form. The reaches that were tried and refused are the ones
 * `confined-plugin-child.test.ts` names: the filesystem root, a sensitive path
 * under an approved root, this plugin's bundle and a neighbour's, a bundle root
 * that is a symlink, a directory a `hostDirectory` row granted READ, the same
 * directory once the row's target is moved onto another volume, and a link
 * planted inside the plugin's own data directory. A reach nobody has tried is
 * not covered by that list.
 *
 * An entry is INERT until the plugin is actually routed out-of-process: nothing
 * reads this table for an in-process plugin, which still loads in main with no
 * confinement of its own.
 *
 * `local-indexer`'s row is derived from what its worker spawn actually asks for
 * (`allowReadPaths: [pythonExecutable, workerScriptPath, corpCaPath?]`,
 * `allowWritePaths: [indexRoot, workspace]`), not from what it might want.
 */
const PLUGIN_ENVELOPE_GRANTS: ReadonlyMap<string, readonly PluginEnvelopeGrant[]> = new Map([
  [
    "local-indexer",
    [
      {
        kind: "hostDirectory",
        segments: ["runtime"],
        why:
          "the Python interpreter the indexer's worker executes. `PythonRuntimeBootstrapper` "
          + "provisions it at `~/.lvis/runtime/python-envs/<target>/venv/bin/python` and boot "
          + "injects the path, so it is host-owned and the plugin merely names it back",
      },
      {
        kind: "hostDirectory",
        segments: ["certs"],
        why:
          "the corporate CA bundle `corp-ca-loader` caches at `~/.lvis/certs/corp-ca.pem`. The "
          + "worker points `SSL_CERT_FILE` at it so internal TLS verifies rather than being "
          + "disabled. This path IS on the sensitive deny floor and the grant pierces it for "
          + "this plugin alone; a root CA certificate is a trust anchor rather than a "
          + "credential, which is what makes that a proportionate host decision",
      },
      {
        kind: "userChosenDirectory",
        configKey: "indexStorageRoot",
        why:
          "where the index itself is written. Unset, it defaults to `<pluginDataDir>/index`, "
          + "which is already inside the envelope; a user who moves it onto another volume "
          + "needs the grant to follow",
      },
      {
        kind: "userChosenDirectory",
        configKey: "workspace",
        why:
          "the worker's scratch + state directory. Unset, the plugin resolves it under its "
          + "own data directory — a SIBLING of the default index root rather than a child of "
          + "it — so both defaults are already inside the envelope and this grant only has an "
          + "effect once the user names a directory outside. The host requires an absolute "
          + "value for this key even though the plugin accepts a relative one; see "
          + "{@link resolveUserChosenDirectory} for why the host cannot resolve one",
      },
    ],
  ],
]);

/**
 * What the derivation needs that it cannot read for itself.
 *
 * `configValue` is `hostApi.config.get`, taken from the incarnation rather than
 * re-read from settings: `config.get` is the merge of schema defaults, manifest
 * config and the user's saved value, and a second reader assembled here would
 * answer a different question from the one the plugin's own code asks.
 */
export interface PluginChildEnvelopeInputs {
  readonly pluginId: string;
  /** The plugin's immutable runtime root; the child reads its code from here. */
  readonly pluginRoot: string;
  /** `~/.lvis/plugins/<id>/data`. */
  readonly pluginDataDir: string;
  readonly configValue: (key: string) => unknown;
}

/**
 * Refuse a widening, and say which grant asked for what.
 *
 * A plain `Error` rather than a boundary error: this runs on the SPAWN path, so
 * a refusal here fails the plugin's construction — there is no child yet to
 * answer, and a plugin whose declared envelope cannot be honoured must not load
 * with a quietly smaller one.
 */
function rejectEnvelopeGrant(pluginId: string, configKey: string, detail: string): never {
  throw new Error(
    `[out-of-process-plugin] ${pluginId}: cannot widen the child's envelope for `
      + `config key '${configKey}': ${detail}`,
  );
}

/**
 * Where one `hostDirectory` row resolves.
 *
 * ONE answer, read by the derivation that grants the directory and by the
 * subtraction that keeps a config value from naming it. Spelled out twice,
 * the two could come to disagree about where a row points, and the disagreement
 * would be invisible: the grant would still be read-only and the subtraction
 * would still refuse something — just not the same directory.
 */
function hostGrantDirectory(
  grant: Extract<PluginEnvelopeGrant, { kind: "hostDirectory" }>,
): string {
  return join(lvisHome(), ...grant.segments);
}

/**
 * The roots a `userChosenDirectory` value is refused for naming, whatever the
 * user approved, and why each one is on the list.
 *
 * These are SUBTRACTED from the ceiling rather than left out of one half of it,
 * and the difference is not stylistic. The ceiling's own-roots half and its
 * user-approval half overlap in the production layout, so a root merely omitted
 * from the first is readmitted by the second the moment the user approves
 * anything above it — which is one `config.set` away, and needs no symlink and
 * no race.
 *
 * Each entry is a WRITE exclusion and says nothing about read. What the child
 * may read is decided elsewhere — by the ASRT deny floor and by the envelope's
 * own `read` list — and appearing here neither opens nor closes any of that.
 * What the exclusion removes is a config value's ability to turn a directory
 * into a kernel-level WRITE grant.
 */
function ceilingSubtractions(
  inputs: PluginChildEnvelopeInputs,
): readonly { readonly root: string; readonly detail: string }[] {
  return [
    {
      // `<pluginsRoot>` — the parent of THIS plugin's root, which is where
      // every install physically lives (`plugin-paths.ts`; `ensurePluginDataDir`
      // already reads the parent the same way). Named as the whole directory
      // rather than as `inputs.pluginRoot` alone because the argument for
      // excluding the plugin's own bundle — it is the module the next load
      // imports into the main process, and the bytes the install receipt is
      // taken over — is the same argument for every sibling's bundle, and for
      // every sibling's storage namespace. The plugin's own data directory is
      // under here too, which is why it is admitted BEFORE this runs.
      //
      // In the default layout this root is INSIDE the one below and either
      // entry would refuse; they are separate because they are anchored to
      // different things. This one is derived from the path the host actually
      // located this incarnation's bundle at, while `lvisHome()` re-reads
      // `LVIS_HOME` on every call — so a home that moved after install, or a
      // `pluginsRoot` supplied by constructor injection, leaves the two
      // pointing at different directories and only this one still covers the
      // bundles.
      root: resolvePath(inputs.pluginRoot, ".."),
      detail:
        "resolves inside the directory that holds every installed plugin's bundle, which "
        + "carries the modules the next load imports into the main process and the bytes "
        + "each install receipt is taken over",
    },
    {
      // `~/.lvis` — the host's own storage namespace. The parts of it that are
      // secret are already refused by the sensitive-path gate in
      // {@link resolveUserChosenDirectory}, and this entry is what covers the
      // parts that are merely host-owned: session transcripts, the routine
      // store, the audit log, and any directory a later host feature adds
      // under the home without anyone editing this list.
      //
      // It is NOT what keeps a `hostDirectory` grant out of the write list.
      // Every row does join onto `lvisHome()`, so in a home whose entries are
      // all real directories this entry happens to cover them — but that is a
      // fact about one filesystem, not about the shapes, and the entries below
      // are what actually carry the exclusion.
      root: lvisHome(),
      detail: "resolves inside the host's own storage namespace",
    },
    {
      // This plugin's OWN bundle root, named separately from the install root
      // above even though the shipped layout puts it inside. The row above is
      // `resolvePath(pluginRoot, "..")` — a LEXICAL parent, which is the right
      // way to name the install root and the wrong way to name a bundle that
      // is a symlink out of it, because the caller canonicalises what it is
      // handed. Naming the bundle root itself is what makes the two agree when
      // the install directory is a link.
      root: inputs.pluginRoot,
      detail: "resolves inside the plugin's own bundle root",
    },
    // Every directory a `hostDirectory` row resolves to — the WHOLE table's,
    // not this plugin's alone, because what is being excluded is the class
    // "somewhere the host handed a plugin child READ" and a value that names a
    // neighbour's granted directory raises the same question as one that names
    // its own. The rows are enumerated rather than covered by the `lvisHome()`
    // entry above: a row is a LEXICAL join onto the home, the caller compares
    // in canonical form, and a granted directory that is itself a symlink out
    // of the home therefore has a canonical form the home entry does not
    // contain. Moving a multi-gigabyte interpreter tree to another volume and
    // linking it back is the ordinary reason for that to be true on a real
    // machine.
    ...[...PLUGIN_ENVELOPE_GRANTS.values()].flatMap((grants) =>
      grants.flatMap((grant) =>
        grant.kind === "hostDirectory"
          ? [
              {
                root: hostGrantDirectory(grant),
                detail: "resolves inside a directory the host's own table grants a plugin READ",
              },
            ]
          : [],
      ),
    ),
  ];
}

/**
 * Resolve one `userChosenDirectory` grant, or refuse it.
 *
 * Returns `undefined` when the key names nothing — an unset key means the
 * plugin is using the default that already lives inside its data directory, so
 * there is no widening to perform. That is the set being empty, not a rescue
 * branch: a key that IS set and cannot be honoured throws.
 *
 * THE CEILING IS THE PLUGIN'S OWN WRITABLE ROOT — `pluginDataDir` — UNIONED
 * WITH the directories the user approved through the host's workspace-root
 * flow, the same `permissions.additionalDirectories` list that already widens a
 * plugin-owned tool's write jail (`sandbox-write-jail.ts`). Both halves go
 * through `isPathAllowed`, the host's own segment-aligned predicate for "did
 * the user authorise this", so there is no second notion of approval here to
 * drift from the first.
 *
 * {@link ceilingSubtractions} IS SUBTRACTED FROM THE WHOLE CEILING, and that it
 * is subtracted rather than merely left out of one half is the point. What this
 * resolves is a WRITE grant, and those roots hold the bundles the next load
 * imports, the bytes each install receipt is taken over, and every directory a
 * `hostDirectory` row granted READ. Putting any of them into the child's
 * kernel-level write jail is the primitive {@link spawnConfinedPluginChild}
 * removes rather than merely detects, and a root the child may only READ cannot
 * bound a grant that carries write.
 *
 * Omitting them from the own-roots half alone would NOT have achieved that, and
 * the reason is the production layout: `pluginDataDir` is a CHILD of
 * `pluginRoot` (`~/.lvis/plugins/<id>/data`, `plugin-storage-layout.ts`), which
 * is itself under the install root and under `~/.lvis`. Any workspace root the
 * user approves at or above the install location therefore contains all three,
 * and the approval half would readmit exactly what the own-roots half declined
 * to name — with no symlink and no race, on one `config.set`.
 *
 * THE ORDER OF THE THREE STEPS IS: the plugin's own data directory is admitted
 * FIRST, the subtractions are asked SECOND, the user's approvals are consulted
 * LAST. The first boundary decides a VERDICT and the second decides a MESSAGE,
 * and it is worth being exact about which is which:
 *
 *  - The data-directory step RETURNS. It is the only admitting step, and the
 *    data directory sits inside every subtracted root, so a subtraction asked
 *    ahead of it refuses the plugin's own default index location. Four cases in
 *    `confined-plugin-child.test.ts` go red on that move.
 *  - The remaining two steps both REFUSE and neither admits, so swapping them
 *    changes no verdict — a subtracted root is refused either way. What it
 *    changes is which refusal the caller is handed: with the approvals first, a
 *    value under a subtracted root that no approval covers is told to "approve
 *    the directory in the host first", which is advice that cannot work. One
 *    case goes red on that move, and it goes red on the message.
 *
 * ALL FOUR CONTAINMENT QUESTIONS THIS FUNCTION ASKS ARE ASKED ON THE CANONICAL
 * FORM, not on the lexical one: the value, the plugin's own writable root, each
 * subtracted root, and the user's approved roots (`sanitizeAllowedDirectories`
 * canonicalises and case-folds what it returns, so that side arrives that way).
 * `config.set` is a member the plugin holds and `pluginDataDir` is a directory
 * the plugin writes, so a lexical containment test is one the plugin can
 * satisfy with a symlink it planted itself. A link at `<pluginDataDir>/x` pointing at a
 * directory the user never approved reads as inside the ceiling while naming a
 * directory outside it, and the grant that follows is what reaches the kernel.
 * `canonicalizePathForMatch` resolves the link; where the path does not exist
 * yet it resolves the nearest existing ancestor and re-joins the missing tail,
 * so "the directory is not there yet" is answered without weakening the check.
 * It is also already in hand — the sensitive-path layer above computes the same
 * string.
 *
 * WHAT IS RETURNED IS THE CALLER'S OWN SPELLING, not the canonical one. The
 * delegated-worker check compares a worker's requested paths against these
 * entries and the plugin asks with the value it holds, so returning a
 * re-spelled path would refuse the very grants this widening exists to admit.
 * Containment was decided on the canonical form, so both spellings name a
 * directory inside the ceiling.
 *
 * The host DEFAULTS that scope normally carries — `computeDefaultAllowedDirectories`
 * returns the process cwd and `~/.lvis` — are deliberately not unioned in here.
 * They are where the app happens to be running and where the host keeps its own
 * state; neither is a directory the user chose for a plugin, and including them
 * would widen every plugin with a row here by accident rather than by decision.
 * `~/.lvis` is more than left out: {@link ceilingSubtractions} takes it away
 * even when the user has approved it explicitly.
 */
function resolveUserChosenDirectory(
  inputs: PluginChildEnvelopeInputs,
  grant: Extract<PluginEnvelopeGrant, { kind: "userChosenDirectory" }>,
): string | undefined {
  const raw = inputs.configValue(grant.configKey);
  // `""` is the default several plugin config schemas ship for an unset string
  // key, and `resolve("")` is the host's cwd — a value that would silently
  // grant something nobody chose.
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    rejectEnvelopeGrant(inputs.pluginId, grant.configKey, `expected a string, got ${typeof raw}`);
  }
  if (!isAbsolute(raw)) {
    // A relative value has no meaning HERE, and the reason is not that it is
    // suspicious. The directory it is relative to is the PLUGIN's to choose,
    // and the host holds no way to learn which one a given key is resolved
    // against — so honouring one would mean guessing a base and then handing
    // the kernel a write grant over the guess. A leading `~` lands here for the
    // same reason and is expanded nowhere on this path.
    //
    // WHAT THIS COSTS is worth stating rather than discovering: a relative
    // value the plugin itself accepts and resolves fails the plugin's whole
    // construction here, because {@link rejectEnvelopeGrant} runs on the spawn
    // path. That is the fail-closed direction — the alternative is a child
    // loaded with an envelope quietly smaller than the reviewed one — but it
    // means such a setting has to be made absolute BEFORE the plugin holding it
    // is routed out of process. Stated here rather than discovered there: today
    // no plugin routed out of process holds either key, so the cost is latent
    // and this comment is the notice.
    rejectEnvelopeGrant(
      inputs.pluginId,
      grant.configKey,
      `'${raw}' is not an absolute path — the host cannot resolve a relative value, because `
        + `the directory it would be relative to is the plugin's to choose`,
    );
  }
  const target = resolvePath(raw);
  const folded = caseFoldForMatch(canonicalizePathForMatch(target));
  // The read half of this grant re-allows inside the deny floor exactly as a
  // `hostDirectory` grant does, and unlike a `hostDirectory` grant the value is
  // reachable by anything that can write the plugin's config. Without this the
  // user approving `~/.lvis` as a workspace root — which the approval flow
  // permits, since `~/.lvis` is not itself a sensitive path — would let a
  // config value point the grant at `~/.lvis/secrets` and re-open it.
  const sensitive = isSensitivePath(folded);
  if (sensitive) {
    rejectEnvelopeGrant(
      inputs.pluginId,
      grant.configKey,
      `'${target}' matches the sensitive-path rule '${sensitive}'`,
    );
  }
  const ownWritableRoot = caseFoldForMatch(canonicalizePathForMatch(inputs.pluginDataDir));
  if (isPathAllowed(folded, { directories: [ownWritableRoot] })) return target;
  for (const excluded of ceilingSubtractions(inputs)) {
    const root = caseFoldForMatch(canonicalizePathForMatch(excluded.root));
    if (!isPathAllowed(folded, { directories: [root] })) continue;
    rejectEnvelopeGrant(
      inputs.pluginId,
      grant.configKey,
      `'${target}' ${excluded.detail} — no approval can open it to write`,
    );
  }
  const approved = sanitizeAllowedDirectories(
    readPermissionSettings().permissions.additionalDirectories,
  );
  if (!isPathAllowed(folded, { directories: approved })) {
    rejectEnvelopeGrant(
      inputs.pluginId,
      grant.configKey,
      `'${target}' resolves outside the plugin's own data directory and no workspace root `
        + `the user approved covers it — approve the directory in the host first`,
    );
  }
  return target;
}

/**
 * The paths the PLUGIN owns, plus whatever the host decided it also reaches.
 *
 * Read by the spawn — which adds the throwaway sandbox HOME on top — and by the
 * `spawnWorker` grant check, which does not: that HOME belongs to this process
 * and is not the plugin's to hand on. Deriving both from one function is what
 * makes the delegation check a check against the ACTUAL jail: widening what a
 * plugin child may reach widens what it may delegate, in the same edit, instead
 * of leaving a second list to drift behind the first.
 *
 * PER INCARNATION, and not by preference. ASRT applies the wrap to the child's
 * argv at exec, so the jail is fixed for the life of that process — a directory
 * the user approves afterwards does not widen a running child, and one they
 * revoke does not narrow it. The delegated-worker check therefore has to read
 * this same snapshot rather than a fresh derivation, or the boundary would
 * admit a grant the child's own kernel-level jail denies.
 *
 * WHAT THIS DOES NOT DO IS MATERIALISE the roots it names. A declared directory
 * that does not exist yet is still in the envelope; creating it belongs to the
 * ONE caller that hands the lists to the kernel —
 * {@link spawnConfinedPluginChild} — and it is done there rather than skipped,
 * for a reason that is not cosmetic: a root that is absent at wrap time is
 * DROPPED FROM THE GRANT rather than refused, so the child would start with an
 * envelope quietly unequal to the reviewed one. Creating it first is what keeps
 * the enforced set and the decided set the same set.
 *
 * It does READ the disk, and it has to. A `userChosenDirectory` grant is
 * bounded by the user's approvals in `~/.lvis/settings.json` and compared in
 * canonical form, which means resolving symlinks. Containment decided on
 * spellings alone would be a question about strings, and the plugin writes one
 * of the strings — see {@link resolveUserChosenDirectory}. A `hostDirectory`
 * grant needs none of that: its path is written out in this file.
 */
export function derivePluginChildEnvelope(
  inputs: PluginChildEnvelopeInputs,
): DelegatedWorkerConfinement {
  const read = [inputs.pluginRoot, inputs.pluginDataDir];
  const write = [inputs.pluginDataDir];
  for (const grant of PLUGIN_ENVELOPE_GRANTS.get(inputs.pluginId) ?? []) {
    if (grant.kind === "hostDirectory") {
      const directory = hostGrantDirectory(grant);
      read.push(directory);
      // Logged, not merely declared: a child running with more reach than the
      // base envelope is an operational fact, and `why` is the reviewed reason
      // it holds — which is worth having in the log of the run rather than only
      // in the diff that added it.
      log.info(`[${inputs.pluginId}] envelope widened: read ${directory} — ${grant.why}`);
      continue;
    }
    const chosen = resolveUserChosenDirectory(inputs, grant);
    if (chosen === undefined) continue;
    // Read as well as write: the plugin has to list and re-open what it wrote.
    // This is also the only thing that keeps `read` a superset of `write` —
    // `DelegatedWorkerConfinement` documents that relation as maintained here
    // rather than enforced anywhere.
    read.push(chosen);
    write.push(chosen);
    log.info(
      `[${inputs.pluginId}] envelope widened: write ${chosen} `
        + `(config '${grant.configKey}') — ${grant.why}`,
    );
  }
  return { read: [...new Set(read)], write: [...new Set(write)] };
}

/** What a confined child needs to exist. */
export interface ConfinedPluginChildSpec {
  readonly pluginId: string;
  /**
   * Every root the child may reach, as {@link derivePluginChildEnvelope}
   * produced it. Carried as ONE value rather than as the two directories it
   * used to be spelled out as, so the ASRT wrap below and the delegated-worker
   * check in `host-api-dispatcher.ts` are looking at the same object rather
   * than at two derivations of it.
   *
   * `envelope.write` is what this spawn GRANTS for writing, not the whole set
   * the child can write: see the spawn's own filesystem note below, and axis 6
   * in `out-of-process-plugins.ts`.
   */
  readonly envelope: DelegatedWorkerConfinement;
  /** The child's own entry module. Injected so a test can serve a stand-in. */
  readonly childEntryPath: string;
}

/**
 * A connected child.
 *
 * It is a {@link ChildLink} and nothing else: the factory above never touches a
 * `ChildProcess`, so the protocol can be exercised over in-memory paired
 * streams while the confinement is exercised against a real process.
 */
export interface ConfinedPluginChild {
  readonly link: ChildLink;
}

/**
 * Spawn the child under ASRT.
 *
 * Filesystem grants, and why each is the size it is:
 *
 *  - WRITE is a real jail, and what THIS SPAWN puts into it is `envelope.write`
 *    plus the throwaway sandbox HOME — no other path is added on this path.
 *    THE CHILD'S ALLOW SET IS LARGER THAN THAT, and not by this spawn's
 *    choice: ASRT composes the write allow-list as
 *    `[...getDefaultWritePaths(), ...userAllowWrite]`, so its own defaults —
 *    the `/dev` entries, `/tmp/claude`, `/private/tmp/claude`,
 *    `<real home>/.npm/_logs`, `<real home>/.claude/debug` — are merged into
 *    every wrap and no argument here removes them. Measured on macOS/arm64
 *    with the sandbox active: a child spawned by this function wrote into all
 *    four of the non-`/dev` paths and the host read the bytes back. Those
 *    paths are per-machine rather than per-plugin, so two confined children
 *    share them. `out-of-process-plugins.ts` axis 6 carries the full record,
 *    including what closing it would take and why that is not done here.
 *    Everything below is about the host's decision — which paths THIS SPAWN
 *    grants — rather than about the kernel's final set.
 *    What the host does NOT put in it is `pluginRoot`. A value under this
 *    plugin's bundle root, a value under a SIBLING's bundle under the same
 *    install root, and a value under a bundle root that is itself a symlink out
 *    of that install root are each refused by {@link ceilingSubtractions}, and
 *    each of those three has a case in `confined-plugin-child.test.ts` that
 *    goes red when its entry is removed.
 *    That root is the one the integrity check covers, and a plugin that could
 *    rewrite it could rewrite the bytes its own manifest hash was taken over.
 *    What CAN be in it under that root is `pluginDataDir` — the plugin's own
 *    storage namespace, which the production layout nests inside it
 *    (`~/.lvis/plugins/<id>/data`, `plugin-storage-layout.ts`) — and
 *    directories INSIDE `pluginDataDir`, because a `userChosenDirectory` value
 *    may name the plugin's own default index location and that is where it
 *    lives. Because the data directory is nested there, the exclusion cannot be
 *    expressed by omitting a name from one list; it is the subtraction, applied
 *    between the two halves of {@link resolveUserChosenDirectory}'s ceiling,
 *    that carries it.
 *
 *    THE UNRESOLVED SIBLING is the edge this does not reach. The install-root
 *    entry is the lexical parent of THIS bundle, so a NEIGHBOUR's bundle that
 *    is itself a symlink out of the install root has a canonical form that
 *    entry does not contain, and no entry enumerates the neighbours — that
 *    would mean reading the install directory on every derivation. Stated as a
 *    residual rather than closed, and it is narrower than it sounds: the host
 *    is what creates an install directory, so a bundle root that is a link is a
 *    layout nothing in the app produces on its own.
 *  - READ in ASRT is deny-only — `allowRead` re-allows a region INSIDE a
 *    covering deny and is inert without one (see `asrt-sandbox.ts`). The deny
 *    floor covers the Electron userData directory, which is where plugins are
 *    installed, so the child would not be able to read its OWN code or data
 *    without these re-allows. For the plugin's own two directories this is not
 *    a widening of the floor; it is the floor's own carve-out for the one plugin
 *    this child serves — and it is what makes "cannot read another plugin's data
 *    directory" true rather than aspirational. A `hostDirectory` grant in
 *    {@link PLUGIN_ENVELOPE_GRANTS} DOES widen the floor, deliberately, for the
 *    one plugin whose row names it.
 *
 * On Windows ASRT 0.0.73 supports no per-exec allow grants at all — passing any
 * makes `wrapWorkerCommand` throw — so the wrap carries the deny floor alone
 * (`grantMode: "deny-only"`) and reachability is an ACL question. §4's Windows
 * residual stands unchanged and is not softened here: srt-win confines
 * filesystem and network but NOT process creation, so a confined plugin child
 * on Windows can still spawn. Admitting third-party plugins on Windows is the
 * separate owner decision §7.4 names, not something this spawn resolves.
 */
export async function spawnConfinedPluginChild(
  spec: ConfinedPluginChildSpec,
): Promise<ConfinedPluginChild> {
  const sandboxHome = createSandboxProcessHome();
  let wrapped = false;
  const releaseSandboxState = (): void => {
    if (wrapped) {
      wrapped = false;
      void cleanupAsrtSandboxAfterCommand();
    }
    sandboxHome.cleanup();
  };
  try {
    // Every root the wrap is about to grant is created first, `0o700` — the
    // same thing `worker-spawn.ts` does for the control-socket dir it grants.
    // An allow path that does not exist at wrap time is SILENTLY SKIPPED rather
    // than refused: ASRT 0.0.73's Linux backend drops a non-existent write path
    // and a non-existent read allow path from the bwrap argv with a debug line
    // and no error, and macOS's lexical rule admits the path but the kernel
    // still has no directory to open. Neither reports anything, so without this
    // pass the child would come up with an envelope quietly unequal to the one
    // that was reviewed — the failure to avoid is the silent inequality, not a
    // crash.
    // BOTH lists are walked rather than `read` alone: `read` is documented as a
    // superset of `write`, but nothing in the type or at runtime enforces that,
    // and a write-only root that slipped past it would be the one root this
    // pass exists for and the one it skipped. A creation failure throws, and
    // the plugin then does not load at all rather than loading with an envelope
    // the host did not decide on.
    // IT SITS INSIDE THE `try`, and not for tidiness: the throwaway HOME above
    // is a `mkdtemp` directory that only `releaseSandboxState` removes, and a
    // dangling-symlink grant makes this loop throw on the documented
    // fail-closed path. Run ahead of the `try` it left one such directory
    // behind per failed load, and `config.set` restarts the plugin, so a
    // setting that keeps failing kept accumulating them.
    for (const directory of [...spec.envelope.read, ...spec.envelope.write]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const child = await spawnConfinedChild({
      // `process.execPath` is the Electron binary — in production AND under
      // this repository's own test runner, which launches Vitest through that
      // binary (`scripts/run-vitest-under-electron.mjs`). A child spawned from
      // a test is therefore spawned from the executable production spawns
      // from, which is what makes the confinement suite's `electron` answers
      // measurements rather than artefacts of a Node-versus-Electron runner.
      // `ELECTRON_RUN_AS_NODE` makes that binary behave as Node, which is what
      // removes `electron` from the child's CJS registry — §4's "No Electron"
      // is this environment variable plus the absence of a renderer, not a
      // promise. It does NOT act uniformly across module systems, so
      // `confined-plugin-child.test.ts` asserts each form separately rather
      // than one on the others' behalf.
      command: process.execPath,
      args: [spec.childEntryPath],
      label: `plugin-child:${spec.pluginId}`,
      grantMode: process.platform === "win32" ? "deny-only" : "allow-list",
      allowRead: [...spec.envelope.read, sandboxHome.path],
      allowWrite: [...spec.envelope.write, sandboxHome.path],
      baseEnv: buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: "1" }),
      extraEnv: { ...sandboxHome.env },
      // The child is a JSON-RPC server whose pipes the host owns, so unlike the
      // Python worker it needs stdin.
      stdio: ["pipe", "pipe", "pipe"],
      onWrapped: () => {
        wrapped = true;
      },
    });
    if (!child.stdin || !child.stdout) {
      child.kill("SIGKILL");
      throw new Error(`[out-of-process-plugin] ${spec.pluginId}: child has no pipes`);
    }
    // Diagnostics only. The child rebinds everything except the framer to
    // stderr precisely so a stray plugin `console.log` lands here instead of
    // corrupting the protocol.
    child.stderr?.on("data", (chunk: Buffer) => {
      log.debug(`[${spec.pluginId}] ${chunk.toString("utf-8").trimEnd()}`);
    });
    child.once("exit", releaseSandboxState);
    return {
      link: {
        input: child.stdout,
        output: child.stdin,
        terminate: (reason) => {
          log.debug(`[${spec.pluginId}] terminating child: ${reason}`);
          child.kill("SIGTERM");
        },
        onGone: (handler) => {
          child.once("exit", (code, signal) =>
            handler(
              `[out-of-process-plugin] ${spec.pluginId}: child exited ` +
                `code=${String(code)} signal=${String(signal)}`,
            ),
          );
          child.once("error", (error: Error) =>
            handler(`[out-of-process-plugin] ${spec.pluginId}: child error: ${error.message}`),
          );
        },
      },
    };
  } catch (error) {
    releaseSandboxState();
    throw error;
  }
}

export interface OutOfProcessPluginSpec {
  readonly manifest: PluginManifest;
  /** The resolved, real entry path of the PLUGIN (not of the child runtime). */
  readonly entryPath: string;
  /**
   * How the factory obtains a child. Defaults to the confined spawn; a test may
   * supply paired streams so the protocol can be exercised without a process.
   */
  readonly connect?: (spec: ConfinedPluginChildSpec) => Promise<ConfinedPluginChild>;
  /** Defaults to the emitted `plugin-child-main.js` under the runtime asset dir. */
  readonly childEntryPath?: string;
}

/**
 * Read a plugin's declared tool names.
 *
 * The same derivation `buildMethodMap` performs, and it is repeated here rather
 * than shared because it answers a different question: that one asks which
 * handlers an instance HAS, this one tells the child which handlers the host
 * will ask it for. Passing the declared set is what stops a compromised child
 * announcing a tool the reviewed manifest never contained.
 */
function declaredToolNames(manifest: PluginManifest): string[] {
  return [...new Set((manifest.tools ?? []).map((tool) => tool.name))];
}

/**
 * The `tools/call` arguments object for one invocation.
 *
 * Refuses anything that is neither absent nor a plain object. Coercing a
 * string or an array to `{}` would turn "you invoked this tool wrongly" into
 * "you invoked it with no payload", which the plugin would answer as a normal
 * call — a wrong answer with no error anywhere.
 */
function asToolArguments(
  pluginId: string,
  toolName: string,
  payload: unknown,
): Record<string, unknown> {
  if (payload === undefined) return {};
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(
      `[out-of-process-plugin] ${pluginId}: tool '${toolName}' payload must be an ` +
        `object or absent to cross the boundary, received ${typeof payload}`,
    );
  }
  return payload as Record<string, unknown>;
}

/**
 * Read a tool result off the MCP reply.
 *
 * `_meta[RAW_RESULT_META]` and NOT `content[0].text`: the text branch is lossy,
 * because a plugin returning the string `'{"a":1}'` and one returning the
 * object `{a:1}` produce the same text. The raw value is the plugin's own
 * return, and this is the same key the in-process delegate uses, so a tool's
 * result has one representation regardless of which arm ran it.
 */
function readToolResult(pluginId: string, toolName: string, result: unknown): unknown {
  if (typeof result !== "object" || result === null) {
    throw new Error(
      `[out-of-process-plugin] ${pluginId}: tool '${toolName}' returned no result body`,
    );
  }
  const body = result as { isError?: boolean; content?: unknown; _meta?: Record<string, unknown> };
  if (body.isError === true) {
    // The child turns a throwing handler into an `isError` result, which is the
    // mechanism `plugin-mcp-server.ts` already has for the child→host
    // direction (§3.3). The identity that survives is the message; nothing is
    // reconstructed by matching it.
    const content = Array.isArray(body.content) ? body.content : [];
    const first = content[0] as { text?: unknown } | undefined;
    throw new Error(
      typeof first?.text === "string"
        ? first.text
        : `[out-of-process-plugin] ${pluginId}: tool '${toolName}' failed`,
    );
  }
  const meta = body._meta;
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, RAW_RESULT_META)) {
    throw new Error(
      `[out-of-process-plugin] ${pluginId}: tool '${toolName}' returned a result ` +
        `without '${RAW_RESULT_META}' — the child and the host disagree about the wire`,
    );
  }
  return meta[RAW_RESULT_META];
}

/**
 * Build the factory the lifecycle calls in place of the in-process one.
 *
 * The returned factory does the whole of the boundary's setup — spawn,
 * dispatcher assembly, construct — inside ONE call, which is what puts it under
 * the host's existing `runPluginFactoryWithTimeout`. A child that never
 * finishes constructing therefore fails the plugin exactly as a factory that
 * never resolves does today, with no new timeout policy invented for it.
 */
export function createOutOfProcessPluginFactory(
  spec: OutOfProcessPluginSpec,
): RuntimePluginFactory {
  const connect = spec.connect ?? spawnConfinedPluginChild;
  const childEntryPath = spec.childEntryPath ?? resolvePluginChildEntryPath();
  const pluginId = spec.manifest.id;

  return async (context: PluginRuntimeContext): Promise<RuntimePlugin> => {
    // Minted per factory call, which is per incarnation. Its job (§2.4) is that
    // the child is told which incarnation it serves and a message naming a
    // different one is refused; a fresh id per construction is exactly that.
    const generationId = randomUUID();
    const hostApi = context.hostApi as unknown as DispatchableHostApi;
    // Derived ONCE, here, and then held: the spawn wraps the child with it and
    // the dispatch table checks delegated workers against it, so the two cannot
    // be looking at different answers to the same question. Deriving it before
    // the spawn is also what makes a refused widening fail construction rather
    // than produce a child confined more narrowly than the host decided.
    const envelope = derivePluginChildEnvelope({
      pluginId,
      pluginRoot: context.pluginRoot,
      pluginDataDir: context.pluginDataDir,
      configValue: (key) => hostApi.config.get(key),
    });
    const child = await connect({ pluginId, envelope, childEntryPath });

    let live = true;
    const transport = new PluginChildTransport({
      pluginId,
      generationId,
      // The boundary's own liveness, not a second authority. The authoritative
      // check is still `enforceActiveHostApi` on the object below, which throws
      // on every member once the incarnation deactivates — and which the child
      // cannot reach around, because it is on the other side of a pipe. This
      // one exists so a call arriving after `stop()` is refused at the wire
      // instead of being carried to a hostApi that will refuse it anyway.
      isActive: () => live,
      table: createBoundHostApiDispatchTable(hostApi, envelope),
      link: child.link,
    });
    transport.start();

    /**
     * Every host-owned watcher for this incarnation, ended together.
     *
     * A LIST rather than three named disposers, because REGISTERING one can
     * fail: `hostApi` here is the generation-scoped proxy, and every member on
     * it throws once that generation retires. A failure partway through has to
     * end the ones that already exist, and by this line the child is already
     * spawned — so anything that escapes without this leaves a live process
     * reading stdin with nobody subscribed on its behalf.
     */
    const hostWatchers: Array<() => void> = [];
    const stopHostWatchers = (): void => {
      while (hostWatchers.length > 0) hostWatchers.pop()?.();
    };
    /**
     * Give up the child this call spawned, and everything registered for it.
     *
     * ONE teardown for the whole bring-up below, rather than a guard around the
     * single step most likely to throw. Every step after the spawn can fail —
     * the watcher registrations, the two hostApi reads that build the child's
     * context, `construct` itself, and the snapshot pushed once it returns —
     * and each of them fails with the same thing already owned: a child
     * process, an open transport, and however many watchers exist.
     *
     * NOT the same path `instance.stop()` takes, and deliberately so: a normal
     * stop keeps `live` true across the plugin's own `stop()` hook so that hook
     * can still reach hostApi, and flips it only afterwards. Here there is no
     * hook to run — the plugin never became an instance — so the flip comes
     * first and nothing the child sends after it is honoured.
     */
    const abandonChild = (reason: string): void => {
      live = false;
      stopHostWatchers();
      transport.close(reason);
    };

    try {
      // The host re-pushes the installed-plugin snapshot the child answers
      // `getInstalledPluginIds` from. It is the host's OWN subscription, separate
      // from any the plugin opens: the member has to answer whether or not the
      // plugin ever subscribed to `onPluginsChanged`.
      hostWatchers.push(hostApi.onPluginsChanged(() => {
        transport.sendToChild({
          wire: HOST_API_WIRE_VERSION,
          pluginId,
          generationId,
          kind: "installed-plugins",
          pluginIds: hostApi.getInstalledPluginIds(),
        });
      }));

      /**
       * The host re-pushes the config snapshot the child answers `config.get`
       * from. Also the host's OWN subscription, and for the same reason as the
       * one above: `config.get` has to answer whether or not the plugin ever
       * called `config.onChange`, and without a re-push it would answer with the
       * value the key had at construction for the life of the process.
       *
       * `"*"` is the change bus's every-key wildcard, so this fires for a user's
       * settings edit and for the plugin's own `config.set` alike. The bus emits
       * INSIDE `config.set`'s persistence chain, before that call's reply is
       * produced — which is what makes the contract's ordering obligation ("the
       * push is emitted before the `config.set` reply") hold on the wire rather
       * than by luck: both are written to the same pipe in that order.
       *
       * The callback's value is ignored on purpose. It carries one key's new
       * value and not which key, and a snapshot rebuilt through `config.get` is
       * the same merge the in-process member reads — one authority for what a
       * config value is, rather than a second assembled from change events.
       */
      const configKeys = resolvableConfigKeys(spec.manifest, context.config);
      hostWatchers.push(hostApi.config.onChange("*", () => {
        const values: Record<string, unknown> = {};
        for (const key of configKeys) {
          const value = hostApi.config.get(key);
          // Absent, not `undefined`: the wire distinguishes "unset" from "has a
          // value" by presence in this record, because JSON has no `undefined`.
          if (value !== undefined) values[key] = value;
        }
        transport.sendToChild({
          wire: HOST_API_WIRE_VERSION,
          pluginId,
          generationId,
          kind: "config-snapshot",
          keys: configKeys,
          values,
        });
      }));
      /**
       * The allow-listed host preferences, read through the SAME member a plugin
       * would call — so the snapshot is the reader's answer, not a second one.
       *
       * `undefined` when this host implements no `getAppPreference`: the member
       * is optional on `PluginHostApi`, and a child seeded with an empty snapshot
       * could not tell "unset" from "unavailable". Not seeding at all keeps those
       * apart, because the child's member throws when nothing was seeded.
       *
       * NO HOST THE APP BUILDS TAKES THAT BRANCH — `host-api-factory.ts` always
       * defines the member — so it is the shape of a partial hostApi assembled in
       * a test, kept because the optional member and this reader are two objects
       * that nothing forces to agree.
       */
      const readAppPreferences = ():
        | { keys: readonly string[]; values: Record<string, unknown> }
        | undefined => {
        const read = hostApi.getAppPreference;
        if (typeof read !== "function") return undefined;
        const values: Record<string, unknown> = {};
        for (const key of HOST_PUBLIC_PREFERENCE_KEYS) {
          const value = read.call(hostApi, key);
          // Absent, not `undefined`: the wire distinguishes "unset" from "has a
          // value" by presence in this record, because JSON has no `undefined`.
          if (value !== undefined) values[key] = value;
        }
        return { keys: HOST_PUBLIC_PREFERENCE_KEYS, values };
      };

      /**
       * Send the child the preferences as they read RIGHT NOW.
       *
       * One function for the watcher below and for the post-construct push, so
       * the two cannot disagree about what a snapshot contains.
       */
      const pushPreferenceSnapshot = (): void => {
        const snapshot = readAppPreferences();
        // A host with no reader never seeded the child, so there is nothing this
        // push could correct. Unreachable for the same reason the branch above
        // is; it is here so the two stay one decision rather than two.
        if (!snapshot) return;
        transport.sendToChild({
          wire: HOST_API_WIRE_VERSION,
          pluginId,
          generationId,
          kind: "preference-snapshot",
          keys: snapshot.keys,
          values: snapshot.values,
        });
      };

      /**
       * The host re-pushes the preference snapshot the child answers
       * `getAppPreference` from — the third host-owned watcher, and the one that
       * makes the member answerable out of process at all.
       *
       * `getAppPreference` is synchronous, so §3.1 answers it from a snapshot,
       * and a snapshot with no re-push is the value the preference held at plugin
       * start. `ms-graph` reads `webView.preferredFlow` at CALL time, so it would
       * have read a stale answer for the life of the process with nothing
       * reporting it. The bus announces only a REAL change to an allow-listed
       * key (`publishAppPreferenceChange` diffs before emitting), so an unrelated
       * settings save costs nothing here.
       */
      hostWatchers.push(subscribeAppPreferenceChange(pushPreferenceSnapshot));

      const constructionPreferences = readAppPreferences();
      const childContext: PluginChildContext = {
        pluginId,
        pluginRoot: context.pluginRoot,
        hostRoot: context.hostRoot,
        pluginDataDir: context.pluginDataDir,
        generationId,
        installedPluginIds: hostApi.getInstalledPluginIds(),
        ...(context.config !== undefined ? { config: context.config } : {}),
        // Omitted entirely when the host implements no reader, which is what lets
        // the child tell "unset" from "unavailable".
        ...(constructionPreferences ? { appPreferences: constructionPreferences } : {}),
      };
      const constructParams: PluginConstructParams = {
        wire: PLUGIN_INSTANCE_WIRE_VERSION,
        manifest: spec.manifest,
        context: childContext,
        entryPath: spec.entryPath,
        declaredToolNames: declaredToolNames(spec.manifest),
      };

      const construction = (await transport.request(
        PLUGIN_INSTANCE_METHODS.construct,
        constructParams as unknown as Record<string, unknown>,
        // The child performs BOTH halves of what the in-process path splits
        // between `importPluginFactory` and the factory call, so the import
        // bound is applied here and the outer factory bound covers the rest. A
        // child that hangs is killed by this deadline rather than left running
        // under a confinement nobody is watching.
        TOOL_TIMEOUT_POLICY.pluginImportMs + TOOL_TIMEOUT_POLICY.pluginFactoryMs,
      )) as PluginConstructResult;

      /**
       * The seed above was read BEFORE the child could receive anything, so this
       * re-push closes the window between the two.
       *
       * A `preference-snapshot` sent while the child is still constructing is
       * DROPPED: the child routes notifications through a runtime it assigns only
       * after the plugin module has imported and its factory has run
       * (`plugin-child-main.ts`). The two watchers above survive that: neither
       * compares anything, so the next event either of them receives re-pushes
       * its whole snapshot and repairs the drop. Preferences do not work that
       * way — the bus announces only a MOVE, and the value that moved is already
       * the current one — so the child would answer `getAppPreference` with its
       * construction value until the preference moved AGAIN, which is exactly the
       * staleness this member was wired to end.
       *
       * Sending it here cannot be dropped in turn: the child assigns its runtime
       * before it writes the construct reply, this runs after that reply arrived,
       * and one pipe delivers both in order.
       */
      pushPreferenceSnapshot();

      const handlers: Record<string, PluginToolHandler> = {};
      for (const toolName of construction.implementedToolNames) {
        handlers[toolName] = async (payload?: unknown) => {
          const result = await transport.request("tools/call", {
            name: toolName,
            // MCP's `tools/call` params are an OBJECT, so an absent payload
            // crosses as `{}` and the child's delegate turns it back into
            // "absent" — the same conversion the in-process delegate performs.
            // A payload that is neither absent nor an object cannot make that
            // round trip, and is refused rather than silently replaced by `{}`.
            arguments: asToolArguments(pluginId, toolName, payload),
          });
          return readToolResult(pluginId, toolName, result);
        };
      }

      const instance: RuntimePlugin = {
        handlers,
        /**
         * ALWAYS present, unlike the other two hooks.
         *
         * `stop` is the host's only hand on the child's lifetime: the lifecycle
         * calls `instance.stop?.()` when it retires a generation, and if the
         * proxy omitted it for a plugin that implements no `stop()` the child
         * would outlive the incarnation it serves. So the plugin's own hook is
         * optional and the teardown is not.
         */
        stop: async () => {
          stopHostWatchers();
          try {
            if (construction.lifecycleHooks.includes("stop")) {
              await transport.request(
                PLUGIN_INSTANCE_METHODS.stop,
                {},
                // Bounded where the in-process call is not, which §3.1 names as
                // an improvement: today a plugin can hang shutdown forever. The
                // child is killed either way on the next line.
                TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs,
              );
            }
          } finally {
            // Marked dead AFTER the hook, not before. The in-process lifecycle
            // deactivates the incarnation once `stop()` has returned, so a
            // plugin's stop hook can still reach hostApi — flipping this first
            // would refuse the very last thing a plugin does (flush a file, log a
            // shutdown line) and would do it silently, as a `plugin-inactive`
            // rejection on a `void` member the plugin never awaits.
            live = false;
            transport.close(`[out-of-process-plugin] ${pluginId}: stopped`);
          }
        },
      };
      if (construction.lifecycleHooks.includes("start")) {
        instance.start = async () => {
          await transport.request(PLUGIN_INSTANCE_METHODS.start, {});
        };
      }
      if (construction.lifecycleHooks.includes("onPublished")) {
        instance.onPublished = async () => {
          await transport.request(PLUGIN_INSTANCE_METHODS.onPublished, {});
        };
      }
      if (construction.servesUiResources) {
        instance.readUiResource = async (uri: string) => {
          const result = (await transport.request(PLUGIN_INSTANCE_METHODS.readUiResource, {
            uri,
          })) as ReadUiResourceResult;
          if (typeof result?.html !== "string") {
            throw new Error(
              `[out-of-process-plugin] ${pluginId}: readUiResource('${uri}') returned no html`,
            );
          }
          return result.html;
        };
      }
      return instance;
    } catch (error) {
      // Named for the whole bring-up rather than for `construct`: a throw from
      // any of the steps above leaves the same three things owned — the spawned
      // child, the open transport, and the watchers registered so far — and one
      // teardown for all of them is what keeps a failed start from turning into
      // an orphaned process no ledger knows about.
      abandonChild(`[out-of-process-plugin] ${pluginId}: startup failed`);
      throw error;
    }
  };
}
