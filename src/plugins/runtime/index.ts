/**
 * PluginRuntime orchestrator.
 *
 * This class is a thin coordinator that delegates to domain modules:
 *   - manifest-validation.ts  — AJV + MUST/SHOULD checks
 *   - snapshots.ts            — readEnabledManifestSnapshots, load plan, trust boundary
 *   - sandbox.ts              — entry-path resolution, data-dir, noop HostApi
 */

import { basename, dirname, resolve } from "node:path";
import type { ValidateFunction } from "ajv";
import type {
  InstallPolicy,
  PluginAccessSpec,
  PluginAuthSpec,
  PluginConfigSchema,
  PluginHostApi,
  PluginManifest,
  PluginOnboardingSpec,
  PluginToolHandler,
  PluginUiExtension,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
import { createPluginStorage } from "../storage.js";
import type { Actor, PluginDeploymentGuard } from "../deployment-guard.js";
import { resolveDependencies } from "../dependency-resolver.js";
import { appVersionSatisfiesMin } from "../../shared/semver-compare.js";
import { getLvisAppVersion } from "../../shared/app-version.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import type { PluginInstallFailureKind } from "../../shared/plugin-install-failure.js";
import { isDevModeUnlocked } from "../../boot/dev-flags.js";
import { verifyInstallReceipt } from "../plugin-install-receipt.js";
import { updatePluginRegistry } from "../registry.js";
import { runWithCeiling } from "../../tools/executor-ceiling.js";
import { manifestIntegrityState } from "../../permissions/manifest-integrity.js";
import { sessionContext } from "../../engine/session-context.js";
import { runStartWithTimeout, SessionActivationTracker } from "./lifecycle-timeout.js";

import {
  buildManifestValidator,
  getDeclaredEmittedEvents,
  parsePluginJson,
} from "./manifest-validation.js";
import {
  readEnabledManifestSnapshots,
  resolveManifestLoadPlan,
} from "./snapshots.js";
import {
  buildImportUrl,
  buildPluginContext,
  createNoopHostApi,
  ensurePluginDataDir,
  resolveEntryPath,
  resolveRealEntryPath,
} from "./sandbox.js";
import type { LoadedPlugin, ManifestLoadPlan, ManifestSnapshot, SinglePluginStartResult } from "./types.js";
import { buildPluginCard } from "./cards.js";
import { PerfStatsTracker } from "./perf-stats.js";
import type { PluginPerfStats } from "./perf-stats.js";
import { ConfigOverrideStore } from "./config-overrides.js";
import {
  assertEventEmitAccess,
  assertEventSubscribeAccess,
  assertUiActionInvokable,
} from "./access-control.js";
import { PreparationTracker } from "./preparation.js";
import {
  buildMethodMap,
  declaredRuntimeMethods,
  declaredUiInvokableMethods,
  importPluginFactory,
} from "./plugin-loader.js";
import { isModelVisible } from "./tool-visibility.js";
import type { InvocationOrigin } from "./origin-chain.js";
import { createLogger } from "../../lib/logger.js";
import { plog, PluginPhase } from "../lifecycle-log.js";
const log = createLogger("plugin-runtime");
const START_FAILURE_STOP_TIMEOUT_MS = 2_000;
const BOOT_PREFLIGHT_CONCURRENCY = 4;

type PluginIntegrityCheckResult =
  | {
      ok: true;
      verified?: {
        installSource: "marketplace" | "local-dev";
        signerKeyId: string | null;
        artifactSha256: string | null;
      };
    }
  | {
      ok: false;
      reason: string;
      error?: unknown;
    };

type BootPreflightOutcome =
  | {
      ok: true;
      plan: ManifestLoadPlan;
      manifest: PluginManifest;
      approvedPluginAccess: PluginAccessSpec | undefined;
      integrityResult?: PluginIntegrityCheckResult;
    }
  | {
      ok: false;
      plan: ManifestLoadPlan;
      kind: "integrity";
      integrityResult: PluginIntegrityCheckResult & { ok: false };
    }
  | {
      ok: false;
      plan: ManifestLoadPlan;
      kind: "manifest";
      error: unknown;
    };

/**
 * Bounded parallel map whose result positions always match the input order.
 * Receipt hashing is I/O-heavy, so an unbounded Promise.all can make startup
 * slower on large managed fleets even though a small amount of overlap helps.
 */
async function mapBoundedInOrder<T, R>(
  items: readonly T[],
  concurrency: number,
  mapItem: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapItem(items[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker()),
  );
  return results;
}

/**
 * Hard cap on the HTML one {@link RuntimePlugin.readUiResource} call may return
 * (see {@link PluginRuntime.readUiResource}). An MCP App card inlines its own
 * JS/CSS, so it is legitimately large — but it is a CARD, not a payload channel:
 * bounding it keeps a runaway hook from ballooning the render path. Exported so
 * the test pins the boundary rather than re-deriving it.
 */
export const MAX_UI_RESOURCE_HTML_BYTES = 4 * 1024 * 1024;

export { runStartWithTimeout };
export type { PluginPerfStats };

export type { InstallPolicy };
export { resolveManifestLoadPlan, readEnabledManifestSnapshots };

// Re-export public interface types so callers that do
// `import { PluginCard, PluginPerfStats } from "./runtime/index.js"` work.
export type { ManifestLoadPlan, ManifestSnapshot };

/**
 * Option C — non-active plugin catalog card.
 */
export interface PluginCard {
  id: string;
  name: string;
  description: string;
  sampleTools: string[];
  /** All tool names declared in the manifest (filtered by toolRegistry visibility when provided). */
  tools: string[];
  /** Capability tags declared in manifest.capabilities. */
  capabilities: string[];
  /** tool name → the tool's own `description` (#885 v6 — toolSchemas removed). */
  toolDescriptions?: Record<string, string>;
  /** true when the plugin is protected from ordinary user uninstall/disable */
  isManaged?: boolean;
  /** Install policy declared in the manifest: "admin" (IT-managed) or "user" (anyone). */
  installPolicy?: "admin" | "user";
  /** Runtime load status derived from loaded/failed/disabled runtime state. */
  loadStatus: "loaded" | "preparing" | "failed" | "disabled";
  /** Whether this plugin's tools are currently exposed to the model. */
  active: boolean;
  /** Whether a plugin instance is loaded and callable even when inactive. */
  runtimeLoaded: boolean;
  /** Current dependency/runtime preparation step while loadStatus is "preparing". */
  preparationStatus?: PluginPreparationStatus;
  /** Optional Lucide icon name declared in the plugin manifest. */
  icon?: string;
  /** Optional short text rendered in place of a Lucide icon. */
  iconText?: string;
  /** Manifest-declared sidebar UI metadata, even before the plugin is loaded. */
  uiExtensions?: PluginUiExtension[];
  version?: string;
  publisher?: string;
  configSchema?: PluginConfigSchema;
  /** Optional declarative auth contract — see architecture.md §9.4a "Plugin-Owned OAuth — Host UI Surface". */
  auth?: PluginAuthSpec;
  /** Declarative egress disclosure copied from the plugin manifest/catalog. */
  networkAccess?: PluginManifest["networkAccess"];
  /** Declarative first-run guidance copied unchanged from the manifest. */
  onboarding?: PluginOnboardingSpec;
  /** Structured marketplace install failure classification for Doctor UI. */
  installFailureKind?: PluginInstallFailureKind;
  /** User-visible install/load failure detail preserved for Doctor diagnostics. */
  installFailureMessage?: string;
  /**
   * Request slugs that can address this installed plugin in marketplace
   * lifecycle events. This is derived from registry hints, not plugin-specific
   * host knowledge, so renderer surfaces can collapse in-flight install rows
   * onto the canonical plugin card.
   */
  installAliases?: string[];
}

export interface PluginPreparationStatus {
  phase: string;
  message: string;
  progressPct?: number;
  updatedAt: string;
}

export interface PluginPreparationProgressInput {
  phase: string;
  message: string;
  progressPct?: number;
}

export interface PluginToolInvocationContext {
  /** SoT: {@link InvocationOrigin} (`plugins/runtime/origin-chain.ts`). */
  origin: InvocationOrigin;
  callerPluginId?: string;
  ownerPluginId?: string;
  /**
   * True only when the renderer call was made during an active browser user
   * activation. Renderer-provided booleans are not trusted directly; preload
   * derives this from `navigator.userActivation.isActive`.
   *
   * Only the trusted host renderer (`origin: "ui"` — the plugin's own React
   * panel) can produce this. An `origin: "mcp-app"` call NEVER sets it: the
   * guest iframe's activation state is not the host frame's, and a gesture claim
   * synthesized inside untrusted card HTML is unverifiable.
   */
  userAction?: boolean;
  /**
   * Issue #664 P2 — UI-origin chain propagation.
   *
   * When a host wrapper tool (sourced from a user click in the panel) calls
   * `ctx.callTool(...)` to delegate to another plugin's tool, the inner call
   * is dispatched with `origin: "plugin"` but the *user* already approved the
   * outer wrapper at the UI. Without propagation the inner call hits the
   * headless reviewer lane (`headless: origin !== "ui"`), defeating the user
   * approval the wrapper UX promised.
   *
   * `parentOrigin` carries the *effective* origin of the user action that
   * triggered the call chain. The plugin runtime sets it to the calling
   * HostApi's `origin` so a UI→plugin→plugin chain stays UI-origin all the
   * way down. The reviewer lane reads this through the executor's
   * {@link ToolPermissionContext} so the inner call is treated as
   * foreground (headless=false) and the user's outer approval is honoured.
   *
   * Boundary: only wrapper tools owned by the host or first-party plugins
   * benefit from this — third-party plugins still cross the same trust gate
   * because the reviewer continues to evaluate each call. The propagation
   * only changes the `headless` lane decision, not the per-tool deny/allow
   * rules or the per-tool category × source × trust matrix.
   *
   * SoT: {@link InvocationOrigin}.
   */
  parentOrigin?: InvocationOrigin;
}

export type PluginToolInvocationDelegate = (
  method: string,
  payload: unknown,
  context: PluginToolInvocationContext,
) => Promise<unknown>;

/**
 * Kebab-case deny code (CLAUDE.md §IPC Error Message Language Convention) for the
 * ONE thing an MCP App is denied that the spec's `["app"]` semantics alone would
 * otherwise allow: the plugin's manifest-declared auth trio
 * (`manifest.auth.{statusTool,loginTool,logoutTool}`). See {@link callFromApp} for
 * why this is a deliberate narrowing, not a bug.
 */
export const MCP_APP_AUTH_TOOL_NOT_APP_CALLABLE = "mcp-app-auth-tool-not-app-callable";

export interface PluginStartPreparationContext {
  pluginId: string;
  manifest: PluginManifest;
  manifestPath: string;
  pluginRoot: string;
  reportProgress?: (status: PluginPreparationProgressInput) => void;
}

export interface PluginRuntimeOptions {
  hostRoot: string;
  manifestPaths?: string[];
  registryPath?: string;
  pluginsRoot?: string;
  configOverrides?: Record<string, Record<string, unknown>>;
  /** Plugin-scoped HostApi factory — injected by boot.ts */
  createHostApi?: (pluginId: string, manifest: PluginManifest, pluginDataDir: string) => PluginHostApi;
  deploymentGuard?: PluginDeploymentGuard;
  installReceiptCacheRoot?: string;
  auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  /**
   * Fires when a plugin's tear-down path runs (`restartPlugin` stop phase,
   * `restartAll` stop phase per plugin, `disable`, `removePlugin`,
   * `reloadPlugin` stop phase, and `cleanupFailedStartRuntimeState` when a
   * fresh start fails mid-`restartAll`). The host wires this to
   * `toolRegistry.unregisterByPlugin` + `keywordEngine.unregisterByPlugin`
   * + `conversationLoop.onPluginDisabled` so transient runtime state stays
   * in sync with the runtime's plugin map.
   *
   * May fire more than once per logical cycle for the same pluginId — e.g.,
   * `restartAll` fires it from its pre-stop fan-out and then again from
   * `cleanupFailedStartRuntimeState` if that plugin's start fails. Callbacks
   * MUST be idempotent.
   */
  onDisable?: (pluginId: string) => void;



  onEnable?: (pluginId: string) => void;
  /**
   * Fires when the user toggles active/inactive without unloading the runtime.
   * Unlike {@link onDisable}, this MUST NOT unregister plugin tools from the
   * execution registry: auth/config/UI calls remain runtime-callable while
   * model exposure is gated by ConversationLoop scope.
   */
  onActiveStateChange?: (pluginId: string, enabled: boolean) => void;
  /**
   * Optional dependency preparation gate. When this returns a Promise, plugin
   * loading/start is deferred without blocking app boot; calls into the
   * plugin fail with a clear "preparing" message until the Promise resolves.
   */
  preparePluginStart?: (context: PluginStartPreparationContext) => Promise<void> | void | null | undefined;
}

type RestartPluginResult = "started" | "deferred" | "failed" | undefined;

export class PluginRuntime {
  private readonly hostRoot: string;
  private readonly manifestPaths: string[];
  private readonly registryPath?: string;
  private readonly pluginsRoot?: string;
  private readonly configStore: ConfigOverrideStore;
  private readonly createHostApi?: (pluginId: string, manifest: PluginManifest, pluginDataDir: string) => PluginHostApi;
  private readonly deploymentGuard?: PluginDeploymentGuard;
  private readonly installReceiptCacheRoot?: string;
  private readonly auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  private readonly onDisable?: (pluginId: string) => void;
  private readonly onEnable?: (pluginId: string) => void;
  private readonly onActiveStateChange?: (pluginId: string, enabled: boolean) => void;
  private readonly preparePluginStart?: (context: PluginStartPreparationContext) => Promise<void> | void | null | undefined;
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly methodMap = new Map<string, { pluginId: string; handler: PluginToolHandler }>();
  private readonly perf = new PerfStatsTracker();
  private readonly disposers = new Map<string, Array<() => void>>();
  private readonly knownPluginManifests = new Map<string, PluginManifest>();
  private readonly knownPluginAccessGrants = new Map<string, PluginAccessSpec | undefined>();
  private readonly knownInstallAliases = new Map<string, Set<string>>();
  private readonly knownToolOwners = new Map<string, string>();
  private readonly knownEventOwners = new Map<string, string>();
  private readonly failedPluginIds = new Set<string>();
  private readonly failedPluginStubs = new Map<string, { name: string; description: string }>();
  /**
   * Structured load-failure classification for the Plugin Doctor, keyed by the
   * plugin id (or the registry-id hint when the manifest never parsed).
   * Populated by {@link markFailed}; only surfaced on cards whose `loadStatus`
   * is `"failed"`, and cleared when the plugin loads successfully. Lets the
   * Doctor tell reinstall-fixable failures (stale/pre-v6 schema manifest) apart
   * from not-locally-fixable ones (app-version incompatibility).
   */
  private readonly loadFailureInfo = new Map<
    string,
    { installFailureKind?: PluginInstallFailureKind; installFailureMessage?: string }
  >();
  private readonly disabledPluginIds = new Set<string>();
  /**
   * #1176 active/inactive — plugins toggled inactive at runtime via
   * {@link setPluginEnabled}. Orthogonal to {@link disabledPluginIds} (the
   * load/unload state): an inactive plugin stays *loaded* but its tools are
   * hidden from the model's per-turn scope. `enabled !== false` is the active
   * predicate, so absence from this set means active (migration-safe default).
   */
  private readonly inactivePluginIds = new Set<string>();
  private readonly preparation: PreparationTracker;
  private readonly pendingRestarts = new Map<string, Promise<RestartPluginResult>>();
  private readonly pendingRestartPreparations = new Map<string, Promise<void>>();
  private readonly pluginUiRevisions = new Map<string, number>();
  private nextPluginUiRevision = 0;
  private toolInvocationDelegate: PluginToolInvocationDelegate | null = null;
  private loaded = false;
  /** §B-1 — lazily-compiled AJV validator for plugin.schema.json. */
  private manifestValidator: ValidateFunction | null = null;
  private manifestValidatorPromise: Promise<ValidateFunction> | null = null;

  constructor(options: PluginRuntimeOptions) {
    this.hostRoot = resolve(options.hostRoot);
    this.manifestPaths = (options.manifestPaths ?? []).map((path) => resolve(path));
    this.registryPath = options.registryPath ? resolve(options.registryPath) : undefined;
    this.pluginsRoot = options.pluginsRoot ? resolve(options.pluginsRoot) : undefined;
    this.configStore = new ConfigOverrideStore(options.configOverrides ?? {});
    this.createHostApi = options.createHostApi;
    this.deploymentGuard = options.deploymentGuard;
    this.installReceiptCacheRoot = options.installReceiptCacheRoot
      ? resolve(options.installReceiptCacheRoot)
      : undefined;
    this.auditLog = options.auditLog;
    this.onDisable = options.onDisable;
    this.onEnable = options.onEnable;
    this.onActiveStateChange = options.onActiveStateChange;
    this.preparePluginStart = options.preparePluginStart;
    this.preparation = new PreparationTracker({
      preparePluginStart: options.preparePluginStart,
      instantiateAndStartSinglePlugin: (plan, manifest, approvedPluginAccess, opts) =>
        this.instantiateAndStartSinglePlugin(plan, manifest, approvedPluginAccess, opts),
      markFailed: (pluginId, stub) => this.markFailed(pluginId, stub),
      onDisable: options.onDisable,
    });
  }

  // ─── Manifest Validator (lazy) ─────────────────────────────────────────────

  private async getManifestValidator(): Promise<ValidateFunction> {
    if (this.manifestValidator) return this.manifestValidator;
    if (!this.manifestValidatorPromise) {
      this.manifestValidatorPromise = buildManifestValidator()
        .then((validator) => {
          this.manifestValidator = validator;
          return validator;
        })
        .finally(() => {
          this.manifestValidatorPromise = null;
        });
    }
    return this.manifestValidatorPromise;
  }

  private async readManifest(path: string): Promise<PluginManifest> {
    const validator = await this.getManifestValidator();
    try {
      return await parsePluginJson(path, validator);
    } catch (err) {
      // Supply-chain visibility — manifest schema reject / cross-field violation /


      this.auditLog?.("error", "plugin_manifest_rejected", {
        manifestPath: path,
        error: err instanceof Error ? err.message.slice(0, 500) : String(err),
      });
      throw err;
    }
  }

  // ─── Sandbox helpers (instance-context wrappers) ───────────────────────────

  private resolveEntryPathForPlugin(pluginRoot: string, entry: string): string {
    return resolveEntryPath(pluginRoot, entry, this.hostRoot);
  }

  private ensureDataDir(pluginId: string, pluginRoot: string): string {
    return ensurePluginDataDir(pluginId, pluginRoot, this.pluginsRoot);
  }

  private buildHostApi(pluginId: string, manifest: PluginManifest, pluginDataDir: string): PluginHostApi {
    const hostApi = this.createHostApi?.(pluginId, manifest, pluginDataDir) ?? createNoopHostApi(pluginId, pluginDataDir);
    // Defence-in-depth: PluginHostApi.storage is required but partial hostApi
    // objects from test harnesses may omit it.
    if (!hostApi.storage) {
      hostApi.storage = createPluginStorage(pluginId, pluginDataDir);
    }
    return hostApi;
  }

  private markPluginUiRevision(pluginId: string): number {
    const revision = ++this.nextPluginUiRevision;
    this.pluginUiRevisions.set(pluginId, revision);
    return revision;
  }

  private getPluginUiRevision(pluginId: string): number {
    return this.pluginUiRevisions.get(pluginId) ?? this.markPluginUiRevision(pluginId);
  }

  private buildPluginUiEntryUrl(pluginId: string, manifest: PluginManifest, entryPath: string): string {
    const url = new URL(buildImportUrl(entryPath));
    url.searchParams.set("lvisPluginVersion", manifest.version ?? "0");
    url.searchParams.set("lvisRuntimeRevision", String(this.getPluginUiRevision(pluginId)));
    return url.href;
  }

  // ─── Load Plan & Snapshots ─────────────────────────────────────────────────

  private async resolveManifestLoadPlanInternal(): Promise<ManifestLoadPlan[]> {
    return resolveManifestLoadPlan({
      manifestPaths: this.manifestPaths,
      registryPath: this.registryPath,
      pluginsRoot: this.pluginsRoot,
    });
  }

  private async readSnapshotsInternal(
    loadPlan: ManifestLoadPlan[],
  ): Promise<Map<string, ManifestSnapshot>> {
    const validator = await this.getManifestValidator();
    return readEnabledManifestSnapshots(loadPlan, validator);
  }

  /**
   * #885 v6 — MODEL-ONLY (ratified security decision §2.4a). The `knownToolOwners`
   * map is the pre-runtime `??` fallback in `resolveToolOwner`, feeding the
   * "plugin still installing" guard (`throwIfToolOwnerNotReady`). Today's `tools[]` was model-facing
   * only; a naive all-names `.map` would silently add the app-only auth trio to the
   * access-control map (a widening). `isModelVisible` reproduces today's EXACT set;
   * UI-only ownership still resolves at runtime via `methodMap` (all names), which stays
   * authoritative.
   *
   * HOLDS AFTER app-only tools became registry `Tool`s. Registry membership (what may
   * execute under the gate) and model exposure (what the LLM is shown) were split apart;
   * THIS map independently records names while a plugin is starting, and stays
   * exactly the model-visible set.
   *
   * ONE method, three callers (`rememberPluginManifest`, `load`, single-plugin add), so
   * the MODEL-ONLY `.filter(isModelVisible)` lives once. Pinned by
   * `__tests__/known-tool-owners-model-only.test.ts` (which exercises
   * `rememberPluginManifest`; the other two callers share this method, so the pin covers
   * them too). A future all-names `.map` here flips that pin closed.
   */
  private rememberToolOwners(pluginId: string, manifest: PluginManifest): void {
    for (const t of (manifest.tools ?? []).filter(isModelVisible)) {
      this.knownToolOwners.set(t.name, pluginId);
    }
  }

  private rememberPluginManifest(
    pluginId: string,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
  ): void {
    this.knownPluginManifests.set(pluginId, manifest);
    if (approvedPluginAccess) {
      this.knownPluginAccessGrants.set(pluginId, approvedPluginAccess);
    } else {
      this.knownPluginAccessGrants.delete(pluginId);
    }
    for (const [toolName, ownerId] of [...this.knownToolOwners.entries()]) {
      if (ownerId === pluginId) this.knownToolOwners.delete(toolName);
    }
    for (const [eventType, ownerId] of [...this.knownEventOwners.entries()]) {
      if (ownerId === pluginId) this.knownEventOwners.delete(eventType);
    }
    this.rememberToolOwners(pluginId, manifest); // #885 §2.4a MODEL-ONLY (see method)
    for (const eventType of getDeclaredEmittedEvents(manifest)) {
      this.knownEventOwners.set(eventType, pluginId);
    }
  }

  private rememberPluginInstallAlias(pluginId: string, alias: string | undefined): void {
    const normalizedPluginId = pluginId.trim();
    const normalizedAlias = alias?.trim();
    if (!normalizedPluginId || !normalizedAlias || normalizedAlias === normalizedPluginId) return;
    let aliases = this.knownInstallAliases.get(normalizedPluginId);
    if (!aliases) {
      aliases = new Set<string>();
      this.knownInstallAliases.set(normalizedPluginId, aliases);
    }
    aliases.add(normalizedAlias);
  }

  private getPluginInstallAliases(pluginId: string): string[] | undefined {
    const aliases = this.knownInstallAliases.get(pluginId);
    if (!aliases || aliases.size === 0) return undefined;
    return [...aliases].sort();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  waitForPluginReady(pluginId: string): Promise<void> {
    if (this.plugins.has(pluginId)) return Promise.resolve();
    return this.preparation.waitForReady(pluginId);
  }

  /**
   * Verify installed bytes before parsing any manifest, then parse each accepted
   * manifest exactly once. Work overlaps with a conservative bound while the
   * returned array preserves registry/load-plan order for deterministic state
   * projection and failure reporting.
   */
  private async preflightBootLoadPlan(
    loadPlan: ManifestLoadPlan[],
  ): Promise<BootPreflightOutcome[]> {
    if (loadPlan.length === 0) return [];
    // Compile AJV once before concurrent reads. This also prevents parallel
    // callers from paying duplicate schema-compilation cost.
    await this.getManifestValidator();
    return mapBoundedInOrder(
      loadPlan,
      BOOT_PREFLIGHT_CONCURRENCY,
      async (plan): Promise<BootPreflightOutcome> => {
        let integrityResult: PluginIntegrityCheckResult | undefined;
        if (plan.pluginIdHint) {
          try {
            integrityResult = await this.verifyReceiptAndDevGuard(
              plan.pluginIdHint,
              dirname(plan.manifestPath),
              { report: false },
            );
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            integrityResult = {
              ok: false,
              reason: `install receipt verification failed unexpectedly: ${detail}`,
              error,
            };
          }
          if (!integrityResult.ok) {
            return { ok: false, plan, kind: "integrity", integrityResult };
          }
        }
        try {
          const manifest = await this.readManifest(plan.manifestPath);
          return {
            ok: true,
            plan,
            manifest,
            approvedPluginAccess: plan.approvedPluginAccess,
            integrityResult,
          };
        } catch (error) {
          return { ok: false, plan, kind: "manifest", error };
        }
      },
    );
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const loadPlan = await this.resolveManifestLoadPlanInternal();
    for (const plan of loadPlan) {
      const pluginId = plan.pluginIdHint ?? `<unresolved:${basename(dirname(plan.manifestPath))}>`;
      plog("debug", { pluginId, phase: PluginPhase.LOAD_START }, "loading plugin");
    }
    const preflight = await this.preflightBootLoadPlan(loadPlan);
    const enabledManifestSnapshots = new Map<string, ManifestSnapshot>();
    for (const outcome of preflight) {
      if (
        outcome.plan.pluginIdHint
        && "integrityResult" in outcome
        && outcome.integrityResult
      ) {
        this.reportPluginIntegrityResult(outcome.plan.pluginIdHint, outcome.integrityResult);
      }
      if (!outcome.ok) continue;
      const pluginId = outcome.plan.pluginIdHint ?? outcome.manifest.id;
      enabledManifestSnapshots.set(pluginId, {
        manifest: outcome.manifest,
        approvedPluginAccess: outcome.approvedPluginAccess,
      });
      this.rememberPluginInstallAlias(outcome.manifest.id, outcome.plan.pluginIdHint);
      this.knownPluginManifests.set(pluginId, outcome.manifest);
      this.knownPluginAccessGrants.set(pluginId, outcome.approvedPluginAccess);
      this.rememberToolOwners(pluginId, outcome.manifest); // #885 §2.4a MODEL-ONLY (see method)
      for (const eventType of getDeclaredEmittedEvents(outcome.manifest)) {
        this.knownEventOwners.set(eventType, pluginId);
      }
    }
    for (const outcome of preflight) {
      const { plan } = outcome;
      const manifestPath = plan.manifestPath;
      const pluginRoot = dirname(manifestPath);
      let pluginId = plan.pluginIdHint ?? `<unresolved:${basename(dirname(manifestPath))}>`;
      if (!outcome.ok) {
        if (outcome.kind === "integrity") {
          if (plan.pluginIdHint) {
            this.markFailed(plan.pluginIdHint);
          }
          continue;
        }
        const err = outcome.error;
        const reason =
          err instanceof SyntaxError ? "manifest_parse"
          : (err as Error).message?.includes("schema validation") ? "manifest_schema"
          : (err as NodeJS.ErrnoException).code === "ENOENT" ? "manifest_missing"
          : "manifest_read";
        plog("error", { pluginId, phase: PluginPhase.VALIDATION_FAIL, err, reason }, `manifest read failed: ${(err as Error).message}`);
        if (plan.pluginIdHint) {
          this.markFailed(plan.pluginIdHint, {
            name: plan.pluginIdHint,
            description: "Plugin manifest could not be loaded.",
          }, {
            ...(reason === "manifest_schema"
              ? { installFailureKind: "manifest-validation-error" as const }
              : {}),
            installFailureMessage: (err as Error).message,
          });
        }
        continue;
      }
      const { manifest, approvedPluginAccess } = outcome;
      // Reassign to manifest.id so all subsequent phases use the canonical id.
      pluginId = manifest.id;
      this.rememberPluginInstallAlias(manifest.id, plan.pluginIdHint);
      this.knownPluginManifests.set(manifest.id, manifest);
      this.failedPluginStubs.delete(manifest.id);
      this.loadFailureInfo.delete(manifest.id);
      // #1176 M1 fix: inactive plugins (enabled=false) are LOADED just like
      // active ones — only model exposure is gated. Seed inactivePluginIds here
      // so isPluginEnabled() is correct immediately after boot; the boot
      // ToolRegistry sync and hostApi.registerKeywords gate suppress inactive
      // tools/keywords without stop/reload churn.
      if (!plan.enabled) {
        this.inactivePluginIds.add(manifest.id);
      } else {
        // Ensure a previously-inactive plugin becomes active on re-enable.
        this.inactivePluginIds.delete(manifest.id);
      }
      this.disabledPluginIds.delete(manifest.id);
      this.failedPluginIds.delete(manifest.id);
      // Plugin↔app minimum-version gate — HARD BLOCK at LOAD. A plugin already
      // on disk (e.g. installed against a newer host, then the user downgraded
      // the app, or a sideload) must NOT silently run against a too-old app.
      // Skip activation, log an English reason, surface a "needs newer app"
      // stub. Other plugins continue to load (isolation).
      if (this.markIncompatibleAppVersion(manifest)) {
        continue;
      }
      const requiredCapabilities = manifest.requires?.capabilities ?? [];
      if (requiredCapabilities.length > 0) {
        const availableManifests = [...enabledManifestSnapshots.values()]
          .filter((candidate) => candidate.manifest.id !== manifest.id)
          .map((candidate) => candidate.manifest);
        const dependencyResult = resolveDependencies(requiredCapabilities, availableManifests);
        if (!dependencyResult.ok) {
          const reason = `missing required capabilities: ${dependencyResult.missing.join(", ")}`;
          log.error(`${manifest.id} rejected — ${reason}`);
          this.auditLog?.("error", "plugin_dependency_missing", {
            pluginId: manifest.id,
            missing: dependencyResult.missing,
          });
          this.markFailed(manifest.id, {
            name: manifest.name ?? manifest.id,
            description: `Missing capabilities: ${dependencyResult.missing.join(", ")}`,
          });
          continue;
        }
      }
      if (this.preparation.deferStart(plan, manifest, approvedPluginAccess)) {
        continue;
      }
      let entryPath: string;
      try {
        entryPath = this.resolveEntryPathForPlugin(pluginRoot, manifest.entry);
      } catch (err) {
        const reason = (err as Error).message;
        plog("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, err, reason: "entry_path" }, "entry path rejected");
        this.auditLog?.("error", "plugin_entry_path_rejected", {
          pluginId: manifest.id,
          entry: manifest.entry,
          reason,
        });
        this.markFailed(manifest.id);
        continue;
      }
      const resolvedEntryPath = resolveRealEntryPath(entryPath);
      let createPlugin: RuntimePluginFactory | undefined;
      try {
        createPlugin = await importPluginFactory(resolvedEntryPath);
      } catch (err) {
        plog("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, err, reason: "import" }, "import failed");
        this.auditLog?.("error", "plugin_import_failed", {
          pluginId: manifest.id,
          reason: (err as Error).message,
        });
        this.markFailed(manifest.id);
        continue;
      }
      if (!createPlugin) {
        plog("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, reason: "no_default_export" }, "entry does not export default/createPlugin");
        this.markFailed(manifest.id);
        continue;
      }

      const pluginDataDir = this.ensureDataDir(manifest.id, pluginRoot);
      const hostApi = this.buildHostApi(manifest.id, manifest, pluginDataDir);

      const instance = await createPlugin(
        buildPluginContext({
          pluginId: manifest.id,
          pluginRoot,
          hostRoot: this.hostRoot,
          pluginDataDir,
          manifest,
          configOverrides: this.configOverrides,
          hostApi,
        }),
      );

      const methods = new Map<string, PluginToolHandler>();
      for (const toolName of declaredRuntimeMethods(manifest)) {
        const handler = instance.handlers[toolName];
        if (!handler) {
          plog("warn", { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" }, "tool disabled — missing handler");
          continue;
        }
        methods.set(toolName, handler);
        if (this.methodMap.has(toolName)) {
          throw new Error(`Duplicate plugin method registered: ${toolName}`);
        }
        this.methodMap.set(toolName, { pluginId: manifest.id, handler });
        plog("debug", { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_OK, toolName }, "tool registered");
      }

      if (manifest.keywords && manifest.keywords.length > 0) {
        hostApi.registerKeywords(manifest.keywords);
        plog("debug", { pluginId: manifest.id, phase: PluginPhase.REGISTER_KEYWORDS_OK, count: manifest.keywords.length }, "keywords registered");
      }

      this.plugins.set(manifest.id, {
        manifest,
        pluginRoot,
        instance,
        methods,
        approvedPluginAccess,
        started: false,
      });
      this.markPluginUiRevision(manifest.id);
      this.failedPluginIds.delete(manifest.id);
      this.disabledPluginIds.delete(manifest.id);
      plog("debug", { pluginId: manifest.id, phase: PluginPhase.LOAD_OK }, "plugin loaded");
      // NOTE: inactive-plugin model visibility is not a runtime load concern.
      // Boot sync still registers loaded tools for host/UI/auth execution;
      // ConversationLoop scope and the hostApi.registerKeywords gate suppress
      // model-visible tools/keywords for inactive plugins.
    }
    this.loaded = true;
  }

  async startAll(): Promise<void> {
    await this.load();
    const SLOW_THRESHOLD_MS = 5000;
    const failed: Array<{ id: string; reason: string }> = [];

    const tasks = [...this.plugins.values()].map((plugin) => {
      const { id } = plugin.manifest;
      const startedAt = Date.now();
      const slowTimer = setTimeout(() => {
        log.warn(`slow plugin: ${id} (>${SLOW_THRESHOLD_MS}ms)`);
      }, SLOW_THRESHOLD_MS);

      const startPromise = (async () => {
        this.perf.ensure(id);
        try {
          if (!plugin.instance.start) {
            this.perf.setStartupMs(id, Date.now() - startedAt);
            plugin.started = true;
            return;
          }
          await runStartWithTimeout(
            plugin.instance.start.bind(plugin.instance),
            plugin.manifest.startupTimeoutMs,
          );
        } finally {
          clearTimeout(slowTimer);
        }
        const elapsed = Date.now() - startedAt;
        this.perf.setStartupMs(id, elapsed);
        plugin.started = true;
        if (elapsed > SLOW_THRESHOLD_MS) {
          plog("warn", { pluginId: id, phase: PluginPhase.START_SLOW, elapsedMs: elapsed }, "plugin start slow");
        } else {
          plog("debug", { pluginId: id, phase: PluginPhase.START_OK, elapsedMs: elapsed }, "plugin start ok");
        }
      })();

      return startPromise.then(
        () => ({ id, ok: true as const }),
        (err: Error) => ({ id, ok: false as const, reason: err.message }),
      );
    });

    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const item = result.value;
      if (!item.ok) failed.push({ id: item.id, reason: item.reason });
    }

    for (const { id, reason } of failed) {
      plog("error", { pluginId: id, phase: PluginPhase.START_FAIL, reason }, "plugin start failed");
      const plugin = this.plugins.get(id);
      if (!plugin) continue;
      this.markFailed(id);
      this.cleanupFailedStartRuntimeState(id, plugin.methods);
      await this.stopAfterStartFailure(plugin.manifest.id, plugin.instance);
    }
  }

  async stopAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      try {
        await plugin.instance.stop?.();
      } catch (err) {
        log.error(`stopAll failed for ${plugin.manifest.id}: %s`, (err as Error).message);
      }
    }
  }

  async restartAll(): Promise<void> {
    const loadedPluginIds = [...this.plugins.keys()];
    await this.stopAll();
    for (const pluginId of loadedPluginIds) {
      this.onDisable?.(pluginId);
    }
    this.resetLoadedState();
    await this.startAll();
    // Symmetric to the per-plugin onDisable fan-out above: fire onEnable for
    // each plugin that survived the restart so the host's ToolRegistry sync
    // (wired in boot/steps/plugin-runtime.ts) runs without callers having to
    // remember a follow-up sync. Initial boot's `startAll` is the only path
    // that intentionally bypasses onEnable — registration there flows through
    // PluginLoopbackManager (each plugin runs as an in-process MCP server),
    // wired in boot/steps/plugin-runtime.ts, which owns that one-shot.
    // See architecture.md §9.3a.
    if (this.onEnable) {
      for (const pluginId of this.plugins.keys()) {
        this.onEnable(pluginId);
      }
    }
  }

  /**
   * US-3c.2 — Targeted single-plugin restart.
   */
  async restartPlugin(
    pluginId: string,
    opts: { skipPreparation?: boolean } = {},
  ): Promise<RestartPluginResult> {
    const pending = this.pendingRestarts.get(pluginId);
    if (pending) return pending;
    const restart = this.restartPluginInternal(pluginId, opts).finally(() => {
      if (this.pendingRestarts.get(pluginId) === restart) {
        this.pendingRestarts.delete(pluginId);
      }
    });
    this.pendingRestarts.set(pluginId, restart);
    return restart;
  }

  private async restartPluginInternal(
    pluginId: string,
    opts: { skipPreparation?: boolean } = {},
  ): Promise<RestartPluginResult> {
    plog("info", { pluginId, phase: PluginPhase.RESTART_REQUEST }, "restart requested");
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      plog("warn", { pluginId, phase: PluginPhase.RESTART_REQUEST, reason: "not_loaded" }, "restart no-op — plugin not loaded");
      return undefined;
    }

    const loadPlan = await this.resolveManifestLoadPlanInternal();
    const enabledSnapshots = await this.readSnapshotsInternal(loadPlan);
    const snapshot = enabledSnapshots.get(pluginId);
    const targetPlan = loadPlan.find(
      (p) =>
        p.pluginIdHint === pluginId ||
        (p.enabled && this.matchesManifestPath(p.manifestPath, pluginId)),
    );
    const pluginRoot = targetPlan ? dirname(targetPlan.manifestPath) : plugin.pluginRoot;
    const approvedPluginAccess =
      snapshot?.approvedPluginAccess ??
      targetPlan?.approvedPluginAccess ??
      plugin.approvedPluginAccess ??
      this.knownPluginAccessGrants.get(pluginId);
    const integrityResult = await this.verifyReceiptAndDevGuard(pluginId, pluginRoot);
    if (!integrityResult.ok) {
      return "failed";
    }
    let manifest: PluginManifest;
    try {
      manifest =
        snapshot?.manifest ??
        (await this.readManifest(targetPlan?.manifestPath ?? resolve(pluginRoot, "plugin.json")));
    } catch (err) {
      plog("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err, reason: "manifest_read" }, "manifest read failed during restart");
      return "failed";
    }
    const restartPlan: ManifestLoadPlan = targetPlan ?? {
      pluginIdHint: pluginId,
      manifestPath: resolve(pluginRoot, "plugin.json"),
      enabled: true,
      approvedPluginAccess,
    };

    if (!opts.skipPreparation && this.preparePluginStart) {
      const pluginRootForPreparation = dirname(restartPlan.manifestPath);
      let result: Promise<void> | void | null | undefined;
      let preparation = this.pendingRestartPreparations.get(pluginId);
      if (!preparation) {
        try {
          result = this.preparePluginStart({
            pluginId: manifest.id,
            manifest,
            manifestPath: restartPlan.manifestPath,
            pluginRoot: pluginRootForPreparation,
          });
        } catch (err) {
          plog("error", { pluginId, phase: PluginPhase.START_FAIL, err, reason: "restart_dependency_prepare" }, "restart dependency preparation failed");
          return "failed";
        }
        if (result && typeof (result as Promise<void>).then === "function") {
          preparation = Promise.resolve(result);
          this.pendingRestartPreparations.set(pluginId, preparation);
          void preparation.finally(() => {
            if (this.pendingRestartPreparations.get(pluginId) === preparation) {
              this.pendingRestartPreparations.delete(pluginId);
            }
          }).catch(() => {});
        }
      }
      if (preparation) {
        try {
          await preparation;
        } catch (err) {
          plog("error", { pluginId, phase: PluginPhase.START_FAIL, err, reason: "restart_dependency_prepare" }, "restart dependency preparation failed");
          return "failed";
        }
      }
    }

    const entryPath = this.resolveEntryPathForPlugin(pluginRoot, manifest.entry);
    const resolvedEntryPath = resolveRealEntryPath(entryPath);
    // Cache-bust: Node ESM loader memoizes by URL — without it
    // restart re-runs createPlugin against the OLD module's closures
    // even when the on-disk bundle changed. Mirrors `reloadPlugin`.
    let createPlugin: RuntimePluginFactory | undefined;
    try {
      createPlugin = await importPluginFactory(resolvedEntryPath, true);
      plog("debug", { pluginId, phase: PluginPhase.RESTART_RELOAD_OK }, "module re-imported");
    } catch (err) {
      plog("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err }, "module re-import failed");
      return "failed";
    }

    if (!createPlugin) {
      plog("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, reason: "no_default_export" }, "entry does not export default/createPlugin after restart");
      return "failed";
    }

    const pluginDataDir = this.ensureDataDir(pluginId, pluginRoot);
    const hostApi = this.buildHostApi(pluginId, manifest, pluginDataDir);

    let instance: RuntimePlugin;
    try {
      instance = await createPlugin(
        buildPluginContext({
          pluginId,
          pluginRoot,
          hostRoot: this.hostRoot,
          pluginDataDir,
          manifest,
          configOverrides: this.configOverrides,
          hostApi,
        }),
      );
    } catch (err) {
      plog("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err, reason: "createPlugin_failed" }, "createPlugin failed during restart");
      return "failed";
    }

    const methods = buildMethodMap(manifest, instance, (toolName) =>
      plog("warn", { pluginId, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" }, "tool disabled — missing handler after restart"),
    );

    try {
      await instance.start?.();
      plog("debug", { pluginId, phase: PluginPhase.RESTART_START_OK }, "restart complete");
    } catch (err) {
      plog("error", { pluginId, phase: PluginPhase.RESTART_START_FAIL, err }, "start after restart failed");
      await this.stopAfterStartFailure(pluginId, instance);
      throw new Error(`restartPlugin failed for ${pluginId}: ${(err as Error).message}`);
    }

    try {
      await plugin.instance.stop?.();
      plog("debug", { pluginId, phase: PluginPhase.RESTART_STOP_OK }, "stopped previous instance");
    } catch (err) {
      plog("error", { pluginId, phase: PluginPhase.RESTART_STOP_FAIL, err }, "stop during restart failed");
    }

    for (const method of plugin.methods.keys()) {
      this.methodMap.delete(method);
    }
    this.plugins.delete(pluginId);

    const pluginDisposers = this.disposers.get(pluginId);
    if (pluginDisposers) {
      for (const d of pluginDisposers) {
        try { d(); } catch (err) {
          log.error(`disposer failed during restartPlugin: %s`, (err as Error).message);
        }
      }
      this.disposers.delete(pluginId);
    }

    this.onDisable?.(pluginId);

    this.rememberPluginManifest(pluginId, manifest, approvedPluginAccess);
    for (const [toolName, handler] of methods) {
      this.methodMap.set(toolName, { pluginId, handler });
    }
    if (manifest.keywords && manifest.keywords.length > 0) {
      hostApi.registerKeywords(manifest.keywords);
    }
    this.plugins.set(pluginId, {
      manifest,
      pluginRoot,
      instance,
      methods,
      approvedPluginAccess,
      started: true,
    });
    this.markPluginUiRevision(pluginId);
    this.failedPluginIds.delete(pluginId);
    this.disabledPluginIds.delete(pluginId);
    this.onEnable?.(pluginId);
    return "started";
  }

  /**
   * Live view of the raw config-override map, backed by {@link configStore}.
   * Retained as an instance member of this name because unit tests assert
   * against the runtime's internal override map directly (see
   * `runtime-wildcard-config.test.ts`).
   */
  private get configOverrides(): Record<string, Record<string, unknown>> {
    return this.configStore.all();
  }

  setConfigOverride(pluginId: string, config: Record<string, unknown>): void {
    this.configStore.set(pluginId, config);
  }

  mergeConfigOverride(pluginId: string, config: Record<string, unknown>): void {
    this.configStore.merge(pluginId, config);
  }

  /**
   * #893 — Wildcard (`"*"` slot) config injection. Plugins read the active
   * LLM vendor id via `hostApi.config.get("hostApiVendor")`; the raw API key
   * is NOT injected here — callers must obtain it through `getSecret` so it
   * never appears in the plain-object config map. Merges with existing
   * wildcard overrides (e.g. `pythonExecutable`) so calling this does NOT
   * clobber unrelated keys set by other boot steps.
   */
  setWildcardConfigOverride(config: Record<string, unknown>): void {
    this.configStore.setWildcard(config);
  }

  /**
   * #893 / PR #894 B2 — Read the wildcard slot so `hostApi.config.get(...)`
   * can merge host-injected values (e.g. `hostApiVendor`) into every
   * plugin's effective config map. Returns an empty object when no wildcard
   * overrides have been set so callers can spread the result unconditionally.
   * The returned object is a shallow copy — callers MUST NOT mutate it.
   */
  getWildcardConfigOverride(): Record<string, unknown> {
    return this.configStore.getWildcard();
  }

  /**
   * #893 — Inverse of `setWildcardConfigOverride`. Clears ONLY the keys
   * named in `keys` from the wildcard slot, preserving other injected
   * values. When `keys` is empty the call is a no-op so the unrelated
   * `pythonExecutable` slot survives a vendor swap.
   */
  clearWildcardConfigOverride(keys: string[]): void {
    this.configStore.clearWildcard(keys);
  }

  /**
   * US-A3 — Targeted single-plugin add for install / install-local paths.
   */
  async addPlugin(pluginId: string): Promise<"started" | "preparing"> {
    if (this.plugins.has(pluginId)) {
      try {
        const restartResult = await this.restartPlugin(pluginId);
        if (restartResult === "deferred") return "preparing";
        if (restartResult === "failed") {
          throw new Error(`restartPlugin failed for ${pluginId}`);
        }
      } catch (err) {
        throw new Error(`addPlugin failed for ${pluginId}: ${(err as Error).message}`);
      }
      this.throwIfPluginFailedAfterAdd(pluginId);
      return "started";
    }

    const loadPlan = await this.resolveManifestLoadPlanInternal();
    const enabledSnapshots = await this.readSnapshotsInternal(loadPlan);
    const snapshot = enabledSnapshots.get(pluginId);
    const targetPlan = loadPlan.find(
      (p) => p.pluginIdHint === pluginId || (p.enabled && this.matchesManifestPath(p.manifestPath, pluginId)),
    );
    if (!snapshot) {
      if (targetPlan?.enabled) {
        await this.readManifest(targetPlan.manifestPath); // throws with the actual reason
      }
      throw new Error(`addPlugin: plugin not found in registry or disabled: ${pluginId}`);
    }
    if (!targetPlan) {
      throw new Error(`addPlugin: load plan entry missing for ${pluginId}`);
    }

    const { manifest, approvedPluginAccess } = snapshot;
    this.rememberPluginInstallAlias(manifest.id, pluginId);
    this.knownPluginManifests.set(pluginId, manifest);
    this.knownPluginAccessGrants.set(pluginId, approvedPluginAccess);
    this.rememberToolOwners(pluginId, manifest); // #885 §2.4a MODEL-ONLY (see method)
    for (const eventType of getDeclaredEmittedEvents(manifest)) {
      this.knownEventOwners.set(eventType, pluginId);
    }

    const startResult = await this.instantiateAndStartSinglePlugin(targetPlan, manifest, approvedPluginAccess);
    if (startResult === "deferred") return "preparing";

    // Throw if the plugin landed in failed state — caller (IPC install
    // handler) catches to roll back marketplace state. boot-time `load()`
    // doesn't take this path; it inlines its own iteration.
    this.throwIfPluginFailedAfterAdd(pluginId);
    return "started";
  }

  /**
   * US-A3 — Targeted single-plugin remove for uninstall paths.
   */
  async removePlugin(pluginId: string): Promise<void> {
    this.preparation.clearFor(pluginId);
    this.configStore.delete(pluginId);
    // Plugin may be in one of three states when uninstall is requested:
    //   - loaded (`this.plugins` has it) → run stop + dispose, then clean
    //     all tracking maps below
    //   - failed-load (in `failedPluginIds` / `failedPluginStubs` /
    //     `knownPluginManifests` but NOT in `this.plugins`) → skip the
    //     stop/dispose path but still clean tracking so `listPluginCards`
    //     stops surfacing a stale entry after marketplace registry purge
    //   - not tracked at all (no-op)
    //
    // Pre-fix: an early `return` when `this.plugins` lacked the entry
    // left failed-load plugins in `failedPluginStubs` / `knownPluginManifests`
    // forever — UI showed the ghost card and a second uninstall click hit
    // `Plugin not found` from the deployment guard against the already-purged
    // marketplace registry.
    const plugin = this.plugins.get(pluginId);
    if (plugin) {
      try {
        await plugin.instance.stop?.();
      } catch (err) {
        log.error(`stop during removePlugin failed: %s`, (err as Error).message);
      }

      for (const method of plugin.methods.keys()) {
        this.methodMap.delete(method);
      }
      this.plugins.delete(pluginId);

      const pluginDisposers = this.disposers.get(pluginId);
      if (pluginDisposers) {
        for (const d of pluginDisposers) {
          try { d(); } catch (err) {
            log.error(`disposer failed during removePlugin: %s`, (err as Error).message);
          }
        }
        this.disposers.delete(pluginId);
      }
    } else if (
      !this.knownPluginManifests.has(pluginId) &&
      !this.failedPluginIds.has(pluginId) &&
      !this.failedPluginStubs.has(pluginId) &&
      !this.disabledPluginIds.has(pluginId)
    ) {
      log.warn(`removePlugin: plugin not loaded — ${pluginId}`);
      return;
    } else {
      log.info(`removePlugin: plugin in non-loaded state (failed/disabled), purging tracking — ${pluginId}`);
    }

    this.knownPluginManifests.delete(pluginId);
    this.knownPluginAccessGrants.delete(pluginId);
    for (const [toolName, ownerId] of [...this.knownToolOwners.entries()]) {
      if (ownerId === pluginId) this.knownToolOwners.delete(toolName);
    }
    for (const [eventType, ownerId] of [...this.knownEventOwners.entries()]) {
      if (ownerId === pluginId) this.knownEventOwners.delete(eventType);
    }
    this.failedPluginIds.delete(pluginId);
    this.failedPluginStubs.delete(pluginId);
    this.loadFailureInfo.delete(pluginId);
    this.disabledPluginIds.delete(pluginId);
    this.pluginUiRevisions.delete(pluginId);

    this.onDisable?.(pluginId);
  }

  /** Helper: does a manifest path's directory name suggest it owns `pluginId`? */
  private matchesManifestPath(manifestPath: string, pluginId: string): boolean {
    const parent = dirname(manifestPath);
    const dirName = parent.split(/[\\/]/).pop() ?? "";
    return dirName === pluginId || dirName === pluginId.replace(/[^a-zA-Z0-9._-]/g, "-");
  }

  /**
   * Verify the install receipt for `pluginId` under `pluginRoot` and enforce
   * the dev-signer-in-packaged-build guard. Reporting may be deferred so boot
   * can perform concurrent checks while emitting results in registry order.
   *
   * Returns `{ ok: true }` when verification passes (or is not required).
   * Returns `{ ok: false }` when the plugin must be rejected — the caller is
   * responsible for calling `markFailed` and deciding the control-flow
   * (`continue` vs `return`).
   *
   * Skips all checks when `installReceiptCacheRoot` is not configured.
   * Receipt verification now applies to every install source (admin / user /
   * local-dev) — the legacy dev-link bypass was removed when the dev:link
   * script was deleted.
   */
  private async verifyReceiptAndDevGuard(
    pluginId: string,
    pluginRoot: string,
    options: { report?: boolean } = {},
  ): Promise<PluginIntegrityCheckResult> {
    if (!this.installReceiptCacheRoot) {
      return { ok: true };
    }
    const receiptResult = await verifyInstallReceipt(
      this.installReceiptCacheRoot,
      pluginId,
      pluginRoot,
    );
    if (!receiptResult.ok) {
      const result = { ok: false as const, reason: receiptResult.reason };
      if (options.report !== false) this.reportPluginIntegrityResult(pluginId, result);
      return result;
    }
    const { installSource, signerKeyId, artifactSha256 } = receiptResult.receipt;
    // Policy gate: local-dev receipts are only valid in unpackaged dev builds.
    // verifyInstallReceipt is a pure integrity verifier; environment-based
    // policy (packaged vs dev) is enforced here in the runtime layer.
    if (installSource === "local-dev" && !isDevModeUnlocked()) {
      const reason = "local-dev install rejected in packaged build";
      const result = { ok: false as const, reason };
      if (options.report !== false) this.reportPluginIntegrityResult(pluginId, result);
      return result;
    }
    const result: PluginIntegrityCheckResult = {
      ok: true,
      verified: { installSource, artifactSha256, signerKeyId },
    };
    if (options.report !== false) this.reportPluginIntegrityResult(pluginId, result);
    return result;
  }

  private reportPluginIntegrityResult(
    pluginId: string,
    result: PluginIntegrityCheckResult,
  ): void {
    if (!result.ok) {
      log.error(
        { pluginId, reason: result.reason, ...(result.error === undefined ? {} : { err: result.error }) },
        `${pluginId} rejected — install receipt integrity failed`,
      );
      try {
        this.auditLog?.("error", "plugin_integrity_rejected", {
          pluginId,
          reason: result.reason,
        });
      } catch (error) {
        log.error({ pluginId, err: error }, "plugin integrity rejection audit failed");
      }
      return;
    }
    if (!result.verified) return;
    try {
      this.auditLog?.("info", "plugin_integrity_verified", {
        pluginId,
        ...result.verified,
      });
    } catch (error) {
      log.error({ pluginId, err: error }, "plugin integrity verification audit failed");
    }
  }

  /**
   * Per-plugin instantiation + start. Used by `addPlugin` for post-boot
   * fresh-load installs. Boot's `startAll` intentionally bypasses this path
   * — it runs its own inline start loop and lets registration flow through
   * PluginLoopbackManager (each plugin runs as an in-process MCP server),
   * wired in boot/steps/plugin-runtime.ts, which owns the one-shot
   * ToolRegistry population (see §9.3a). This method fires
   * `onEnable` on the start-success branch so post-boot installs converge
   * the host's transient state automatically.
   */
  private async instantiateAndStartSinglePlugin(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    opts: { skipPreparation?: boolean; cacheBust?: boolean; shouldCommit?: () => boolean } = {},
  ): Promise<SinglePluginStartResult> {
    const pluginRoot = dirname(plan.manifestPath);
    this.rememberPluginInstallAlias(manifest.id, plan.pluginIdHint);
    if (plan.pluginIdHint) {
      const integrityResult = await this.verifyReceiptAndDevGuard(
        plan.pluginIdHint,
        pluginRoot,
      );
      if (!integrityResult.ok) {
        this.markFailed(plan.pluginIdHint);
        return "failed";
      }
    }

    // Plugin↔app minimum-version gate — HARD BLOCK at LOAD (see boot path).
    if (this.markIncompatibleAppVersion(manifest)) {
      return "failed";
    }

    const requiredCapabilities = manifest.requires?.capabilities ?? [];
    if (requiredCapabilities.length > 0) {
      const availableManifests = [...this.knownPluginManifests.entries()]
        .filter(([id]) => id !== manifest.id)
        .map(([, m]) => m);
      const dependencyResult = resolveDependencies(requiredCapabilities, availableManifests);
      if (!dependencyResult.ok) {
        const reason = `missing required capabilities: ${dependencyResult.missing.join(", ")}`;
        log.error(`${manifest.id} rejected — ${reason}`);
        this.auditLog?.("error", "plugin_dependency_missing", {
          pluginId: manifest.id,
          missing: dependencyResult.missing,
        });
        this.markFailed(manifest.id, {
          name: manifest.name ?? manifest.id,
          description: `Missing capabilities: ${dependencyResult.missing.join(", ")}`,
        });
        return "failed";
      }
    }

    if (!opts.skipPreparation && this.preparation.deferStart(plan, manifest, approvedPluginAccess, opts)) {
      return "deferred";
    }

    let entryPath: string;
    try {
      entryPath = this.resolveEntryPathForPlugin(pluginRoot, manifest.entry);
    } catch (err) {
      const reason = (err as Error).message;
      log.error(`${manifest.id} rejected: ${reason}`);
      this.auditLog?.("error", "plugin_entry_path_rejected", {
        pluginId: manifest.id,
        entry: manifest.entry,
        reason,
      });
      this.markFailed(manifest.id);
      return "failed";
    }
    const resolvedEntryPath = resolveRealEntryPath(entryPath);

    let createPlugin: RuntimePluginFactory | undefined;
    try {
      createPlugin = await importPluginFactory(resolvedEntryPath, opts.cacheBust);
    } catch (err) {
      log.error(`${manifest.id} import failed: %s`, (err as Error).message);
      this.auditLog?.("error", "plugin_import_failed", {
        pluginId: manifest.id,
        reason: (err as Error).message,
      });
      this.markFailed(manifest.id);
      return "failed";
    }
    if (!createPlugin) {
      log.error(`${manifest.id} entry does not export default/createPlugin — skipped`);
      this.markFailed(manifest.id);
      return "failed";
    }

    const pluginDataDir = this.ensureDataDir(manifest.id, pluginRoot);
    const hostApi = this.buildHostApi(manifest.id, manifest, pluginDataDir);

    let instance: RuntimePlugin;
    try {
      instance = await createPlugin(
        buildPluginContext({
          pluginId: manifest.id,
          pluginRoot,
          hostRoot: this.hostRoot,
          pluginDataDir,
          manifest,
          configOverrides: this.configOverrides,
          hostApi,
        }),
      );
    } catch (err) {
      log.error(`${manifest.id} createPlugin failed: %s`, (err as Error).message);
      this.markFailed(manifest.id);
      return "failed";
    }

    const methods = new Map<string, PluginToolHandler>();
    for (const toolName of declaredRuntimeMethods(manifest)) {
      const handler = instance.handlers[toolName];
      if (!handler) {
        log.warn(`missing handler '${toolName}' — tool disabled`);
        continue;
      }
      methods.set(toolName, handler);
      if (this.methodMap.has(toolName)) {
        throw new Error(`Duplicate plugin method registered: ${toolName}`);
      }
    }

    if (opts.shouldCommit && !opts.shouldCommit()) {
      await this.stopAfterStartFailure(manifest.id, instance);
      return "cancelled";
    }

    let startupMs = 0;
    if (instance.start) {
      const startedAt = Date.now();
      try {
        await runStartWithTimeout(instance.start.bind(instance), manifest.startupTimeoutMs);
        startupMs = Date.now() - startedAt;
      } catch (err) {
        if (opts.shouldCommit && !opts.shouldCommit()) {
          await this.stopAfterStartFailure(manifest.id, instance);
          return "cancelled";
        }
        log.error(`start during addPlugin failed: %s`, (err as Error).message);
        this.markFailed(manifest.id);
        await this.stopAfterStartFailure(manifest.id, instance);
        return "failed";
      }
    }
    if (opts.shouldCommit && !opts.shouldCommit()) {
      await this.stopAfterStartFailure(manifest.id, instance);
      return "cancelled";
    }
    for (const toolName of methods.keys()) {
      if (this.methodMap.has(toolName)) {
        await this.stopAfterStartFailure(manifest.id, instance);
        throw new Error(`Duplicate plugin method registered: ${toolName}`);
      }
    }
    for (const [toolName, handler] of methods) {
      this.methodMap.set(toolName, { pluginId: manifest.id, handler });
    }

    if (manifest.keywords && manifest.keywords.length > 0) {
      hostApi.registerKeywords(manifest.keywords);
    }

    this.plugins.set(manifest.id, {
      manifest,
      pluginRoot,
      instance,
      methods,
      approvedPluginAccess,
      started: true,
    });
    this.markPluginUiRevision(manifest.id);
    this.failedPluginIds.delete(manifest.id);
    this.loadFailureInfo.delete(manifest.id);
    this.disabledPluginIds.delete(manifest.id);

    this.perf.recordStartup(manifest.id, startupMs);
    this.onEnable?.(manifest.id);
    return "started";
  }

  /**
   * I2 — Plugin live-reload (dev only).
   */
  async reloadPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not loaded: ${pluginId}`);
    }
    const { manifest, pluginRoot } = plugin;

    try {
      await plugin.instance.stop?.();
    } catch (err) {
      log.error(`stop during reload failed: %s`, (err as Error).message);
    }

    if (plugin) {
      for (const method of plugin.methods.keys()) {
        this.methodMap.delete(method);
      }
    }
    this.plugins.delete(pluginId);
    const pluginDisposers = this.disposers.get(pluginId);
    if (pluginDisposers) {
      for (const d of pluginDisposers) {
        try { d(); } catch (err) {
          log.error(`disposer failed during reload: %s`, (err as Error).message);
        }
      }
      this.disposers.delete(pluginId);
    }

    this.onDisable?.(pluginId);

    const entryPath = this.resolveEntryPathForPlugin(pluginRoot, manifest.entry);
    const resolvedEntryPath = resolveRealEntryPath(entryPath);
    // cache-bust for dev reload
    const createPlugin = await importPluginFactory(resolvedEntryPath, true);
    if (!createPlugin) {
      throw new Error(`Plugin entry does not export default/createPlugin: ${pluginId}`);
    }

    const pluginDataDir = this.ensureDataDir(pluginId, pluginRoot);
    const hostApi = this.buildHostApi(pluginId, manifest, pluginDataDir);
    const instance = await createPlugin(
      buildPluginContext({
        pluginId,
        pluginRoot,
        hostRoot: this.hostRoot,
        pluginDataDir,
        manifest,
        configOverrides: this.configOverrides,
        hostApi,
      }),
    );

    const methods = buildMethodMap(manifest, instance, (toolName) =>
      log.warn(`missing handler '${toolName}' after reload — tool disabled`),
    );
    for (const [toolName, handler] of methods) {
      this.methodMap.set(toolName, { pluginId, handler });
    }

    if (manifest.keywords && manifest.keywords.length > 0) {
      hostApi.registerKeywords(manifest.keywords);
    }

    this.plugins.set(pluginId, {
      manifest,
      pluginRoot,
      instance,
      methods,
      approvedPluginAccess: this.plugins.get(pluginId)?.approvedPluginAccess ?? this.knownPluginAccessGrants.get(pluginId),
      started: false,
    });

    try {
      await instance.start?.();
      this.plugins.get(pluginId)!.started = true;
      this.markPluginUiRevision(pluginId);
    } catch (err) {
      log.error(`start after reload failed: %s`, (err as Error).message);
      this.markFailed(pluginId);
      this.cleanupFailedStartRuntimeState(pluginId, methods);
      await this.stopAfterStartFailure(pluginId, instance);
      throw err;
    }
    this.onEnable?.(pluginId);
  }

  /**
   * Disable a loaded plugin at runtime.
   */
  async disable(pluginId: string, actor: Actor = "user"): Promise<void> {
    if (this.deploymentGuard) {
      const result = await this.deploymentGuard.canDisable(pluginId, actor);
      if (!result.allowed) {
        throw new Error(result.reason ?? `Plugin disable denied: ${pluginId}`);
      }
    }

    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not loaded: ${pluginId}`);
    }

    // Durable state is the source of truth. Do not tear down the live plugin
    // until the registry transaction commits successfully.
    if (this.registryPath) {
      await updatePluginRegistry(this.registryPath, (registry) => {
        const entry = registry.plugins.find((p) => p.id === pluginId);
        if (entry) entry.enabled = false;
      });
    }

    try {
      await plugin.instance.stop?.();
    } catch (err) {
      log.error(`stop during disable failed: %s`, (err as Error).message);
    }

    for (const method of plugin.methods.keys()) {
      this.methodMap.delete(method);
    }
    this.plugins.delete(pluginId);

    const pluginDisposers = this.disposers.get(pluginId);
    if (pluginDisposers) {
      for (const d of pluginDisposers) {
        try { d(); } catch (err) {
          log.error(`disposer failed: %s`, (err as Error).message);
        }
      }
      this.disposers.delete(pluginId);
    }
    this.disabledPluginIds.add(pluginId);
    this.failedPluginIds.delete(pluginId);
    this.pluginUiRevisions.delete(pluginId);

    this.onDisable?.(pluginId);
  }

  // ─── Dispatcher / Bridge ───────────────────────────────────────────────────

  setToolInvocationDelegate(delegate: PluginToolInvocationDelegate): void {
    this.toolInvocationDelegate = delegate;
  }

  clearToolInvocationDelegate(): void {
    this.toolInvocationDelegate = null;
  }

  async call(method: string, payload?: unknown): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      this.throwIfToolOwnerNotReady(method);
      throw new Error(`Plugin method not found: ${method}`);
    }
    const { pluginId } = entry;
    this.throwIfPluginNotStarted(pluginId);
    const stats = this.perf.beginCall(pluginId);
    const t0 = Date.now();
    try {
      return await entry.handler(payload);
    } catch (err) {
      stats.errorCount += 1;
      throw err;
    } finally {
      stats.totalExecMs += Date.now() - t0;
    }
  }

  resolveToolOwner(method: string): string | undefined {
    return this.methodMap.get(method)?.pluginId ?? this.knownToolOwners.get(method);
  }

  assertPluginEventAccess(callerPluginId: string, eventType: string): void {
    assertEventSubscribeAccess({
      callerPluginId,
      eventType,
      targetPluginId: this.inferEventOwner(eventType),
      getAccessGrant: () => this.getPluginAccessGrant(callerPluginId),
      auditLog: this.auditLog,
    });
  }

  assertPluginEventEmitAccess(callerPluginId: string, eventType: string): void {
    assertEventEmitAccess({
      callerPluginId,
      eventType,
      ownerPluginId: this.inferEventOwner(eventType),
      auditLog: this.auditLog,
    });
  }

  /**
   * Invoke a plugin method declared as a UI action directly against the runtime,
   * enforcing the app-visible allowlist (#885 v6 — tools whose
   * `_meta.ui.visibility` includes `"app"`, via `declaredUiInvokableMethods`).
   * Used by the boot plugin-tool executor for UI-only runtime methods that bypass
   * the reviewer surface.
   *
   * REACHABLE ONLY FROM THE TRUSTED PANEL (`origin: "ui"`). `isAppOnlyRuntimeInvocation`
   * routes here only on a UI-effective chain, so an MCP App (`origin: "mcp-app"`,
   * untrusted sandboxed iframe) can never land on this ungoverned path — a card's
   * app-only call takes the GOVERNED executor instead ({@link callFromApp}), because
   * an app-only tool is a registry `Tool`. The panel keeps this bypass (it can supply
   * a real user gesture); the card never sees it.
   *
   * This bypass skips the ToolExecutor and therefore its Step-6
   * `runWithCeiling` cap, so the ceiling is enforced STRUCTURALLY here — at the
   * sole entry point of the bypass — rather than in the boot wiring that reaches
   * it. Any caller of this method is capped regardless of how boot dispatches to
   * it, closing the regression class where a future revert of the boot wiring
   * back to a direct call would silently drop the ceiling (CLAUDE.md §Tool
   * Execution Timeout Policy: every tool path passes through `runWithCeiling`).
   *
   * Abort-parity note: like the governed executor path, the ceiling only
   * unblocks the *caller* — `PluginRuntime.call` hands the handler only
   * `payload`, never an abort signal, so a hung handler's work stays detached.
   * We match that exact parity and do NOT invent a handler-abort mechanism the
   * executor path itself lacks. `ceilingMs` defaults to the SOT
   * (`TOOL_TIMEOUT_POLICY.globalCeilingMs`) and is a parameter solely so tests
   * can exercise the ceiling with a small value without weakening the SOT.
   */
  async callDeclaredAppOnlyTool(
    method: string,
    payload?: unknown,
    ceilingMs: number = TOOL_TIMEOUT_POLICY.globalCeilingMs,
  ): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      this.throwIfToolOwnerNotReady(method);
      throw new Error(`Plugin method not found: ${method}`);
    }
    const plugin = this.plugins.get(entry.pluginId);
    this.throwIfPluginNotStarted(entry.pluginId);
    assertUiActionInvokable({
      method,
      pluginId: entry.pluginId,
      uiInvokable: plugin ? declaredUiInvokableMethods(plugin.manifest) : [],
    });
    this.auditLog?.("info", "plugin_ui_action_invoked", {
      pluginId: entry.pluginId,
      method,
    });
    const outcome = await runWithCeiling(
      () => this.call(method, payload),
      ceilingMs,
      undefined,
      method,
    );
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }

  /**
   * Invoke a plugin method from the plugin's own TRUSTED first-party React panel
   * (the host renderer), enforcing the UI invocation allowlist so only explicitly
   * declared methods are reachable via the IPC bridge.
   *
   * This is the ONE origin that can carry a real user gesture, and therefore the
   * ONE origin from which the ungoverned app-only dispatch path
   * ({@link callDeclaredAppOnlyTool}) is reachable. An MCP App is NOT this — it
   * uses {@link callFromApp}.
   */
  async callFromUi(
    method: string,
    payload?: unknown,
    options?: { userAction?: boolean },
  ): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      this.throwIfToolOwnerNotReady(method);
      throw new Error(`Plugin method not found: ${method}`);
    }
    const plugin = this.plugins.get(entry.pluginId);
    this.throwIfPluginNotStarted(entry.pluginId);
    assertUiActionInvokable({
      method,
      pluginId: entry.pluginId,
      uiInvokable: plugin ? declaredUiInvokableMethods(plugin.manifest) : [],
    });
    if (!this.toolInvocationDelegate) {
      throw new Error("Plugin tool executor is not wired; UI plugin call denied");
    }
    return this.toolInvocationDelegate(method, payload, {
      origin: "ui",
      ownerPluginId: entry.pluginId,
      userAction: options?.userAction === true,
    });
  }

  /**
   * Invoke a plugin method from an MCP APP — an untrusted `ui://` card running in
   * a sandboxed iframe, calling a tool on its own server through the `oncalltool`
   * bridge. The loopback arm of `mcp-ui-tool-call.ts` is the sole caller.
   *
   * Deliberately NOT {@link callFromUi}: an MCP App is not the plugin's trusted
   * panel, and conflating the two is what let a hostile card reach the ungoverned
   * app-only dispatch path. Two differences, both structural:
   *
   *  1. `origin: "mcp-app"` — so `isAppOnlyRuntimeInvocation` (which only ever
   *     answers true for `"ui"`) can never route an app call into
   *     {@link callDeclaredAppOnlyTool}. That also makes the auth `statusTool`
   *     user-activation carve-out unreachable from a card. This is what makes the
   *     ungoverned bypass unreachable from an app — structurally, not by a check.
   *  2. NO `userAction` parameter. It is never true for an app, so it is not
   *     accepted as an argument — there is nothing for a caller to get wrong.
   *
   * EVERY app-visible tool goes through the delegate (the governed ToolExecutor:
   * `inspectHostRisk` → reviewer/approval → audit), APP-ONLY ONES INCLUDED, WITH ONE
   * NAMED EXCEPTION below. They are §6.4 registry `Tool`s now — the loopback projects
   * them to `tools/list` with their explicit visibility — so the gate has something
   * to run, which is exactly what `["app"]` is for: a plugin ships tools that serve
   * its CARD without putting them in the model's tool surface. (The earlier
   * fail-closed deny existed only because an app-only tool had NO registry entry and
   * therefore no gate; giving it one removes the reason to deny it, without giving
   * the card the panel's ungoverned path.) The app-visibility allow-list
   * (`assertUiActionInvokable`, the spec MUST) still bounds the surface: a
   * MODEL-ONLY tool is not app-callable.
   *
   * ── DELIBERATE NARROWING below the spec's `["app"]` semantics: the auth trio ──
   * `manifest.auth.{statusTool,loginTool,logoutTool}` is denied here BY NAME,
   * unconditionally, even though it is app-visible and even though the executor
   * would otherwise gate it like any other tool. Do not "fix" this by deleting it:
   *
   *  - The trio is not a generic spec `["app"]` tool; it is an LVIS MANIFEST CONCEPT
   *    whose intended caller has always been the plugin's own first-party React
   *    panel (`callFromUi`) — trusted code, a real user gesture. `["app"]` on it is
   *    an artifact of how the manifest expresses "the panel may call this", not a
   *    server declaring "my card may call this". Cards are a different, untrusted
   *    surface that did not exist when that declaration was designed.
   *  - `auth.loginTool` in particular does not merely "run a tool": it spawns a real
   *    auth `BrowserWindow` with cookie/partition access, pointed at an identity
   *    provider. Letting an untrusted card trigger that is a privilege escalation
   *    EVEN BEHIND THE APPROVAL GATE — the user would see a login window they did
   *    not ask for, summoned by a card that can also render whatever it likes around
   *    it. Approval-gating a phishing-shaped affordance is not the same as not
   *    having it.
   *  - So: registry membership (governed execution, reachable from the panel) is
   *    right, and card reachability is not. This is that one exception, named and
   *    contained to this method — `assertUiActionInvokable`, the `"ui"` panel path,
   *    and `isAppOnlyRuntimeInvocation` are untouched.
   */
  async callFromApp(method: string, payload?: unknown): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      this.throwIfToolOwnerNotReady(method);
      throw new Error(`Plugin method not found: ${method}`);
    }
    const plugin = this.plugins.get(entry.pluginId);
    this.throwIfPluginNotStarted(entry.pluginId);
    assertUiActionInvokable({
      method,
      pluginId: entry.pluginId,
      uiInvokable: plugin ? declaredUiInvokableMethods(plugin.manifest) : [],
    });
    const auth = plugin?.manifest.auth;
    if (auth && (method === auth.statusTool || method === auth.loginTool || method === auth.logoutTool)) {
      throw new Error(
        `[${MCP_APP_AUTH_TOOL_NOT_APP_CALLABLE}] Tool '${method}' is this plugin's manifest-declared ` +
          `auth tool and is reserved for the plugin's own trusted panel: a card cannot invoke it. ` +
          `auth.loginTool opens a credentialed auth window, and an untrusted card must never be able ` +
          `to summon one, gated or not.`,
      );
    }
    if (!this.toolInvocationDelegate) {
      throw new Error("Plugin tool executor is not wired; MCP App plugin call denied");
    }
    return this.toolInvocationDelegate(method, payload, {
      origin: "mcp-app",
      ownerPluginId: entry.pluginId,
      userAction: false,
    });
  }

  /**
   * Serve one of a plugin's manifest-declared `ui://` MCP App cards by asking the
   * PLUGIN for the HTML ({@link RuntimePlugin.readUiResource}). The plugin is the
   * MCP server — it serves its own resource bytes; the host relays them. The host
   * therefore never resolves or reads a plugin-declared disk path, which is what
   * removed the realpath-containment layer this method replaces.
   *
   * The caller ({@link createPluginUiResourceProvider}) has ALREADY enforced the
   * serving policy — own-namespace authority + declared-only — so this method's
   * job is the RUNTIME-STATE gate plus bounding the hook:
   *
   *  - the same fail-closed gates `pluginRuntimeToolDelegate` applies to
   *    `tools/call` (registry-enabled OR session-activated for the calling ALS
   *    session; not manifest-integrity-disabled), so a disabled plugin cannot
   *    render a card any more than it can run a tool;
   *  - a `pluginUiResourceReadMs` ceiling (SOT: TOOL_TIMEOUT_POLICY) — a plugin
   *    hook, unlike a file read, can hang; the user is waiting on a card;
   *  - a hard HTML size cap, so a runaway hook cannot balloon the render path.
   *
   * Every failure throws — the loopback server maps it to `-32002` and no body is
   * ever served.
   *
   * `ceilingMs` defaults to the SOT and is a parameter solely so tests can exercise
   * the ceiling with a small value without weakening it (same seam as
   * {@link callDeclaredAppOnlyTool}).
   */
  async readUiResource(
    pluginId: string,
    uri: string,
    ceilingMs: number = TOOL_TIMEOUT_POLICY.pluginUiResourceReadMs,
  ): Promise<string> {
    // Gate parity with pluginRuntimeToolDelegate (Gate 4): registry-enabled OR
    // session-activated for the CALLING session (read from the ALS store;
    // fail-closed when absent).
    const sessionId = sessionContext.getStore()?.sessionId;
    if (
      !this.isPluginEnabled(pluginId) &&
      !(sessionId !== undefined && this.isSessionActivated(sessionId, pluginId))
    ) {
      throw new Error(
        `Plugin '${pluginId}' is inactive; its ui:// resources are unavailable until the plugin is re-enabled.`,
      );
    }
    if (manifestIntegrityState.isDisabled(pluginId)) {
      throw new Error(
        `Plugin '${pluginId}' was disabled after a manifest integrity violation. Reinstall the plugin to re-enable.`,
      );
    }

    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin '${pluginId}' is not loaded; cannot serve '${uri}'.`);
    }
    const readUiResource = plugin.instance.readUiResource;
    if (typeof readUiResource !== "function") {
      throw new Error(
        `Plugin '${pluginId}' declares ui:// resources but does not implement readUiResource(); cannot serve '${uri}'.`,
      );
    }

    const outcome = await runWithCeiling(
      async () => readUiResource.call(plugin.instance, uri),
      ceilingMs,
      undefined,
      `${pluginId}.readUiResource`,
    );
    if (!outcome.ok) throw outcome.error;

    const html = outcome.value;
    if (typeof html !== "string") {
      throw new Error(
        `Plugin '${pluginId}' readUiResource('${uri}') returned ${typeof html}, expected the card HTML as a string.`,
      );
    }
    const bytes = Buffer.byteLength(html, "utf-8");
    if (bytes > MAX_UI_RESOURCE_HTML_BYTES) {
      throw new Error(
        `Plugin '${pluginId}' readUiResource('${uri}') returned ${bytes} bytes, over the ${MAX_UI_RESOURCE_HTML_BYTES}-byte card limit.`,
      );
    }
    return html;
  }

  getMethodMap(): ReadonlyMap<string, { pluginId: string; handler: PluginToolHandler }> {
    return this.methodMap;
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  getPerfStats(): Record<string, PluginPerfStats> {
    return this.perf.snapshot();
  }

  /**
   * Test-only: inject a plugin + method handler directly into the runtime's
   * internal maps without going through the full load/start lifecycle.
   *
   * Populates `plugins`, `methodMap`, and `perfStats` so that `call()`,
   * `getPerfStats()`, and related queries work without disk fixtures.
   *
   * @internal Only call from test files. The leading underscore signals
   *   test-only usage; tree-shaking removes it from production bundles.
   */
  _testInjectPlugin(
    pluginId: string,
    toolName: string,
    handler: (payload?: unknown) => Promise<unknown>,
  ): void {
    const stub: LoadedPlugin = {
      manifest: {
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        entry: "index.js",
        description: "Test fixture",
        publisher: "Test fixture",
        // #885 v6 — pure Tool[] (model-visible, matching the old tools[]-only shape).
        tools: [
          {
            name: toolName,
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model"] } },
          },
        ],
      },
      pluginRoot: "/tmp/test-inject",
      instance: {} as import("../types.js").RuntimePlugin,
      methods: new Map([[toolName, handler as import("../types.js").PluginToolHandler]]),
      started: true,
    };
    this.plugins.set(pluginId, stub);
    this.markPluginUiRevision(pluginId);
    this.methodMap.set(toolName, { pluginId, handler: handler as import("../types.js").PluginToolHandler });
    this.perf.ensure(pluginId);
  }

  registerDisposer(pluginId: string, dispose: () => void): void {
    let list = this.disposers.get(pluginId);
    if (!list) {
      list = [];
      this.disposers.set(pluginId, list);
    }
    list.push(dispose);
  }

  listToolNames(): string[] {
    return [...this.methodMap.keys()].sort();
  }

  listPluginIds(): string[] {
    return [...this.plugins.keys()];
  }

  /**
   * #1176 active/inactive — whether a plugin's tools may be exposed this turn.
   * Mirrors the registry `enabled` field: `enabled !== false` is active, so an
   * unknown / never-toggled plugin defaults to active (migration-safe). This is
   * orthogonal to load state — an inactive plugin stays loaded. Its tools are
   * hidden from the model by resolveToolScope and refused on the model/agent
   * execution path by the plugin-tool-adapter, while host-internal call() stays
   * callable for auth/config/UI. The synchronous in-memory mirror lets the
   * per-turn `resolveToolScope` gate read it without touching disk.
   */
  isPluginEnabled(pluginId: string): boolean {
    return !this.inactivePluginIds.has(pluginId);
  }

  /**
   * Transient, per-session on-demand activation state — see
   * {@link SessionActivationTracker}. Managed by ConversationLoop:
   * `setSessionActivated` after Gate 2 pass, `clearSessionActivated` at both
   * session-reset sites (resetSession + restore-from-checkpoint) and after
   * routine loop completion. Plugin enablement is NEVER mutated on this path —
   * the plugin stays registry-disabled throughout.
   */
  private readonly sessionActivation = new SessionActivationTracker();

  /**
   * Returns true iff the plugin was on-demand session-activated in the given
   * session. Gate 4 (pluginRuntimeToolDelegate) calls this with the session ID
   * read from the ALS session context.
   */
  isSessionActivated(sessionId: string, pluginId: string): boolean {
    return this.sessionActivation.isActivated(sessionId, pluginId);
  }

  /**
   * Record a plugin as session-activated for the given session.
   * Called by ConversationLoop immediately after Gate 2 on-demand activation.
   */
  setSessionActivated(sessionId: string, pluginId: string): void {
    this.sessionActivation.activate(sessionId, pluginId);
  }

  /**
   * Clear on-demand activations for `sessionId` ONLY — does NOT affect any
   * other session's activation state. Called at session-reset and after
   * routine loop completion (prevents stale Map entries from discarded loops).
   */
  clearSessionActivated(sessionId: string): void {
    this.sessionActivation.clear(sessionId);
  }

  /**
   * #1176 — toggle a plugin's active/inactive state. Persists `enabled` to the
   * registry atomically and updates the in-memory mirror. Deliberately does NOT
   * unload/reload the plugin: tool exposure is recomputed per turn from
   * {@link isPluginEnabled}, so a disabled plugin's tools simply vanish from the
   * next turn's scope (and reappear on re-enable) with no runtime churn.
   * Active-state changes use `onActiveStateChange`; runtime lifecycle
   * `onDisable`/`onEnable` remains reserved for actual unload/reload paths.
   *
   * @throws if `pluginId` is not a known/loaded plugin.
   */
  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    if (!this.knownPluginManifests.has(pluginId) && !this.plugins.has(pluginId)) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }
    if (this.registryPath) {
      await updatePluginRegistry(this.registryPath, (registry) => {
        const entry = registry.plugins.find((p) => p.id === pluginId);
        if (!entry) {
          throw new Error(`Plugin not found in registry: ${pluginId}`);
        }
        entry.enabled = enabled;
      });
    }
    if (enabled) {
      this.inactivePluginIds.delete(pluginId);
      try {
        this.onActiveStateChange?.(pluginId, true);
      } catch (err) {
        log.error(`onActiveStateChange failed during setPluginEnabled(${pluginId}, true): %s`, (err as Error).message);
      }
    } else {
      this.inactivePluginIds.add(pluginId);
      try {
        this.onActiveStateChange?.(pluginId, false);
      } catch (err) {
        log.error(`onActiveStateChange failed during setPluginEnabled(${pluginId}, false): %s`, (err as Error).message);
      }
    }
  }

  getPluginManifest(pluginId: string): PluginManifest | undefined {
    return this.plugins.get(pluginId)?.manifest ?? this.knownPluginManifests.get(pluginId);
  }

  getApprovedPluginAccess(pluginId: string): PluginAccessSpec | undefined {
    return this.plugins.get(pluginId)?.approvedPluginAccess ?? this.knownPluginAccessGrants.get(pluginId);
  }

  private getPluginAccessGrant(pluginId: string): PluginAccessSpec | undefined {
    return this.getApprovedPluginAccess(pluginId);
  }

  listPluginCards(toolRegistry?: { getModelVisibleTools(): Array<{ name: string }> }): PluginCard[] {
    // #885 v6 — the plugin card UI is model-facing (see buildPluginCard). Feed it the
    // MODEL-visible set, not the executable `getVisibleTools()` superset: after app-only
    // tools became registry `Tool`s, `getVisibleTools()` includes them (+ the auth trio),
    // and passing that here would make `buildPluginCard`'s `.filter(isModelVisible)`
    // pre-filter the ONLY thing keeping app-only names out of the settings/marketplace
    // card. Using `getModelVisibleTools()` restores the pre-filter to a genuine no-op.
    const visibleNames = toolRegistry
      ? new Set(toolRegistry.getModelVisibleTools().map((t) => t.name))
      : null;
    const cards = new Map<string, PluginCard>();
    for (const [pluginId, manifest] of this.knownPluginManifests) {
      const runtimeLoaded = this.plugins.has(pluginId);
      const enabled = !this.inactivePluginIds.has(pluginId);
      const active = enabled && runtimeLoaded;
      const loadStatus = this.preparation.isPreparing(pluginId)
        ? "preparing"
        // #1176 active/inactive — a runtime-toggled inactive plugin stays in
        // `this.plugins` (loaded) but reports "disabled" so the UI reflects the
        // active/inactive state, not the load state.
        : !enabled
          ? "disabled"
          : runtimeLoaded
          ? "loaded"
          : this.failedPluginIds.has(pluginId)
          ? "failed"
          : this.disabledPluginIds.has(pluginId)
            ? "disabled"
            : null;
      if (!loadStatus) continue;
      const card = buildPluginCard(pluginId, manifest, loadStatus, visibleNames, {
        active,
        runtimeLoaded,
      }, {
        preparationStatus: this.preparation.getStatus(pluginId),
        installAliases: this.getPluginInstallAliases(pluginId),
      });
      // A plugin that parsed its manifest but failed a later load phase (entry
      // path, factory import, min-app-version gate, …) carries its Doctor
      // classification here so the settings UI can offer the right repair.
      if (loadStatus === "failed") {
        const info = this.loadFailureInfo.get(pluginId);
        if (info?.installFailureKind) card.installFailureKind = info.installFailureKind;
        if (info?.installFailureMessage) card.installFailureMessage = info.installFailureMessage;
      }
      cards.set(pluginId, card);
    }
    for (const [pluginId, stub] of this.failedPluginStubs) {
      if (cards.has(pluginId)) continue;
      // Manifest never parsed (schema-invalid / missing / corrupt on-disk shape)
      // — surface the classification so the Doctor auto-repairs a reinstall-
      // fixable cause instead of leaving the user to guess.
      const info = this.loadFailureInfo.get(pluginId);
      cards.set(pluginId, {
        id: pluginId,
        name: stub.name,
        description: stub.description,
        sampleTools: [],
        tools: [],
        capabilities: [],
        loadStatus: "failed",
        active: false,
        runtimeLoaded: false,
        ...(info?.installFailureKind ? { installFailureKind: info.installFailureKind } : {}),
        ...(info?.installFailureMessage ? { installFailureMessage: info.installFailureMessage } : {}),
      });
    }
    return [...cards.values()];
  }

  listPluginManifests(): Array<{ pluginId: string; manifest: PluginManifest }> {
    const result: Array<{ pluginId: string; manifest: PluginManifest }> = [];
    for (const pluginId of this.preparation.preparingIds()) {
      const manifest = this.knownPluginManifests.get(pluginId);
      if (manifest) result.push({ pluginId, manifest });
    }
    for (const [pluginId, plugin] of this.plugins) {
      result.push({ pluginId, manifest: plugin.manifest });
    }
    return result;
  }

  findPluginIdByCapability(capability: string): string | undefined {
    const matches = this.listPluginIdsByCapability(capability);
    if (matches.length > 1) {
      log.warn(
        `Multiple plugins declare capability '${capability}': ${matches.join(", ")}. ` +
        `Using '${matches[0]}'. Ensure only one plugin provides this capability.`,
      );
    }
    return matches[0];
  }

  listPluginIdsByCapability(capability: string): string[] {
    const result: string[] = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.manifest.capabilities?.includes(capability)) {
        result.push(pluginId);
      }
    }
    return result;
  }

  getPluginInstance<T = unknown>(pluginId: string): T | undefined {
    return this.plugins.get(pluginId)?.instance as T | undefined;
  }

  getPluginEntryDir(pluginId: string): string | undefined {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return undefined;
    try {
      const entryPath = this.resolveEntryPathForPlugin(plugin.pluginRoot, plugin.manifest.entry);
      return dirname(entryPath);
    } catch {
      return undefined;
    }
  }

  getPluginRoot(pluginId: string): string | undefined {
    return this.plugins.get(pluginId)?.pluginRoot;
  }

  /**
   * Resolve the per-plugin sandboxed `PluginStorage` instance for `pluginId`.
   *
   * Used by the plugin webview bridge (`lvis:plugin:storage:*` IPC) so a UI
   * panel running in an isolated webview can read/write its own plugin data
   * dir through the same containment-checked path validation enforced for
   * the host plugin (createPluginStorage). Returns `undefined` for unknown
   * pluginIds — the IPC handler maps that to `unknown-plugin-id`.
   */
  getPluginStorage(pluginId: string): import("../types.js").PluginStorage | undefined {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return undefined;
    const pluginDataDir = this.ensureDataDir(pluginId, plugin.pluginRoot);
    return createPluginStorage(pluginId, pluginDataDir);
  }

  listUiExtensions(): Array<{ pluginId: string; icon?: string; iconText?: string; extension: PluginUiExtension; entryUrl?: string; runtimeRevision?: number }> {
    const result: Array<{ pluginId: string; icon?: string; iconText?: string; extension: PluginUiExtension; entryUrl?: string; runtimeRevision?: number }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      const runtimeRevision = this.getPluginUiRevision(pluginId);
      for (const extension of plugin.manifest.ui ?? []) {
        const entrySource = extension.entry ?? extension.page;
        let entryPath: string | undefined;
        if (entrySource) {
          try {
            entryPath = this.resolveEntryPathForPlugin(plugin.pluginRoot, entrySource);
          } catch (err) {
            log.warn(
              `ui entry rejected for '${pluginId}': ${(err as Error).message}`,
            );
            this.auditLog?.("error", "plugin_ui_entry_path_rejected", {
              pluginId,
              entry: entrySource,
              reason: (err as Error).message,
            });
            continue;
          }
        }
        result.push({
          pluginId,
          icon: plugin.manifest.icon,
          iconText: plugin.manifest.iconText,
          extension,
          entryUrl: entryPath ? this.buildPluginUiEntryUrl(pluginId, plugin.manifest, entryPath) : undefined,
          runtimeRevision,
        });
      }
    }
    return result;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private resetLoadedState(): void {
    for (const [, list] of this.disposers) {
      for (const d of list) {
        try { d(); } catch (err) {
          log.error(`disposer failed: %s`, (err as Error).message);
        }
      }
    }
    this.disposers.clear();
    this.knownPluginManifests.clear();
    this.knownPluginAccessGrants.clear();
    this.knownToolOwners.clear();
    this.knownEventOwners.clear();
    this.plugins.clear();
    this.pluginUiRevisions.clear();
    this.methodMap.clear();
    this.failedPluginIds.clear();
    this.failedPluginStubs.clear();
    this.loadFailureInfo.clear();
    this.disabledPluginIds.clear();
    this.preparation.clear();
    this.pendingRestarts.clear();
    this.pendingRestartPreparations.clear();
    this.loaded = false;
  }

  private async stopAfterStartFailure(
    pluginId: string,
    instance: RuntimePlugin,
  ): Promise<void> {
    if (!instance.stop) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve(instance.stop()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`stop timeout (>${START_FAILURE_STOP_TIMEOUT_MS}ms)`)),
            START_FAILURE_STOP_TIMEOUT_MS,
          );
        }),
      ]);
      plog("debug", { pluginId, phase: PluginPhase.STOP_OK }, "stopped after start failure");
    } catch (err) {
      plog("error", { pluginId, phase: PluginPhase.STOP_FAIL, err }, "stop after start failure failed");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private cleanupFailedStartRuntimeState(
    pluginId: string,
    methods: Map<string, PluginToolHandler>,
  ): void {
    for (const method of methods.keys()) {
      this.methodMap.delete(method);
    }
    this.plugins.delete(pluginId);
    this.runPluginDisposers(pluginId, "start failure cleanup");
    this.onDisable?.(pluginId);
  }

  private runPluginDisposers(pluginId: string, context: string): void {
    const pluginDisposers = this.disposers.get(pluginId);
    if (!pluginDisposers) return;
    for (const dispose of pluginDisposers) {
      try {
        dispose();
      } catch (err) {
        log.error(`disposer failed during ${context}: %s`, (err as Error).message);
      }
    }
    this.disposers.delete(pluginId);
  }

  private throwIfPluginFailedAfterAdd(pluginId: string): void {
    if (!this.failedPluginIds.has(pluginId) && this.plugins.has(pluginId)) return;
    const stub = this.failedPluginStubs.get(pluginId);
    const reason = stub?.description ?? "plugin failed to load (see prior log)";
    throw new Error(`addPlugin failed for ${pluginId}: ${reason}`);
  }

  private throwIfToolOwnerNotReady(toolName: string): void {
    const pluginId = this.knownToolOwners.get(toolName);
    if (!pluginId) return;
    if (this.preparation.isPreparing(pluginId)) {
      throw new Error(
        `Plugin '${pluginId}' is still installing its runtime dependencies. ` +
        `Try again after the plugin is ready.`,
      );
    }
    const failure = this.preparation.getFailure(pluginId);
    if (failure) {
      throw new Error(`Plugin '${pluginId}' runtime dependency install failed: ${failure}`);
    }
  }

  private throwIfPluginNotStarted(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || plugin.started !== false) return;
    throw new Error(
      `Plugin '${pluginId}' is still starting. Try again after the plugin is ready.`,
    );
  }

  private markFailed(
    pluginId: string,
    stub?: { name: string; description: string },
    failure?: { installFailureKind?: PluginInstallFailureKind; installFailureMessage?: string },
  ): void {
    this.failedPluginIds.add(pluginId);
    this.disabledPluginIds.delete(pluginId);
    if (stub) {
      this.failedPluginStubs.set(pluginId, stub);
    }
    if (failure && (failure.installFailureKind || failure.installFailureMessage)) {
      this.loadFailureInfo.set(pluginId, failure);
    }
  }

  /**
   * Plugin↔app minimum-version gate (LOAD boundary). Returns `true` and marks
   * the plugin failed when `manifest.requires.minAppVersion` is higher than the
   * running LVIS app version; the caller then skips `start()`. Returns `false`
   * (no field, or app satisfies the minimum) so the normal load path proceeds.
   *
   * Fail-closed: an unresolvable app version ("unknown" sentinel) blocks too.
   * The failed-stub `description` carries the English IPC error message; the
   * renderer maps the `incompatible-app-version` code to the Korean copy.
   */
  private markIncompatibleAppVersion(manifest: PluginManifest): boolean {
    const minAppVersion = manifest.requires?.minAppVersion;
    if (!minAppVersion) return false;
    const currentAppVersion = getLvisAppVersion();
    if (appVersionSatisfiesMin(currentAppVersion, minAppVersion)) return false;

    const reason = `incompatible app version — plugin requires LVIS >= ${minAppVersion}, current ${currentAppVersion}`;
    log.error(`${manifest.id} rejected — ${reason}`);
    this.auditLog?.("error", "plugin_incompatible_app_version", {
      pluginId: manifest.id,
      required: minAppVersion,
      current: currentAppVersion,
    });
    this.markFailed(manifest.id, {
      name: manifest.name ?? manifest.id,
      description: `plugin requires LVIS >= ${minAppVersion}, current ${currentAppVersion}`,
    }, {
      // NOT locally reinstall-fixable — the marketplace ships the same too-new
      // package, so a reinstall re-throws. The Doctor must fall back to a
      // diagnosis directing the user to update the app.
      installFailureKind: "incompatible-app-version",
      installFailureMessage: `plugin requires LVIS >= ${minAppVersion}, current ${currentAppVersion}`,
    });
    return true;
  }

  private inferEventOwner(eventType: string): string | undefined {
    const exactOwner = this.knownEventOwners.get(eventType);
    if (exactOwner) return exactOwner;
    const candidateIds = new Set<string>([
      ...this.plugins.keys(),
      ...this.knownPluginManifests.keys(),
    ]);
    let bestMatch: string | undefined;
    for (const pluginId of candidateIds) {
      if (!eventType.startsWith(`${pluginId}.`)) continue;
      if (!bestMatch || pluginId.length > bestMatch.length) {
        bestMatch = pluginId;
      }
    }
    return bestMatch;
  }
}
