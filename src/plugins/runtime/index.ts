/**
 * PluginRuntime.
 *
 * The plugin runtime is one object with one lifetime: `PluginRuntime` and the
 * abstract bases it extends (`PluginRuntimeState` ->
 * `PluginRuntimePublicationState` -> `PluginRuntimeCapabilityLifecycle` ->
 * `PluginRuntimeLifecycle` -> `PluginRuntime`) are a single inheritance chain
 * sharing one `this`, together with the helpers that only that chain uses.
 * They live in this file for that reason.
 *
 * Still separate modules, because each has consumers outside this file:
 *   - manifest-validation.ts  — AJV + MUST/SHOULD checks
 *   - sandbox.ts              — entry-path resolution, data-dir, plugin context
 *   - plugin-loader.ts        — factory import + method map
 *   - tool-visibility.ts      — model/app tool exposure
 *   - origin-chain.ts, runtime-admission.ts, detached-operation.ts, types.ts
 */

import type { PluginAccessSpec, PluginManifest, PluginHostApi, PluginRegistryEntry, PluginToolHandler, RuntimePlugin, RuntimePluginFactory, InstallPolicy, PluginAuthSpec, PluginConfigSchema, PluginOnboardingSpec, PluginUiExtension } from "../types.js";
import { classifySubscription } from "../capabilities.js";
import { normalizeInstallPolicy, parsePluginJson, buildManifestValidator, getDeclaredEmittedEvents } from "./manifest-validation.js";
import { flattenAgentPluginsManifest } from "../public-contract.js";
import { isModelVisible } from "./tool-visibility.js";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve, basename } from "node:path";
import type { ManifestLoadPlan, PluginStartPreparationOutcome, PluginStartPreparationReturn, SinglePluginStartResult, ManifestSnapshot, LoadedPlugin, PluginLifecycleHookScope } from "./types.js";
import { logPluginLifecycle, PluginPhase } from "../lifecycle-log.js";
import { t } from "../../i18n/index.js";
import type { CommittedPluginGeneration, PluginRuntimeGenerationLifecycle, PluginRuntimeGenerationProjection, PluginRuntimeGenerationAccess, PluginRuntimeRetirementStep, PreparedPluginRuntimeGenerationPublication } from "../plugin-host-generation.js";
import { resolveDependencies } from "../dependency-resolver.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import type { ValidateFunction } from "ajv";
import { readPluginRegistry, updatePluginRegistry } from "../registry.js";
import { isTrustedRegistryManifestPath } from "../registry-manifest-trust.js";
import { createLogger } from "../../lib/logger.js";
import { isDevModeUnlocked } from "../../boot/dev-flags.js";
import { verifyInstallReceipt, installReceiptPath } from "../plugin-install-receipt.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { type PluginDeploymentGuard, type Actor, PluginDeploymentDeniedError, assertDisableAllowed } from "../deployment-guard.js";
import { pluginArtifactGenerationId } from "../plugin-artifact-identity.js";
import { HostApiGenerationScope } from "../plugin-host-effect-scope.js";
import { canonicalJSON } from "../whitelist/canonical-json.js";
import { materializePluginGenerationRoot, removeRetainedPluginGeneration } from "../plugin-contributions.js";
import { appVersionSatisfiesMin } from "../../shared/semver-compare.js";
import { getLvisAppVersion } from "../../shared/app-version.js";
import type { PluginInstallFailureKind } from "../../shared/plugin-install-failure.js";
import { revocationRegistry } from "../revocation/revocation-registry.js";
import { isPluginRuntimeDetachedOperationError, PluginRuntimeDetachedOperationError } from "./detached-operation.js";
import { ensurePluginDataDir, resolvePluginDataDir, resolveEntryPath, buildPluginContext, resolveRealEntryPath } from "./sandbox.js";
import { buildImportUrl, buildMethodMap, importPluginFactory, declaredAppVisibleToolMethods } from "./plugin-loader.js";
import { withPluginInstallLock, hasExclusivePluginLifecycleMutation, isPluginInstallLockHeld, withAllPluginInstallLocks, withResolvedPluginInstallLocks } from "../install-lifecycle.js";
import { isOutOfProcessPlugin } from "../isolation/out-of-process-plugins.js";
import { createOutOfProcessPluginFactory } from "../isolation/out-of-process-plugin.js";
import { createPluginStorage, createPluginStorageAuditSink } from "../storage.js";
import { runWithCeiling } from "../../tools/executor-ceiling.js";
import { checkRuntimeAdmission } from "./runtime-admission.js";
import type { FloatingDockErrorCode, ResolvedFloatingSurface } from "../../main/floating-dock.js";
import type { InvocationOrigin } from "./origin-chain.js";
import { errorMessage } from "../../shared/error-message.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";

const log = createLogger("plugin-runtime");


/**
 * Hard cap on the HTML one {@link RuntimePlugin.readUiResource} call may return
 * (see {@link PluginRuntime.readUiResource}). An MCP App card inlines its own
 * JS/CSS, so it is legitimately large — but it is a CARD, not a payload channel:
 * bounding it keeps a runaway hook from ballooning the render path. Exported so
 * the test pins the boundary rather than re-deriving it.
 */
export const MAX_UI_RESOURCE_HTML_BYTES = 4 * 1024 * 1024;


export type { InstallPolicy };


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
  /** Host-admitted runtime activation; never inferred from mutable live state. */
  ownerGenerationId?: string;
  /**
   * Host-private auth classification captured from the exact immutable manifest
   * that admitted this invocation. It prevents a replacement generation from
   * downgrading a predecessor auth call into an ordinary app-only call.
   */
  authToolKind?: "status" | "login" | "logout";
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
  /** Host-owned app-call envelope. The renderer may carry only the opaque token. */
  appInvocation?: {
    surface: "trusted-panel" | "mcp-app";
    sessionId: string;
    operationGrantToken?: string;
  };
  /** Exact foreign MCP owner captured from the card and rechecked at dispatch. */
  expectedMcpServerId?: string;
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

interface PluginStartPreparationContext {
  pluginId: string;
  manifest: PluginManifest;
  manifestPath: string;
  pluginRoot: string;
  reportProgress?: (status: PluginPreparationProgressInput) => void;
}

interface PreparedArtifactRuntimeActivationInput<T> {
  installId: string;
  pluginRoot: string;
  manifest: PluginManifest;
  receiptRaw: string;
  registryEntry: Readonly<
    Pick<PluginRegistryEntry, "installSource" | "manifestSha256">
  >;
  approvedPluginAccess?: PluginAccessSpec;
  durableCommit(): Promise<T>;
}

export interface PluginHostApiIncarnation {
  registerDisposer(dispose: () => void): void;
  trackOperation<T>(operation: Promise<T>): Promise<T>;
  isActive(): boolean;
  isLifecycleHookActive(): boolean;
  /**
   * Optional generation-wide effect scope. Prepared generations stage
   * registrations here until the generation is atomically published.
   */
  generationScope?: HostApiGenerationScope;
}

export interface PluginRuntimeOptions {
  hostRoot: string;
  manifestPaths?: string[];
  registryPath?: string;
  pluginsRoot?: string;
  configOverrides?: Record<string, Record<string, unknown>>;
  /** Plugin-scoped HostApi factory — injected by boot.ts */
  createHostApi: (
    pluginId: string,
    manifest: PluginManifest,
    pluginDataDir: string,
    incarnation: PluginHostApiIncarnation,
    installPluginId: string | null,
    candidateRegistryEntry?: Readonly<Pick<PluginRegistryEntry, "installSource" | "manifestSha256">>,
    candidateApprovedPluginAccess?: PluginAccessSpec | null,
  ) => PluginHostApi;
  deploymentGuard?: PluginDeploymentGuard;
  installReceiptCacheRoot?: string;
  auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  /**
   * Fires when a plugin's tear-down path runs (`restartPlugin` stop phase,
   * `restartAll` stop phase per plugin, `disable`, `removePlugin`,
   * `reloadPlugin` stop phase, and `failClosedLoadedPlugin` when a
   * fresh start fails mid-`restartAll`). The host wires this to
   * `toolRegistry.unregisterByPlugin` +
   * `conversationLoop.onPluginDisabled` so transient runtime state stays
   * in sync with the runtime's plugin map.
   *
   * May fire more than once per logical cycle for the same pluginId — e.g.,
   * `restartAll` fires it from its pre-stop fan-out and then again from
   * `failClosedLoadedPlugin` if that plugin's start fails. Callbacks
   * MUST be idempotent.
   */
  onDisable?: (pluginId: string) => void;


  onEnable?: (pluginId: string) => void;
  /** Revokes renderer authority whenever a plugin UI generation changes. */
  onPluginUiRevisionChange?: (pluginId: string) => void;
  /**
   * Fires when the user toggles active/inactive without unloading the runtime.
   * Unlike {@link onDisable}, this MUST NOT unregister plugin tools from the
   * execution registry: auth/config/UI calls remain runtime-callable while
   * model exposure is gated by ConversationLoop scope.
   */
  onActiveStateChange?: (
    pluginId: string,
    enabled: boolean,
  ) => Promise<void> | void;
  /**
   * Optional dependency preparation gate. When this returns a Promise, plugin
   * loading/start is deferred without blocking app boot; calls into the
   * plugin fail with a clear "preparing" message until the Promise resolves.
   */
  preparePluginStart?: (context: PluginStartPreparationContext) => PluginStartPreparationReturn;
}


// ---------------------------------------------------------------------------
// Cross-plugin access control
// ---------------------------------------------------------------------------

/**
 * Cross-plugin access-control policy.
 *
 * Consolidates the deny/allow gate + audit + error-message construction for
 * the three plugin trust boundaries the runtime enforces:
 *   - event subscription across plugins (`assertEventSubscribeAccess`)
 *   - event emission of another plugin's event (`assertEventEmitAccess`)
 *   - renderer→plugin invocation allowlist (`assertAppVisibleToolInvokable`)
 *
 * Each function is pure given its resolved inputs; the runtime resolves the
 * owner/grant/state and delegates the policy decision here so the rules and
 * their audit trail live in one place.
 */

type AuditLog = (
  level: "info" | "warn" | "error",
  message: string,
  data?: unknown,
) => void;

/**
 * Enforce that `callerPluginId` may subscribe to `eventType` from its owning
 * plugin. Self-owned or unowned events are always allowed; otherwise the
 * caller must hold an explicit event grant.
 */
export function assertEventSubscribeAccess(opts: {
  callerPluginId: string;
  eventType: string;
  targetPluginId: string | undefined;
  getAccessGrant: () => PluginAccessSpec | undefined;
  auditLog?: AuditLog;
}): void {
  const { callerPluginId, eventType, targetPluginId } = opts;
  if (classifySubscription(eventType) === "private") {
    opts.auditLog?.("error", "plugin_private_event_access_denied", {
      callerPluginId,
      eventType,
    });
    throw new Error(
      `Plugin '${callerPluginId}' is not allowed to subscribe to private event '${eventType}'`,
    );
  }
  if (!targetPluginId || targetPluginId === callerPluginId) return;
  const rule = opts
    .getAccessGrant()
    ?.plugins.find((entry) => entry.pluginId === targetPluginId);
  if (rule?.events?.includes(eventType)) return;
  opts.auditLog?.("error", "plugin_event_access_denied", {
    callerPluginId,
    targetPluginId,
    eventType,
  });
  throw new Error(
    `Plugin '${callerPluginId}' is not allowed to subscribe to event '${eventType}' from plugin '${targetPluginId}'`,
  );
}

/**
 * Enforce that `callerPluginId` may emit `eventType`. A plugin may only emit
 * events it owns (or events with no resolvable owner).
 */
export function assertEventEmitAccess(opts: {
  callerPluginId: string;
  eventType: string;
  ownerPluginId: string | undefined;
  auditLog?: AuditLog;
}): void {
  const { callerPluginId, eventType, ownerPluginId } = opts;
  if (classifySubscription(eventType) === "private") {
    opts.auditLog?.("error", "plugin_private_event_emit_denied", {
      callerPluginId,
      eventType,
    });
    throw new Error(
      `Plugin '${callerPluginId}' is not allowed to emit private event '${eventType}'`,
    );
  }
  if (!ownerPluginId || ownerPluginId === callerPluginId) return;
  opts.auditLog?.("error", "plugin_event_emit_denied", {
    callerPluginId,
    ownerPluginId,
    eventType,
  });
  throw new Error(
    `Plugin '${callerPluginId}' is not allowed to emit event '${eventType}' owned by plugin '${ownerPluginId}'`,
  );
}

/**
 * Enforce the renderer→plugin allowlist: only tools whose `_meta.ui.visibility`
 * includes `"app"` (#885 v6 — app-visible / dual) may be invoked from the UI IPC
 * bridge. `appVisibleTools` is derived by `declaredAppVisibleToolMethods`.
 */
function assertAppVisibleToolInvokable(opts: {
  method: string;
  pluginId: string;
  appVisibleTools: string[];
}): void {
  if (!opts.appVisibleTools.includes(opts.method)) {
    throw new Error(
      `Method '${opts.method}' is not an app-visible Tool for plugin '${opts.pluginId}'. ` +
        `Give its tools[] entry "_meta":{"ui":{"visibility":["app"]}} (or ["model","app"]) to allow renderer invocation.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Plugin catalog cards
// ---------------------------------------------------------------------------

/**
 * Plugin catalog card construction (Option C).
 *
 * `buildPluginCard` is a pure projection of a manifest + resolved runtime
 * state into the `PluginCard` shape consumed by the marketplace/settings UI.
 * The runtime resolves load-status, visibility, preparation status, and
 * install aliases, then delegates the shaping here.
 */

export function buildPluginCard(
  pluginId: string,
  manifest: PluginManifest,
  loadStatus: PluginCard["loadStatus"],
  visibleNames: Set<string> | null,
  state: { active: boolean; runtimeLoaded: boolean },
  extras: {
    preparationStatus: PluginPreparationStatus | undefined;
    installAliases: string[] | undefined;
  },
): PluginCard {
  // #885 v6 — the card stays LLM-facing: model-visible tools only. `visibleNames`
  // (the ToolRegistry-visible set) is itself model-facing, so the pre-filter is a
  // no-op when it is provided; it matters for the `visibleNames === null` fallback
  // (listPluginCards with no registry), keeping app-only auth tools from surfacing
  // as "tools" in the settings/marketplace UI (they are app-only-visibility, not
  // model-facing).
  const modelTools = (manifest.tools ?? []).filter(isModelVisible);
  const filteredTools = !state.active
    ? []
    : visibleNames
    ? modelTools.filter((t) => visibleNames.has(t.name))
    : modelTools;
  const filteredNames = filteredTools.map((t) => t.name);
  const sampleTools = filteredNames.slice(0, 3);
  const description = manifest.description;
  const toolDescriptions: Record<string, string> = {};
  for (const t of filteredTools) {
    if (t.description) toolDescriptions[t.name] = t.description;
  }
  const uiExtensions = manifest.ui?.filter((extension) => extension.slot === "sidebar");
  return {
    id: pluginId,
    name: manifest.name ?? manifest.id,
    description,
    sampleTools,
    tools: filteredNames,
    capabilities: manifest.capabilities ?? [],
    toolDescriptions: Object.keys(toolDescriptions).length > 0 ? toolDescriptions : undefined,
    isManaged: normalizeInstallPolicy(manifest) === "admin",
    installPolicy: manifest.installPolicy ?? "user",
    loadStatus,
    active: state.active,
    runtimeLoaded: state.runtimeLoaded,
    preparationStatus: loadStatus === "preparing" ? extras.preparationStatus : undefined,
    icon: manifest.icon,
    iconText: manifest.iconText,
    uiExtensions: uiExtensions && uiExtensions.length > 0 ? uiExtensions : undefined,
    version: manifest.version,
    publisher: manifest.publisher,
    configSchema: manifest.configSchema,
    auth: manifest.auth,
    networkAccess: manifest.networkAccess,
    onboarding: manifest.onboarding,
    installAliases: extras.installAliases,
  };
}

// ---------------------------------------------------------------------------
// Plugin auth identity + invalidation
// ---------------------------------------------------------------------------

/** Host-private revocation tuple. Hash and minting generation are inseparable. */
type PluginAuthInvalidation = Readonly<{
  invalidatedAccountHash: string;
  invalidatedAccountGenerationId: string;
}>;

export type PluginAuthObservation = Readonly<{
  invalidatedAccountHash?: string;
  invalidatedAccountGenerationId?: string;
}>;
export type PluginAuthOperationAccount = Readonly<{
  /** Stable scope shared with ordinary account operations for FIFO serialization. */
  accountScopeHash: string;
  /**
   * Host-private synthetic principal used only by a manifest auth Tool's
   * operation-policy path. It is never a cached authenticated account.
   */
  accountHash: string;
}>;
export type PluginAuthInvocation = PluginAuthObservation & Readonly<{
  epoch: number;
  accountTransitionScopeHash: string;
  operationAccount: PluginAuthOperationAccount;
}>;

function fallbackPluginAuthTransitionScope(pluginId: string): string {
  return createHash("sha256")
    .update("plugin-auth-transition/v1\0")
    .update(pluginId)
    .digest("hex");
}

function pluginAuthOperationAccount(
  pluginId: string,
  generationId: string,
  appSessionId: string | undefined,
  accountScopeHash: string,
): PluginAuthOperationAccount {
  const effectiveSessionId = appSessionId || `plugin-auth-${pluginId}-${generationId}`;
  return Object.freeze({
    accountScopeHash,
    accountHash: createHash("sha256")
      .update("plugin-auth-operation-principal/v1\0")
      .update(pluginId)
      .update("\0")
      .update(generationId)
      .update("\0")
      .update(effectiveSessionId)
      .update("\0")
      .update(accountScopeHash)
      .digest("hex"),
  });
}

function pluginAccountIdentityHash(account: string): string {
  return createHash("sha256")
    .update("plugin-account-identity/v1\0")
    .update(account.trim().toLowerCase())
    .digest("hex");
}

function pluginAccountPrincipalHash(identityHash: string, sessionNonce: string): string {
  return createHash("sha256")
    .update("plugin-account-session/v1\0")
    .update(identityHash)
    .update("\0")
    .update(sessionNonce)
    .digest("hex");
}

function authInvalidation(
  current: { readonly principalHash: string } | undefined,
  currentGenerationId: string,
  retained: { readonly principalHash: string; readonly generationId: string } | undefined,
): PluginAuthInvalidation | undefined {
  if (current) {
    return {
      invalidatedAccountHash: current.principalHash,
      invalidatedAccountGenerationId: currentGenerationId,
    };
  }
  return retained
    ? {
        invalidatedAccountHash: retained.principalHash,
        invalidatedAccountGenerationId: retained.generationId,
      }
    : undefined;
}

// ---------------------------------------------------------------------------
// Per-plugin performance stats
// ---------------------------------------------------------------------------

/**
 * Per-plugin performance statistics.
 *
 * `PerfStatsTracker` owns the perf accounting Map and exposes the exact same
 * numbers the runtime previously computed inline. Deliberately NOT cleared by
 * `PluginRuntime.resetLoadedState()` — perf history survives a restart cycle,
 * matching the pre-extraction behavior.
 */

/**
 * Per-plugin performance statistics collected at runtime.
 */
export interface PluginPerfStats {
  startupMs: number;
  toolCallCount: number;
  errorCount: number;
  totalExecMs: number;
  lastCallAt: number | null;
}

function zeroed(startupMs = 0): PluginPerfStats {
  return { startupMs, toolCallCount: 0, errorCount: 0, totalExecMs: 0, lastCallAt: null };
}

class PerfStatsTracker {
  private readonly stats = new Map<string, PluginPerfStats>();

  has(pluginId: string): boolean {
    return this.stats.has(pluginId);
  }

  /** Create a zeroed entry if none exists yet. No-op when already present. */
  ensure(pluginId: string): void {
    if (!this.stats.has(pluginId)) {
      this.stats.set(pluginId, zeroed());
    }
  }

  /** Set `startupMs` on an existing entry. No-op when the entry is absent. */
  setStartupMs(pluginId: string, startupMs: number): void {
    const stats = this.stats.get(pluginId);
    if (stats) stats.startupMs = startupMs;
  }

  /**
   * Record a startup measurement: create the entry (seeded with `startupMs`)
   * when absent, otherwise overwrite only `startupMs` on the existing entry.
   */
  recordStartup(pluginId: string, startupMs: number): void {
    const existing = this.stats.get(pluginId);
    if (!existing) {
      this.stats.set(pluginId, zeroed(startupMs));
    } else {
      existing.startupMs = startupMs;
    }
  }

  /**
   * Account the start of a tool call: get-or-create the entry, bump
   * `toolCallCount`, stamp `lastCallAt`, and return the live entry so the
   * caller can finalize `errorCount` / `totalExecMs` around the invocation.
   */
  beginCall(pluginId: string): PluginPerfStats {
    let stats = this.stats.get(pluginId);
    if (!stats) {
      stats = zeroed();
      this.stats.set(pluginId, stats);
    }
    stats.toolCallCount += 1;
    stats.lastCallAt = Date.now();
    return stats;
  }

  /** Deep-copied snapshot — mutations by callers never affect internal state. */
  snapshot(): Record<string, PluginPerfStats> {
    const result: Record<string, PluginPerfStats> = {};
    for (const [id, stats] of this.stats) {
      result[id] = { ...stats };
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Config override store
// ---------------------------------------------------------------------------

/**
 * Plugin config-override store.
 *
 * `ConfigOverrideStore` owns the `pluginId → config` override map (including
 * the `"*"` wildcard slot) and centralizes the set/merge/clear semantics the
 * runtime previously implemented inline. Deliberately NOT cleared by
 * `PluginRuntime.resetLoadedState()` — overrides survive a restart cycle.
 */
class ConfigOverrideStore {
  private readonly overrides: Record<string, Record<string, unknown>>;

  constructor(initial: Record<string, Record<string, unknown>> = {}) {
    this.overrides = initial;
  }

  /**
   * Live reference to the override map — used to build plugin sandbox context.
   * Callers MUST treat it as read-only.
   */
  all(): Record<string, Record<string, unknown>> {
    return this.overrides;
  }

  /** Replace a plugin's overrides (empty config clears the entry). */
  set(pluginId: string, config: Record<string, unknown>): void {
    if (Object.keys(config).length === 0) {
      delete this.overrides[pluginId];
      return;
    }
    this.overrides[pluginId] = { ...config };
  }

  /** Shallow copy of a plugin's override, or undefined when none is stored. */
  get(pluginId: string): Record<string, unknown> | undefined {
    const current = this.overrides[pluginId];
    return current ? { ...current } : undefined;
  }

  /** Merge into a plugin's existing overrides (empty config is a no-op). */
  merge(pluginId: string, config: Record<string, unknown>): void {
    if (Object.keys(config).length === 0) return;
    this.overrides[pluginId] = {
      ...(this.overrides[pluginId] ?? {}),
      ...config,
    };
  }

  /** Merge into the wildcard (`"*"`) slot (empty config is a no-op). */
  setWildcard(config: Record<string, unknown>): void {
    if (Object.keys(config).length === 0) return;
    this.overrides["*"] = {
      ...(this.overrides["*"] ?? {}),
      ...config,
    };
  }

  /** Shallow copy of the wildcard slot; callers MUST NOT mutate the result. */
  getWildcard(): Record<string, unknown> {
    return { ...(this.overrides["*"] ?? {}) };
  }

  /** Clear ONLY the named keys from the wildcard slot (empty `keys` no-op). */
  clearWildcard(keys: string[]): void {
    const current = this.overrides["*"];
    if (!current) return;
    for (const key of keys) {
      delete current[key];
    }
    if (Object.keys(current).length === 0) {
      delete this.overrides["*"];
    }
  }

  /** Drop a plugin's overrides entirely (uninstall path). */
  delete(pluginId: string): void {
    delete this.overrides[pluginId];
  }
}

// ---------------------------------------------------------------------------
// Preparation tracker
// ---------------------------------------------------------------------------

/**
 * Dependency-preparation lifecycle for deferred plugin starts.
 *
 * `PreparationTracker` owns the MONOTONIC preparation generation counter plus
 * every map/set that tracks an in-flight `preparePluginStart` gate:
 * preparing ids, per-plugin status, failures, and pending prepared-start
 * handles. It calls back into the runtime for the three effects it cannot own
 * itself — `instantiateAndStartSinglePlugin`, `markFailed`, and `onDisable` —
 * which are injected at construction.
 *
 * Generation semantics: each defer/cancel/reset bumps the counter and stamps
 * the plugin's generation. Any in-flight task that observes a generation
 * mismatch is stale and silently aborts, so a reset that rejects pending
 * readiness promises BEFORE clearing the maps (see {@link clear}) can never be
 * clobbered by a late-arriving prepared start.
 */

interface PendingPreparedStart {
  generation: number;
  task: Promise<void>;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (err: Error) => void;
}

interface PreparationTrackerDeps {
  preparePluginStart?: (
    context: PluginStartPreparationContext,
  ) => PluginStartPreparationReturn;
  applyConfigOverride: (
    pluginId: string,
    configOverride: Record<string, unknown>,
  ) => void;
  instantiateAndStartSinglePlugin: (
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    opts: { skipPreparation?: boolean; cacheBust?: boolean; shouldCommit?: () => boolean },
  ) => Promise<SinglePluginStartResult>;
  markFailed: (pluginId: string, stub?: { name: string; description: string }) => void;
  onDisable?: (pluginId: string) => void;
}

class PreparationTracker {
  private readonly preparingPluginIds = new Set<string>();
  private readonly preparationStatuses = new Map<string, PluginPreparationStatus>();
  private readonly preparationFailures = new Map<string, string>();
  private readonly pendingPreparedStarts = new Map<string, PendingPreparedStart>();
  private readonly preparationGenerations = new Map<string, number>();
  private nextPreparationGeneration = 0;

  constructor(private readonly deps: PreparationTrackerDeps) {}

  hasPending(pluginId: string): boolean {
    return this.pendingPreparedStarts.has(pluginId);
  }

  /**
   * Attempt to defer a plugin's start behind its `preparePluginStart` gate.
   * Returns `true` when the start was deferred (an async preparation is now
   * pending, or preparation failed synchronously) and `false` when no
   * preparation applies and the caller should start the plugin inline.
   */
  deferStart(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    startOpts: { cacheBust?: boolean; shouldCommit?: () => boolean } = {},
  ): boolean {
    if (!this.deps.preparePluginStart) return false;
    if (this.pendingPreparedStarts.has(manifest.id)) return true;
    const pluginRoot = dirname(plan.manifestPath);
    const generation = ++this.nextPreparationGeneration;
    this.preparationGenerations.set(manifest.id, generation);
    let result: PluginStartPreparationReturn;
    try {
      result = this.deps.preparePluginStart({
        pluginId: manifest.id,
        manifest,
        manifestPath: plan.manifestPath,
        pluginRoot,
        reportProgress: (status) => this.setStatus(manifest.id, status, generation),
      });
    } catch (err) {
      this.markPreparationFailed(manifest, err);
      return true;
    }
    if (!result || typeof (result as Promise<void>).then !== "function") {
      this.applyPreparationResult(
        manifest.id,
        result as PluginStartPreparationOutcome,
      );
      this.preparationStatuses.delete(manifest.id);
      return false;
    }

    this.preparingPluginIds.add(manifest.id);
    this.preparationFailures.delete(manifest.id);
    if (!this.preparationStatuses.has(manifest.id)) {
      this.setStatus(manifest.id, {
        phase: "pending",
        message: t("be_runtimeIndex.preparingRuntimeMessage"),
        progressPct: 5,
      }, generation);
    }
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const task = Promise.resolve(result)
      .then(async (preparationResult) => {
        if (this.preparationGenerations.get(manifest.id) !== generation) return;
        this.applyPreparationResult(manifest.id, preparationResult);
        const startResult = await this.deps.instantiateAndStartSinglePlugin(plan, manifest, approvedPluginAccess, {
          skipPreparation: true,
          cacheBust: startOpts.cacheBust,
          shouldCommit: () =>
            this.preparationGenerations.get(manifest.id) === generation
            && (startOpts.shouldCommit?.() ?? true),
        });
        if (this.preparationGenerations.get(manifest.id) !== generation) {
          return;
        }
        if (startResult !== "started") {
          const err = new Error(`plugin '${manifest.id}' failed to start after runtime dependencies were prepared`);
          this.markPreparationFailed(manifest, err);
          rejectReady(err);
          return;
        }
        this.preparingPluginIds.delete(manifest.id);
        this.preparationStatuses.delete(manifest.id);
        this.preparationFailures.delete(manifest.id);
        resolveReady();
      })
      .catch((err: unknown) => {
        if (this.preparationGenerations.get(manifest.id) !== generation) return;
        this.markPreparationFailed(manifest, err);
        rejectReady(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (this.pendingPreparedStarts.get(manifest.id)?.generation === generation) {
          this.pendingPreparedStarts.delete(manifest.id);
        }
      });
    this.pendingPreparedStarts.set(manifest.id, { generation, task, ready, resolveReady, rejectReady });
    void ready.catch(() => {});
    return true;
  }

  private applyPreparationResult(
    pluginId: string,
    result: PluginStartPreparationOutcome,
  ): void {
    if (!result || typeof result !== "object" || !result.configOverride) return;
    this.deps.applyConfigOverride(pluginId, result.configOverride);
  }

  private setStatus(pluginId: string, status: PluginPreparationProgressInput, generation: number): void {
    if (this.preparationGenerations.get(pluginId) !== generation) return;
    const progressPct = typeof status.progressPct === "number"
      ? Math.max(0, Math.min(100, Math.round(status.progressPct)))
      : undefined;
    this.preparationStatuses.set(pluginId, {
      phase: status.phase,
      message: status.message,
      progressPct,
      updatedAt: new Date().toISOString(),
    });
  }

  private markPreparationFailed(manifest: PluginManifest, err: unknown): void {
    const message = errorMessage(err);
    this.preparingPluginIds.delete(manifest.id);
    this.preparationStatuses.delete(manifest.id);
    this.preparationFailures.set(manifest.id, message);
    this.deps.markFailed(manifest.id, {
      name: manifest.name ?? manifest.id,
      description: `Plugin dependencies failed: ${message}`,
    });
    this.deps.onDisable?.(manifest.id);
    logPluginLifecycle("error", { pluginId: manifest.id, phase: PluginPhase.START_FAIL, reason: message }, "plugin dependency preparation failed");
  }

  /** Cancel and forget a single plugin's preparation state (uninstall path). */
  clearFor(pluginId: string): void {
    const pending = this.pendingPreparedStarts.get(pluginId);
    pending?.rejectReady(new Error(`plugin '${pluginId}' runtime dependency preparation was cancelled`));
    this.preparationGenerations.set(pluginId, ++this.nextPreparationGeneration);
    this.preparingPluginIds.delete(pluginId);
    this.preparationStatuses.delete(pluginId);
    this.preparationFailures.delete(pluginId);
    this.pendingPreparedStarts.delete(pluginId);
  }

  /**
   * Readiness promise for a plugin that is preparing (not yet loaded). The
   * caller is responsible for the already-loaded fast path.
   */
  waitForReady(pluginId: string): Promise<void> {
    const pending = this.pendingPreparedStarts.get(pluginId);
    if (pending) {
      return pending.ready;
    }
    const failure = this.preparationFailures.get(pluginId);
    if (failure) return Promise.reject(new Error(failure));
    return Promise.reject(new Error(`plugin '${pluginId}' is not preparing or loaded`));
  }

  isPreparing(pluginId: string): boolean {
    return this.preparingPluginIds.has(pluginId);
  }

  preparingIds(): IterableIterator<string> {
    return this.preparingPluginIds.values();
  }

  getStatus(pluginId: string): PluginPreparationStatus | undefined {
    return this.preparationStatuses.get(pluginId);
  }

  getFailure(pluginId: string): string | undefined {
    return this.preparationFailures.get(pluginId);
  }

  /**
   * Runtime-reset clear: reject every pending readiness promise and bump its
   * generation BEFORE clearing the maps, so no in-flight prepared start can
   * resurrect state after the reset.
   */
  clear(): void {
    for (const [pluginId, pending] of this.pendingPreparedStarts) {
      pending.rejectReady(new Error(`plugin '${pluginId}' runtime dependency preparation was cancelled by runtime reset`));
      this.preparationGenerations.set(pluginId, ++this.nextPreparationGeneration);
    }
    this.preparingPluginIds.clear();
    this.preparationStatuses.clear();
    this.preparationFailures.clear();
    this.pendingPreparedStarts.clear();
    this.preparationGenerations.clear();
  }
}

// ---------------------------------------------------------------------------
// Atomic plugin removal
// ---------------------------------------------------------------------------

interface AtomicPluginRemovalOptions<T> {
  requestedPluginId: string;
  loaded: boolean;
  known: boolean;
  hasActiveGeneration(): boolean;
  durableCommit(): Promise<T>;
  deactivateWithCommit(): Promise<CommittedPluginGeneration<T>>;
  captureRetirementFailure(retirement: Promise<void>): Promise<unknown>;
  purgeRuntimeState(): Promise<void>;
}

/**
 * Commit the durable registry removal before purging Host runtime state.
 *
 * Once deactivation publishes the inactive generation pointer, retirement
 * failure is reported only after the remaining runtime tracking has been
 * purged. This keeps the durable marketplace commit and Host projection
 * monotonic even when a retired plugin's stop hook fails.
 */
async function commitAtomicPluginRemoval<T>(
  options: AtomicPluginRemovalOptions<T>,
): Promise<T> {
  if (!options.known) {
    throw new Error(
      `cannot atomically remove unknown plugin: ${options.requestedPluginId}`,
    );
  }

  let result: T;
  let retirementError: unknown;
  if (options.loaded) {
    const committed = await options.deactivateWithCommit();
    result = committed.result;
    retirementError = await options.captureRetirementFailure(
      committed.retirement,
    );
  } else {
    if (options.hasActiveGeneration()) {
      throw new Error(
        `atomic plugin removal found active generation without loaded runtime: ${options.requestedPluginId}`,
      );
    }
    result = await options.durableCommit();
  }

  await options.purgeRuntimeState();
  if (retirementError !== undefined) throw retirementError;
  return result;
}

// ---------------------------------------------------------------------------
// Capability dependency resolution
// ---------------------------------------------------------------------------

/**
 * Resolves capability providers from runtime generations that are actually
 * admitted. A manifest being installed, registry-enabled, or merely loaded is
 * not sufficient: its provider must have completed startup and published an
 * active generation before another plugin can rely on its capabilities.
 */
class CapabilityDependencies {
  constructor(
    private readonly manifests: ReadonlyMap<string, PluginManifest>,
    private readonly isActive: (pluginId: string) => boolean,
  ) {}

  activeManifests(excludePluginIds: readonly string[] = []): PluginManifest[] {
    const excluded = new Set(excludePluginIds);
    return [...this.manifests.entries()]
      .filter(([pluginId]) =>
        !excluded.has(pluginId)
        && this.isActive(pluginId),
      )
      .map(([, manifest]) => manifest);
  }

  missing(
    manifest: PluginManifest,
    additionallyUnavailablePluginIds: readonly string[] = [],
  ): string[] {
    const requiredCapabilities = manifest.requires?.capabilities ?? [];
    if (requiredCapabilities.length === 0) return [];
    const result = resolveDependencies(
      requiredCapabilities,
      this.activeManifests([
        manifest.id,
        ...additionallyUnavailablePluginIds,
      ]),
    );
    return result.ok ? [] : result.missing;
  }
}

// ---------------------------------------------------------------------------
// Capability commit scope types
// ---------------------------------------------------------------------------

type CapabilityDependencyCommitScope = <T>(
  operation: () => Promise<T>,
) => Promise<T>;

interface CapabilityBlockedReadiness {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

interface CapabilityBlockedRetry {
  readonly retry: () => Promise<void>;
  readonly isCurrent: () => boolean;
  readonly readiness: CapabilityBlockedReadiness;
  readonly waitingForOwnPreparation?: boolean;
}

/** Internal extension implemented by PluginBundleLifecycle, never public API. */
interface CapabilityCommitScopedGenerationLifecycle
  extends PluginRuntimeGenerationLifecycle {
  replaceRuntime(
    runtime: PluginRuntimeGenerationProjection,
    commitScope?: CapabilityDependencyCommitScope,
  ): Promise<void>;
  replaceRuntimeWithCommit<T>(
    runtime: PluginRuntimeGenerationProjection,
    receiptRaw: string,
    durableCommit: () => Promise<T>,
    commitScope?: CapabilityDependencyCommitScope,
  ): Promise<CommittedPluginGeneration<T>>;
  deactivateWithCommit<T>(
    pluginId: string,
    durableCommit: () => Promise<T>,
    commitScope?: CapabilityDependencyCommitScope,
  ): Promise<CommittedPluginGeneration<T>>;
}

// ---------------------------------------------------------------------------
// Lifecycle timeouts + session activation
// ---------------------------------------------------------------------------

/**
 * Lifecycle helpers — host-enforced plugin `start()` timeout and the
 * per-session on-demand activation tracker.
 *
 * Both are lifecycle-adjacent runtime concerns kept out of the PluginRuntime
 * orchestrator: the timeout is a pure policy helper shared by every start
 * site, and the session-activation tracker is self-contained in-memory state
 * with no dependency on the plugin load/registry machinery.
 */


class PluginImportTimeoutError extends Error {
  readonly code = "plugin-import-timeout";

  constructor(timeoutMs: number) {
    super(`plugin import timeout (>${timeoutMs}ms)`);
  }
}

class PluginFactoryTimeoutError extends Error {
  readonly code = "plugin-factory-timeout";

  constructor(timeoutMs: number) {
    super(`plugin factory timeout (>${timeoutMs}ms)`);
  }
}

class PluginStartupTimeoutError extends Error {
  readonly code = "plugin-startup-timeout";

  constructor(timeoutMs: number) {
    super(`startup timeout (>${timeoutMs}ms)`);
  }
}

/**
 * Bound the host's wait for ESM evaluation. Dynamic import cannot be aborted
 * in the main process, so callers must quarantine the affected plugin id when
 * this error is observed. The late operation is always observed to avoid an
 * unhandled rejection.
 */
export async function runPluginImportWithTimeout<T>(
  importer: () => Promise<T>,
  timeoutMs: number = TOOL_TIMEOUT_POLICY.pluginImportMs,
): Promise<T> {
  const operation = Promise.resolve().then(importer);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PluginImportTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    void operation.catch(() => undefined);
  }
}

/**
 * Bound plugin factory execution without abandoning a late-created instance.
 * The caller revokes the pending HostApi incarnation when this rejects;
 * `onLateResolution` receives a result that appears after the timeout so it
 * can be stopped without ever becoming runtime-visible.
 */
export async function runPluginFactoryWithTimeout<T>(
  factory: () => Promise<T> | T,
  onLateResolution: (value: T) => Promise<void> | void,
  timeoutMs: number = TOOL_TIMEOUT_POLICY.pluginFactoryMs,
): Promise<T> {
  const operation = Promise.resolve().then(factory);
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new PluginFactoryTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      void operation.then(
        (value) => Promise.resolve(onLateResolution(value)).catch(() => undefined),
        () => undefined,
      );
    }
  }
}

/**
 * Run a plugin's `start()` lifecycle hook under a host-enforced timeout. The
 * manifest's declared `startupTimeoutMs` is honored when present and clamped
 * to `pluginStartupMaxMs`; an undeclared value falls back to
 * `pluginStartupDefaultMs`. The call sites share this helper — when they
 * diverge, fix it here, not in multiple places.
 */
export async function runStartWithTimeout(
  start: () => unknown,
  declaredTimeoutMs: number | undefined,
): Promise<void> {
  const hardTimeoutMs = Math.min(
    declaredTimeoutMs ?? TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs,
    TOOL_TIMEOUT_POLICY.pluginStartupMaxMs,
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new PluginStartupTimeoutError(hardTimeoutMs));
    }, hardTimeoutMs);
  });
  try {
    await Promise.race([Promise.resolve(start()), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Transient, per-session on-demand activation map.
 *
 * Key   = sessionId  (a ConversationLoop instance's session UUID).
 * Value = Set of plugin IDs on-demand activated in that session via
 *         `request_plugin` while the plugin was registry-disabled.
 *
 * Using a Map instead of a flat Set scopes each session's activation state
 * independently: clearing session A never affects session B. This is
 * critical for concurrent loops (e.g. a routine running while the user has an
 * active main-chat conversation — the user starting a new chat must not wipe
 * the routine's activation mid-scan).
 *
 * INVARIANT: plugin enablement is NEVER mutated on this path — the plugin
 * remains registry-disabled throughout.
 */
class SessionActivationTracker {
  private readonly bySession = new Map<string, Set<string>>();

  /**
   * Returns true iff the plugin was on-demand session-activated in the given
   * session.
   */
  isActivated(sessionId: string, pluginId: string): boolean {
    return this.bySession.get(sessionId)?.has(pluginId) ?? false;
  }

  /** Record a plugin as session-activated for the given session. */
  activate(sessionId: string, pluginId: string): void {
    let set = this.bySession.get(sessionId);
    if (!set) {
      set = new Set<string>();
      this.bySession.set(sessionId, set);
    }
    set.add(pluginId);
  }

  /**
   * Clear on-demand activations for `sessionId` ONLY — does NOT affect any
   * other session's activation state.
   */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Manifest snapshots + load plan
// ---------------------------------------------------------------------------

/**
 * Snapshot helpers — readEnabledManifestSnapshots, load plan resolution,
 * trust-boundary checks for registry manifest paths.
 */


// The trust predicate lives in `../registry-manifest-trust.js` — one authority
// shared with `resolveManifestPathsFromRegistry` (registry.ts), which resolves
// the SAME field from the SAME registry for the same purpose. It cannot live
// in registry.ts: this module already imports that one.

/**
 * A registry row the load plan refuses to carry: it names an installed plugin
 * — `marketplace.list()` keeps reporting it as installed — whose manifest the
 * runtime must never read, so it cannot become a plan entry.
 *
 * It is reported OUT OF BAND rather than as a plan entry carrying a flag, and
 * that is the point. `readEnabledManifestSnapshots`, `restartAll`, `addPlugin`
 * and the re-enable path all consume the plan and all reach for
 * `plan.manifestPath`. A refused row inside the plan would be one forgotten
 * `if` away from handing an untrusted path to `readManifest`; keeping the plan
 * exclusively trusted makes that mistake unavailable rather than merely
 * avoided.
 */
export type RegistryLoadRefusal = {
  pluginId: string;
  /** The resolved candidate, for the diagnostic the user is shown. Never read. */
  manifestPath: string;
  reason: string;
};

/**
 * Build a ManifestLoadPlan from manifestPaths + registry.
 *
 * `onRefused` receives every registry row dropped for an untrusted
 * `manifestPath`. Callers that only need the trusted plan omit it; boot passes
 * one so the drop reaches a card instead of only a log line.
 */
export async function resolveManifestLoadPlan(opts: {
  manifestPaths: string[];
  registryPath?: string;
  pluginsRoot?: string;
  onRefused?: (refusal: RegistryLoadRefusal) => void;
}): Promise<ManifestLoadPlan[]> {
  const plans: ManifestLoadPlan[] = opts.manifestPaths.map((manifestPath) => ({
    manifestPath,
    enabled: true,
  }));
  if (!opts.registryPath) {
    if (plans.length > 0) return plans;
    throw new Error("Either manifestPaths or registryPath must be provided.");
  }
  const registry = await readPluginRegistry(opts.registryPath);
  plans.push(
    ...registry.plugins.flatMap((entry) => {
      if (entry.pendingUpdate) {
        log.warn(`skipping pending-update registry entry for ${entry.id}`);
        return [];
      }
      const manifestPath = isAbsolute(entry.manifestPath)
        ? entry.manifestPath
        : resolve(dirname(opts.registryPath!), entry.manifestPath);
      if (!opts.pluginsRoot || !isTrustedRegistryManifestPath(manifestPath, opts.pluginsRoot)) {
        const reason = opts.pluginsRoot
          ? `registry manifest path is not inside the plugin root: ${manifestPath}`
          : `registry manifest path cannot be trusted without a plugin root: ${manifestPath}`;
        log.warn(`ignoring untrusted registry manifest path for ${entry.id}: ${manifestPath}`);
        opts.onRefused?.({ pluginId: entry.id, manifestPath, reason });
        return [];
      }
      return [{
        pluginIdHint: entry.id,
        manifestPath,
        enabled: entry.enabled !== false,
        approvedPluginAccess: entry.approvedPluginAccess as PluginAccessSpec | undefined,
        installSource: entry.installSource,
        manifestSha256: entry.manifestSha256,
      }];
    }),
  );
  return plans;
}

/**
 * For every plan entry (enabled or inactive), read and validate the manifest.
 * Returns a map keyed by pluginIdHint (or manifest.id when no hint). Failed
 * reads are skipped with a warning.
 *
 * Inactive manifests are parsed into metadata so settings can offer re-enable,
 * but PluginRuntime does not instantiate or publish them until receipt and
 * package bytes have been reverified.
 */
export async function readEnabledManifestSnapshots(
  loadPlan: ManifestLoadPlan[],
  validator: ValidateFunction,
): Promise<Map<string, ManifestSnapshot>> {
  const snapshots = new Map<string, ManifestSnapshot>();
  for (const plan of loadPlan) {
    try {
      const manifest = await parsePluginJson(plan.manifestPath, validator);
      // Key by pluginIdHint (registry id) when available so addPlugin() lookups
      // by registry id remain consistent even if manifest.id diverges.
      const key = plan.pluginIdHint ?? manifest.id;
      snapshots.set(key, {
        manifest,
        approvedPluginAccess: plan.approvedPluginAccess,
      });
    } catch (err) {
      log.warn(
        `failed to read manifest at ${plan.manifestPath} (plugin: ${plan.pluginIdHint ?? "<unknown>"}) — skipping: %s`,
        (err as Error).message,
      );
      continue;
    }
  }
  return snapshots;
}

// ---------------------------------------------------------------------------
// Boot preflight
// ---------------------------------------------------------------------------

const BOOT_PREFLIGHT_CONCURRENCY = 4;

export type PluginIntegrityCheckResult =
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

export type BootPreflightOutcome =
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
      integrityResult?: PluginIntegrityCheckResult;
    };

interface BootPreflightOperations {
  prepare(): Promise<unknown>;
  verify(pluginId: string, pluginRoot: string): Promise<PluginIntegrityCheckResult>;
  readManifest(manifestPath: string): Promise<PluginManifest>;
}

export async function preflightPluginLoadPlan(
  loadPlan: ManifestLoadPlan[],
  operations: BootPreflightOperations,
): Promise<BootPreflightOutcome[]> {
  if (loadPlan.length === 0) return [];
  await operations.prepare();
  return mapBoundedInOrder(
    loadPlan,
    BOOT_PREFLIGHT_CONCURRENCY,
    async (plan): Promise<BootPreflightOutcome> => {
      let integrityResult: PluginIntegrityCheckResult | undefined;
      if (plan.pluginIdHint) {
        try {
          integrityResult = await operations.verify(
            plan.pluginIdHint,
            dirname(plan.manifestPath),
          );
        } catch (error) {
          const detail = errorMessage(error);
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
        return {
          ok: true,
          plan,
          manifest: await operations.readManifest(plan.manifestPath),
          approvedPluginAccess: plan.approvedPluginAccess,
          integrityResult,
        };
      } catch (error) {
        return { ok: false, plan, kind: "manifest", error, integrityResult };
      }
    },
  );
}

async function mapBoundedInOrder<T, R>(
  items: readonly T[],
  concurrency: number,
  mapItem: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
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
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Bundle integrity verification
// ---------------------------------------------------------------------------

type IntegrityAuditLog = (
  level: "info" | "warn" | "error",
  message: string,
  data?: unknown,
) => void;

export async function verifyPluginIntegrity(
  cacheRoot: string | undefined,
  pluginId: string,
  pluginRoot: string,
): Promise<PluginIntegrityCheckResult> {
  if (!cacheRoot) return { ok: true };
  const receiptResult = await verifyInstallReceipt(cacheRoot, pluginId, pluginRoot);
  if (!receiptResult.ok) {
    return { ok: false, reason: receiptResult.reason };
  }
  const { installSource, signerKeyId, artifactSha256 } = receiptResult.receipt;
  if (installSource === "local-dev" && !isDevModeUnlocked()) {
    return {
      ok: false,
      reason: "local-dev install rejected in packaged build",
    };
  }
  return {
    ok: true,
    verified: { installSource, artifactSha256, signerKeyId },
  };
}

function reportPluginIntegrity(
  pluginId: string,
  result: PluginIntegrityCheckResult,
  auditLog: IntegrityAuditLog | undefined,
): void {
  if (!result.ok) {
    log.error(
      {
        pluginId,
        reason: result.reason,
        ...(result.error === undefined ? {} : { err: result.error }),
      },
      `${pluginId} rejected — install receipt integrity failed`,
    );
    try {
      auditLog?.("error", "plugin_integrity_rejected", {
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
    auditLog?.("info", "plugin_integrity_verified", {
      pluginId,
      ...result.verified,
    });
  } catch (error) {
    log.error({ pluginId, err: error }, "plugin integrity verification audit failed");
  }
}

// ---------------------------------------------------------------------------
// PluginRuntimeState
// ---------------------------------------------------------------------------

const START_FAILURE_STOP_TIMEOUT_MS = 2_000;
const HOST_API_OPERATION_DRAIN_TIMEOUT_MS = 10_000;

type RestartPluginResult = "started" | "deferred" | "failed" | undefined;

interface PendingRestartCancellation {
  generation: number;
  cancelled: boolean;
  readonly promise: Promise<void>;
  cancel(): void;
}

function createPendingRestartCancellation(): PendingRestartCancellation {
  let resolveCancellation!: () => void;
  return {
    generation: 0,
    cancelled: false,
    promise: new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    }),
    cancel() {
      if (this.cancelled) return;
      this.cancelled = true;
      resolveCancellation();
    },
  };
}

abstract class PluginRuntimeState {
  protected readonly hostRoot: string;
  protected readonly manifestPaths: string[];
  protected readonly registryPath?: string;
  protected readonly pluginsRoot?: string;
  protected readonly configStore: ConfigOverrideStore;
  protected readonly createHostApi: (
    pluginId: string,
    manifest: PluginManifest,
    pluginDataDir: string,
    incarnation: PluginHostApiIncarnation,
    installPluginId: string | null,
    candidateRegistryEntry?: Readonly<
      Pick<PluginRegistryEntry, "installSource" | "manifestSha256">
    >,
    candidateApprovedPluginAccess?: PluginAccessSpec | null,
  ) => PluginHostApi;
  protected readonly deploymentGuard?: PluginDeploymentGuard;
  protected readonly installReceiptCacheRoot?: string;
  protected readonly auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  protected readonly onDisable?: (pluginId: string) => void;
  protected readonly onPluginUiRevisionChange?: (pluginId: string) => void;
  protected readonly onEnable?: (pluginId: string) => void;
  protected readonly onActiveStateChange?: (
    pluginId: string,
    enabled: boolean,
  ) => Promise<void> | void;
  protected readonly preparePluginStart?: (context: PluginStartPreparationContext) => PluginStartPreparationReturn;
  protected plugins = new Map<string, LoadedPlugin>();
  protected methodMap = new Map<string, { pluginId: string; handler: PluginToolHandler }>();
  protected readonly perf = new PerfStatsTracker();
  protected disposers = new Map<string, Array<() => void>>();
  protected readonly knownPluginManifests = new Map<string, PluginManifest>();
  protected readonly knownPluginAccessGrants = new Map<string, PluginAccessSpec | undefined>();
  protected readonly knownInstallAliases = new Map<string, Set<string>>();
  protected readonly knownInstallClaims = new Map<string, string | null>();
  private readonly pendingInstallIdentityOwners = new Map<string, symbol>();
  protected readonly knownToolOwners = new Map<string, string>();
  protected readonly knownEventOwners = new Map<string, string>();
  protected readonly failedPluginIds = new Set<string>();
  protected readonly failedPluginStubs = new Map<string, { name: string; description: string }>();
  /**
   * Structured load-failure classification for the Plugin Doctor, keyed by the
   * plugin id (or the registry-id hint when the manifest never parsed).
   * Populated by {@link markFailed}; only surfaced on cards whose `loadStatus`
   * is `"failed"`, and cleared when the plugin loads successfully. Lets the
   * Doctor tell reinstall-fixable failures (stale/pre-v6 schema manifest) apart
   * from not-locally-fixable ones (app-version incompatibility).
   */
  protected readonly loadFailureInfo = new Map<
    string,
    { installFailureKind?: PluginInstallFailureKind; installFailureMessage?: string }
  >();
  protected readonly disabledPluginIds = new Set<string>();
  /**
   * #1176 active/inactive — plugins toggled inactive at runtime via
   * {@link setPluginEnabled}. Orthogonal to {@link disabledPluginIds} (the
   * load/unload state): an inactive plugin stays *loaded* but its tools are
   * hidden from the model's per-turn scope. `enabled !== false` is the active
   * predicate, so absence from this set means active (migration-safe default).
   */
  protected readonly inactivePluginIds = new Set<string>();
  protected readonly preparation: PreparationTracker;
  /** Loaded or requested consumers waiting for a preparing capability provider. */
  protected readonly capabilityBlockedPluginIds = new Set<string>();
  protected readonly pendingRestarts = new Map<string, Promise<RestartPluginResult>>();
  protected readonly pendingRestartPreparations = new Map<
    string,
    Promise<PluginStartPreparationOutcome>
  >();
  /**
   * Hash-only authenticated session state. The principal hash includes a
   * per-login nonce so a later login to the same account cannot revive grants
   * admitted under an earlier session.
   */
  protected pluginAccountHashes = new Map<string, {
    identityHash: string;
    principalHash: string;
  }>();
  /** Latest auth invocation admitted for each immutable plugin generation. */
  protected pluginAuthInvocationEpochs = new Map<string, number>();
  /** Latest auth result that actually published for each immutable generation. */
  protected pluginAuthPublishedEpochs = new Map<string, number>();
  /**
   * Principal observed when an auth invocation began. A failed refresh revokes
   * this exact authority unless a later result has actually published; a later
   * *start* alone must not keep stale governed work alive.
   */
  protected pluginAuthFailurePrincipals = new Map<string, {
    principalHash: string;
    generationId: string;
  }>();
  /**
   * Stable account identity retained after login/logout invalidates the active
   * principal. Concurrent auth transitions reuse it so they cannot bypass the
   * governed-operation/account-transition FIFO while the identity is absent.
   */
  protected pluginAuthTransitionPrincipals = new Map<string, {
    identityHash: string;
    principalHash: string;
    generationId: string;
  }>();
  protected nextPluginAuthInvocationEpoch = 0;
  protected readonly pendingRestartCancellations = new Map<string, PendingRestartCancellation>();
  /** Monotonic generation used to reject stale async add/restart commits. */
  protected readonly pluginLifecycleGenerations = new Map<string, number>();
  /**
   * Process-lifetime quarantine for lifecycle work whose execution state is
   * unknowable. In-process ESM evaluation and plugin hooks cannot be cancelled;
   * another same-id incarnation would permit concurrent stale bodies.
   */
  protected readonly quarantinedPluginLifecycles = new Map<string, string>();
  /** HostApi incarnations whose plugin factory has not committed an instance. */
  private readonly pendingHostApiIncarnations = new Map<string, Set<() => void>>();
  /** A RuntimePlugin instance's stop hook must execute at most once. */
  private readonly pluginStopOperations = new WeakMap<RuntimePlugin, Promise<boolean>>();
  protected nextPluginLifecycleGeneration = 0;
  protected readonly pluginUiRevisions = new Map<string, number>();
  protected nextPluginUiRevision = 0;
  protected toolInvocationDelegate: PluginToolInvocationDelegate | null = null;
  protected generationAccess: PluginRuntimeGenerationAccess | undefined;
  protected generationLifecycle: PluginRuntimeGenerationLifecycle | undefined;
  protected readonly pinnedGenerations =
    new AsyncLocalStorage<ReadonlyMap<string, string>>();
  /**
   * Cross-plugin capability admission has one short linearization boundary.
   * Candidate import, factory execution, and startup intentionally happen
   * outside this queue; only the final generation-pointer commit uses it.
   */
  private capabilityDependencyCommitTail: Promise<void> = Promise.resolve();
  protected loaded = false;

  protected async withCapabilityDependencyCommit<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.capabilityDependencyCommitTail;
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.capabilityDependencyCommitTail = previous.then(() => next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  protected createPendingRestartCancellation(): PendingRestartCancellation {
    return createPendingRestartCancellation();
  }
  /** §B-1 — lazily-compiled AJV validator for plugin.schema.json. */
  protected manifestValidator: ValidateFunction | null = null;
  protected manifestValidatorPromise: Promise<ValidateFunction> | null = null;

  protected abstract instantiateAndStartSinglePlugin(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    opts?: { skipPreparation?: boolean; cacheBust?: boolean; shouldCommit?: () => boolean },
  ): Promise<SinglePluginStartResult>;

  protected hasTrackedPluginState(pluginId: string): boolean {
    return this.plugins.has(pluginId)
      || this.knownPluginManifests.has(pluginId)
      || this.failedPluginIds.has(pluginId)
      || this.failedPluginStubs.has(pluginId)
      || this.disabledPluginIds.has(pluginId)
      || this.inactivePluginIds.has(pluginId);
  }

  constructor(options: PluginRuntimeOptions) {
    if (typeof options.createHostApi !== "function") {
      throw new Error(
        "PluginRuntime requires an explicit createHostApi factory; test harnesses may inject createNoopHostApiForTests",
      );
    }
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
    this.onPluginUiRevisionChange = options.onPluginUiRevisionChange;
    this.onEnable = options.onEnable;
    this.onActiveStateChange = options.onActiveStateChange;
    this.preparePluginStart = options.preparePluginStart;
    this.preparation = new PreparationTracker({
      preparePluginStart: options.preparePluginStart,
      applyConfigOverride: (pluginId, configOverride) =>
        this.mergeConfigOverride(pluginId, configOverride),
      instantiateAndStartSinglePlugin: (plan, manifest, approvedPluginAccess, opts) =>
        this.instantiateAndStartSinglePlugin(plan, manifest, approvedPluginAccess, opts),
      markFailed: (pluginId, stub) => this.markFailed(pluginId, stub),
      onDisable: options.onDisable,
    });
  }

  /**
   * Live view of the raw config-override map, backed by {@link configStore}.
   * Retained for tests that assert against the internal override map.
   */
  protected get configOverrides(): Record<string, Record<string, unknown>> {
    return this.configStore.all();
  }

  setConfigOverride(pluginId: string, config: Record<string, unknown>): void {
    this.configStore.set(this.resolveKnownPluginId(pluginId), config);
  }

  getConfigOverride(pluginId: string): Record<string, unknown> | undefined {
    return this.configStore.get(this.resolveKnownPluginId(pluginId));
  }

  mergeConfigOverride(pluginId: string, config: Record<string, unknown>): void {
    this.configStore.merge(this.resolveKnownPluginId(pluginId), config);
  }

  /** Merge host-injected values into the wildcard (`"*"`) config slot. */
  setWildcardConfigOverride(config: Record<string, unknown>): void {
    this.configStore.setWildcard(config);
  }

  /** Shallow copy of the wildcard config slot. */
  getWildcardConfigOverride(): Record<string, unknown> {
    return this.configStore.getWildcard();
  }

  /** Clear only the named wildcard keys, preserving unrelated host values. */
  clearWildcardConfigOverride(keys: string[]): void {
    this.configStore.clearWildcard(keys);
  }

  protected matchesManifestPath(manifestPath: string, pluginId: string): boolean {
    const dirName = basename(dirname(manifestPath));
    return dirName === pluginId
      || dirName === pluginId.replace(/[^a-zA-Z0-9._-]/g, "-");
  }

  protected async verifyReceiptAndDevGuard(
    pluginId: string,
    pluginRoot: string,
    options: { report?: boolean } = {},
  ): Promise<PluginIntegrityCheckResult> {
    const result = await verifyPluginIntegrity(
      this.installReceiptCacheRoot,
      pluginId,
      pluginRoot,
    );
    if (options.report !== false) {
      this.reportPluginIntegrityResult(pluginId, result);
    }
    return result;
  }

  protected reportPluginIntegrityResult(
    pluginId: string,
    result: PluginIntegrityCheckResult,
  ): void {
    reportPluginIntegrity(pluginId, result, this.auditLog);
  }

  // ─── Manifest Validator (lazy) ─────────────────────────────────────────────

  protected async getManifestValidator(): Promise<ValidateFunction> {
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

  protected async readManifest(
    path: string,
    options: { report?: boolean } = {},
  ): Promise<PluginManifest> {
    const validator = await this.getManifestValidator();
    try {
      return await parsePluginJson(path, validator);
    } catch (err) {
      if (options.report !== false) this.reportPluginManifestRejected(path, err);
      throw err;
    }
  }

  protected reportPluginManifestRejected(path: string, error: unknown): void {
    try {
      this.auditLog?.("error", "plugin_manifest_rejected", {
        manifestPath: path,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    } catch (auditError) {
      log.error({ manifestPath: path, err: auditError }, "plugin manifest rejection audit failed");
    }
  }

  // ─── Sandbox helpers (instance-context wrappers) ───────────────────────────

  protected resolveEntryPathForPlugin(pluginRoot: string, entry: string): string {
    return resolveEntryPath(pluginRoot, entry, this.hostRoot);
  }

  protected ensureDataDir(pluginId: string, pluginRoot: string): string {
    return ensurePluginDataDir(pluginId, pluginRoot, this.pluginsRoot);
  }

  /**
   * The plugin's data directory WITHOUT creating it — for callers that run per
   * request rather than per load. See {@link resolvePluginDataDir}.
   */
  protected resolveDataDir(pluginId: string, pluginRoot: string): string {
    return resolvePluginDataDir(pluginId, pluginRoot, this.pluginsRoot);
  }

  protected buildHostApiIncarnation(
    pluginId: string,
    manifest: PluginManifest,
    pluginDataDir: string,
    hostEffects?: HostApiGenerationScope,
    installPluginId: string | null = this.requirePluginInstallClaim(pluginId),
    candidateRegistryEntry?: Readonly<
      Pick<PluginRegistryEntry, "installSource" | "manifestSha256">
    >,
    candidateApprovedPluginAccess?: PluginAccessSpec | null,
  ): {
    hostApi: PluginHostApi;
    disposers: Array<() => void>;
    deactivate: () => void;
    drainOperations: () => Promise<void>;
    commit: () => void;
    lifecycleHookScope: PluginLifecycleHookScope;
  } {
    const disposers: Array<() => void> = [];
    const pendingOperations = new Set<Promise<unknown>>();
    let active = true;
    const lifecycleHookScope: PluginLifecycleHookScope = { active: true, depth: 0 };
    let pending = true;
    let deactivate!: () => void;
    const forgetPending = () => {
      const pendingForPlugin = this.pendingHostApiIncarnations.get(pluginId);
      pendingForPlugin?.delete(deactivate);
      if (pendingForPlugin?.size === 0) {
        this.pendingHostApiIncarnations.delete(pluginId);
      }
      pending = false;
    };
    deactivate = () => {
      if (!active && !pending) return;
      active = false;
      lifecycleHookScope.active = false;
      lifecycleHookScope.depth = 0;
      if (pending) {
        forgetPending();
        // A factory may never settle after invalidation. Pending incarnations
        // have not transferred their disposer list into `this.disposers`, so
        // invalidation itself owns immediate cleanup. Splicing makes every late
        // factory/error continuation's cleanup idempotent.
        const pendingDisposers = disposers.splice(0);
        this.runDisposerList(pendingDisposers, "pending HostApi invalidation");
      }
    };
    let pendingForPlugin = this.pendingHostApiIncarnations.get(pluginId);
    if (!pendingForPlugin) {
      pendingForPlugin = new Set();
      this.pendingHostApiIncarnations.set(pluginId, pendingForPlugin);
    }
    pendingForPlugin.add(deactivate);
    const incarnation: PluginHostApiIncarnation = {
      registerDisposer: (dispose) => {
        if (active) {
          disposers.push(dispose);
          return;
        }
        try { dispose(); } catch { /* best-effort stale cleanup */ }
      },
      trackOperation: <T>(operation: Promise<T>): Promise<T> => {
        const tracked = Promise.resolve(operation);
        pendingOperations.add(tracked);
        void tracked.then(
          () => pendingOperations.delete(tracked),
          () => pendingOperations.delete(tracked),
        );
        return tracked;
      },
      isActive: () => active,
      isLifecycleHookActive: () =>
        lifecycleHookScope.active && lifecycleHookScope.depth > 0,
      ...(hostEffects ? { generationScope: hostEffects } : {}),
    };
    try {
      const rawHostApi = this.createHostApi(
        pluginId,
        manifest,
        pluginDataDir,
        incarnation,
        installPluginId,
        candidateRegistryEntry,
        candidateApprovedPluginAccess,
      );
      const hostApi = hostEffects ? hostEffects.wrapHostApi(rawHostApi) : rawHostApi;
      // Defence-in-depth: PluginHostApi.storage is required but partial hostApi
      // objects from test harnesses may omit it.
      if (!hostApi.storage) {
        throw new Error(
          `createHostApi returned an incomplete HostApi without storage: ${pluginId}`,
        );
      }
      return {
        hostApi,
        disposers,
        deactivate,
        drainOperations: async () => {
          if (pendingOperations.size === 0) return;
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              Promise.allSettled([...pendingOperations]),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error(
                    `HostApi operation drain timeout (>${HOST_API_OPERATION_DRAIN_TIMEOUT_MS}ms)`,
                  )),
                  HOST_API_OPERATION_DRAIN_TIMEOUT_MS,
                );
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
        lifecycleHookScope,
        commit: () => {
          if (!active) {
            throw new Error(`Cannot commit inactive HostApi incarnation: ${pluginId}`);
          }
          if (pending) forgetPending();
        },
      };
    } catch (err) {
      deactivate();
      throw err;
    }
  }

  protected async runPluginLifecycleHook<T>(
    scope: PluginLifecycleHookScope | undefined,
    hook: () => Promise<T> | T,
  ): Promise<T> {
    if (!scope) return await hook();
    scope.depth += 1;
    try {
      return await hook();
    } finally {
      scope.depth = Math.max(0, scope.depth - 1);
    }
  }

  protected markPluginUiRevision(pluginId: string): number {
    const revision = ++this.nextPluginUiRevision;
    this.pluginUiRevisions.set(pluginId, revision);
    this.onPluginUiRevisionChange?.(pluginId);
    return revision;
  }

  protected invalidatePluginUiRevision(pluginId: string): void {
    this.pluginUiRevisions.delete(pluginId);
    this.onPluginUiRevisionChange?.(pluginId);
  }

  protected getPluginUiRevision(pluginId: string): number {
    return this.pluginUiRevisions.get(pluginId) ?? this.markPluginUiRevision(pluginId);
  }

  protected buildPluginUiEntryUrl(pluginId: string, manifest: PluginManifest, entryPath: string): string {
    const url = new URL(buildImportUrl(entryPath));
    url.searchParams.set("lvisPluginVersion", manifest.version ?? "0");
    url.searchParams.set("lvisRuntimeRevision", String(this.getPluginUiRevision(pluginId)));
    return url.href;
  }

  // ─── Load Plan & Snapshots ─────────────────────────────────────────────────

  protected async resolveManifestLoadPlanInternal(onRefused?: (refusal: RegistryLoadRefusal) => void): Promise<ManifestLoadPlan[]> {
    return resolveManifestLoadPlan({
      manifestPaths: this.manifestPaths,
      registryPath: this.registryPath,
      pluginsRoot: this.pluginsRoot,
      onRefused,
    });
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
  protected rememberToolOwners(pluginId: string, manifest: PluginManifest): void {
    for (const t of (manifest.tools ?? []).filter(isModelVisible)) {
      this.knownToolOwners.set(t.name, pluginId);
    }
  }

  protected rememberPluginManifest(
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

  protected rememberPluginInstallAlias(pluginId: string, alias: string | undefined): void {
    const normalizedPluginId = pluginId.trim();
    const normalizedAlias = alias?.trim() || undefined;
    if (!normalizedPluginId) return;
    this.assertPluginIdentityNamespace([
      { pluginId: normalizedPluginId, alias: normalizedAlias },
    ]);
    this.publishValidatedPluginInstallAlias(normalizedPluginId, normalizedAlias);
  }

  protected publishValidatedPluginInstallAlias(
    normalizedPluginId: string,
    normalizedAlias: string | undefined,
  ): void {
    this.knownInstallClaims.set(normalizedPluginId, normalizedAlias ?? null);
    if (!normalizedAlias || normalizedAlias === normalizedPluginId) return;
    let aliases = this.knownInstallAliases.get(normalizedPluginId);
    if (!aliases) {
      aliases = new Set<string>();
      this.knownInstallAliases.set(normalizedPluginId, aliases);
    }
    aliases.add(normalizedAlias);
  }

  /**
   * Manifest ids and deployment aliases share every public lifecycle entry
   * point, so they must form one unambiguous namespace. Validate a complete
   * batch before boot mutates runtime state, and validate again at each
   * incremental alias adoption.
   */
  protected assertPluginIdentityNamespace(
    mappings: Iterable<{ pluginId: string; alias?: string }>,
    reservedInstallIds: Iterable<string> = [],
  ): void {
    const normalizedMappings = [...mappings]
      .map(({ pluginId, alias }) => ({
        pluginId: pluginId.trim(),
        alias: alias?.trim(),
      }))
      .filter(({ pluginId }) => pluginId.length > 0);
    const normalizedReservedIds = [...reservedInstallIds]
      .map((pluginId) => pluginId.trim())
      .filter(Boolean);
    const existingCanonicalIds = new Set([
      ...this.knownPluginManifests.keys(),
      ...this.plugins.keys(),
      ...this.knownInstallAliases.keys(),
      ...this.knownInstallClaims.keys(),
    ]);
    const canonicalIds = new Set([
      ...existingCanonicalIds,
      ...normalizedMappings.map(({ pluginId }) => pluginId),
    ]);
    const aliasOwners = new Map<string, string>();

    const recordAliasOwner = (alias: string, canonicalId: string) => {
      const existingOwner = aliasOwners.get(alias);
      if (existingOwner && existingOwner !== canonicalId) {
        throw this.pluginIdentityCollision(
          alias,
          `install alias for both '${existingOwner}' and '${canonicalId}'`,
        );
      }
      aliasOwners.set(alias, canonicalId);
    };
    for (const [canonicalId, aliases] of this.knownInstallAliases) {
      for (const alias of aliases) recordAliasOwner(alias, canonicalId);
    }

    const canonicalClaimCounts = new Map<string, number>();
    for (const { pluginId, alias } of normalizedMappings) {
      const claimCount = (canonicalClaimCounts.get(pluginId) ?? 0) + 1;
      canonicalClaimCounts.set(pluginId, claimCount);
      if (claimCount > 1) {
        throw this.pluginIdentityCollision(
          pluginId,
          `multiple active artifacts claim canonical id '${pluginId}'`,
        );
      }
      const aliasOwner = aliasOwners.get(pluginId);
      if (aliasOwner && aliasOwner !== pluginId) {
        throw this.pluginIdentityCollision(
          pluginId,
          `canonical id for '${pluginId}' and install alias for '${aliasOwner}'`,
        );
      }
      if (existingCanonicalIds.has(pluginId)) {
        const incomingClaim = alias ?? null;
        const reusesKnownIdentity = this.knownInstallClaims.has(pluginId)
          ? this.knownInstallClaims.get(pluginId) === incomingClaim
          : !alias
            ? !(this.knownInstallAliases.get(pluginId)?.size)
            : alias === pluginId
            ? !(this.knownInstallAliases.get(pluginId)?.size)
            : this.knownInstallAliases.get(pluginId)?.has(alias) === true;
        if (!reusesKnownIdentity) {
          throw this.pluginIdentityCollision(
            alias ?? pluginId,
            `new artifact claim for existing canonical id '${pluginId}'`,
          );
        }
      }
    }
    for (const { pluginId, alias } of normalizedMappings) {
      if (!alias || alias === pluginId) continue;
      if (canonicalIds.has(alias)) {
        throw this.pluginIdentityCollision(
          alias,
          `canonical id for '${alias}' and install alias for '${pluginId}'`,
        );
      }
      recordAliasOwner(alias, pluginId);
    }

    // Failed manifest/integrity rows still own their raw registry ids for
    // diagnostics and cleanup. Consume the claims backed by successful
    // mappings, then reject any remaining raw id that overlaps a canonical or
    // alias identity.
    const successfulClaimCounts = new Map<string, number>();
    for (const { alias } of normalizedMappings) {
      if (!alias) continue;
      successfulClaimCounts.set(alias, (successfulClaimCounts.get(alias) ?? 0) + 1);
    }
    for (const reservedId of normalizedReservedIds) {
      const successfulClaims = successfulClaimCounts.get(reservedId) ?? 0;
      if (successfulClaims > 0) {
        successfulClaimCounts.set(reservedId, successfulClaims - 1);
        continue;
      }
      const aliasOwner = aliasOwners.get(reservedId);
      if (canonicalIds.has(reservedId) || aliasOwner) {
        throw this.pluginIdentityCollision(
          reservedId,
          aliasOwner
            ? `failed registry id and install alias for '${aliasOwner}'`
            : `failed registry id and canonical id for '${reservedId}'`,
        );
      }
    }
  }

  protected async assertCurrentPluginIdentityLoadPlan(
    loadPlan: ManifestLoadPlan[],
  ): Promise<Array<{ plan: ManifestLoadPlan; snapshot: ManifestSnapshot }>> {
    const currentIdentities: Array<{
      plan: ManifestLoadPlan;
      snapshot: ManifestSnapshot;
    }> = [];
    for (const plan of loadPlan) {
      try {
        currentIdentities.push({
          plan,
          snapshot: {
            manifest: await this.readManifest(plan.manifestPath, { report: false }),
            approvedPluginAccess: plan.approvedPluginAccess,
          },
        });
      } catch {
        // Raw registry ids are still reserved below when a manifest is invalid.
      }
    }
    this.assertPluginIdentityNamespace(
      currentIdentities.map(({ plan, snapshot }) => ({
        pluginId: snapshot.manifest.id,
        alias: plan.pluginIdHint,
      })),
      loadPlan.flatMap((plan) => plan.pluginIdHint ? [plan.pluginIdHint] : []),
    );
    return currentIdentities;
  }

  private pluginIdentityCollision(identifier: string, detail: string): Error {
    const error = new Error(
      `Plugin identity collision for '${identifier}': ${detail}`,
    ) as Error & { code?: string };
    error.code = "plugin-identity-collision";
    return error;
  }

  protected resolveKnownPluginId(pluginId: string): string {
    if (this.knownInstallAliases.has(pluginId)) return pluginId;
    for (const [canonicalId, aliases] of this.knownInstallAliases) {
      if (aliases.has(pluginId)) return canonicalId;
    }
    return pluginId;
  }

  protected getPluginInstallAliases(pluginId: string): string[] | undefined {
    const aliases = this.knownInstallAliases.get(pluginId);
    if (!aliases || aliases.size === 0) return undefined;
    return [...aliases].sort();
  }

  protected getPluginInstallClaim(pluginId: string): string | null | undefined {
    return this.knownInstallClaims.get(pluginId);
  }

  protected requirePluginInstallClaim(pluginId: string): string | null {
    const installClaim = this.getPluginInstallClaim(this.resolveKnownPluginId(pluginId));
    if (installClaim === undefined) {
      throw new Error(`Plugin install provenance unknown: ${pluginId}`);
    }
    return installClaim;
  }

  protected validatePreparedInstallIdentity(pluginId: string, installId: string): string {
    const normalized = installId.trim();
    if (!normalized) {
      throw new Error(`prepared artifact install identity missing for '${pluginId}'`);
    }
    this.assertPluginIdentityNamespace(
      [{ pluginId, alias: normalized }],
      [normalized],
    );
    return normalized;
  }

  protected reservePreparedInstallIdentity(
    pluginId: string,
    installId: string,
  ): { installId: string; release(): void } {
    const normalized = this.validatePreparedInstallIdentity(pluginId, installId);
    const identifiers = [...new Set([pluginId, normalized])];
    for (const identifier of identifiers) {
      if (this.pendingInstallIdentityOwners.has(identifier)) {
        throw this.pluginIdentityCollision(
          identifier,
          "reserved by another prepared activation",
        );
      }
    }
    const owner = Symbol(`prepared-plugin-identity:${pluginId}`);
    for (const identifier of identifiers) {
      this.pendingInstallIdentityOwners.set(identifier, owner);
    }
    let released = false;
    return {
      installId: normalized,
      release: () => {
        if (released) return;
        released = true;
        for (const identifier of identifiers) {
          if (this.pendingInstallIdentityOwners.get(identifier) === owner) {
            this.pendingInstallIdentityOwners.delete(identifier);
          }
        }
      },
    };
  }

  protected async withPreparedInstallIdentity<T>(
    pluginId: string,
    installId: string,
    operation: (normalizedInstallId: string) => Promise<T>,
  ): Promise<T> {
    const reservation = this.reservePreparedInstallIdentity(pluginId, installId);
    try {
      return await operation(reservation.installId);
    } finally {
      reservation.release();
    }
  }

  /**
   * `manifestDocument` is the `plugin.json` as authored, not the flat
   * projection: the registry's `manifestSha256` pins the FILE, and every other
   * producer of that value hashes the document. Re-deriving it from the
   * projection here would make the pin disagree with itself.
   */
  protected validatePreparedRegistryEntry(
    manifest: PluginManifest,
    registryEntry: Readonly<
      Pick<PluginRegistryEntry, "installSource" | "manifestSha256">
    > | undefined,
    manifestDocument: unknown,
  ): Readonly<Pick<PluginRegistryEntry, "installSource" | "manifestSha256">> {
    if (!registryEntry) {
      throw new Error(`prepared artifact registry provenance missing for '${manifest.id}'`);
    }
    const candidateManifestSha256 = sha256Hex(canonicalJSON(manifestDocument));
    if (
      registryEntry.manifestSha256 !== undefined
      && registryEntry.manifestSha256 !== candidateManifestSha256
    ) {
      throw new Error(`prepared artifact registry manifest provenance changed for '${manifest.id}'`);
    }
    return Object.freeze({ ...registryEntry });
  }

  protected assertPluginManifestIdentity(
    expectedPluginId: string,
    actualPluginId: string,
  ): void {
    if (expectedPluginId === actualPluginId) return;
    throw this.pluginIdentityCollision(
      actualPluginId,
      `manifest id changed from active canonical id '${expectedPluginId}'`,
    );
  }

  protected beginPluginLifecycleOperation(
    pluginId: string,
    preserveRestartCancellation?: PendingRestartCancellation,
  ): number {
    const generation = ++this.nextPluginLifecycleGeneration;
    const canonicalId = this.resolveKnownPluginId(pluginId);
    const lifecycleIds = new Set([
      pluginId,
      canonicalId,
      ...(this.knownInstallAliases.get(canonicalId) ?? []),
    ]);
    for (const lifecycleId of lifecycleIds) {
      const cancellation = this.pendingRestartCancellations.get(lifecycleId);
      if (cancellation !== preserveRestartCancellation) cancellation?.cancel();
      for (const deactivate of this.pendingHostApiIncarnations.get(lifecycleId) ?? []) {
        deactivate();
      }
    }
    this.pluginLifecycleGenerations.set(canonicalId, generation);
    this.pluginLifecycleGenerations.set(pluginId, generation);
    for (const alias of this.knownInstallAliases.get(canonicalId) ?? []) {
      this.pluginLifecycleGenerations.set(alias, generation);
    }
    return generation;
  }

  protected assertPluginLifecycleAvailable(pluginId: string): void {
    const canonicalId = this.resolveKnownPluginId(pluginId);
    const reason = this.quarantinedPluginLifecycles.get(canonicalId)
      ?? this.quarantinedPluginLifecycles.get(pluginId);
    if (!reason) return;
    const error = new Error(
      `Plugin lifecycle is quarantined until host restart: ${canonicalId} (${reason})`,
    ) as Error & { code?: string };
    error.code = "plugin-lifecycle-quarantined";
    throw error;
  }

  protected quarantinePluginLifecycle(pluginId: string, reason: string): void {
    const canonicalId = this.resolveKnownPluginId(pluginId);
    this.quarantinedPluginLifecycles.set(canonicalId, reason);
    this.quarantinedPluginLifecycles.set(pluginId, reason);
    for (const alias of this.knownInstallAliases.get(canonicalId) ?? []) {
      this.quarantinedPluginLifecycles.set(alias, reason);
    }
    this.markFailed(canonicalId);
  }

  protected adoptPluginLifecycleIdentity(
    requestedPluginId: string,
    canonicalPluginId: string,
    generation: number,
    installAlias: string | undefined,
  ): boolean {
    const requestedGeneration = this.pluginLifecycleGenerations.get(requestedPluginId);
    const canonicalGeneration = this.pluginLifecycleGenerations.get(canonicalPluginId);
    if (requestedGeneration !== generation || (canonicalGeneration !== undefined && canonicalGeneration > generation)) {
      return false;
    }
    this.rememberPluginInstallAlias(canonicalPluginId, installAlias);
    this.pluginLifecycleGenerations.set(canonicalPluginId, generation);
    this.pluginLifecycleGenerations.set(requestedPluginId, generation);
    for (const alias of this.knownInstallAliases.get(canonicalPluginId) ?? []) {
      this.pluginLifecycleGenerations.set(alias, generation);
    }
    return true;
  }

  protected isPluginLifecycleOperationCurrent(pluginId: string, generation: number): boolean {
    const canonicalId = this.resolveKnownPluginId(pluginId);
    const keys = new Set([
      canonicalId,
      pluginId,
      ...(this.knownInstallAliases.get(canonicalId) ?? []),
    ]);
    return [...keys].every(
      (key) => this.pluginLifecycleGenerations.get(key) === generation,
    );
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  waitForPluginReady(pluginId: string): Promise<void> {
    const canonicalId = this.resolveKnownPluginId(pluginId);
    if (this.preparation.isPreparing(canonicalId)) {
      return this.preparation.waitForReady(canonicalId);
    }
    if (this.plugins.has(canonicalId)) return Promise.resolve();
    return this.preparation.waitForReady(canonicalId);
  }

  /**
   * Verify installed bytes before parsing any manifest, then parse each accepted
   * manifest exactly once. Work overlaps with a conservative bound while the
   * returned array preserves registry/load-plan order for deterministic state
   * projection and failure reporting.
   */

  // ─── Private helpers ───────────────────────────────────────────────────────

  protected resetLoadedState(): void {
    for (const plugin of this.plugins.values()) {
      plugin.deactivateHostApi?.();
    }
    for (const pending of this.pendingHostApiIncarnations.values()) {
      for (const deactivate of pending) {
        deactivate();
      }
    }
    this.pendingHostApiIncarnations.clear();
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
    this.knownInstallAliases.clear();
    this.knownInstallClaims.clear();
    this.knownToolOwners.clear();
    this.knownEventOwners.clear();
    this.plugins.clear();
    for (const pluginId of this.pluginUiRevisions.keys()) {
      this.onPluginUiRevisionChange?.(pluginId);
    }
    this.pluginUiRevisions.clear();
    this.methodMap.clear();
    this.failedPluginIds.clear();
    this.failedPluginStubs.clear();
    this.loadFailureInfo.clear();
    this.disabledPluginIds.clear();
    this.capabilityBlockedPluginIds.clear();
    this.preparation.clear();
    this.pendingRestarts.clear();
    this.pendingRestartPreparations.clear();
    for (const cancellation of this.pendingRestartCancellations.values()) {
      cancellation.cancel();
    }
    this.pendingRestartCancellations.clear();
    this.pluginLifecycleGenerations.clear();
    this.loaded = false;
  }

  protected stopAfterStartFailure(
    pluginId: string,
    instance: RuntimePlugin,
    lifecycleHookScope?: PluginLifecycleHookScope,
  ): Promise<boolean> {
    const pending = this.pluginStopOperations.get(instance);
    if (pending) return pending;
    const stop = this.stopPluginInstance(pluginId, instance, lifecycleHookScope);
    this.pluginStopOperations.set(instance, stop);
    return stop;
  }

  private async stopPluginInstance(
    pluginId: string,
    instance: RuntimePlugin,
    lifecycleHookScope?: PluginLifecycleHookScope,
  ): Promise<boolean> {
    if (!instance.stop) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.runPluginLifecycleHook(lifecycleHookScope, () => instance.stop!()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`stop timeout (>${START_FAILURE_STOP_TIMEOUT_MS}ms)`)),
            START_FAILURE_STOP_TIMEOUT_MS,
          );
        }),
      ]);
      logPluginLifecycle("debug", { pluginId, phase: PluginPhase.STOP_OK }, "stopped after start failure");
      return true;
    } catch (err) {
      this.quarantinePluginLifecycle(pluginId, (err as Error).message);
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.STOP_FAIL, err }, "stop after start failure failed");
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  protected async drainPluginHostApiOperations(
    pluginId: string,
    plugin: Pick<LoadedPlugin, "drainHostApiOperations">,
  ): Promise<boolean> {
    if (!plugin.drainHostApiOperations) return true;
    try {
      await plugin.drainHostApiOperations();
      return true;
    } catch (err) {
      this.quarantinePluginLifecycle(pluginId, (err as Error).message);
      logPluginLifecycle(
        "error",
        { pluginId, phase: PluginPhase.STOP_FAIL, err },
        "HostApi operation drain failed",
      );
      return false;
    }
  }

  protected async settleCommittedRetirement(
    pluginId: string,
    retirement: Promise<void>,
    context: string,
  ): Promise<void> {
    try {
      await retirement;
    } catch (error) {
      log.error(
        `plugin generation retirement failed after ${context} for ${pluginId}: %s`,
        errorMessage(error),
      );
      this.auditLog?.("error", "plugin_generation_retirement_failed", {
        pluginId,
        context,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  protected async captureCommittedRetirementFailure(
    pluginId: string,
    retirement: Promise<void>,
    context: string,
  ): Promise<unknown | undefined> {
    try {
      await this.settleCommittedRetirement(pluginId, retirement, context);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  protected async failClosedLoadedPlugin(
    pluginId: string,
    plugin: LoadedPlugin,
    context: string,
  ): Promise<void> {
    this.markFailed(pluginId);
    plugin.deactivateHostApi?.();
    for (const method of plugin.methods.keys()) {
      this.methodMap.delete(method);
    }
    this.plugins.delete(pluginId);
    this.runPluginDisposers(pluginId, context);
    this.onDisable?.(pluginId);
    await this.stopAfterStartFailure(
      pluginId,
      plugin.instance,
      plugin.lifecycleHookScope,
    );
    await this.drainPluginHostApiOperations(pluginId, plugin);
  }

  protected runPluginDisposers(pluginId: string, context: string): void {
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

  protected runDisposerList(disposers: Array<() => void>, context: string): void {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (err) {
        log.error(`disposer failed during ${context}: %s`, (err as Error).message);
      }
    }
  }

  protected throwIfPluginFailedAfterAdd(pluginId: string): void {
    if (!this.failedPluginIds.has(pluginId) && this.plugins.has(pluginId)) return;
    const stub = this.failedPluginStubs.get(pluginId);
    const reason = stub?.description ?? "plugin failed to load (see prior log)";
    throw new Error(`addPlugin failed for ${pluginId}: ${reason}`);
  }

  protected throwIfToolOwnerNotReady(toolName: string): void {
    const pluginId = this.knownToolOwners.get(toolName);
    if (!pluginId) return;
    if (
      this.preparation.isPreparing(pluginId)
      || this.capabilityBlockedPluginIds.has(pluginId)
    ) {
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

  protected throwIfPluginNotStarted(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || plugin.started !== false) return;
    throw new Error(
      `Plugin '${pluginId}' is still starting. Try again after the plugin is ready.`,
    );
  }

  protected markFailed(
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
   * THE reporter for every LOAD-boundary refusal: each gate decides *whether*
   * to refuse and supplies the wording, none decides *how* it reaches the user.
   *
   * The obligation it discharges is the STUB. `listPluginCards()` projects
   * exactly two maps — `knownPluginManifests` and `failedPluginStubs` — so a
   * gate that reaches its verdict before the manifest is read (receipt check,
   * registry-path trust check) and marks the id failed WITHOUT a stub produces
   * no card at all: the plugin vanishes from the sidebar, Settings and the
   * Plugin Doctor while its registry row still reports it installed.
   *
   * `kind` is what makes one refusal distinguishable from another: it selects
   * the remedy sentence AND whether a reinstall is offered at all
   * ({@link isReinstallFixableFailureKind}); undefined means unclassified,
   * which is treated as reinstall-repairable. `summary` becomes the card
   * description, `reason` the Doctor's "Error detail".
   */
  protected markLoadRefused(
    pluginId: string,
    refusal: {
      summary: string;
      reason: string;
      kind?: PluginInstallFailureKind;
      displayName?: string;
    },
  ): void {
    this.markFailed(pluginId, {
      name: refusal.displayName ?? pluginId,
      description: refusal.summary,
    }, {
      ...(refusal.kind ? { installFailureKind: refusal.kind } : {}),
      installFailureMessage: refusal.reason,
    });
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
  protected markIncompatibleAppVersion(manifest: PluginManifest): boolean {
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
    this.markLoadRefused(manifest.id, {
      summary: `plugin requires LVIS >= ${minAppVersion}, current ${currentAppVersion}`,
      reason: `plugin requires LVIS >= ${minAppVersion}, current ${currentAppVersion}`,
      // NOT locally reinstall-fixable — the marketplace ships the same too-new
      // package, so a reinstall re-throws. The Doctor must fall back to a
      // diagnosis directing the user to update the app.
      kind: "incompatible-app-version",
      displayName: manifest.name ?? manifest.id,
    });
    return true;
  }

  /**
   * Plugin revocation gate (LOAD boundary). A plugin already on disk
   * (installed before it was revoked, or sideloaded) must not silently keep
   * running once the marketplace revocation registry blocks its exact
   * version or drops it below the pinned minimum — mirrors
   * `markIncompatibleAppVersion` immediately above, including the
   * "isolation" property: this plugin is skipped, every other plugin still
   * loads normally.
   *
   * Fail-open by construction: `revocationRegistry.evaluate()` returns
   * `allow` whenever no valid signed document has ever been obtained (see
   * `revocation-registry.ts` for the fail-open/fail-closed rationale), so
   * this method only ever blocks when a signed document actually says to.
   */
  protected markRevoked(manifest: PluginManifest): boolean {
    const decision = revocationRegistry.evaluate(manifest.id, manifest.version);
    if (decision.kind === "allow") return false;

    const reason = `plugin revoked — ${decision.reason}`;
    log.error(`${manifest.id} rejected — ${reason}`);
    this.auditLog?.("error", "plugin_revoked", {
      pluginId: manifest.id,
      version: manifest.version,
      ruleKind: decision.ruleKind,
      reason: decision.reason,
    });
    this.markLoadRefused(manifest.id, {
      summary: decision.reason,
      reason: decision.reason,
      // NOT locally reinstall-fixable — a reinstall from the marketplace
      // either re-fetches the same blocked version (the install path
      // enforces the same registry) or is a genuine version upgrade, not a
      // "repair". The Doctor must show the block reason and offer Remove.
      kind: "plugin-revoked",
      displayName: manifest.name ?? manifest.id,
    });
    return true;
  }

  protected inferEventOwner(eventType: string): string | undefined {
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

  protected async materializeImmutableRuntimeRoot(
    pluginId: string,
    pluginRoot: string,
    activationId: string,
    receiptPluginId: string = pluginId,
  ): Promise<string> {
    this.requireGenerationLifecycle("materialize runtime root");
    if (!this.installReceiptCacheRoot) {
      throw new Error("plugin generation lifecycle requires installReceiptCacheRoot");
    }
    const manifestRaw = await readFile(resolve(pluginRoot, "plugin.json"), "utf8");
    const receiptRaw = await readFile(
      installReceiptPath(this.installReceiptCacheRoot, receiptPluginId),
      "utf8",
    );
    const artifactGenerationId = pluginArtifactGenerationId(manifestRaw, receiptRaw);
    const generationId = createHash("sha256")
      .update(artifactGenerationId)
      .update("\0")
      .update(activationId)
      .digest("hex");
    return materializePluginGenerationRoot(
      pluginRoot,
      this.installReceiptCacheRoot,
      pluginId,
      generationId,
      receiptRaw,
      receiptPluginId,
    );
  }

  protected async removeUnpublishedRuntimeRoot(pluginId: string, runtimeRoot: string): Promise<void> {
    if (!this.installReceiptCacheRoot) {
      throw new Error("plugin generation lifecycle requires installReceiptCacheRoot");
    }
    const generationDir = dirname(runtimeRoot);
    const generationsRoot = resolve(this.installReceiptCacheRoot, pluginId, "generations");
    if (dirname(generationDir) !== generationsRoot || basename(runtimeRoot) !== "payload") return;
    const generationId = basename(generationDir);
    if (!/^[a-f0-9]{64}$/.test(generationId)) return;
    await removeRetainedPluginGeneration(this.installReceiptCacheRoot, pluginId, generationId);
  }

  setGenerationAccess(access: PluginRuntimeGenerationAccess): void {
    if (!("replaceRuntime" in access) || typeof access.replaceRuntime !== "function") {
      throw new Error("plugin runtime requires a complete generation lifecycle");
    }
    this.generationAccess = access;
    this.generationLifecycle = access as PluginRuntimeGenerationLifecycle;
  }

  protected requireGenerationLifecycle(operation: string): PluginRuntimeGenerationLifecycle {
    if (!this.generationLifecycle) {
      throw new Error(`[plugin-runtime] generation lifecycle is not bound before ${operation}`);
    }
    return this.generationLifecycle;
  }

  protected requireGenerationAccess(operation: string): PluginRuntimeGenerationAccess {
    if (!this.generationAccess) {
      throw new Error(`[plugin-runtime] generation access is not bound before ${operation}`);
    }
    return this.generationAccess;
  }

  getGenerationAccess(): PluginRuntimeGenerationAccess | undefined {
    return this.generationAccess;
  }

  prepareRuntimeRetirement(
    runtime: PluginRuntimeGenerationProjection,
  ): readonly PluginRuntimeRetirementStep[] {
    return Object.freeze([
      Object.freeze({
        phase: "runtime.authority" as const,
        run: () => {
          // Revoke general HostApi authority before user stop code runs. Any
          // exact operation admitted before publication can finish during
          // coordinator drain; retirement begins only after those leases have
          // been released.
          runtime.deactivateHostApi?.();
        },
      }),
      Object.freeze({
        phase: "runtime.stop" as const,
        run: async () => {
          const stopped = await this.stopAfterStartFailure(
            runtime.manifest.id,
            runtime.instance,
            runtime.lifecycleHookScope,
          );
          if (!stopped) {
            throw new Error(
              `generation stop failed or timed out for ${runtime.manifest.id}`,
            );
          }
        },
      }),
      Object.freeze({
        phase: "runtime.effects" as const,
        run: () => {
          const errors = [...(runtime.hostEffects?.retire() ?? [])];
          for (const dispose of runtime.disposers ?? []) {
            try {
              dispose();
            } catch (error) {
              log.error(
                `generation disposer failed for ${runtime.manifest.id}: %s`,
                (error as Error).message,
              );
              errors.push(error instanceof Error ? error : new Error(String(error)));
            }
          }
          if (errors.length > 0) {
            throw new AggregateError(
              errors,
              `plugin '${runtime.manifest.id}' generation effects retirement failed`,
            );
          }
        },
      }),
      Object.freeze({
        phase: "runtime.drain" as const,
        run: async () => {
          if (!runtime.drainHostApiOperations) return;
          try {
            await runtime.drainHostApiOperations();
          } catch (error) {
            log.error(
              `generation HostApi drain failed for ${runtime.manifest.id}: %s`,
              (error as Error).message,
            );
            throw error;
          }
        },
      }),
    ]);
  }

  protected async withPinnedGeneration<T>(
    pluginId: string,
    operation: (
      projection: PluginRuntimeGenerationProjection,
      generationId: string,
    ) => Promise<T>,
    expectedGenerationId?: string,
  ): Promise<T> {
    const access = this.requireGenerationAccess("plugin operation");
    const pinned = expectedGenerationId ?? this.pinnedGenerations.getStore()?.get(pluginId);
    const lease = pinned
      ? await access.acquireExact(pluginId, pinned)
      : await access.acquire(pluginId);
    const next = new Map(this.pinnedGenerations.getStore() ?? []);
    next.set(pluginId, lease.generation.generationId);
    let releaseDeferred = false;
    try {
      return await access.runWithLease(
        lease,
        () => this.pinnedGenerations.run(
          Object.freeze(next) as ReadonlyMap<string, string>,
          () => operation(lease.generation.state.runtime, lease.generation.generationId),
        ),
      );
    } catch (error) {
      if (isPluginRuntimeDetachedOperationError(error)) {
        releaseDeferred = true;
        void error.settlement.then(
          () => lease.release(),
          () => lease.release(),
        );
      }
      throw error;
    } finally {
      if (!releaseDeferred) lease.release();
    }
  }

  /**
   * Run a host-owned integration against the exact immutable plugin instance
   * admitted for the duration of the operation. Callers must not retain the
   * instance beyond the callback: disable, update, rollback, and uninstall all
   * wait for this lease before retiring the generation.
   */
  async withPluginInstanceLease<TPlugin, TResult>(
    pluginId: string,
    operation: (instance: TPlugin) => Promise<TResult>,
  ): Promise<TResult> {
    return this.withPinnedGeneration(
      pluginId,
      async (projection) => operation(projection.instance as TPlugin),
    );
  }
}

// ---------------------------------------------------------------------------
// PluginRuntimePublicationState
// ---------------------------------------------------------------------------

/** Host-private in-memory projections for an already prepared plugin generation. */
abstract class PluginRuntimePublicationState extends PluginRuntimeState {
  getRuntimeGenerationProjection(pluginId: string): PluginRuntimeGenerationProjection | undefined {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return undefined;
    return Object.freeze({
      activationId: plugin.activationId,
      installId: this.requirePluginInstallClaim(pluginId),
      manifest: plugin.manifest,
      pluginRoot: plugin.pluginRoot,
      instance: plugin.instance,
      methods: new Map(plugin.methods),
      ...(plugin.approvedPluginAccess ? { approvedPluginAccess: plugin.approvedPluginAccess } : {}),
      disposers: Object.freeze([...(this.disposers.get(pluginId) ?? [])]),
      ...(plugin.hostEffects ? { hostEffects: plugin.hostEffects } : {}),
      ...(plugin.deactivateHostApi ? { deactivateHostApi: plugin.deactivateHostApi } : {}),
      ...(plugin.drainHostApiOperations
        ? { drainHostApiOperations: plugin.drainHostApiOperations }
        : {}),
      ...(plugin.lifecycleHookScope ? { lifecycleHookScope: plugin.lifecycleHookScope } : {}),
    });
  }

  prepareRuntimeGeneration(
    runtime: PluginRuntimeGenerationProjection,
    predecessorGenerationId: string | undefined,
  ): PreparedPluginRuntimeGenerationPublication {
    const pluginId = runtime.manifest.id;
    if (runtime.installId === undefined) {
      throw new Error(`Plugin runtime generation install provenance missing: ${pluginId}`);
    }
    this.assertPluginIdentityNamespace(
      [{ pluginId, alias: runtime.installId ?? undefined }],
      runtime.installId === null ? [] : [runtime.installId],
    );
    const nextMethods = new Map(this.methodMap);
    for (const [toolName, entry] of nextMethods) {
      if (entry.pluginId === pluginId) nextMethods.delete(toolName);
    }
    for (const toolName of runtime.methods.keys()) {
      const owner = nextMethods.get(toolName)?.pluginId;
      if (owner && owner !== pluginId) throw new Error(`Duplicate plugin method registered: ${toolName}`);
      nextMethods.set(toolName, { pluginId, handler: runtime.methods.get(toolName)! });
    }
    const nextPlugins = new Map(this.plugins);
    nextPlugins.set(pluginId, {
      activationId: runtime.activationId,
      manifest: runtime.manifest,
      pluginRoot: runtime.pluginRoot,
      instance: runtime.instance,
      methods: new Map(runtime.methods),
      approvedPluginAccess: runtime.approvedPluginAccess,
      hostEffects: runtime.hostEffects,
      started: true,
      deactivateHostApi: runtime.deactivateHostApi,
      drainHostApiOperations: runtime.drainHostApiOperations,
      lifecycleHookScope: runtime.lifecycleHookScope,
    });
    const nextDisposers = new Map(this.disposers);
    nextDisposers.set(pluginId, [...(runtime.disposers ?? [])]);
    const predecessorAuthKey = predecessorGenerationId === undefined
      ? undefined
      : `${pluginId}\0${predecessorGenerationId}`;
    const publishHostEffects = runtime.hostEffects?.preparePublish();
    let published = false;
    return Object.freeze({
      pluginId,
      publish: () => {
        if (published) return;
        this.plugins.get(pluginId)?.hostEffects?.supersede();
        publishHostEffects?.();
        this.publishValidatedPluginInstallAlias(pluginId, runtime.installId ?? undefined);
        this.methodMap = nextMethods;
        this.plugins = nextPlugins;
        this.disposers = nextDisposers;
        this.rememberPluginManifest(pluginId, runtime.manifest, runtime.approvedPluginAccess);
        this.markPluginUiRevision(pluginId);
        this.failedPluginIds.delete(pluginId);
        this.loadFailureInfo.delete(pluginId);
        this.disabledPluginIds.delete(pluginId);
        // Auth outcomes can arrive after preparation. Retain the live bridge
        // and erase only the exact predecessor's mutable generation state.
        if (predecessorAuthKey !== undefined) {
          this.pluginAccountHashes.delete(predecessorAuthKey);
          this.pluginAuthInvocationEpochs.delete(predecessorAuthKey);
          this.pluginAuthPublishedEpochs.delete(predecessorAuthKey);
          for (const key of this.pluginAuthFailurePrincipals.keys()) {
            if (key.startsWith(`${predecessorAuthKey}\0`)) {
              this.pluginAuthFailurePrincipals.delete(key);
            }
          }
        }
        published = true;
      },
    });
  }

  prepareRuntimeRemoval(
    pluginId: string,
    predecessorGenerationId: string | undefined,
  ): PreparedPluginRuntimeGenerationPublication {
    const nextMethods = new Map(this.methodMap);
    for (const [toolName, entry] of nextMethods) {
      if (entry.pluginId === pluginId) nextMethods.delete(toolName);
    }
    const nextPlugins = new Map(this.plugins);
    nextPlugins.delete(pluginId);
    const nextDisposers = new Map(this.disposers);
    nextDisposers.delete(pluginId);
    const predecessorAuthKey = predecessorGenerationId === undefined
      ? undefined
      : `${pluginId}\0${predecessorGenerationId}`;
    let published = false;
    return Object.freeze({
      pluginId,
      publish: () => {
        if (published) return;
        this.plugins.get(pluginId)?.hostEffects?.supersede();
        this.methodMap = nextMethods;
        this.plugins = nextPlugins;
        this.disposers = nextDisposers;
        this.invalidatePluginUiRevision(pluginId);
        if (predecessorAuthKey !== undefined) {
          this.pluginAccountHashes.delete(predecessorAuthKey);
          this.pluginAuthInvocationEpochs.delete(predecessorAuthKey);
          this.pluginAuthPublishedEpochs.delete(predecessorAuthKey);
          for (const key of this.pluginAuthFailurePrincipals.keys()) {
            if (key.startsWith(`${predecessorAuthKey}\0`)) {
              this.pluginAuthFailurePrincipals.delete(key);
            }
          }
        }
        published = true;
      },
    });
  }

  /**
   * Two different owners can fail here, and they do not deserve the same answer.
   *
   * `hostEffects.postPublish()` is the host's own generation fence. If it fails
   * the host can no longer say which generation owns which effect, so throwing
   * — which keeps dispatch closed — is the only safe answer.
   *
   * `instance.onPublished()` is the plugin's startup, and by the time it runs
   * the instance is constructed and its handlers are already in the method map.
   * A plugin whose startup failed is in the same state as one whose worker dies
   * a second after a successful startup — except the later death leaves dispatch
   * open and lets each call report the real reason, while the earlier one used
   * to close dispatch for the whole session with no retry path, since readiness
   * is only replaced when a new generation is committed. One condition, two
   * opposite outcomes, decided by timing. So a startup failure is recorded as
   * degraded and dispatch opens; the plugin answers per call.
   */
  async postPublishRuntimeGeneration(runtime: PluginRuntimeGenerationProjection): Promise<void> {
    const hostFaults: Error[] = [];
    for (const error of runtime.hostEffects?.postPublish() ?? []) {
      log.error(`generation post-publish signal failed for ${runtime.manifest.id}: %s`, error.message);
      hostFaults.push(error);
    }
    try {
      await runtime.instance.onPublished?.();
    } catch (error) {
      log.error(`generation post-publish startup degraded for ${runtime.manifest.id}: %s`, (error as Error).message);
      this.auditLog?.("warn", "plugin_post_publish_startup_degraded", {
        pluginId: runtime.manifest.id,
        version: runtime.manifest.version,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    }
    if (hostFaults.length > 0) {
      throw new AggregateError(
        hostFaults,
        `plugin '${runtime.manifest.id}' host generation effects failed to publish`,
      );
    }
  }

  publishRuntimeGeneration(
    runtime: PluginRuntimeGenerationProjection,
    predecessorGenerationId: string | undefined,
  ): void {
    this.prepareRuntimeGeneration(runtime, predecessorGenerationId).publish();
  }

  unpublishRuntimeGeneration(
    pluginId: string,
    predecessorGenerationId: string | undefined,
  ): void {
    this.prepareRuntimeRemoval(pluginId, predecessorGenerationId).publish();
  }
}

// ---------------------------------------------------------------------------
// PluginRuntimeCapabilityLifecycle
// ---------------------------------------------------------------------------

type PreparedArtifactHostApiIncarnation = {
  hostApi: PluginHostApi;
  disposers: Array<() => void>;
  deactivate: () => void;
  drainOperations: () => Promise<void>;
  commit: () => void;
  lifecycleHookScope: PluginLifecycleHookScope;
};
abstract class PluginRuntimeCapabilityLifecycle extends PluginRuntimePublicationState {
  /**
   * Install-receipt integrity gate (LOAD boundary). Same "skip this plugin,
   * keep loading everything else" shape as the gates below. The kind stays
   * unclassified on purpose: reinstalling rewrites payload and receipt
   * together, which is the repair `isReinstallFixableFailureKind(undefined)`
   * lets the Doctor offer.
   */
  protected markReceiptIntegrityFailed(
    pluginId: string,
    reason: string,
    displayName: string = pluginId,
  ): void {
    this.markLoadRefused(pluginId, {
      summary: "Plugin files do not match their install receipt.",
      reason,
      displayName,
    });
  }

  private readonly capabilityBlockedRetries = new Map<
    string,
    CapabilityBlockedRetry
  >();
  protected readonly capabilityBlockedReadiness = new Map<
    string,
    CapabilityBlockedReadiness
  >();
  protected readonly capabilityBlockedRetryAdds = new Set<string>();
  private readonly watchedPreparingCapabilityProviders = new Map<string, symbol>();
  private pendingCapabilityBlockedRetry: Promise<void> | undefined;
  private capabilityBlockedRetryRequested = false;

  protected abstract importPluginFactoryForLifecycle(
    pluginId: string,
    resolvedEntryPath: string,
    manifest: PluginManifest,
    bustCache?: boolean,
  ): Promise<RuntimePluginFactory | undefined>;

  protected abstract startLoadedPluginAtBoot(
    pluginId: string,
    expectedPlugin?: LoadedPlugin,
    shouldCommit?: () => boolean,
  ): Promise<string | undefined>;

  protected abstract failBootPlugin(
    pluginId: string,
    plugin: LoadedPlugin,
    reason: string,
  ): Promise<void>;

  abstract restartPlugin(
    pluginId: string,
    opts?: { skipPreparation?: boolean; throwOnFailure?: boolean },
  ): Promise<RestartPluginResult>;

  abstract addPlugin(pluginId: string): Promise<"started" | "preparing">;

  abstract removePlugin(
    pluginId: string,
    options?: { preserveConfigOverride?: boolean },
  ): Promise<void>;

  protected abstract deferBlockedAddPlugin(
    pluginId: string,
    providerIds: readonly string[],
  ): void;
  /**
   * A capability-blocked boot candidate is loaded enough to have a runtime
   * projection, but it has never published a bundle generation. The bundle
   * lifecycle deliberately rejects normal deactivation for that state, because
   * an active pointer must never be fabricated just to tear down a candidate.
   */
  protected isUnpublishedLoadedCandidate(
    pluginId: string,
    plugin: LoadedPlugin,
    generationLifecycle: PluginRuntimeGenerationLifecycle,
  ): boolean {
    return this.plugins.get(pluginId) === plugin
      && plugin.started === false
      && !generationLifecycle.getActive(pluginId);
  }

  private throwUnpublishedCandidateCleanupErrors(pluginId: string, cleanupErrors: readonly Error[]): void {
    if (cleanupErrors.length === 1) throw cleanupErrors[0]!;
    if (cleanupErrors.length > 1) {
      throw new AggregateError(
        cleanupErrors,
        `unpublished plugin candidate cleanup failed: ${pluginId}`,
      );
    }
  }

  private runUnpublishedCandidateDisposers(
    disposers: Array<() => void> | undefined,
    context: string,
    cleanupErrors: Error[],
  ): void {
    if (!disposers) return;
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        log.error(`disposer failed during ${context}: %s`, normalized.message);
        cleanupErrors.push(normalized);
      }
    }
  }

  /**
   * Retire resources owned by an unpublished candidate. The map/method state is
   * deliberately not touched here: direct removal detaches it synchronously,
   * while prepared replacement has already published the successor. A failed
   * stop, effect cleanup, or HostApi drain preserves the old retained root and
   * is surfaced to the caller's retirement contract.
   */
  private async retireUnpublishedCandidateResources(
    pluginId: string,
    plugin: LoadedPlugin,
    candidateDisposers: Array<() => void> | undefined,
    context: string,
    options: { authorityAlreadyRevoked?: boolean; preserveRuntimeRoot?: string } = {},
    initialErrors: Error[] = [],
  ): Promise<void> {
    const cleanupErrors = [...initialErrors];
    if (!options.authorityAlreadyRevoked) {
      try {
        plugin.deactivateHostApi?.();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    let stopped = false;
    try {
      stopped = await this.stopAfterStartFailure(
        pluginId,
        plugin.instance,
        plugin.lifecycleHookScope,
      );
      if (!stopped) {
        cleanupErrors.push(new Error(`unpublished plugin candidate stop failed: ${pluginId}`));
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }

    try {
      if (plugin.hostEffects?.isPreparing()) plugin.hostEffects.discard();
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    this.runUnpublishedCandidateDisposers(candidateDisposers, context, cleanupErrors);

    let drained = false;
    try {
      drained = await this.drainPluginHostApiOperations(pluginId, plugin);
      if (!drained) {
        cleanupErrors.push(new Error(
          `unpublished plugin candidate HostApi drain failed: ${pluginId}`,
        ));
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }

    if (
      cleanupErrors.length === 0
      && stopped
      && drained
      && plugin.pluginRoot !== options.preserveRuntimeRoot
    ) {
      try {
        await this.removeUnpublishedRuntimeRoot(pluginId, plugin.pluginRoot);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.throwUnpublishedCandidateCleanupErrors(pluginId, cleanupErrors);
  }

  /**
   * Discard exactly one unstarted, unpublished candidate without touching the
   * bundle-generation pointer. Callers own durable state, retry cancellation,
   * and catalog bookkeeping; this method only retires the candidate-local
   * runtime resources it can prove still belong to `plugin`.
   */
  protected detachUnpublishedLoadedCandidate(
    pluginId: string,
    plugin: LoadedPlugin,
    context: string,
  ): () => Promise<void> {
    if (this.plugins.get(pluginId) !== plugin) {
      throw new Error(`plugin '${pluginId}' unpublished candidate changed before cleanup`);
    }
    const candidateDisposers = this.disposers.get(pluginId);
    const cleanupErrors: Error[] = [];
    try {
      plugin.deactivateHostApi?.();
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    // Do not remove a same-id successor's handlers if a stale callback manages
    // to interleave with this candidate cleanup.
    if (this.plugins.get(pluginId) !== plugin) {
      throw new Error(`plugin '${pluginId}' unpublished candidate changed during cleanup`);
    }
    for (const [toolName, handler] of plugin.methods) {
      const entry = this.methodMap.get(toolName);
      if (entry?.pluginId === pluginId && entry.handler === handler) {
        this.methodMap.delete(toolName);
      }
    }
    this.plugins.delete(pluginId);
    if (candidateDisposers && this.disposers.get(pluginId) === candidateDisposers) {
      this.disposers.delete(pluginId);
    }
    return () =>
      this.retireUnpublishedCandidateResources(
        pluginId,
        plugin,
        candidateDisposers,
        context,
        { authorityAlreadyRevoked: true },
        cleanupErrors,
      );
  }

  /**
   * Retire a candidate displaced by a successfully published replacement. Its
   * successor already owns the runtime maps, so this only touches resources
   * captured from the exact old object and never mutates current map entries.
   */
  private retireDisplacedUnpublishedLoadedCandidate(
    pluginId: string,
    plugin: LoadedPlugin,
    candidateDisposers: Array<() => void> | undefined,
    replacementRuntimeRoot: string,
    context: string,
  ): Promise<void> {
    if (this.plugins.get(pluginId) === plugin) {
      return Promise.reject(new Error(
        `plugin '${pluginId}' unpublished candidate was not displaced by replacement`,
      ));
    }
    return this.retireUnpublishedCandidateResources(
      pluginId,
      plugin,
      candidateDisposers,
      context,
      { preserveRuntimeRoot: replacementRuntimeRoot },
    );
  }

  protected async removePluginLocked(
    pluginId: string,
    canonicalPluginId: string,
    options: { preserveConfigOverride?: boolean },
  ): Promise<void> {
    this.assertNoActiveCapabilityDependents(canonicalPluginId, "remove");
    this.clearCapabilityBlockedRetry(
      canonicalPluginId,
      `plugin '${canonicalPluginId}' capability dependency wait was cancelled by removal`,
    );
    // Invalidate in-flight add/restart continuations before the first await.
    this.beginPluginLifecycleOperation(canonicalPluginId);
    this.preparation.clearFor(canonicalPluginId);
    this.pendingRestartPreparations.delete(canonicalPluginId);
    // Late incarnations own private disposers; tracked state can be purged
    // without waiting on an invalidated preparation that may never settle.
    const plugin = this.plugins.get(canonicalPluginId);
    let retirementError: unknown;
    let unpublishedCleanup: (() => Promise<void>) | undefined;
    if (plugin) {
      const generationLifecycle = this.requireCapabilityCommitLifecycle("plugin removal");
      if (this.isUnpublishedLoadedCandidate(canonicalPluginId, plugin, generationLifecycle)) {
        unpublishedCleanup = this.detachUnpublishedLoadedCandidate(
          canonicalPluginId,
          plugin,
          "unpublished plugin removal",
        );
      } else {
        const { retirement } = await generationLifecycle.deactivateWithCommit(
          canonicalPluginId,
          async () => undefined,
          this.capabilityDependencyCommitScope(() => {
            this.assertNoActiveCapabilityDependents(canonicalPluginId, "remove");
          }),
        );
        retirementError = await this.captureCommittedRetirementFailure(canonicalPluginId, retirement, "plugin removal");
      }
    } else if (
      !this.knownPluginManifests.has(canonicalPluginId) &&
      !this.failedPluginIds.has(canonicalPluginId) &&
      !this.failedPluginStubs.has(canonicalPluginId) &&
      !this.disabledPluginIds.has(canonicalPluginId)
    ) {
      log.warn(`removePlugin: plugin not loaded — ${pluginId}`);
      this.knownInstallAliases.delete(canonicalPluginId);
      this.knownInstallClaims.delete(canonicalPluginId);
      this.inactivePluginIds.delete(canonicalPluginId);
      if (!options.preserveConfigOverride) {
        this.configStore.delete(canonicalPluginId);
      }
      return;
    } else {
      log.info(`removePlugin: plugin in non-loaded state (failed/disabled), purging tracking — ${pluginId}`);
    }

    // stop() may persist configuration while releasing resources. Delete the
    // runtime override only after that hook has been bounded and deactivated.
    if (!options.preserveConfigOverride) {
      this.configStore.delete(canonicalPluginId);
    }

    this.knownPluginManifests.delete(canonicalPluginId);
    this.knownPluginAccessGrants.delete(canonicalPluginId);
    for (const [toolName, ownerId] of [...this.knownToolOwners.entries()]) {
      if (ownerId === canonicalPluginId) this.knownToolOwners.delete(toolName);
    }
    for (const [eventType, ownerId] of [...this.knownEventOwners.entries()]) {
      if (ownerId === canonicalPluginId) this.knownEventOwners.delete(eventType);
    }
    this.failedPluginIds.delete(canonicalPluginId);
    this.failedPluginStubs.delete(canonicalPluginId);
    this.loadFailureInfo.delete(canonicalPluginId);
    this.disabledPluginIds.delete(canonicalPluginId);
    this.inactivePluginIds.delete(canonicalPluginId);
    this.invalidatePluginUiRevision(canonicalPluginId);
    this.knownInstallAliases.delete(canonicalPluginId);
    this.knownInstallClaims.delete(canonicalPluginId);

    this.onDisable?.(canonicalPluginId);
    if (unpublishedCleanup) {
      try {
        await unpublishedCleanup();
      } catch (error) {
        retirementError = error;
      }
    }
    if (retirementError !== undefined) throw retirementError;
  }

  /** Instantiate and start one post-boot plugin without rebuilding its peers. */
  protected async instantiateAndStartSinglePlugin(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    opts: { skipPreparation?: boolean; cacheBust?: boolean; shouldCommit?: () => boolean } = {},
  ): Promise<SinglePluginStartResult> {
    const generationLifecycle = this.requireCapabilityCommitLifecycle("plugin add");
    const pluginRoot = dirname(plan.manifestPath);
    const canCommit = () => opts.shouldCommit?.() ?? true;
    if (!canCommit()) return "cancelled";
    this.rememberPluginInstallAlias(manifest.id, plan.pluginIdHint);
    if (plan.pluginIdHint) {
      const integrityResult = await this.verifyReceiptAndDevGuard(
        plan.pluginIdHint,
        pluginRoot,
      );
      if (!canCommit()) return "cancelled";
      if (!integrityResult.ok) {
        // Keyed by the canonical manifest id — the caller already remembered
        // the manifest under it, so the registry-id key the receipt check uses
        // would leave that card reporting a non-failed status and strip the
        // reason from `throwIfPluginFailedAfterAdd`.
        this.markReceiptIntegrityFailed(
          manifest.id,
          integrityResult.reason,
          manifest.name ?? manifest.id,
        );
        return "failed";
      }
    }

    // Plugin↔app minimum-version gate — HARD BLOCK at LOAD (see boot path).
    if (!canCommit()) return "cancelled";
    if (this.markIncompatibleAppVersion(manifest)) {
      return "failed";
    }

    // Plugin revocation gate — HARD BLOCK at LOAD (see boot path).
    if (!canCommit()) return "cancelled";
    if (this.markRevoked(manifest)) {
      return "failed";
    }

    const missingCapabilities = this.capabilityDependencies().missing(manifest);
    if (missingCapabilities.length > 0) {
      if (!canCommit()) return "cancelled";
      const preparingProviderIds = this.preparingCapabilityProviderIds(
        manifest,
        missingCapabilities,
      );
      if (preparingProviderIds) {
        // This branch is reached only by PreparationTracker after the
        // consumer's own preparation completed. Waiting here is background
        // work, so startAll/restartAll remain nonblocking.
        if (opts.skipPreparation) {
          await this.waitForPreparingCapabilityProviderChange(
            preparingProviderIds,
          );
          if (!canCommit()) return "cancelled";
          return this.instantiateAndStartSinglePlugin(
            plan,
            manifest,
            approvedPluginAccess,
            opts,
          );
        }
        // Let the existing tracker own a consumer's own preparation first.
        // If it has no preparation hook, retain only the id and re-enter via
        // addPlugin once a provider settles so current identity is re-read.
        if (
          this.preparation.deferStart(
            plan,
            manifest,
            approvedPluginAccess,
            opts,
          )
        ) {
          return "deferred";
        }
        this.deferBlockedAddPlugin(manifest.id, preparingProviderIds);
        return "deferred";
      }
      if (!canCommit()) return "cancelled";
      const reason = `missing required capabilities: ${missingCapabilities.join(", ")}`;
      log.error(`${manifest.id} rejected — ${reason}`);
      this.auditLog?.("error", "plugin_dependency_missing", {
        pluginId: manifest.id,
        missing: missingCapabilities,
      });
      this.markFailed(manifest.id, {
        name: manifest.name ?? manifest.id,
        description: `Missing capabilities: ${missingCapabilities.join(", ")}`,
      });
      return "failed";
    }

    if (!canCommit()) return "cancelled";
    if (!opts.skipPreparation && this.preparation.deferStart(plan, manifest, approvedPluginAccess, opts)) {
      return "deferred";
    }

    const activationId = randomUUID();
    const runtimeRoot = await this.materializeImmutableRuntimeRoot(
      manifest.id,
      pluginRoot,
      activationId,
      plan.pluginIdHint ?? manifest.id,
    );
    let entryPath: string;
    try {
      entryPath = this.resolveEntryPathForPlugin(runtimeRoot, manifest.entry);
    } catch (err) {
      if (!canCommit()) {
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        return "cancelled";
      }
      const reason = (err as Error).message;
      log.error(`${manifest.id} rejected: ${reason}`);
      this.auditLog?.("error", "plugin_entry_path_rejected", {
        pluginId: manifest.id,
        entry: manifest.entry,
        reason,
      });
      this.markFailed(manifest.id);
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return "failed";
    }
    const resolvedEntryPath = resolveRealEntryPath(entryPath);

    let createPlugin: RuntimePluginFactory | undefined;
    try {
      createPlugin = await this.importPluginFactoryForLifecycle(
        manifest.id,
        resolvedEntryPath,
        manifest,
        opts.cacheBust,
      );
    } catch (err) {
      if (!canCommit()) {
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        return "cancelled";
      }
      log.error(`${manifest.id} import failed: %s`, (err as Error).message);
      this.auditLog?.("error", "plugin_import_failed", {
        pluginId: manifest.id,
        reason: (err as Error).message,
      });
      this.markFailed(manifest.id);
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return "failed";
    }
    if (!canCommit()) {
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return "cancelled";
    }
    if (!createPlugin) {
      log.error(`${manifest.id} entry does not export default/createPlugin — skipped`);
      this.markFailed(manifest.id);
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return "failed";
    }

    const pluginDataDir = this.ensureDataDir(manifest.id, pluginRoot);
    const hostEffects = new HostApiGenerationScope(manifest.id);
    const { hostApi, disposers, deactivate, drainOperations, commit, lifecycleHookScope } =
      this.buildHostApiIncarnation(
        manifest.id,
        manifest,
        pluginDataDir,
        hostEffects,
      );

    let instance: RuntimePlugin;
    try {
      instance = await runPluginFactoryWithTimeout(
        () => this.runPluginLifecycleHook(
          lifecycleHookScope,
          () => createPlugin(
            buildPluginContext({
              pluginId: manifest.id,
              pluginRoot: runtimeRoot,
              hostRoot: this.hostRoot,
              pluginDataDir,
              manifest,
              configOverrides: this.configOverrides,
              hostApi,
            }),
          ),
        ),
        async (lateInstance) => {
          deactivate();
          await this.stopAfterStartFailure(manifest.id, lateInstance, lifecycleHookScope);
        },
      );
    } catch (err) {
      deactivate();
      hostEffects.discard();
      if (err instanceof PluginFactoryTimeoutError) {
        this.quarantinePluginLifecycle(manifest.id, err.message);
      }
      this.runDisposerList(disposers, "failed add factory");
      await this.drainPluginHostApiOperations(manifest.id, {
        drainHostApiOperations: drainOperations,
      });
      if (!canCommit()) {
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        return "cancelled";
      }
      log.error(`${manifest.id} createPlugin failed: %s`, (err as Error).message);
      this.markFailed(manifest.id);
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return "failed";
    }

    const methods = buildMethodMap(manifest, instance, (toolName) =>
      logPluginLifecycle(
        "warn",
        { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" },
        "tool disabled — missing handler",
      ),
    );
    for (const toolName of methods.keys()) {
      const owner = this.methodMap.get(toolName)?.pluginId;
      if (owner && owner !== manifest.id) {
        deactivate();
        hostEffects.discard();
        await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
        this.runDisposerList(disposers, "duplicate add method");
        await this.drainPluginHostApiOperations(manifest.id, {
          drainHostApiOperations: drainOperations,
        });
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        throw new Error(`Duplicate plugin method registered: ${toolName}`);
      }
    }

    if (!canCommit()) {
      deactivate();
      hostEffects.discard();
      await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
      this.runDisposerList(disposers, "stale add factory");
      await this.drainPluginHostApiOperations(manifest.id, {
        drainHostApiOperations: drainOperations,
      });
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return "cancelled";
    }

    let startupMs = 0;
    if (instance.start) {
      const startedAt = Date.now();
      try {
        await runStartWithTimeout(
          () => this.runPluginLifecycleHook(
            lifecycleHookScope,
            instance.start!.bind(instance),
          ),
          manifest.startupTimeoutMs,
        );
        startupMs = Date.now() - startedAt;
      } catch (err) {
        deactivate();
        hostEffects.discard();
        if (err instanceof PluginStartupTimeoutError) {
          this.quarantinePluginLifecycle(manifest.id, err.message);
        }
        if (!canCommit()) {
          await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
          this.runDisposerList(disposers, "stale add start");
          await this.drainPluginHostApiOperations(manifest.id, {
            drainHostApiOperations: drainOperations,
          });
          await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
          return "cancelled";
        }
        log.error(`start during addPlugin failed: %s`, (err as Error).message);
        this.markFailed(manifest.id);
        await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
        this.runDisposerList(disposers, "failed add start");
        await this.drainPluginHostApiOperations(manifest.id, {
          drainHostApiOperations: drainOperations,
        });
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        return "failed";
      }
    }
    if (!canCommit()) {
      deactivate();
      hostEffects.discard();
      await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
      this.runDisposerList(disposers, "stale add commit");
      await this.drainPluginHostApiOperations(manifest.id, {
        drainHostApiOperations: drainOperations,
      });
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return "cancelled";
    }
    for (const toolName of methods.keys()) {
      const owner = this.methodMap.get(toolName)?.pluginId;
      if (owner && owner !== manifest.id) {
        deactivate();
        hostEffects.discard();
        await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
        this.runDisposerList(disposers, "duplicate add method");
        await this.drainPluginHostApiOperations(manifest.id, {
          drainHostApiOperations: drainOperations,
        });
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        throw new Error(`Duplicate plugin method registered: ${toolName}`);
      }
    }
    const candidate: PluginRuntimeGenerationProjection = Object.freeze({
      activationId,
      installId: this.requirePluginInstallClaim(manifest.id),
      manifest,
      pluginRoot: runtimeRoot,
      instance,
      methods: new Map(methods),
      ...(approvedPluginAccess ? { approvedPluginAccess } : {}),
      hostEffects,
      disposers,
      deactivateHostApi: deactivate,
      drainHostApiOperations: drainOperations,
      lifecycleHookScope,
    });
    try {
      await generationLifecycle.replaceRuntime(
        candidate,
        this.capabilityDependencyCommitScope(() => {
          if (!canCommit()) {
            throw new Error(`plugin add cancelled for ${manifest.id}`);
          }
          this.assertActiveCapabilityDependencies(manifest, "plugin add");
          commit();
        }),
      );
    } catch (error) {
      deactivate();
      if (hostEffects.isPreparing()) hostEffects.discard();
      await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
      this.runDisposerList(disposers, "failed add publication");
      await this.drainPluginHostApiOperations(manifest.id, {
        drainHostApiOperations: drainOperations,
      });
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      if (!canCommit()) return "cancelled";
      const missing = this.capabilityDependencies().missing(manifest);
      if (missing.length > 0) {
        this.auditLog?.("error", "plugin_dependency_missing", {
          pluginId: manifest.id,
          missing,
        });
        this.markFailed(manifest.id, {
          name: manifest.name ?? manifest.id,
          description: `Missing capabilities: ${missing.join(", ")}`,
        });
        return "failed";
      }
      throw error;
    }
    this.inactivePluginIds.delete(manifest.id);
    this.perf.recordStartup(manifest.id, startupMs);
    this.resolveCapabilityBlockedRetry(manifest.id);
    this.onEnable?.(manifest.id);
    return "started";
  }

  /** Capability providers are successfully started, actively admitted generations. */
  protected capabilityDependencies(): CapabilityDependencies {
    return new CapabilityDependencies(
      this.knownPluginManifests,
      (pluginId) => this.isPluginGenerationActive(pluginId),
    );
  }

  /**
   * The generation coordinator is authoritative. The local started bit also
   * prevents an unstarted boot candidate from being treated as active by
   * legacy/test lifecycle adapters.
   */
  protected isPluginGenerationActive(pluginId: string): boolean {
    return this.plugins.get(pluginId)?.started === true
      && Boolean(this.generationLifecycle?.getActive(pluginId));
  }

  /**
   * Returns a non-empty provider set only when every missing capability can be
   * supplied by a provider that is already preparing. Callers must not await
   * it on a boot/restart path: readiness is watched in the background so a
   * hung preparation cannot hold the runtime startup promise open.
   */
  protected preparingCapabilityProviderIds(
    manifest: PluginManifest,
    missingCapabilities: readonly string[],
  ): string[] | undefined {
    if (missingCapabilities.length === 0) return undefined;
    const candidatesByCapability = new Map<string, string[]>();
    for (const capability of missingCapabilities) {
      const candidates = [...this.knownPluginManifests.entries()]
        .filter(([pluginId, candidate]) =>
          pluginId !== manifest.id
          && this.preparation.isPreparing(pluginId)
          && candidate.capabilities?.includes(capability),
        )
        .map(([pluginId]) => pluginId);
      if (candidates.length === 0) return undefined;
      candidatesByCapability.set(capability, candidates);
    }

    // A preparation task that would wait back on the current plugin can never
    // publish a provider. Reject that cycle here so both tasks fail closed
    // instead of leaving boot/restart indefinitely "preparing".
    const waitableByCapability = new Map<string, string[]>();
    for (const [capability, candidates] of candidatesByCapability) {
      const waitable = candidates.filter(
        (pluginId) => !this.preparingCapabilityCanReach(pluginId, manifest.id),
      );
      if (waitable.length === 0) return undefined;
      waitableByCapability.set(capability, waitable);
    }
    return [...new Set([...waitableByCapability.values()].flat())];
  }

  /** Waits only inside an already-background preparation task. */
  private async waitForPreparingCapabilityProviderChange(
    providerIds: readonly string[],
  ): Promise<void> {
    await Promise.race(
      providerIds.map((pluginId) =>
        this.preparation.waitForReady(pluginId).catch(() => undefined),
      ),
    );
  }

  /**
   * Keep a consumer visibly preparing and retry it only after one of its
   * concrete provider preparations settles. The retry callback must resolve
   * current runtime identity itself; no stale load plan is retained here.
   */
  protected deferCapabilityBlockedRetry(
    pluginId: string,
    providerIds: readonly string[],
    retry: () => Promise<void>,
    isCurrent: () => boolean,
  ): void {
    if (!isCurrent()) return;
    const readiness = this.capabilityBlockedReadiness.get(pluginId)
      ?? this.createCapabilityBlockedReadiness();
    this.capabilityBlockedReadiness.set(pluginId, readiness);
    const entry: CapabilityBlockedRetry = { retry, isCurrent, readiness };
    this.capabilityBlockedPluginIds.add(pluginId);
    this.capabilityBlockedRetries.set(pluginId, entry);
    this.markPluginUiRevision(pluginId);
    for (const providerId of providerIds) {
      if (!this.preparation.isPreparing(providerId)) continue;
      if (this.watchedPreparingCapabilityProviders.has(providerId)) continue;
      const watchToken = Symbol(providerId);
      this.watchedPreparingCapabilityProviders.set(providerId, watchToken);
      void this.preparation.waitForReady(providerId).then(
        () => this.requestCapabilityBlockedRetry(),
        () => this.requestCapabilityBlockedRetry(),
      ).finally(() => {
        if (this.watchedPreparingCapabilityProviders.get(providerId) === watchToken) {
          this.watchedPreparingCapabilityProviders.delete(providerId);
        }
      });
    }
  }

  /**
   * Captures the exact consumer incarnation that was blocked. A later
   * remove, disable, reset, restart, or reinstall must make the old callback
   * a no-op even if a provider's original readiness promise settles late.
   */
  protected capabilityBlockedRetryGuard(
    pluginId: string,
    manifest: PluginManifest,
    loadedPlugin?: LoadedPlugin,
  ): () => boolean {
    const lifecycleGeneration = this.pluginLifecycleGenerations.get(pluginId);
    const installClaim = this.knownInstallClaims.get(pluginId);
    return () =>
      this.knownPluginManifests.get(pluginId) === manifest
      && this.knownInstallClaims.get(pluginId) === installClaim
      && this.pluginLifecycleGenerations.get(pluginId) === lifecycleGeneration
      && !this.disabledPluginIds.has(pluginId)
      && !this.inactivePluginIds.has(pluginId)
      && (!loadedPlugin || this.plugins.get(pluginId) === loadedPlugin);
  }

  private createCapabilityBlockedReadiness(): CapabilityBlockedReadiness {
    let settled = false;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // Callers can intentionally observe cancellation failures; avoid an
    // unhandled rejection when no caller requested readiness for this block.
    void promise.catch(() => undefined);
    return {
      promise,
      resolve: () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      },
    };
  }

  protected resolveCapabilityBlockedRetry(
    pluginId: string,
    expectedReadiness?: CapabilityBlockedReadiness,
  ): void {
    const readiness = this.capabilityBlockedReadiness.get(pluginId);
    if (!readiness || (expectedReadiness && readiness !== expectedReadiness)) return;
    this.capabilityBlockedRetries.delete(pluginId);
    this.capabilityBlockedReadiness.delete(pluginId);
    const wasBlocked = this.capabilityBlockedPluginIds.delete(pluginId);
    if (wasBlocked) this.markPluginUiRevision(pluginId);
    readiness.resolve();
  }

  protected rejectCapabilityBlockedRetry(
    pluginId: string,
    error: Error,
    expectedReadiness?: CapabilityBlockedReadiness,
    expectedEntry?: CapabilityBlockedRetry,
  ): void {
    const readiness = this.capabilityBlockedReadiness.get(pluginId);
    const current = this.capabilityBlockedRetries.get(pluginId);
    if (!readiness) {
      if (expectedReadiness) return;
      this.capabilityBlockedRetries.delete(pluginId);
      const wasBlocked = this.capabilityBlockedPluginIds.delete(pluginId);
      if (wasBlocked) this.markPluginUiRevision(pluginId);
      return;
    }
    if (expectedReadiness && readiness !== expectedReadiness) return;
    // A re-deferred retry owns the same readiness promise. An old watcher must
    // never reject that newer attempt after it has replaced the map entry.
    if (expectedEntry && current && current !== expectedEntry) return;
    this.capabilityBlockedRetries.delete(pluginId);
    this.capabilityBlockedReadiness.delete(pluginId);
    const wasBlocked = this.capabilityBlockedPluginIds.delete(pluginId);
    if (wasBlocked) this.markPluginUiRevision(pluginId);
    readiness.reject(error);
  }

  /** Cancel one blocked consumer and fail all of its outstanding waiters. */
  protected clearCapabilityBlockedRetry(
    pluginId: string,
    reason = `plugin '${pluginId}' capability dependency wait was cancelled`,
  ): void {
    this.rejectCapabilityBlockedRetry(pluginId, new Error(reason));
  }

  protected clearAllCapabilityBlockedRetries(): void {
    const blockedPluginIds = new Set([
      ...this.capabilityBlockedRetries.keys(),
      ...this.capabilityBlockedReadiness.keys(),
      ...this.capabilityBlockedPluginIds,
    ]);
    this.watchedPreparingCapabilityProviders.clear();
    this.capabilityBlockedRetryRequested = false;
    for (const pluginId of blockedPluginIds) {
      this.clearCapabilityBlockedRetry(
        pluginId,
        `plugin '${pluginId}' capability dependency wait was cancelled by runtime reset`,
      );
    }
  }

  protected bridgeCapabilityBlockedReadinessToPreparation(pluginId: string): void {
    const readiness = this.capabilityBlockedReadiness.get(pluginId);
    if (!readiness) return;
    const entry: CapabilityBlockedRetry = {
      retry: async () => undefined,
      isCurrent: () => this.preparation.isPreparing(pluginId),
      readiness,
      waitingForOwnPreparation: true,
    };
    this.capabilityBlockedRetries.set(pluginId, entry);
    void this.preparation.waitForReady(pluginId).then(
      () => this.resolveCapabilityBlockedRetry(pluginId, readiness),
      (error: unknown) => this.rejectCapabilityBlockedRetry(
        pluginId,
        error instanceof Error ? error : new Error(String(error)),
        readiness,
        entry,
      ),
    );
  }

  private requestCapabilityBlockedRetry(): void {
    this.capabilityBlockedRetryRequested = true;
    if (this.pendingCapabilityBlockedRetry) return;
    const retryTask = (async () => {
      while (this.capabilityBlockedRetryRequested) {
        this.capabilityBlockedRetryRequested = false;
        for (const [pluginId, entry] of [...this.capabilityBlockedRetries]) {
          if (this.capabilityBlockedRetries.get(pluginId) !== entry) continue;
          if (entry.waitingForOwnPreparation) continue;
          this.capabilityBlockedRetries.delete(pluginId);
          if (!entry.isCurrent()) {
            this.rejectCapabilityBlockedRetry(
              pluginId,
              new Error(`plugin '${pluginId}' capability dependency wait was cancelled`),
              entry.readiness,
              entry,
            );
            continue;
          }
          try {
            await entry.retry();
          } catch (error) {
            if (entry.isCurrent() && this.hasTrackedPluginState(pluginId)) {
              this.markFailed(pluginId, {
                name: this.knownPluginManifests.get(pluginId)?.name ?? pluginId,
                description: errorMessage(error),
              });
            }
            this.rejectCapabilityBlockedRetry(
              pluginId,
              error instanceof Error ? error : new Error(String(error)),
              entry.readiness,
              entry,
            );
            log.error(
              `capability-blocked retry failed for ${pluginId}: ${(error as Error).message}`,
            );
          } finally {
            if (
              !this.capabilityBlockedRetries.has(pluginId)
              && this.capabilityBlockedReadiness.get(pluginId) === entry.readiness
            ) {
              if (this.isPluginGenerationActive(pluginId)) {
                this.resolveCapabilityBlockedRetry(pluginId);
              } else {
                this.rejectCapabilityBlockedRetry(
                  pluginId,
                  new Error(`plugin '${pluginId}' capability dependency retry did not start`),
                  entry.readiness,
                  entry,
                );
              }
            }
          }
        }
      }
    })();
    this.pendingCapabilityBlockedRetry = retryTask;
    void retryTask.finally(() => {
      if (this.pendingCapabilityBlockedRetry !== retryTask) return;
      this.pendingCapabilityBlockedRetry = undefined;
      if (this.capabilityBlockedRetryRequested) {
        this.requestCapabilityBlockedRetry();
      }
    }).catch(() => undefined);
  }
  /** True when a preparing provider would itself wait back on `targetPluginId`. */
  private preparingCapabilityCanReach(
    pluginId: string,
    targetPluginId: string,
    visited = new Set<string>(),
  ): boolean {
    if (pluginId === targetPluginId) return true;
    if (visited.has(pluginId) || !this.preparation.isPreparing(pluginId)) {
      return false;
    }
    visited.add(pluginId);
    const manifest = this.knownPluginManifests.get(pluginId);
    if (!manifest) return false;
    const missing = this.capabilityDependencies().missing(manifest);
    for (const capability of missing) {
      const providers = [...this.knownPluginManifests.entries()]
        .filter(([candidatePluginId, candidate]) =>
          candidatePluginId !== pluginId
          && this.preparation.isPreparing(candidatePluginId)
          && candidate.capabilities?.includes(capability),
        )
        .map(([candidatePluginId]) => candidatePluginId);
      // One alternative provider that can progress without the target breaks
      // this path; a cycle is mandatory only when every candidate for a
      // required capability routes back to the target.
      if (
        providers.length > 0
        && providers.every((providerId) =>
          this.preparingCapabilityCanReach(providerId, targetPluginId, new Set(visited)),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  protected assertEnabledCapabilityDependencies(manifest: PluginManifest): void {
    this.assertActiveCapabilityDependencies(manifest, "plugin re-enable");
  }

  protected assertActiveCapabilityDependencies(
    manifest: PluginManifest,
    operation: string,
  ): void {
    const missing = this.capabilityDependencies().missing(manifest);
    if (missing.length > 0) {
      throw new Error(
        `${operation} blocked — missing required capabilities: ${missing.join(", ")}`,
      );
    }
  }

  /**
   * The bundle lifecycle prepares candidates outside this scope, then calls it
   * immediately around the generation-pointer commit. This closes the gap
   * between dependency admission and a concurrent provider teardown without
   * serializing module import or plugin startup.
   */
  protected capabilityDependencyCommitScope(
    assertDependencies: () => void,
  ): CapabilityDependencyCommitScope {
    return <T>(operation: () => Promise<T>): Promise<T> =>
      this.withCapabilityDependencyCommit(async () => {
        assertDependencies();
        return await operation();
      });
  }

  protected requireCapabilityCommitLifecycle(
    operation: string,
  ): CapabilityCommitScopedGenerationLifecycle {
    return this.requireGenerationLifecycle(operation) as CapabilityCommitScopedGenerationLifecycle;
  }

  /**
   * Refuse a provider teardown when it is the last active provider for an
   * already-admitted consumer. Cascading teardown would be surprising and
   * could expose a consumer while its declared runtime prerequisite is gone.
   */
  protected assertNoActiveCapabilityDependents(
    providerPluginId: string,
    operation: "disable" | "remove",
  ): void {
    this.assertActiveCapabilityDependentsRemainSatisfied(
      providerPluginId,
      undefined,
      `plugin ${operation}`,
    );
  }

  /**
   * Before removing a provider or publishing its replacement, prove every
   * already-active consumer remains covered by the post-change provider set.
   * A replacement may legitimately change capabilities only when another
   * active provider covers each affected consumer requirement.
   */
  protected assertActiveCapabilityDependentsRemainSatisfied(
    providerPluginId: string,
    replacementManifest: PluginManifest | undefined,
    operation: string,
  ): void {
    const blocked = this.activeCapabilityDependentsMissingAfterProviderChange(
      providerPluginId,
      replacementManifest,
    );
    if (blocked.length === 0) return;
    const details = blocked
      .map(({ pluginId, missing }) => `${pluginId} (${missing.join(", ")})`)
      .join("; ");
    throw new Error(
      `${operation} blocked — active dependents require capabilities: ${details}`,
    );
  }

  protected activeCapabilityDependentsMissingAfterProviderChange(
    providerPluginId: string,
    replacementManifest: PluginManifest | undefined,
  ): Array<{ pluginId: string; missing: string[] }> {
    if (!this.isPluginGenerationActive(providerPluginId)) return [];
    const availableProviders = this.capabilityDependencies()
      .activeManifests([providerPluginId]);
    if (replacementManifest) availableProviders.push(replacementManifest);
    const blocked = [...this.knownPluginManifests.entries()].flatMap(
      ([candidatePluginId, candidateManifest]) => {
        if (
          candidatePluginId === providerPluginId
          || !this.isPluginGenerationActive(candidatePluginId)
        ) {
          return [];
        }
        const required = candidateManifest.requires?.capabilities ?? [];
        // A consumer cannot satisfy its own declaration. This mirrors the
        // normal admission resolver, which always excludes the candidate id.
        const dependencyResult = resolveDependencies(
          required,
          availableProviders.filter(
            (providerManifest) => providerManifest.id !== candidatePluginId,
          ),
        );
        return !dependencyResult.ok
          ? [{ pluginId: candidatePluginId, missing: dependencyResult.missing }]
          : [];
      },
    );
    return blocked;
  }

  /** Plugin live-reload (dev only). */
  async reloadPlugin(pluginId: string): Promise<void> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    this.assertPluginLifecycleAvailable(canonicalPluginId);
    this.requireGenerationLifecycle("plugin reload");
    const pendingRestart = this.pendingRestarts.get(canonicalPluginId);
    if (pendingRestart) {
      this.pendingRestartCancellations.get(canonicalPluginId)?.cancel();
      await pendingRestart;
    }
    const result = await this.restartPlugin(canonicalPluginId, {
      skipPreparation: true,
      throwOnFailure: true,
    });
    if (result !== "started") {
      throw new Error(
        `reloadPlugin failed for ${canonicalPluginId}: ${result ?? "not-loaded"}`,
      );
    }
  }

  /** Disable a loaded plugin at runtime. */
  async disable(pluginId: string, actor: Actor = "user"): Promise<void> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    this.pendingRestartCancellations.get(canonicalPluginId)?.cancel();
    return withPluginInstallLock(canonicalPluginId, () =>
      this.disableLocked(pluginId, canonicalPluginId, actor)
    );
  }

  private async disableLocked(
    pluginId: string,
    canonicalPluginId: string,
    actor: Actor,
  ): Promise<void> {
    if (this.deploymentGuard) {
      const result = await this.deploymentGuard.canDisable(pluginId, actor);
      if (!result.allowed) {
        throw new PluginDeploymentDeniedError(
          result.reason ?? `Plugin disable denied: ${pluginId}`,
        );
      }
    }
    if (!this.plugins.has(canonicalPluginId)) {
      throw new Error(`Plugin not loaded: ${pluginId}`);
    }
    this.assertNoActiveCapabilityDependents(canonicalPluginId, "disable");
    const generationLifecycle = this.requireCapabilityCommitLifecycle("plugin disable");
    const plugin = this.plugins.get(canonicalPluginId)!;
    const persistDisable = async (): Promise<void> => {
      if (!this.registryPath) return;
      await updatePluginRegistry(this.registryPath, (registry) => {
        const aliases = new Set([
          canonicalPluginId,
          ...(this.knownInstallAliases.get(canonicalPluginId) ?? []),
        ]);
        const entry = registry.plugins.find((candidate) => aliases.has(candidate.id));
        if (entry) entry.enabled = false;
      });
    };
    let retirement: Promise<void> = Promise.resolve();
    let committedCleanupError: unknown;
    let unpublishedCleanup: (() => Promise<void>) | undefined;
    if (this.isUnpublishedLoadedCandidate(canonicalPluginId, plugin, generationLifecycle)) {
      const commitScope = this.capabilityDependencyCommitScope(() => {
        this.assertNoActiveCapabilityDependents(canonicalPluginId, "disable");
      });
      await generationLifecycle.runInLifecycleQueue(canonicalPluginId, () =>
        commitScope(async () => {
          // Keep the preparing candidate and its readiness promise intact when
          // the durable registry write fails. Once it commits, disable wins and
          // the exact local candidate may be discarded.
          await persistDisable();
          this.pendingRestartPreparations.delete(canonicalPluginId);
          this.clearCapabilityBlockedRetry(
            canonicalPluginId,
            `plugin '${canonicalPluginId}' capability dependency wait was cancelled by disable`,
          );
          this.beginPluginLifecycleOperation(canonicalPluginId);
          this.preparation.clearFor(canonicalPluginId);
          try {
            unpublishedCleanup = this.detachUnpublishedLoadedCandidate(
              canonicalPluginId,
              plugin,
              "unpublished plugin disable",
            );
          } catch (error) {
            committedCleanupError = error;
          }
        }),
      );
    } else {
      this.pendingRestartPreparations.delete(canonicalPluginId);
      this.clearCapabilityBlockedRetry(
        canonicalPluginId,
        `plugin '${canonicalPluginId}' capability dependency wait was cancelled by disable`,
      );
      this.beginPluginLifecycleOperation(canonicalPluginId);
      this.preparation.clearFor(canonicalPluginId);
      const committed = await generationLifecycle.deactivateWithCommit(
        canonicalPluginId,
        persistDisable,
        this.capabilityDependencyCommitScope(() => {
          this.assertNoActiveCapabilityDependents(canonicalPluginId, "disable");
        }),
      );
      retirement = committed.retirement;
    }

    this.disabledPluginIds.add(canonicalPluginId);
    this.failedPluginIds.delete(canonicalPluginId);
    this.invalidatePluginUiRevision(canonicalPluginId);
    this.onDisable?.(canonicalPluginId);
    if (unpublishedCleanup) {
      try {
        await unpublishedCleanup();
      } catch (error) {
        committedCleanupError = committedCleanupError === undefined
          ? error
          : new AggregateError(
              [
                committedCleanupError instanceof Error
                  ? committedCleanupError
                  : new Error(String(committedCleanupError)),
                error instanceof Error ? error : new Error(String(error)),
              ],
              `plugin '${canonicalPluginId}' committed disable cleanup failed`,
            );
      }
    }
    if (committedCleanupError !== undefined) throw committedCleanupError;
    await this.settleCommittedRetirement(canonicalPluginId, retirement, "plugin disable");
  }

  /** Prepare and atomically publish one immutable marketplace generation. */
  async activatePreparedArtifact<T>(
    input: PreparedArtifactRuntimeActivationInput<T>,
  ): Promise<CommittedPluginGeneration<T>> {
    const generationLifecycle = this.requireCapabilityCommitLifecycle("prepared artifact activation");
    if (!this.installReceiptCacheRoot) throw new Error("prepared artifact activation requires installReceiptCacheRoot");
    const manifestPath = resolve(input.pluginRoot, "plugin.json");
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifestDocument: unknown = JSON.parse(manifestRaw);
    const manifest = flattenAgentPluginsManifest(manifestDocument);
    if (manifest.id !== input.manifest.id || manifest.version !== input.manifest.version) {
      throw new Error(`prepared artifact manifest identity changed for '${input.manifest.id}'`);
    }
    this.assertActiveCapabilityDependencies(manifest, "prepared artifact activation");
    this.assertActiveCapabilityDependentsRemainSatisfied(
      manifest.id,
      manifest,
      "prepared artifact activation",
    );
    return this.withPreparedInstallIdentity(manifest.id, input.installId, async (installId) => {
    const candidateRegistryEntry = this.validatePreparedRegistryEntry(
      manifest,
      input.registryEntry,
      manifestDocument,
    );
    // Marketplace activation builds and starts the candidate directly from the
    // verified staging tree, so it does not pass through restartPlugin's
    // dependency-preparation gate. Prepare declared host-managed runtimes here
    // before the factory snapshots configOverrides; otherwise Python-backed
    // candidates start without the injected pythonExecutable and the atomic
    // update rolls back even though ordinary boot/restart can prepare them.
    const preparationResult = await this.preparePluginStart?.({
        pluginId: manifest.id,
        manifest,
        manifestPath: resolve(input.pluginRoot, "plugin.json"),
        pluginRoot: input.pluginRoot,
      });
    const candidateConfigOverride =
      preparationResult && typeof preparationResult === "object"
        ? preparationResult.configOverride
        : undefined;
    const candidateConfigOverrides = candidateConfigOverride
      ? {
          ...this.configOverrides,
          [manifest.id]: {
            ...(this.configOverrides[manifest.id] ?? {}),
            ...candidateConfigOverride,
          },
        }
      : this.configOverrides;
    const activationId = randomUUID();
    const artifactGenerationId = pluginArtifactGenerationId(manifestRaw, input.receiptRaw);
    const generationId = createHash("sha256")
      .update(artifactGenerationId)
      .update("\0")
      .update(activationId)
      .digest("hex");
    const payloadRoot = await materializePluginGenerationRoot(
      input.pluginRoot,
      this.installReceiptCacheRoot!,
      manifest.id,
      generationId,
      input.receiptRaw,
      installId,
    );
    let createPlugin: RuntimePluginFactory | undefined;
    try {
      const entryPath = this.resolveEntryPathForPlugin(payloadRoot, manifest.entry);
      createPlugin = await this.importPluginFactoryForLifecycle(
        manifest.id,
        resolveRealEntryPath(entryPath),
        manifest,
        true,
      );
    } catch (error) {
      await removeRetainedPluginGeneration(
        this.installReceiptCacheRoot!,
        manifest.id,
        generationId,
      );
      throw error;
    }
    if (!createPlugin) {
      await removeRetainedPluginGeneration(
        this.installReceiptCacheRoot!,
        manifest.id,
        generationId,
      );
      throw new Error(`prepared artifact '${manifest.id}' has no default/createPlugin export`);
    }
    const hostEffects = new HostApiGenerationScope(manifest.id);
    let pluginDataDir: string;
    let hostApiIncarnation: PreparedArtifactHostApiIncarnation;
    try {
      pluginDataDir = this.ensureDataDir(manifest.id, payloadRoot);
      hostApiIncarnation = this.buildHostApiIncarnation(
        manifest.id,
        manifest,
        pluginDataDir,
        hostEffects,
        installId,
        candidateRegistryEntry,
        input.approvedPluginAccess ?? null,
      );
    } catch (error) {
      hostEffects.discard();
      await removeRetainedPluginGeneration(
        this.installReceiptCacheRoot!,
        manifest.id,
        generationId,
      );
      throw error;
    }
    const {
      hostApi,
      disposers,
      deactivate,
      drainOperations,
      commit,
      lifecycleHookScope,
    } = hostApiIncarnation;
    let instance: RuntimePlugin | undefined;
    try {
      instance = await runPluginFactoryWithTimeout(
        () => this.runPluginLifecycleHook(
          lifecycleHookScope,
          () => createPlugin(buildPluginContext({
            pluginId: manifest.id,
            pluginRoot: payloadRoot,
            hostRoot: this.hostRoot,
            pluginDataDir,
            manifest,
            configOverrides: candidateConfigOverrides,
            hostApi,
          })),
        ),
        async (lateInstance) => {
          deactivate();
          await this.stopAfterStartFailure(manifest.id, lateInstance, lifecycleHookScope);
        },
      );
      const methods = buildMethodMap(manifest, instance, (toolName) =>
        logPluginLifecycle(
          "warn",
          { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" },
          "tool disabled — missing handler in prepared artifact",
        ),
      );
      if (instance.start) {
        await runStartWithTimeout(
          () => this.runPluginLifecycleHook(
            lifecycleHookScope,
            instance!.start!.bind(instance),
          ),
          manifest.startupTimeoutMs,
        );
      }
      const projection: PluginRuntimeGenerationProjection = Object.freeze({
        activationId,
        installId,
        manifest,
        pluginRoot: payloadRoot,
        instance,
        methods: new Map(methods),
        ...(input.approvedPluginAccess ? { approvedPluginAccess: input.approvedPluginAccess } : {}),
        hostEffects,
        disposers,
        deactivateHostApi: deactivate,
        drainHostApiOperations: drainOperations,
        lifecycleHookScope,
      });
      return withPluginInstallLock(manifest.id, async () => {
        let displacedUnpublishedCandidate:
          | { plugin: LoadedPlugin; disposers: Array<() => void> | undefined }
          | undefined;
        const result = await generationLifecycle.replaceRuntimeWithCommit(
          projection,
          input.receiptRaw,
          input.durableCommit,
          this.capabilityDependencyCommitScope(() => {
            this.assertActiveCapabilityDependencies(
              manifest,
              "prepared artifact activation",
            );
            this.assertActiveCapabilityDependentsRemainSatisfied(
              manifest.id,
              manifest,
              "prepared artifact activation",
            );
            const incumbent = this.plugins.get(manifest.id);
            if (
              incumbent
              && this.isUnpublishedLoadedCandidate(
                manifest.id,
                incumbent,
                generationLifecycle,
              )
            ) {
              displacedUnpublishedCandidate = {
                plugin: incumbent,
                disposers: this.disposers.get(manifest.id),
              };
            }
            commit();
          }),
        );
        if (candidateConfigOverride) {
          this.mergeConfigOverride(manifest.id, candidateConfigOverride);
        }

        // The durable commit and pointer publication have succeeded. Only now
        // may a blocked incumbent lose its readiness/retry state; durable
        // failure above leaves that exact candidate retryable.
        this.clearCapabilityBlockedRetry(
          manifest.id,
          `plugin '${manifest.id}' capability dependency wait was superseded by prepared activation`,
        );
        this.beginPluginLifecycleOperation(manifest.id);
        this.preparation.clearFor(manifest.id);
        this.onEnable?.(manifest.id);

        const displacedRetirement = displacedUnpublishedCandidate
          ? this.retireDisplacedUnpublishedLoadedCandidate(
              manifest.id,
              displacedUnpublishedCandidate.plugin,
              displacedUnpublishedCandidate.disposers,
              payloadRoot,
              "prepared artifact activation replacement",
            )
          : Promise.resolve();
        const retirement = Promise.all([result.retirement, displacedRetirement])
          .then(() => undefined);
        const completion = Promise.all([result.completion, displacedRetirement])
          .then(() => undefined);
        // Consumers may await the returned retirement; attaching this observer
        // simply prevents an unobserved async cleanup failure from becoming an
        // unhandled rejection before that happens.
        void retirement.catch(() => undefined);
        void completion.catch(() => undefined);
        return Object.freeze({
          result: result.result,
          retirement,
          completion,
          retirementDeferred: result.retirementDeferred,
        });
      });
    } catch (error) {
      if (
        error instanceof PluginFactoryTimeoutError
        || error instanceof PluginStartupTimeoutError
      ) {
        this.quarantinePluginLifecycle(manifest.id, error.message);
      }
      const committed = generationLifecycle.getActive(manifest.id)?.generationId === generationId;
      if (!committed) {
        deactivate();
        if (hostEffects.isPreparing()) hostEffects.discard();
        if (instance) {
          await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
        }
        this.runDisposerList(disposers, "failed prepared artifact activation");
        await this.drainPluginHostApiOperations(manifest.id, {
          drainHostApiOperations: drainOperations,
        });
        await removeRetainedPluginGeneration(
          this.installReceiptCacheRoot!,
          manifest.id,
          generationId,
        );
      }
      throw error;
    }
    });
  }

  async removePluginWithCommit<T>(
    pluginId: string,
    durableCommit: () => Promise<T>,
  ): Promise<T> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    const generationLifecycle = this.requireCapabilityCommitLifecycle("atomic plugin removal");
    return generationLifecycle.runInLifecycleQueue(canonicalPluginId, () => {
      this.assertNoActiveCapabilityDependents(canonicalPluginId, "remove");
      return commitAtomicPluginRemoval({
        requestedPluginId: pluginId,
        // An unstarted capability-blocked candidate owns a local runtime
        // projection but no bundle generation. Atomic removal must commit the
        // marketplace transaction first, then let removePlugin discard that
        // candidate locally instead of asking PluginBundleLifecycle to invent
        // an inactive generation for it.
        loaded: Boolean(generationLifecycle.getActive(canonicalPluginId)),
        known: this.hasTrackedPluginState(canonicalPluginId),
        hasActiveGeneration: () => Boolean(generationLifecycle.getActive(canonicalPluginId)),
        durableCommit,
        deactivateWithCommit: () =>
          generationLifecycle.deactivateWithCommit(
            canonicalPluginId,
            durableCommit,
            this.capabilityDependencyCommitScope(() => {
              this.assertNoActiveCapabilityDependents(canonicalPluginId, "remove");
            }),
          ),
        captureRetirementFailure: (retirement) =>
          this.captureCommittedRetirementFailure(
            canonicalPluginId,
            retirement,
            "atomic plugin removal",
        ),
        purgeRuntimeState: () => this.removePlugin(canonicalPluginId),
      });
    });
  }

  // ─── Dispatcher / Bridge ───────────────────────────────────────────────────

}

// ---------------------------------------------------------------------------
// PluginRuntimeLifecycle
// ---------------------------------------------------------------------------

const BOOT_START_CANCELLED = "plugin start cancelled";

/**
 * What one in-flight load attempt has taken from the host so far, so that a
 * throw anywhere inside it can still be unwound and named. `pluginId` starts
 * as the registry id and narrows to the canonical manifest id the moment the
 * manifest is in hand — a crash before that point is still attributable.
 */
type PluginLoadAttemptResources = {
  pluginId: string;
  /** Materialized candidate generation root; unpublished until `commit()`. */
  runtimeRoot?: string;
  incarnation?: {
    deactivate: () => void;
    disposers: Array<() => void>;
    drainOperations: () => Promise<void>;
    hostEffects: HostApiGenerationScope;
  };
};
class PluginRuntimeLifecycle extends PluginRuntimeCapabilityLifecycle {
  /**
   * THE routing decision (`docs/blueprints/plugin-process-isolation.md` §9).
   *
   * Every instantiation path — boot load, add, restart, capability reload —
   * reaches the plugin's factory through this one method, so the in-process and
   * out-of-process arms are chosen in exactly one place. An id in the host-owned
   * routing SOT gets a factory that spawns a confined child; every other id gets
   * the dynamic import it has always got, unchanged.
   *
   * It is a routing decision and NOT a fallback: nothing here retries in-process
   * when the child arm fails. A plugin whose child cannot be spawned or confined
   * fails to load, which is the same outcome an unimportable entry module has.
   */
  protected async importPluginFactoryForLifecycle(
    pluginId: string,
    resolvedEntryPath: string,
    manifest: PluginManifest,
    bustCache?: boolean,
  ): Promise<RuntimePluginFactory | undefined> {
    this.assertPluginLifecycleAvailable(pluginId);
    if (isOutOfProcessPlugin(pluginId)) {
      // No import happens in main for this plugin, so there is no ESM
      // evaluation to bound and nothing to quarantine: the child performs the
      // import, and the whole of it is bounded by the factory timeout the
      // caller already applies. `bustCache` is irrelevant for the same reason —
      // a fresh process has an empty module registry, which is a stronger
      // cache-bust than a query parameter.
      return createOutOfProcessPluginFactory({ manifest, entryPath: resolvedEntryPath });
    }
    try {
      return await runPluginImportWithTimeout(
        () => importPluginFactory(resolvedEntryPath, bustCache),
      );
    } catch (err) {
      if (err instanceof PluginImportTimeoutError) {
        // ESM evaluation cannot be cancelled in-process. Never admit another
        // same-id incarnation while that abandoned module body may still run.
        this.quarantinePluginLifecycle(pluginId, err.message);
      }
      throw err;
    }
  }

  protected async preflightBootLoadPlan(
    loadPlan: ManifestLoadPlan[],
  ): Promise<BootPreflightOutcome[]> {
    return preflightPluginLoadPlan(
      loadPlan,
      {
        prepare: () => this.getManifestValidator(),
        verify: (pluginId, pluginRoot) => this.verifyReceiptAndDevGuard(
          pluginId,
          pluginRoot,
          { report: false },
        ),
        readManifest: (manifestPath) => this.readManifest(manifestPath, { report: false }),
      },
    );
  }

  async load(): Promise<void> {
    this.requireGenerationLifecycle("plugin load");
    if (this.loaded) return;
    // Registry rows refused for an untrusted manifest path never reach the
    // plan (see `RegistryLoadRefusal`), so this callback is the only chance to
    // give them a card. Reporting them BEFORE the loop is deliberate: a later
    // plan entry that loads the same canonical id clears `failedPluginIds`,
    // `failedPluginStubs` and `loadFailureInfo` for it, so a genuine load wins
    // over a stale refusal rather than the other way round.
    const untrustedRegistryRows: RegistryLoadRefusal[] = [];
    const loadPlan = await this.resolveManifestLoadPlanInternal(
      (refusal) => untrustedRegistryRows.push(refusal),
    );
    for (const refusal of untrustedRegistryRows) {
      this.markUntrustedManifestPath(refusal);
    }
    for (const plan of loadPlan) {
      const pluginId = plan.pluginIdHint ?? `<unresolved:${basename(dirname(plan.manifestPath))}>`;
      logPluginLifecycle("debug", { pluginId, phase: PluginPhase.LOAD_START }, "loading plugin");
    }
    const preflight = await this.preflightBootLoadPlan(loadPlan);
    this.assertPluginIdentityNamespace(
      preflight
        .filter((outcome) => outcome.ok)
        .map((outcome) => ({
          pluginId: outcome.manifest.id,
          alias: outcome.plan.pluginIdHint,
        })),
      loadPlan.flatMap((plan) => plan.pluginIdHint ? [plan.pluginIdHint] : []),
    );
    const enabledManifestSnapshots = new Map<string, ManifestSnapshot>();
    for (const outcome of preflight) {
      if (
        outcome.plan.pluginIdHint
        && "integrityResult" in outcome
        && outcome.integrityResult
      ) {
        this.reportPluginIntegrityResult(outcome.plan.pluginIdHint, outcome.integrityResult);
      }
      if (!outcome.ok && outcome.kind === "manifest") {
        this.reportPluginManifestRejected(outcome.plan.manifestPath, outcome.error);
      }
      if (!outcome.ok) continue;
      // Runtime identity is the literal manifest id. A registry id is only a
      // deployment alias and must not own tools, events, grants, or HostApi.
      const pluginId = outcome.manifest.id;
      // This is only a structural preflight: an inactive registry row cannot
      // satisfy a dependency even provisionally. Final admission is deferred
      // to startAll(), which requires a successfully published generation.
      if (outcome.plan.enabled) {
        enabledManifestSnapshots.set(pluginId, {
          manifest: outcome.manifest,
          approvedPluginAccess: outcome.approvedPluginAccess,
        });
      }
      this.rememberPluginInstallAlias(outcome.manifest.id, outcome.plan.pluginIdHint);
      this.knownPluginManifests.set(pluginId, outcome.manifest);
      this.knownPluginAccessGrants.set(pluginId, outcome.approvedPluginAccess);
      this.rememberToolOwners(pluginId, outcome.manifest); // #885 §2.4a MODEL-ONLY (see method)
      for (const eventType of getDeclaredEmittedEvents(outcome.manifest)) {
        this.knownEventOwners.set(eventType, pluginId);
      }
    }
    for (const outcome of preflight) {
      await this.admitPreflightedPlugin(outcome, enabledManifestSnapshots);
    }
    this.loaded = true;
  }

  /**
   * Registry manifest-path trust gate (LOAD boundary). The row named a manifest
   * outside the plugin root, so the runtime refused to read it — which means,
   * like the receipt gate, the verdict lands before any manifest exists and
   * only a stub can carry it to a surface.
   */
  private markUntrustedManifestPath(refusal: RegistryLoadRefusal): void {
    log.error(`${refusal.pluginId} rejected — ${refusal.reason}`);
    this.auditLog?.("error", "plugin_manifest_path_untrusted", {
      pluginId: refusal.pluginId,
      manifestPath: refusal.manifestPath,
    });
    this.markLoadRefused(refusal.pluginId, {
      summary: "Plugin registry entry points outside the plugin folder.",
      reason: refusal.reason,
      kind: "untrusted-manifest-path",
    });
  }

  /**
   * One plugin's whole load attempt, isolated.
   *
   * The refusals `instantiatePreflightedPlugin` decides for itself (bad entry
   * path, failed import, missing capability, …) each leave a card and return.
   * What this wrapper exists for is everything it does NOT decide: a throw out
   * of `materializeImmutableRuntimeRoot`, `ensureDataDir`,
   * `buildHostApiIncarnation`, or `buildMethodMap` used to unwind through
   * `load()`'s `for` loop, which meant a single failing plugin denied every
   * plugin AFTER it in registry order any load attempt at all — and left
   * `this.loaded` false, so nothing retried. Those plugins were not refused;
   * they were never considered, which is why nothing anywhere named them.
   *
   * Catching here converts that into the same per-plugin refusal every gate
   * already produces: the plugin gets a `load-crash` card carrying the throw's
   * message, and the loop moves on to the next entry.
   */
  private async admitPreflightedPlugin(
    outcome: BootPreflightOutcome,
    enabledManifestSnapshots: Map<string, ManifestSnapshot>,
  ): Promise<void> {
    const resources: PluginLoadAttemptResources = {
      pluginId: outcome.plan.pluginIdHint
        ?? `<unresolved:${basename(dirname(outcome.plan.manifestPath))}>`,
    };
    try {
      await this.instantiatePreflightedPlugin(outcome, enabledManifestSnapshots, resources);
    } catch (err) {
      await this.abandonCrashedPluginLoad(resources, err);
    }
  }

  /**
   * Release whatever the crashed attempt had already taken, then report it.
   *
   * The candidate runtime root is on disk and the HostApi incarnation may be
   * live but unpublished; neither has an owner once the attempt is abandoned.
   * Teardown is skipped for a plugin that already reached `this.plugins` — the
   * throw came after it was published, so it is running and must not be pulled
   * out from under its own tools. `listPluginCards()` reads `this.plugins`
   * ahead of `failedPluginIds`, so that plugin still projects as loaded.
   */
  private async abandonCrashedPluginLoad(
    resources: PluginLoadAttemptResources,
    err: unknown,
  ): Promise<void> {
    const { pluginId, runtimeRoot, incarnation } = resources;
    const reason = errorMessage(err);
    logPluginLifecycle(
      "error",
      { pluginId, phase: PluginPhase.LOAD_FAIL, err, reason: "load_crash" },
      `plugin load crashed: ${reason}`,
    );
    this.auditLog?.("error", "plugin_load_crashed", { pluginId, reason });
    if (incarnation && !this.plugins.has(pluginId)) {
      incarnation.deactivate();
      incarnation.hostEffects.discard();
      this.runDisposerList(incarnation.disposers, "crashed plugin load");
      await this.drainPluginHostApiOperations(pluginId, {
        drainHostApiOperations: incarnation.drainOperations,
      });
    }
    if (runtimeRoot) {
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
    }
    this.markLoadRefused(pluginId, {
      summary: "Plugin crashed while loading.",
      reason,
      kind: "load-crash",
      displayName: this.knownPluginManifests.get(pluginId)?.name ?? pluginId,
    });
  }

  private async instantiatePreflightedPlugin(
    outcome: BootPreflightOutcome,
    enabledManifestSnapshots: Map<string, ManifestSnapshot>,
    resources: PluginLoadAttemptResources,
  ): Promise<void> {
    const { plan } = outcome;
    const manifestPath = plan.manifestPath;
    const pluginRoot = dirname(manifestPath);
    let pluginId = resources.pluginId;
    if (!outcome.ok) {
      if (outcome.kind === "integrity") {
        if (plan.pluginIdHint) {
          // Keyed by the registry id: the manifest was never read, so the
          // canonical id is unknown at this boundary.
          this.markReceiptIntegrityFailed(
            plan.pluginIdHint,
            outcome.integrityResult.reason,
          );
        }
        return;
      }
      const err = outcome.error;
      const reason =
        err instanceof SyntaxError ? "manifest_parse"
        : (err as Error).message?.includes("schema validation") ? "manifest_schema"
        : (err as NodeJS.ErrnoException).code === "ENOENT" ? "manifest_missing"
        : "manifest_read";
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.VALIDATION_FAIL, err, reason }, `manifest read failed: ${(err as Error).message}`);
      if (plan.pluginIdHint) {
        this.markLoadRefused(plan.pluginIdHint, {
          summary: "Plugin manifest could not be loaded.",
          reason: (err as Error).message,
          ...(reason === "manifest_schema"
            ? { kind: "manifest-validation-error" as const }
            : {}),
        });
      }
      return;
    }
    if (!plan.enabled) {
      pluginId = resources.pluginId = outcome.manifest.id;
      this.rememberPluginInstallAlias(pluginId, plan.pluginIdHint);
      this.rememberPluginManifest(
        pluginId,
        outcome.manifest,
        outcome.approvedPluginAccess,
      );
      this.inactivePluginIds.add(pluginId);
      this.disabledPluginIds.add(pluginId);
      this.failedPluginIds.delete(pluginId);
      this.failedPluginStubs.delete(pluginId);
      this.loadFailureInfo.delete(pluginId);
      logPluginLifecycle(
        "debug",
        { pluginId, phase: PluginPhase.LOAD_OK, reason: "inactive_pointer" },
        "plugin retained as inactive metadata without runtime admission",
      );
      return;
    }
    const { manifest, approvedPluginAccess } = outcome;
    // The id the manifest declares supersedes the registry hint for every
    // later phase, and `resources` is what carries it there — the local is
    // not read again in this method.
    resources.pluginId = manifest.id;
    this.rememberPluginInstallAlias(manifest.id, plan.pluginIdHint);
    this.knownPluginManifests.set(manifest.id, manifest);
    this.failedPluginStubs.delete(manifest.id);
    this.loadFailureInfo.delete(manifest.id);
    this.inactivePluginIds.delete(manifest.id);
    this.disabledPluginIds.delete(manifest.id);
    this.failedPluginIds.delete(manifest.id);
    // Plugin↔app minimum-version gate — HARD BLOCK at LOAD. A plugin already
    // on disk (e.g. installed against a newer host, then the user downgraded
    // the app, or a sideload) must NOT silently run against a too-old app.
    // Skip activation, log an English reason, surface a "needs newer app"
    // stub. Other plugins continue to load (isolation).
    if (this.markIncompatibleAppVersion(manifest)) {
      return;
    }
    // Plugin revocation gate. Same LOAD-boundary shape as the
    // version gate immediately above: skip this plugin, keep loading
    // everything else (isolation).
    if (this.markRevoked(manifest)) {
      return;
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
        return;
      }
    }
    if (this.preparation.deferStart(plan, manifest, approvedPluginAccess)) {
      return;
    }
    const activationId = randomUUID();
    const runtimeRoot = resources.runtimeRoot = await this.materializeImmutableRuntimeRoot(
      manifest.id,
      pluginRoot,
      activationId,
      plan.pluginIdHint ?? manifest.id,
    );
    let entryPath: string;
    try {
      entryPath = this.resolveEntryPathForPlugin(runtimeRoot, manifest.entry);
    } catch (err) {
      const reason = (err as Error).message;
      logPluginLifecycle("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, err, reason: "entry_path" }, "entry path rejected");
      this.auditLog?.("error", "plugin_entry_path_rejected", {
        pluginId: manifest.id,
        entry: manifest.entry,
        reason,
      });
      this.markFailed(manifest.id);
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return;
    }
    const resolvedEntryPath = resolveRealEntryPath(entryPath);
    let createPlugin: RuntimePluginFactory | undefined;
    try {
      createPlugin = await this.importPluginFactoryForLifecycle(
        manifest.id,
        resolvedEntryPath,
        manifest,
      );
    } catch (err) {
      logPluginLifecycle("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, err, reason: "import" }, "import failed");
      this.auditLog?.("error", "plugin_import_failed", {
        pluginId: manifest.id,
        reason: (err as Error).message,
      });
      this.markFailed(manifest.id);
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return;
    }
    if (!createPlugin) {
      logPluginLifecycle("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, reason: "no_default_export" }, "entry does not export default/createPlugin");
      this.markFailed(manifest.id);
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return;
    }

    const pluginDataDir = this.ensureDataDir(manifest.id, pluginRoot);
    const hostEffects = new HostApiGenerationScope(manifest.id);
    const { hostApi, disposers, deactivate, drainOperations, commit, lifecycleHookScope } =
      this.buildHostApiIncarnation(manifest.id, manifest, pluginDataDir, hostEffects);
    resources.incarnation = { deactivate, disposers, drainOperations, hostEffects };

    let instance: RuntimePlugin;
    try {
      instance = await runPluginFactoryWithTimeout(
        () => this.runPluginLifecycleHook(
          lifecycleHookScope,
          () => createPlugin(
            buildPluginContext({
              pluginId: manifest.id,
              pluginRoot: runtimeRoot,
              hostRoot: this.hostRoot,
              pluginDataDir,
              manifest,
              configOverrides: this.configOverrides,
              hostApi,
            }),
          ),
        ),
        async (lateInstance) => {
          deactivate();
          await this.stopAfterStartFailure(manifest.id, lateInstance, lifecycleHookScope);
        },
      );
    } catch (err) {
      deactivate();
      hostEffects.discard();
      if (err instanceof PluginFactoryTimeoutError) {
        this.quarantinePluginLifecycle(manifest.id, err.message);
      }
      this.runDisposerList(disposers, "failed load factory");
      await this.drainPluginHostApiOperations(manifest.id, {
        drainHostApiOperations: drainOperations,
      });
      this.markFailed(manifest.id);
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      logPluginLifecycle("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, err, reason: "factory" }, "plugin factory failed");
      return;
    }

    const methods = buildMethodMap(manifest, instance, (toolName) =>
      logPluginLifecycle("warn", { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" }, "tool disabled — missing handler"),
    );
    for (const toolName of methods.keys()) {
      if (this.methodMap.has(toolName)) {
        deactivate();
        hostEffects.discard();
        await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
        this.runDisposerList(disposers, "duplicate load method");
        await this.drainPluginHostApiOperations(manifest.id, {
          drainHostApiOperations: drainOperations,
        });
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        resources.incarnation = undefined;
        resources.runtimeRoot = undefined;
        const reason = `Duplicate plugin method registered: ${toolName}`;
        logPluginLifecycle("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, reason: "duplicate_tool_name" }, reason);
        this.auditLog?.("error", "plugin_duplicate_tool_name", { pluginId: manifest.id, toolName });
        this.markLoadRefused(manifest.id, {
          summary: "Plugin declares a tool name another plugin already owns.",
          reason,
          displayName: manifest.name ?? manifest.id,
        });
        return;
      }
    }
    for (const [toolName, handler] of methods) {
      this.methodMap.set(toolName, { pluginId: manifest.id, handler });
      logPluginLifecycle("debug", { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_OK, toolName }, "tool registered");
    }

    commit();
    this.plugins.set(manifest.id, {
      activationId,
      manifest,
      pluginRoot: runtimeRoot,
      instance,
      methods,
      approvedPluginAccess,
      hostEffects,
      started: false,
      deactivateHostApi: deactivate,
      drainHostApiOperations: drainOperations,
      lifecycleHookScope,
    });
    this.disposers.set(manifest.id, disposers);
    this.markPluginUiRevision(manifest.id);
    this.failedPluginIds.delete(manifest.id);
    this.disabledPluginIds.delete(manifest.id);
    logPluginLifecycle("debug", { pluginId: manifest.id, phase: PluginPhase.LOAD_OK }, "plugin loaded");
    // NOTE: inactive-plugin model visibility is not a runtime load concern.
    // Boot sync still registers loaded tools for host/UI/auth execution;
    // ConversationLoop scope suppresses model-visible tools for inactive
    // plugins.
  }


  async startAll(): Promise<void> {
    this.requireGenerationLifecycle("plugin start");
    await this.load();
    // A provider is usable only after startup has completed and its generation
    // is published. Iterate until every currently-startable plugin has been
    // admitted; this permits registry order to be consumer-first without ever
    // starting that consumer before its providers are live.
    const pendingPluginIds = new Set(
      [...this.plugins.values()]
        .filter((plugin) => !plugin.started)
        .map((plugin) => plugin.manifest.id),
    );
    while (pendingPluginIds.size > 0) {
      const startable: Array<{ pluginId: string; plugin: LoadedPlugin }> = [];
      for (const pluginId of [...pendingPluginIds]) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin || plugin.started) {
          pendingPluginIds.delete(pluginId);
          continue;
        }
        if (this.capabilityDependencies().missing(plugin.manifest).length > 0) {
          continue;
        }
        pendingPluginIds.delete(pluginId);
        startable.push({ pluginId, plugin });
      }
      if (startable.length === 0) break;
      // A layer only contains plugins whose dependencies were already active
      // before this pass. Start siblings concurrently; publication remains
      // serialized by the short capability commit boundary.
      const outcomes = await Promise.all(startable.map(async ({ pluginId, plugin }) => ({
        pluginId,
        plugin,
        reason: await this.startLoadedPluginAtBoot(pluginId, plugin),
      })));
      for (const { pluginId, plugin, reason } of outcomes) {
        if (reason === undefined || reason === BOOT_START_CANCELLED) continue;
        await this.failBootPlugin(pluginId, plugin, reason);
      }
    }

    // Any remaining plugin is blocked by either a failed provider, a missing
    // provider, or a dependency cycle. Do not admit its already-instantiated
    // candidate: its capabilities were never live at the startup boundary.
    for (const pluginId of pendingPluginIds) {
      const plugin = this.plugins.get(pluginId);
      if (!plugin) continue;
      const missing = this.capabilityDependencies().missing(plugin.manifest);
      const preparingProviderIds = this.preparingCapabilityProviderIds(
        plugin.manifest,
        missing,
      );
      if (preparingProviderIds) {
        this.deferBlockedLoadedPlugin(plugin, preparingProviderIds);
        continue;
      }
      const reason = `missing required capabilities: ${missing.join(", ")}`;
      this.auditLog?.("error", "plugin_dependency_missing", {
        pluginId,
        missing,
      });
      this.markFailed(pluginId, {
        name: plugin.manifest.name ?? pluginId,
        description: `Missing capabilities: ${missing.join(", ")}`,
      });
      await this.failBootPlugin(pluginId, plugin, reason);
    }
  }

  override waitForPluginReady(pluginId: string): Promise<void> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    const readiness = this.capabilityBlockedReadiness.get(canonicalPluginId);
    if (readiness) return readiness.promise;
    return super.waitForPluginReady(canonicalPluginId);
  }

  protected async startLoadedPluginAtBoot(
    pluginId: string,
    expectedPlugin?: LoadedPlugin,
    shouldCommit?: () => boolean,
  ): Promise<string | undefined> {
    return withPluginInstallLock(pluginId, () =>
      this.startLoadedPluginAtBootLocked(pluginId, expectedPlugin, shouldCommit),
    );
  }

  private async startLoadedPluginAtBootLocked(
    pluginId: string,
    expectedPlugin?: LoadedPlugin,
    shouldCommit?: () => boolean,
  ): Promise<string | undefined> {
    const generationLifecycle = this.requireCapabilityCommitLifecycle("plugin start");
    const plugin = this.plugins.get(pluginId);
    const isCurrent = () =>
      this.plugins.get(pluginId) === plugin
      && (!expectedPlugin || plugin === expectedPlugin)
      && (shouldCommit?.() ?? true);
    if (!plugin || !isCurrent()) return BOOT_START_CANCELLED;
    const SLOW_THRESHOLD_MS = 5000;
    const startedAt = Date.now();
    const slowTimer = setTimeout(() => {
      log.warn(`slow plugin: ${pluginId} (>${SLOW_THRESHOLD_MS}ms)`);
    }, SLOW_THRESHOLD_MS);
    try {
      this.perf.ensure(pluginId);
      if (plugin.instance.start) {
        try {
          if (!isCurrent()) return BOOT_START_CANCELLED;
          await runStartWithTimeout(
            () => this.runPluginLifecycleHook(
              plugin.lifecycleHookScope,
              plugin.instance.start!.bind(plugin.instance),
            ),
            plugin.manifest.startupTimeoutMs,
          );
          if (!isCurrent()) return BOOT_START_CANCELLED;
        } catch (error) {
          if (error instanceof PluginStartupTimeoutError) {
            this.quarantinePluginLifecycle(pluginId, error.message);
          }
          // Fail closed before moving on to another dependency layer.
          plugin.deactivateHostApi?.();
          throw error;
        }
      }
      if (!isCurrent()) return BOOT_START_CANCELLED;
      const elapsed = Date.now() - startedAt;
      this.perf.setStartupMs(pluginId, elapsed);
      const projection = this.getRuntimeGenerationProjection(pluginId);
      if (!projection) throw new Error("runtime projection disappeared before publication");
      await generationLifecycle.replaceRuntime(
        projection,
        this.capabilityDependencyCommitScope(() => {
          if (!isCurrent()) {
            throw new Error(BOOT_START_CANCELLED);
          }
          this.assertActiveCapabilityDependencies(
            plugin.manifest,
            "plugin start",
          );
          plugin.started = true;
        }),
      );
      this.resolveCapabilityBlockedRetry(pluginId);
      if (elapsed > SLOW_THRESHOLD_MS) {
        logPluginLifecycle("warn", { pluginId, phase: PluginPhase.START_SLOW, elapsedMs: elapsed }, "plugin start slow");
      } else {
        logPluginLifecycle("debug", { pluginId, phase: PluginPhase.START_OK, elapsedMs: elapsed }, "plugin start ok");
      }
      return undefined;
    } catch (error) {
      plugin.started = false;
      plugin.deactivateHostApi?.();
      if (!isCurrent()) return BOOT_START_CANCELLED;
      return errorMessage(error);
    } finally {
      clearTimeout(slowTimer);
    }
  }

  protected async failBootPlugin(
    pluginId: string,
    plugin: LoadedPlugin,
    reason: string,
  ): Promise<void> {
    if (this.plugins.get(pluginId) !== plugin) return;
    this.rejectCapabilityBlockedRetry(pluginId, new Error(reason));
    logPluginLifecycle("error", { pluginId, phase: PluginPhase.START_FAIL, reason }, "plugin start failed");
    await this.failClosedLoadedPlugin(pluginId, plugin, "start failure cleanup");
    if (plugin.hostEffects?.isPreparing()) plugin.hostEffects.discard();
    await this.removeUnpublishedRuntimeRoot(pluginId, plugin.pluginRoot);
  }

  private deferBlockedLoadedPlugin(
    plugin: LoadedPlugin,
    providerIds: readonly string[],
  ): void {
    const pluginId = plugin.manifest.id;
    const isCurrent = this.capabilityBlockedRetryGuard(
      pluginId,
      plugin.manifest,
      plugin,
    );
    this.deferCapabilityBlockedRetry(pluginId, providerIds, async () =>
      withPluginInstallLock(pluginId, async () => {
      // A remove, disable, restart, or reset may have replaced this mutable
      // load candidate while its provider was preparing. Never resurrect it.
      if (!isCurrent() || plugin.started) return;
      const missing = this.capabilityDependencies().missing(plugin.manifest);
      const nextProviderIds = this.preparingCapabilityProviderIds(
        plugin.manifest,
        missing,
      );
      if (nextProviderIds) {
        this.deferBlockedLoadedPlugin(plugin, nextProviderIds);
        return;
      }
      if (missing.length > 0) {
        const reason = `missing required capabilities: ${missing.join(", ")}`;
        this.auditLog?.("error", "plugin_dependency_missing", {
          pluginId,
          missing,
        });
        this.markFailed(pluginId, {
          name: plugin.manifest.name ?? pluginId,
          description: `Missing capabilities: ${missing.join(", ")}`,
        });
        await this.failBootPlugin(pluginId, plugin, reason);
        return;
      }
      const reason = await this.startLoadedPluginAtBoot(pluginId, plugin, isCurrent);
      if (reason !== undefined && reason !== BOOT_START_CANCELLED) {
        await this.failBootPlugin(pluginId, plugin, reason);
      }
      }), isCurrent);
  }

  protected deferBlockedAddPlugin(
    pluginId: string,
    providerIds: readonly string[],
  ): void {
    const manifest = this.knownPluginManifests.get(pluginId);
    if (!manifest) return;
    const isCurrent = this.capabilityBlockedRetryGuard(pluginId, manifest);
    this.deferCapabilityBlockedRetry(pluginId, providerIds, async () => {
      // Re-enter through addPlugin rather than retaining a pre-wait plan. It
      // re-resolves the current registry, receipt, canonical identity, and
      // lifecycle generation before admitting anything.
      if (!isCurrent() || !this.hasTrackedPluginState(pluginId)) return;
      try {
        this.capabilityBlockedRetryAdds.add(pluginId);
        const result = await this.addPlugin(pluginId);
        if (result === "preparing" && this.preparation.isPreparing(pluginId)) {
          this.bridgeCapabilityBlockedReadinessToPreparation(pluginId);
        }
      } catch (error) {
        if (
          isCurrent()
          && this.hasTrackedPluginState(pluginId)
          && !this.inactivePluginIds.has(pluginId)
          && !this.disabledPluginIds.has(pluginId)
        ) {
          const message = errorMessage(error);
          this.auditLog?.("error", "plugin_dependency_retry_failed", {
            pluginId,
            reason: message,
          });
          this.markFailed(pluginId, {
            name: this.knownPluginManifests.get(pluginId)?.name ?? pluginId,
            description: message,
          });
          this.rejectCapabilityBlockedRetry(pluginId, new Error(message));
        }
      } finally {
        this.capabilityBlockedRetryAdds.delete(pluginId);
      }
    }, isCurrent);
  }

  protected override resetLoadedState(): void {
    this.clearAllCapabilityBlockedRetries();
    this.capabilityBlockedRetryAdds.clear();
    super.resetLoadedState();
  }

  async stopAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await this.stopAfterStartFailure(
        plugin.manifest.id,
        plugin.instance,
        plugin.lifecycleHookScope,
      );
      plugin.deactivateHostApi?.();
      this.runPluginDisposers(plugin.manifest.id, "stopAll");
      await this.drainPluginHostApiOperations(plugin.manifest.id, plugin);
    }
  }

  async restartAll(): Promise<void> {
    this.requireGenerationLifecycle("plugin restartAll");
    // Cancel dependency-held plugin locks before the global mutation queues.
    for (const cancellation of this.pendingRestartCancellations.values()) {
      cancellation.cancel();
    }
    return withAllPluginInstallLocks(() => this.restartAllLocked());
  }

  private async restartAllLocked(): Promise<void> {
    const lifecycleIds = new Set([
      ...this.plugins.keys(),
      ...this.pendingRestarts.keys(),
      ...this.pluginLifecycleGenerations.keys(),
    ]);
    for (const pluginId of lifecycleIds) {
      this.clearCapabilityBlockedRetry(
        pluginId,
        `plugin '${pluginId}' capability dependency wait was cancelled by restartAll`,
      );
      this.beginPluginLifecycleOperation(pluginId);
    }
    await Promise.allSettled([...this.pendingRestarts.values()]);
    const loadPlan = await this.resolveManifestLoadPlanInternal();
    const currentIdentities = await this.assertCurrentPluginIdentityLoadPlan(loadPlan);
    const targets = currentIdentities.filter(({ plan }) => plan.enabled);
    const targetIds = new Set(targets.map(({ snapshot }) => snapshot.manifest.id));
    // Tear down consumers before their providers. The ordinary remove guard is
    // intentionally strict, so registry changes that remove both sides of an
    // active dependency must be ordered rather than attempting the provider
    // first merely because of insertion order.
    const pendingRemovalIds = new Set(
      [...this.plugins.keys()].filter((pluginId) => !targetIds.has(pluginId)),
    );
    while (pendingRemovalIds.size > 0) {
      const nextPluginId = [...pendingRemovalIds].find(
        (pluginId) =>
          this.activeCapabilityDependentsMissingAfterProviderChange(
            pluginId,
            undefined,
          ).length === 0,
      );
      if (!nextPluginId) {
        // A remaining active dependent is outside this removal set, or the
        // set forms a capability cycle that cannot be safely torn down one at
        // a time. Reuse the public guard for an actionable diagnostic.
        const blockedPluginId = pendingRemovalIds.values().next().value;
        if (typeof blockedPluginId === "string") {
          this.assertNoActiveCapabilityDependents(blockedPluginId, "remove");
        }
        throw new Error("restartAll could not order capability-dependent removals");
      }
      await this.removePlugin(nextPluginId);
      pendingRemovalIds.delete(nextPluginId);
    }

    // A cold restartAll may have no active providers yet. Iterate just like
    // boot so a consumer listed before its provider waits for the provider's
    // successful active-generation publication.
    const pendingPluginIds = new Set(
      targets.map(({ snapshot }) => snapshot.manifest.id),
    );
    const failures: Error[] = [];
    let madeProgress = true;
    while (pendingPluginIds.size > 0 && madeProgress) {
      madeProgress = false;
      for (const { snapshot } of targets) {
        const pluginId = snapshot.manifest.id;
        if (!pendingPluginIds.has(pluginId)) continue;
        if (this.capabilityDependencies().missing(snapshot.manifest).length > 0) {
          continue;
        }
        pendingPluginIds.delete(pluginId);
        madeProgress = true;
        try {
          if (this.plugins.has(pluginId)) {
            const result = await this.restartPlugin(pluginId);
            if (result === "failed") {
              failures.push(new Error(`restartAll failed for ${pluginId}`));
            }
          } else {
            await this.addPlugin(pluginId);
          }
        } catch (error) {
          failures.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    }
    for (const { snapshot, plan } of targets) {
      const pluginId = snapshot.manifest.id;
      if (!pendingPluginIds.has(pluginId)) continue;
      const missing = this.capabilityDependencies().missing(snapshot.manifest);
      this.rememberPluginInstallAlias(pluginId, plan.pluginIdHint);
      this.rememberPluginManifest(
        pluginId,
        snapshot.manifest,
        snapshot.approvedPluginAccess,
      );
      const preparingProviderIds = this.preparingCapabilityProviderIds(
        snapshot.manifest,
        missing,
      );
      if (preparingProviderIds) {
        this.deferBlockedAddPlugin(pluginId, preparingProviderIds);
        continue;
      }
      this.markFailed(pluginId, {
        name: snapshot.manifest.name ?? pluginId,
        description: `Missing capabilities: ${missing.join(", ")}`,
      });
      failures.push(
        new Error(
          `restartAll blocked for ${pluginId} — missing required capabilities: ${missing.join(", ")}`,
        ),
      );
    }
    if (failures.length > 0) throw failures[0]!;
  }

  /** US-3c.2 — Targeted single-plugin restart. */
  async restartPlugin(
    pluginId: string,
    opts: { skipPreparation?: boolean; throwOnFailure?: boolean } = {},
  ): Promise<RestartPluginResult> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    this.assertPluginLifecycleAvailable(canonicalPluginId);
    if (
      hasExclusivePluginLifecycleMutation()
      && !isPluginInstallLockHeld(canonicalPluginId)
    ) {
      log.warn(
        `restartPlugin rejected while an all-plugin lifecycle mutation is queued: ${canonicalPluginId}`,
      );
      return "failed";
    }
    const pending = this.pendingRestarts.get(canonicalPluginId);
    if (pending) return pending;
    const cancellation = this.createPendingRestartCancellation();
    this.pendingRestartCancellations.set(canonicalPluginId, cancellation);
    const restart = withPluginInstallLock(canonicalPluginId, async () => {
      this.clearCapabilityBlockedRetry(
        canonicalPluginId,
        `plugin '${canonicalPluginId}' capability dependency wait was cancelled by restart`,
      );
      const generation = this.beginPluginLifecycleOperation(
        canonicalPluginId,
        cancellation,
      );
      cancellation.generation = generation;
      if (cancellation.cancelled) return "failed";
      return this.restartPluginInternal(
        canonicalPluginId,
        generation,
        cancellation,
        opts,
      );
    }).finally(() => {
      if (this.pendingRestarts.get(canonicalPluginId) === restart) {
        this.pendingRestarts.delete(canonicalPluginId);
      }
      if (this.pendingRestartCancellations.get(canonicalPluginId) === cancellation) {
        this.pendingRestartCancellations.delete(canonicalPluginId);
      }
    });
    this.pendingRestarts.set(canonicalPluginId, restart);
    return restart;
  }

  protected async restartPluginInternal(
    pluginId: string,
    generation: number,
    cancellation: PendingRestartCancellation,
    opts: { skipPreparation?: boolean; throwOnFailure?: boolean } = {},
  ): Promise<RestartPluginResult> {
    const generationLifecycle = this.requireCapabilityCommitLifecycle("plugin restart");
    logPluginLifecycle("info", { pluginId, phase: PluginPhase.RESTART_REQUEST }, "restart requested");
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      logPluginLifecycle("warn", { pluginId, phase: PluginPhase.RESTART_REQUEST, reason: "not_loaded" }, "restart no-op — plugin not loaded");
      return undefined;
    }
    const isCurrent = () =>
      !cancellation.cancelled
      && this.isPluginLifecycleOperationCurrent(pluginId, generation);

    const loadPlan = await this.resolveManifestLoadPlanInternal();
    if (!isCurrent()) return "failed";
    const currentIdentities = await this.assertCurrentPluginIdentityLoadPlan(loadPlan);
    if (!isCurrent()) return "failed";
    const installClaim = this.getPluginInstallClaim(pluginId);
    const targetIdentity = currentIdentities.find(({ plan, snapshot }) => {
      if (snapshot.manifest.id !== pluginId) return false;
      return installClaim === null
        ? !plan.pluginIdHint
          && resolve(dirname(plan.manifestPath)) === resolve(plugin.pluginRoot)
        : plan.pluginIdHint === (installClaim ?? pluginId);
    });
    const snapshot = targetIdentity?.snapshot;
    const targetPlan = targetIdentity?.plan;
    const pluginRoot = targetPlan ? dirname(targetPlan.manifestPath) : plugin.pluginRoot;
    const approvedPluginAccess =
      snapshot?.approvedPluginAccess ??
      targetPlan?.approvedPluginAccess ??
      plugin.approvedPluginAccess ??
      this.knownPluginAccessGrants.get(pluginId);
    const receiptPluginId = targetPlan?.pluginIdHint ?? this.getPluginInstallClaim(pluginId);
    const integrityResult: PluginIntegrityCheckResult = receiptPluginId
      ? await this.verifyReceiptAndDevGuard(receiptPluginId, pluginRoot)
      : { ok: true };
    if (!isCurrent()) return "failed";
    if (!integrityResult.ok) {
      return "failed";
    }
    let manifest: PluginManifest;
    try {
      manifest =
        snapshot?.manifest ??
        (await this.readManifest(targetPlan?.manifestPath ?? resolve(pluginRoot, "plugin.json")));
    } catch (err) {
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err, reason: "manifest_read" }, "manifest read failed during restart");
      return "failed";
    }
    this.assertPluginManifestIdentity(pluginId, manifest.id);
    const missingCapabilities = this.capabilityDependencies().missing(manifest);
    if (missingCapabilities.length > 0) {
      const reason = `missing required capabilities: ${missingCapabilities.join(", ")}`;
      log.error(`${pluginId} restart rejected — ${reason}`);
      this.auditLog?.("error", "plugin_dependency_missing", {
        pluginId,
        missing: missingCapabilities,
      });
      if (opts.throwOnFailure) throw new Error(reason);
      return "failed";
    }
    try {
      this.assertActiveCapabilityDependentsRemainSatisfied(
        pluginId,
        manifest,
        "plugin restart",
      );
    } catch (error) {
      if (opts.throwOnFailure) throw error;
      log.error(
        `${pluginId} restart rejected — ${(error as Error).message}`,
      );
      return "failed";
    }
    const restartPlan: ManifestLoadPlan = targetPlan ?? {
      pluginIdHint: pluginId,
      manifestPath: resolve(pluginRoot, "plugin.json"),
      enabled: true,
      approvedPluginAccess,
    };

    let preparationResult: PluginStartPreparationOutcome = undefined;
    if (!opts.skipPreparation && this.preparePluginStart) {
      const pluginRootForPreparation = dirname(restartPlan.manifestPath);
      let result: PluginStartPreparationReturn;
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
          logPluginLifecycle("error", { pluginId, phase: PluginPhase.START_FAIL, err, reason: "restart_dependency_prepare" }, "restart dependency preparation failed");
          return "failed";
        }
        if (result && typeof (result as Promise<PluginStartPreparationOutcome>).then === "function") {
          preparation = Promise.resolve(result);
          this.pendingRestartPreparations.set(pluginId, preparation);
          void preparation.finally(() => {
            if (this.pendingRestartPreparations.get(pluginId) === preparation) {
              this.pendingRestartPreparations.delete(pluginId);
            }
          }).catch(() => {});
        } else {
          preparationResult = result as PluginStartPreparationOutcome;
        }
      }
      if (preparation) {
        try {
          const outcome = await Promise.race([
            preparation.then((result) => ({ status: "prepared" as const, result })),
            cancellation.promise.then(() => ({ status: "cancelled" as const })),
          ]);
          if (outcome.status === "cancelled") return "failed";
          preparationResult = outcome.result;
        } catch (err) {
          logPluginLifecycle("error", { pluginId, phase: PluginPhase.START_FAIL, err, reason: "restart_dependency_prepare" }, "restart dependency preparation failed");
          return "failed";
        }
      }
    }

    if (!isCurrent()) return "failed";
    if (
      preparationResult
      && typeof preparationResult === "object"
      && preparationResult.configOverride
    ) {
      this.mergeConfigOverride(pluginId, preparationResult.configOverride);
    }
    const activationId = randomUUID();
    const runtimeRoot = await this.materializeImmutableRuntimeRoot(
      pluginId,
      pluginRoot,
      activationId,
      receiptPluginId ?? pluginId,
    );
    let entryPath: string;
    try {
      entryPath = this.resolveEntryPathForPlugin(runtimeRoot, manifest.entry);
    } catch (error) {
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err: error, reason: "entry_path" }, "entry path rejected during restart");
      return "failed";
    }
    const resolvedEntryPath = resolveRealEntryPath(entryPath);
    // Cache-bust so restart imports the new bundle rather than memoized ESM.
    let createPlugin: RuntimePluginFactory | undefined;
    try {
      createPlugin = await this.importPluginFactoryForLifecycle(
        pluginId,
        resolvedEntryPath,
        manifest,
        true,
      );
      logPluginLifecycle("debug", { pluginId, phase: PluginPhase.RESTART_RELOAD_OK }, "module re-imported");
    } catch (err) {
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err }, "module re-import failed");
      return "failed";
    }

    if (!isCurrent()) {
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      return "failed";
    }

    if (!createPlugin) {
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, reason: "no_default_export" }, "entry does not export default/createPlugin after restart");
      return "failed";
    }

    const pluginDataDir = this.ensureDataDir(pluginId, pluginRoot);
    const hostEffects = new HostApiGenerationScope(pluginId);
    const {
      hostApi,
      disposers: replacementDisposers,
      deactivate: deactivateReplacementHostApi,
      drainOperations: drainReplacementHostApiOperations,
      commit: commitReplacementHostApi,
      lifecycleHookScope: replacementLifecycleHookScope,
    } = this.buildHostApiIncarnation(
      pluginId,
      manifest,
      pluginDataDir,
      hostEffects,
    );

    let instance: RuntimePlugin;
    try {
      instance = await runPluginFactoryWithTimeout(
        () => this.runPluginLifecycleHook(
          replacementLifecycleHookScope,
          () => createPlugin(
            buildPluginContext({
              pluginId,
              pluginRoot: runtimeRoot,
              hostRoot: this.hostRoot,
              pluginDataDir,
              manifest,
              configOverrides: this.configOverrides,
              hostApi,
            }),
          ),
        ),
        async (lateInstance) => {
          deactivateReplacementHostApi();
          await this.stopAfterStartFailure(
            pluginId,
            lateInstance,
            replacementLifecycleHookScope,
          );
        },
      );
    } catch (err) {
      deactivateReplacementHostApi();
      hostEffects.discard();
      if (err instanceof PluginFactoryTimeoutError) {
        this.quarantinePluginLifecycle(pluginId, err.message);
      }
      this.runDisposerList(replacementDisposers, "failed restart factory");
      await this.drainPluginHostApiOperations(pluginId, {
        drainHostApiOperations: drainReplacementHostApiOperations,
      });
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err, reason: "createPlugin_failed" }, "createPlugin failed during restart");
      if (opts.throwOnFailure) throw err;
      return "failed";
    }

    if (!isCurrent()) {
      deactivateReplacementHostApi();
      hostEffects.discard();
      await this.stopAfterStartFailure(pluginId, instance, replacementLifecycleHookScope);
      this.runDisposerList(replacementDisposers, "stale restart factory");
      await this.drainPluginHostApiOperations(pluginId, {
        drainHostApiOperations: drainReplacementHostApiOperations,
      });
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      return "failed";
    }

    const methods = buildMethodMap(manifest, instance, (toolName) =>
      logPluginLifecycle("warn", { pluginId, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" }, "tool disabled — missing handler after restart"),
    );

    try {
      if (instance.start) {
        await runStartWithTimeout(
          () => this.runPluginLifecycleHook(
            replacementLifecycleHookScope,
            instance.start!.bind(instance),
          ),
          manifest.startupTimeoutMs,
        );
      }
      logPluginLifecycle("debug", { pluginId, phase: PluginPhase.RESTART_START_OK }, "restart complete");
    } catch (err) {
      if (err instanceof PluginStartupTimeoutError) {
        this.quarantinePluginLifecycle(pluginId, err.message);
      }
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.RESTART_START_FAIL, err }, "start after restart failed");
      deactivateReplacementHostApi();
      hostEffects.discard();
      await this.stopAfterStartFailure(pluginId, instance, replacementLifecycleHookScope);
      this.runDisposerList(replacementDisposers, "failed restart start");
      await this.drainPluginHostApiOperations(pluginId, {
        drainHostApiOperations: drainReplacementHostApiOperations,
      });
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      if (opts.throwOnFailure) throw err;
      return "failed";
    }

    if (!isCurrent()) {
      deactivateReplacementHostApi();
      hostEffects.discard();
      await this.stopAfterStartFailure(pluginId, instance, replacementLifecycleHookScope);
      this.runDisposerList(replacementDisposers, "stale restart start");
      await this.drainPluginHostApiOperations(pluginId, {
        drainHostApiOperations: drainReplacementHostApiOperations,
      });
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      return "failed";
    }
    const candidate: PluginRuntimeGenerationProjection = Object.freeze({
      activationId,
      installId: this.requirePluginInstallClaim(pluginId),
      manifest,
      pluginRoot: runtimeRoot,
      instance,
      methods: new Map(methods),
      ...(approvedPluginAccess ? { approvedPluginAccess } : {}),
      hostEffects,
      disposers: replacementDisposers,
      deactivateHostApi: deactivateReplacementHostApi,
      drainHostApiOperations: drainReplacementHostApiOperations,
      lifecycleHookScope: replacementLifecycleHookScope,
    });
    try {
      await generationLifecycle.replaceRuntime(
        candidate,
        this.capabilityDependencyCommitScope(() => {
          if (!isCurrent()) {
            throw new Error(`plugin restart cancelled for ${pluginId}`);
          }
          this.assertActiveCapabilityDependencies(manifest, "plugin restart");
          this.assertActiveCapabilityDependentsRemainSatisfied(
            pluginId,
            manifest,
            "plugin restart",
          );
          commitReplacementHostApi();
        }),
      );
    } catch (error) {
      deactivateReplacementHostApi();
      if (hostEffects.isPreparing()) hostEffects.discard();
      await this.stopAfterStartFailure(pluginId, instance, replacementLifecycleHookScope);
      this.runDisposerList(replacementDisposers, "failed restart publication");
      await this.drainPluginHostApiOperations(pluginId, {
        drainHostApiOperations: drainReplacementHostApiOperations,
      });
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err: error, reason: "publication" }, "runtime generation publication failed");
      return "failed";
    }
    this.onEnable?.(pluginId);
    return "started";
  }

  /** US-A3 — Targeted single-plugin add for install / install-local paths. */
  async addPlugin(pluginId: string): Promise<"started" | "preparing"> {
    const knownPluginId = this.resolveKnownPluginId(pluginId);
    this.assertPluginLifecycleAvailable(knownPluginId);
    if (!this.capabilityBlockedRetryAdds.has(knownPluginId)) {
      this.clearCapabilityBlockedRetry(
        knownPluginId,
        `plugin '${knownPluginId}' capability dependency wait was superseded by a new add`,
      );
    }
    if (this.plugins.has(knownPluginId)) {
      try {
        const restartResult = await this.restartPlugin(knownPluginId);
        if (restartResult === "deferred") return "preparing";
        if (restartResult === "failed") {
          throw new Error(`restartPlugin failed for ${pluginId}`);
        }
      } catch (err) {
        if ((err as { code?: string })?.code === "plugin-identity-collision") throw err;
        throw new Error(`addPlugin failed for ${pluginId}: ${(err as Error).message}`);
      }
      this.throwIfPluginFailedAfterAdd(knownPluginId);
      return "started";
    }

    const activePreparationGeneration = this.pluginLifecycleGenerations.get(knownPluginId);
    const lifecycleGeneration =
      this.preparation.hasPending(knownPluginId) && activePreparationGeneration !== undefined
        ? activePreparationGeneration
        : this.beginPluginLifecycleOperation(pluginId);

    const loadPlan = await this.resolveManifestLoadPlanInternal();
    if (this.pluginLifecycleGenerations.get(pluginId) !== lifecycleGeneration) {
      throw new Error(`addPlugin cancelled for ${pluginId}`);
    }
    const currentIdentities = await this.assertCurrentPluginIdentityLoadPlan(loadPlan);
    if (this.pluginLifecycleGenerations.get(pluginId) !== lifecycleGeneration) {
      throw new Error(`addPlugin cancelled for ${pluginId}`);
    }
    const targetIdentity = currentIdentities.find(({ plan }) =>
      plan.enabled && plan.pluginIdHint === pluginId
    ) ?? currentIdentities.find(({ plan, snapshot }) =>
      !plan.pluginIdHint && plan.enabled && snapshot.manifest.id === pluginId
    );
    const snapshot = targetIdentity?.snapshot;
    const targetPlan = targetIdentity?.plan;
    if (!snapshot) {
      const requestedPlan = loadPlan.find((plan) => plan.pluginIdHint === pluginId);
      if (requestedPlan?.enabled) {
        await this.readManifest(requestedPlan.manifestPath); // throws with the actual reason
      }
      throw new Error(`addPlugin: plugin not found in registry or disabled: ${pluginId}`);
    }
    if (!targetPlan) {
      throw new Error(`addPlugin: load plan entry missing for ${pluginId}`);
    }

    const { manifest, approvedPluginAccess } = snapshot;
    if (!this.adoptPluginLifecycleIdentity(
      pluginId,
      manifest.id,
      lifecycleGeneration,
      targetPlan.pluginIdHint,
    )) {
      throw new Error(`addPlugin cancelled for ${pluginId}`);
    }
    const shouldCommit = () =>
      this.isPluginLifecycleOperationCurrent(manifest.id, lifecycleGeneration);
    if (!shouldCommit()) throw new Error(`addPlugin cancelled for ${pluginId}`);
    this.rememberPluginManifest(manifest.id, manifest, approvedPluginAccess);

    const startResult = await this.instantiateAndStartSinglePlugin(
      targetPlan,
      manifest,
      approvedPluginAccess,
      { shouldCommit },
    );
    if (startResult === "deferred") return "preparing";
    if (startResult === "cancelled") {
      throw new Error(`addPlugin cancelled for ${pluginId}`);
    }

    // IPC install callers need a hard failure signal for rollback.
    this.throwIfPluginFailedAfterAdd(manifest.id);
    return "started";
  }

  /** US-A3 — Targeted single-plugin remove for uninstall paths. */
  async removePlugin(
    pluginId: string,
    options: { preserveConfigOverride?: boolean } = {},
  ): Promise<void> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    // Cancel dependency-held restart work before entering the lifecycle lock.
    this.pendingRestartCancellations.get(canonicalPluginId)?.cancel();
    return withPluginInstallLock(canonicalPluginId, () =>
      this.removePluginLocked(pluginId, canonicalPluginId, options)
    );
  }

}

// ---------------------------------------------------------------------------
// PluginRuntime
// ---------------------------------------------------------------------------

export class PluginRuntime extends PluginRuntimeLifecycle {
  /** Release a same-plugin lifecycle lock held by dependency preparation. */
  cancelPendingRestart(pluginId: string): void {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    this.pendingRestartCancellations.get(canonicalPluginId)?.cancel();
    this.pendingRestartPreparations.delete(canonicalPluginId);
  }

  /** Release all pending per-plugin restarts before queuing a global mutation. */
  cancelAllPendingRestarts(): void {
    for (const cancellation of this.pendingRestartCancellations.values()) {
      cancellation.cancel();
    }
    this.pendingRestartPreparations.clear();
  }

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
    return this.callForPlugin(entry.pluginId, method, payload);
  }

  resolveToolOwner(method: string): string | undefined {
    return this.methodMap.get(method)?.pluginId ?? this.knownToolOwners.get(method);
  }

  assertPluginEventAccess(callerPluginId: string, eventType: string, candidateApprovedPluginAccess?: PluginAccessSpec | null): void {
    assertEventSubscribeAccess({
      callerPluginId,
      eventType,
      targetPluginId: this.inferEventOwner(eventType),
      getAccessGrant: () => candidateApprovedPluginAccess === undefined
        ? this.getPluginAccessGrant(callerPluginId) : candidateApprovedPluginAccess ?? undefined,
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
   * Invoke an app-visible plugin Tool directly against the runtime,
   * enforcing the app-visible allowlist (#885 v6 — tools whose
   * `_meta.ui.visibility` includes `"app"`, via `declaredAppVisibleToolMethods`).
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
   * The immutable generation lease remains held until that detached settlement,
   * so update/removal cannot publish a replacement beside stale handler work.
   * We do NOT invent a handler-abort mechanism the executor path itself lacks.
   * `ceilingMs` defaults to the SOT
   * (`TOOL_TIMEOUT_POLICY.globalCeilingMs`) and is a parameter solely so tests
   * can exercise the ceiling with a small value without weakening the SOT.
   */
  async callDeclaredAppOnlyTool(
    method: string,
    payload?: unknown,
    ceilingMs: number = TOOL_TIMEOUT_POLICY.globalCeilingMs,
    expectedGenerationId?: string,
    beforeHandler?: () => void,
  ): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      this.throwIfToolOwnerNotReady(method);
      throw new Error(`Plugin method not found: ${method}`);
    }
    return this.withPinnedGeneration(entry.pluginId, async (projection, generationId) => {
      assertAppVisibleToolInvokable({
        method,
        pluginId: entry.pluginId,
        appVisibleTools: declaredAppVisibleToolMethods(projection.manifest),
      });
      const handler = projection.methods.get(method);
      if (!handler) throw new Error(`Plugin method not found in active generation: ${method}`);
      const auth = projection.manifest.auth;
      const isAuthTool = auth !== undefined && (
        method === auth.statusTool ||
        method === auth.loginTool ||
        method === auth.logoutTool
      );
      this.auditLog?.("info", "plugin_ui_action_invoked", {
        pluginId: entry.pluginId,
        method,
      });
      const outcome = await runWithCeiling(
        async () => {
          // Auth calls are stricter than ordinary pinned calls: an admitted
          // predecessor may finish non-auth work, but it must not mutate
          // credentials after the active generation has changed.
          if (
            isAuthTool &&
            this.requireGenerationAccess("plugin auth handler").getActive(entry.pluginId)
              ?.generationId !== generationId
          ) {
            throw new Error("plugin auth generation changed before handler entry");
          }
          // The boot-owned transition lease rechecks session/generation
          // revocation here, after runWithCeiling's task boundary and with no
          // await before the plugin handler.
          beforeHandler?.();
          return handler(payload);
        },
        ceilingMs,
        undefined,
        method,
      );
      if (!outcome.ok) {
        if (outcome.settlement) {
          throw new PluginRuntimeDetachedOperationError(
            outcome.error,
            outcome.settlement,
          );
        }
        throw outcome.error;
      }
      return outcome.value;
    }, expectedGenerationId);
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
    options?: {
      userAction?: boolean;
      appSessionId?: string;
      operationGrantToken?: string;
      expectedGenerationId?: string;
    },
  ): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      this.throwIfToolOwnerNotReady(method);
      throw new Error(`Plugin method not found: ${method}`);
    }
    return this.withPinnedGeneration(entry.pluginId, async (projection, generationId) => {
      const manifest = projection.manifest;
      assertAppVisibleToolInvokable({
        method,
        pluginId: entry.pluginId,
        appVisibleTools: declaredAppVisibleToolMethods(manifest),
      });
      if (!this.toolInvocationDelegate) {
        throw new Error("Plugin tool executor is not wired; UI plugin call denied");
      }
      const authToolKind = method === manifest.auth?.statusTool
        ? "status" as const
        : method === manifest.auth?.loginTool
          ? "login" as const
          : method === manifest.auth?.logoutTool
            ? "logout" as const
            : undefined;
      return this.toolInvocationDelegate(method, payload, {
        origin: "ui",
        ownerPluginId: entry.pluginId,
        ownerGenerationId: generationId,
        ...(authToolKind ? { authToolKind } : {}),
        userAction: options?.userAction === true,
        ...(options?.appSessionId
          ? {
              appInvocation: {
                surface: "trusted-panel" as const,
                sessionId: options.appSessionId,
                ...(options.operationGrantToken ? { operationGrantToken: options.operationGrantToken } : {}),
              },
            }
          : {}),
      });
    }, options?.expectedGenerationId);
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
   * (`assertAppVisibleToolInvokable`, the spec MUST) still bounds the surface: a
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
   *    contained to this method — `assertAppVisibleToolInvokable`, the `"ui"` panel path,
   *    and `isAppOnlyRuntimeInvocation` are untouched.
   */
  async callFromApp(
    method: string,
    payload?: unknown,
    options?: {
      appSessionId?: string;
      operationGrantToken?: string;
      expectedGenerationId?: string;
    },
  ): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      this.throwIfToolOwnerNotReady(method);
      throw new Error(`Plugin method not found: ${method}`);
    }
    return this.withPinnedGeneration(entry.pluginId, async (projection, generationId) => {
      const manifest = projection.manifest;
      assertAppVisibleToolInvokable({
        method,
        pluginId: entry.pluginId,
        appVisibleTools: declaredAppVisibleToolMethods(manifest),
      });
      const auth = manifest?.auth;
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
        ownerGenerationId: generationId,
        userAction: false,
        ...(options?.appSessionId
          ? {
              appInvocation: {
                surface: "mcp-app" as const,
                sessionId: options.appSessionId,
                ...(options.operationGrantToken ? { operationGrantToken: options.operationGrantToken } : {}),
              },
            }
          : {}),
      });
    }, options?.expectedGenerationId);
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
   *  - the same fail-closed gate `pluginRuntimeToolDelegate` applies to
   *    `tools/call` — literally the same predicate, {@link checkRuntimeAdmission},
   *    not a copy of it — so a disabled plugin cannot render a card any more than
   *    it can run a tool;
   *  - a `pluginUiResourceReadMs` ceiling (SOT: TOOL_TIMEOUT_POLICY) — a plugin
   *    hook, unlike a file read, can hang; the user is waiting on a card;
   *  - a hard HTML size cap, so a runaway hook cannot balloon the render path.
   *
   * Every failure throws — the loopback server maps it to `-32602`
   * (resource-not-found under the final revision) and no body is ever served.
   *
   * `ceilingMs` defaults to the SOT and is a parameter solely so tests can exercise
   * the ceiling with a small value without weakening it (same seam as
   * {@link callDeclaredAppOnlyTool}).
   */
  async readUiResource(
    pluginId: string,
    uri: string,
    ceilingMs: number = TOOL_TIMEOUT_POLICY.pluginUiResourceReadMs,
    expectedGenerationId?: string,
  ): Promise<string> {
    // Gate 4, shared with pluginRuntimeToolDelegate — same predicate object,
    // card-shaped message.
    const refusal = checkRuntimeAdmission(this, pluginId);
    if (refusal === "inactive") {
      throw new Error(
        `Plugin '${pluginId}' is inactive; its ui:// resources are unavailable until the plugin is re-enabled.`,
      );
    }
    if (refusal === "integrity-disabled") {
      throw new Error(
        `Plugin '${pluginId}' was disabled after a manifest integrity violation. Reinstall the plugin to re-enable.`,
      );
    }

    const html = await this.withPinnedGeneration(pluginId, async (projection) => {
      const instance = projection.instance;
      const readUiResource = instance.readUiResource;
      if (typeof readUiResource !== "function") {
        throw new Error(
          `Plugin '${pluginId}' declares ui:// resources but does not implement readUiResource(); cannot serve '${uri}'.`,
        );
      }
      const outcome = await runWithCeiling(
        async () => readUiResource.call(instance, uri),
        ceilingMs,
        undefined,
        `${pluginId}.readUiResource`,
      );
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    }, expectedGenerationId);
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
      activationId: randomUUID(),
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

  isPluginRestartPending(pluginId: string): boolean {
    return this.pendingRestarts.has(this.resolveKnownPluginId(pluginId));
  }

  isPluginUiRevisionCurrent(pluginId: string, revision: number): boolean {
    return this.pluginUiRevisions.get(pluginId) === revision;
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
    return !this.inactivePluginIds.has(this.resolveKnownPluginId(pluginId));
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
   * Atomically move a plugin between an active immutable generation and the
   * inactive pointer. Disable drains all predecessor leases before reporting
   * success. Re-enable rebuilds from installed bytes and reverifies the receipt
   * before its registry commit and generation publication linearize together.
   */
  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    // A restart may own the already-known canonical lock while dependency
    // preparation is still pending. Cancel it before admission; the retry
    // callback below only runs after an initial lock has been acquired.
    this.cancelPendingRestart(this.resolveKnownPluginId(pluginId));
    return withResolvedPluginInstallLocks(
      () => {
        const canonicalPluginId = this.resolveKnownPluginId(pluginId);
        const installClaim = this.getPluginInstallClaim(canonicalPluginId);
        return [
          pluginId,
          canonicalPluginId,
          ...(typeof installClaim === "string" ? [installClaim] : []),
        ];
      },
      async () => {
        const canonicalPluginId = this.resolveKnownPluginId(pluginId);
        if (
          !this.knownPluginManifests.has(canonicalPluginId)
          && !this.plugins.has(canonicalPluginId)
        ) {
          throw new Error(`Plugin not found: ${pluginId}`);
        }
        const installClaim = this.getPluginInstallClaim(canonicalPluginId);
        if (installClaim === undefined) {
          throw new Error(`Plugin install provenance unknown: ${pluginId}`);
        }
        await assertDisableAllowed(enabled, installClaim, pluginId, this.deploymentGuard);
        const generationLifecycle = this.requireCapabilityCommitLifecycle(
          "plugin enabled-state change",
        );
        await generationLifecycle.runInLifecycleQueue(canonicalPluginId, async () => {
          if (!this.inactivePluginIds.has(canonicalPluginId) === enabled) return;
          const persist = async (): Promise<void> => {
            // Static manifests have no registry row, so their active toggle is
            // session-local. Registry installs persist through their raw install id.
            if (this.registryPath && installClaim !== null) {
              await updatePluginRegistry(this.registryPath, (registry) => {
                const entry = registry.plugins.find(({ id }) => id === installClaim);
                if (!entry) {
                  throw new Error(`Plugin not found in registry: ${installClaim}`);
                }
                entry.enabled = enabled;
              });
            }
          };

          let retirementError: unknown;
          let unpublishedCleanup: (() => Promise<void>) | undefined;
          if (!enabled) {
            const plugin = this.plugins.get(canonicalPluginId);
            const unpublishedCandidate = plugin && this.isUnpublishedLoadedCandidate(
              canonicalPluginId,
              plugin,
              generationLifecycle,
            )
              ? plugin
              : undefined;
            if (!generationLifecycle.getActive(canonicalPluginId) && !unpublishedCandidate) {
              throw new Error(
                `cannot disable plugin without an active generation: ${canonicalPluginId}`,
              );
            }
            this.assertNoActiveCapabilityDependents(
              canonicalPluginId,
              "disable",
            );
            if (unpublishedCandidate) {
              const commitScope = this.capabilityDependencyCommitScope(() => {
                this.assertNoActiveCapabilityDependents(
                  canonicalPluginId,
                  "disable",
                );
              });
              await commitScope(async () => {
                // The registry transition is the durable winner. Keep a
                // preparing candidate retryable if that transaction fails;
                // cancel and discard it only once the disabled state commits.
                await persist();
                this.clearCapabilityBlockedRetry(
                  canonicalPluginId,
                  `plugin '${canonicalPluginId}' capability dependency wait was cancelled by disable`,
                );
                this.beginPluginLifecycleOperation(canonicalPluginId);
                this.preparation.clearFor(canonicalPluginId);
                try {
                  unpublishedCleanup = this.detachUnpublishedLoadedCandidate(
                    canonicalPluginId,
                    unpublishedCandidate,
                    "unpublished plugin enabled-state disable",
                  );
                } catch (error) {
                  retirementError = error;
                }
              });
            } else {
              this.clearCapabilityBlockedRetry(
                canonicalPluginId,
                `plugin '${canonicalPluginId}' capability dependency wait was cancelled by disable`,
              );
              this.beginPluginLifecycleOperation(canonicalPluginId);
              this.preparation.clearFor(canonicalPluginId);
              const { retirement } = await generationLifecycle.deactivateWithCommit(
                canonicalPluginId,
                persist,
                this.capabilityDependencyCommitScope(() => {
                  this.assertNoActiveCapabilityDependents(
                    canonicalPluginId,
                    "disable",
                  );
                }),
              );
              retirementError = await this.captureCommittedRetirementFailure(
                canonicalPluginId,
                retirement,
                "plugin enabled-state disable",
              );
            }
            this.inactivePluginIds.add(canonicalPluginId);
            this.disabledPluginIds.add(canonicalPluginId);
            if (unpublishedCleanup) {
              try {
                await unpublishedCleanup();
              } catch (error) {
                retirementError = retirementError === undefined
                  ? error
                  : new AggregateError(
                      [
                        retirementError instanceof Error
                          ? retirementError
                          : new Error(String(retirementError)),
                        error instanceof Error ? error : new Error(String(error)),
                      ],
                      `plugin '${canonicalPluginId}' committed disable cleanup failed`,
                    );
              }
            }
          } else {
            if (generationLifecycle.getActive(canonicalPluginId)) {
              throw new Error(
                `cannot re-enable plugin while a generation is active: ${canonicalPluginId}`,
              );
            }
            if (!this.installReceiptCacheRoot) {
              throw new Error("plugin re-enable requires installReceiptCacheRoot");
            }
            const loadPlan = await this.resolveManifestLoadPlanInternal();
            const targetPlan = loadPlan.find((plan) =>
              plan.pluginIdHint === canonicalPluginId
              || (installClaim !== null && plan.pluginIdHint === installClaim)
              || this.matchesManifestPath(plan.manifestPath, canonicalPluginId)
            );
            if (!targetPlan) {
              throw new Error(`Plugin not found in registry: ${canonicalPluginId}`);
            }
            const manifest = await this.readManifest(targetPlan.manifestPath);
            if (manifest.id !== canonicalPluginId) {
              throw new Error(
                `plugin re-enable manifest identity changed: expected ${canonicalPluginId}, got ${manifest.id}`,
              );
            }
            const pluginRoot = dirname(targetPlan.manifestPath);
            const receiptPluginId = installClaim ?? canonicalPluginId;
            const integrity = await this.verifyReceiptAndDevGuard(receiptPluginId, pluginRoot);
            if (!integrity.ok) {
              throw new Error(
                `plugin re-enable receipt verification failed: ${canonicalPluginId}`,
              );
            }
            this.assertEnabledCapabilityDependencies(manifest);
            const receiptRaw = await readFile(
              installReceiptPath(this.installReceiptCacheRoot, receiptPluginId),
              "utf8",
            );
            await this.activatePreparedArtifact({
              installId: receiptPluginId,
              pluginRoot,
              manifest,
              receiptRaw,
              registryEntry: {
                installSource: targetPlan.installSource,
                manifestSha256: targetPlan.manifestSha256,
              },
              approvedPluginAccess:
                targetPlan.approvedPluginAccess
                ?? this.knownPluginAccessGrants.get(canonicalPluginId),
              durableCommit: persist,
            });
            this.inactivePluginIds.delete(canonicalPluginId);
            this.disabledPluginIds.delete(canonicalPluginId);
          }

          // The generation pointer and durable registry are already committed.
          // Keep this runtime view aligned even if a downstream host projection
          // callback reports a post-commit fault; later requests must queue behind
          // that callback and observe the committed state.
          let callbackError: unknown;
          try {
            await this.onActiveStateChange?.(canonicalPluginId, enabled);
          } catch (error) {
            callbackError = error;
          }
          if (retirementError !== undefined && callbackError !== undefined) {
            throw new AggregateError(
              [
                retirementError instanceof Error
                  ? retirementError
                  : new Error(String(retirementError)),
                callbackError instanceof Error
                  ? callbackError
                  : new Error(String(callbackError)),
              ],
              `plugin '${canonicalPluginId}' committed disable cleanup failed`,
            );
          }
          if (retirementError !== undefined) throw retirementError;
          if (callbackError !== undefined) throw callbackError;
        });
      },
      (pluginIds) => {
        for (const discoveredPluginId of pluginIds) {
          this.cancelPendingRestart(discoveredPluginId);
        }
      },
    );
  }

  getPluginManifest(pluginId: string): PluginManifest | undefined {
    return this.plugins.get(pluginId)?.manifest ?? this.knownPluginManifests.get(pluginId);
  }

  /** Canonical lifecycle identity for a marketplace/install alias. */
  resolvePluginId(pluginId: string): string {
    return this.resolveKnownPluginId(pluginId);
  }

  /** Raw registry identity for a canonical/alias plugin id; null for static roots. */
  resolvePluginInstallId(pluginId: string): string | null {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    const installClaim = this.getPluginInstallClaim(canonicalPluginId);
    if (installClaim === undefined) {
      throw new Error(`Plugin install provenance unknown: ${pluginId}`);
    }
    return installClaim;
  }

  /** Registry/static provenance when known; undefined for a fresh identity. */
  resolvePluginInstallIdIfKnown(
    pluginId: string,
  ): string | null | undefined {
    return this.getPluginInstallClaim(this.resolveKnownPluginId(pluginId));
  }

  /** Final uninstall cleanup after stop-hook mutations have drained. */
  clearConfigOverride(pluginId: string): void {
    this.configStore.delete(this.resolveKnownPluginId(pluginId));
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
      // A loaded candidate is not active until its generation has actually
      // published. This includes consumers blocked on a preparing provider.
      const active = enabled && this.isPluginGenerationActive(pluginId);
      const loadStatus = this.preparation.isPreparing(pluginId)
        || this.capabilityBlockedPluginIds.has(pluginId)
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
   * Resolve the per-plugin sandboxed `PluginStorage` for `pluginId` — used by
   * the plugin webview bridge (`lvis:plugin:storage:*` IPC) so a UI panel in an
   * isolated webview gets the same containment-checked path validation the host
   * plugin gets. `undefined` for unknown ids (IPC → `unknown-plugin-id`).
   * The audit sink is MANDATORY: those handlers only reply to the webview on
   * refusal, so without it a symlink escape on a webview's behalf leaves no
   * host-side trace. Shared with the boot host-api-factory wiring: ONE record.
   */
  getPluginStorage(pluginId: string): import("../types.js").PluginStorage | undefined {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return undefined;
    const audit = createPluginStorageAuditSink(pluginId, (...a) => this.auditLog?.(...a));
    // RESOLVES the data directory rather than ensuring it. This runs once per
    // webview storage IPC call, and an install swap has the plugin root renamed
    // aside for the length of two renames: a `mkdir` here landing in that window
    // put an empty `data/` at the promoted root, which the carry that completes
    // the swap then found and refused. The directory is created at load, and a
    // call arriving while it is absent is refused rather than served from a
    // directory this call invented.
    return createPluginStorage(pluginId, this.resolveDataDir(pluginId, plugin.pluginRoot), audit);
  }

  /**
   * Resolve one plugin's declared FLOATING surface for the dock, or say why
   * not.
   *
   * This is the admission gate for the host's always-on-top window. Everything
   * downstream — the slot, the clamp, the chrome — assumes this said yes for a
   * good reason, so a wrong yes here is the one that matters: it puts a
   * plugin's pixels on top of every other application on the machine.
   *
   * Returns a {@link ResolvedFloatingSurface} on success, or a
   * {@link FloatingDockErrorCode} naming the refusal. The codes are the
   * plugin-visible vocabulary and they are not interchangeable — "you did not
   * declare this" is a bug in the plugin, while "this plugin is not loaded" is
   * a condition that may pass.
   */
  resolveFloatingSurface(
    pluginId: string,
    extensionId: string,
  ): ResolvedFloatingSurface | FloatingDockErrorCode {
    // The REGISTRY, and deliberately nothing else. Both loader arms register
    // here after a successful load, so this answers the same for a plugin in
    // its own process as for one in ours — which matters because the only
    // plugin that floats a surface runs out-of-process. Branching on isolation
    // would be deciding whether a plugin may sit on top of every other
    // application based on where it happens to run.
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return "unknown-plugin";
    const extension = (plugin.manifest.ui ?? []).find((candidate) => candidate.id === extensionId);
    if (!extension) return "surface-not-declared";

    // The dock renders through `plugin-ui-shell.html`, which resolves an
    // entry URL and `import()`s it. That is the ONLY thing it can do, so the
    // kinds below are not a policy preference — they are what the surface can
    // actually paint.
    //
    //   `embedded-page` is refused everywhere already: the sidebar answers it
    //   with `legacyIframeNotSupported`, because the iframe path it needs no
    //   longer exists. Admitting it here would produce a transparent
    //   always-on-top window with nothing in it, which is worse than a
    //   refusal — the user would see a defect and the plugin would see
    //   success.
    //
    //   `info-card` is not required to declare an entry at all (see
    //   `manifest-validation.ts`), so there is nothing for the shell to
    //   import. Same outcome.
    if (extension.slot !== "floating") return "surface-not-floating";
    if (extension.kind !== "embedded-module") return "surface-not-floating";

    // Restating an invariant the manifest validator already holds — it
    // requires `entry` + `exportName` for `embedded-module`, so a declaration
    // without them never becomes a loaded plugin and this branch is not
    // reachable from a valid manifest. It stays because the TYPE says these
    // fields are optional, and a narrowing that throws away the reason is
    // worse than one that names it.
    const entrySource = extension.entry ?? extension.page;
    if (!entrySource) return "surface-has-no-entry";

    let entryPath: string;
    try {
      entryPath = this.resolveEntryPathForPlugin(plugin.pluginRoot, entrySource);
    } catch (err) {
      // `listUiExtensions` swallows this and skips the entry, which is right
      // for building a LIST: one bad declaration should not cost the user
      // every other panel. A single resolve is the opposite case — somebody
      // asked about exactly this surface and is waiting for an answer, so the
      // refusal is the answer. Still audited, because a path outside the
      // install root is a containment violation and not a typo.
      log.warn(`floating ui entry rejected for '${pluginId}': ${(err as Error).message}`);
      this.auditLog?.("error", "plugin_ui_entry_path_rejected", {
        pluginId,
        entry: entrySource,
        reason: (err as Error).message,
      });
      return "surface-entry-rejected";
    }

    return {
      pluginId,
      extensionId: extension.id,
      entryUrl: this.buildPluginUiEntryUrl(pluginId, plugin.manifest, entryPath),
      // The plugin's string, rendered inside the host's chrome. It is placed
      // as TEXT by the dock renderer, never as markup — a title is a label,
      // not a way to draw into the host's own frame.
      title: extension.title,
    };
  }

  listUiExtensions(): Array<{ pluginId: string; icon?: string; iconText?: string; extension: PluginUiExtension; entryUrl?: string; runtimeRevision?: number }> {
    const result: Array<{ pluginId: string; icon?: string; iconText?: string; extension: PluginUiExtension; entryUrl?: string; runtimeRevision?: number }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      const runtimeRevision = this.getPluginUiRevision(pluginId);
      for (const extension of plugin.manifest.ui ?? []) {
        // Sidebar only. Every caller of this list renders its entries as
        // in-window panels — the sidebar rail, the app menu, and the `uiList`
        // IPC behind them — and until the floating slot existed `"sidebar"`
        // was the only possible value, so none of them ever had to ask. A
        // floating surface reaching them would appear as a panel the plugin
        // never asked for, in addition to the dock slot it did.
        // `resolveFloatingSurface` above is the floating slot's own lookup.
        if (extension.slot !== "sidebar") continue;
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

  async callForPlugin(
    pluginId: string,
    method: string,
    payload?: unknown,
    expectedGenerationId?: string,
  ): Promise<unknown> {
    this.throwIfToolOwnerNotReady(method);
    this.throwIfPluginNotStarted(pluginId);
    return this.withPinnedGeneration(pluginId, async (projection) => {
      const handler = projection.methods.get(method);
      if (!handler) throw new Error(`Plugin method not found in active generation: ${method}`);
      const stats = this.perf.beginCall(pluginId);
      const t0 = Date.now();
      try {
        return await handler(payload);
      } catch (err) {
        stats.errorCount += 1;
        throw err;
      } finally {
        stats.totalExecMs += Date.now() - t0;
      }
    }, expectedGenerationId);
  }

  getPluginOperationAccountIdentity(
    pluginId: string,
    generationId: string,
  ): {
    readonly identityHash: string;
    readonly principalHash: string;
  } | undefined {
    const identity = this.pluginAccountHashes.get(`${pluginId}\0${generationId}`);
    return identity ? { ...identity } : undefined;
  }

  /**
   * Return the Host-only operation identity for one exact manifest auth Tool.
   * It intentionally never reuses or publishes the cached authenticated
   * account principal: auth status, login, and logout need one shared identity
   * so a valid governed status-read → login/write chain can retain its receipt
   * after login revokes the real account principal. Normal tools continue to
   * use {@link getPluginOperationAccountIdentity} exclusively.
   */
  getPluginAuthOperationAccount(
    pluginId: string,
    generationId: string,
    toolName: string,
    appSessionId: string,
  ): PluginAuthOperationAccount | undefined {
    const active = this.requireGenerationAccess("plugin auth operation account")
      .getActive(pluginId);
    if (!active || active.generationId !== generationId) return undefined;
    const auth = active.manifest.auth;
    if (
      !auth ||
      (
        toolName !== auth.statusTool &&
        toolName !== auth.loginTool &&
        toolName !== auth.logoutTool
      )
    ) {
      return undefined;
    }
    const key = `${pluginId}\0${generationId}`;
    const currentAccount = this.pluginAccountHashes.get(key);
    const retainedTransitionAccount = this.pluginAuthTransitionPrincipals.get(pluginId);
    const accountTransitionScopeHash =
      currentAccount?.identityHash ??
      retainedTransitionAccount?.identityHash ??
      fallbackPluginAuthTransitionScope(pluginId);
    return pluginAuthOperationAccount(
      pluginId,
      generationId,
      appSessionId,
      accountTransitionScopeHash,
    );
  }

  /**
   * Claim publication order for any auth lifecycle invocation. Starting login
   * or logout immediately removes the current principal, so neither a failed
   * nor partial transition can retain stale write authority. Every auth tool
   * also receives one stable transition scope: status, login, and logout
   * therefore serialize with admitted governed work and with each other. The
   * caller must synchronously revoke grants for the returned hash before
   * awaiting plugin execution and pass the epoch to
   * {@link observePluginAuthResult}.
   */
  beginPluginAuthInvocation(
    pluginId: string,
    generationId: string,
    toolName: string,
    appSessionId?: string,
  ): PluginAuthInvocation | undefined {
    const active = this.requireGenerationAccess("plugin auth invocation").getActive(pluginId);
    if (!active || active.generationId !== generationId) return undefined;
    const auth = active.manifest.auth;
    if (
      !auth ||
      (
        toolName !== auth.statusTool &&
        toolName !== auth.loginTool &&
        toolName !== auth.logoutTool
      )
    ) {
      return undefined;
    }
    const epoch = ++this.nextPluginAuthInvocationEpoch;
    const key = `${pluginId}\0${generationId}`;
    const transitionKey = pluginId;
    this.pluginAuthInvocationEpochs.set(key, epoch);
    const currentAccount = this.pluginAccountHashes.get(key);
    const retainedTransitionAccount =
      this.pluginAuthTransitionPrincipals.get(transitionKey);
    const failurePrincipal = currentAccount
      ? { principalHash: currentAccount.principalHash, generationId }
      : retainedTransitionAccount
        ? {
            principalHash: retainedTransitionAccount.principalHash,
            generationId: retainedTransitionAccount.generationId,
          }
        : undefined;
    if (failurePrincipal) {
      this.pluginAuthFailurePrincipals.set(
        `${key}\0${epoch}`,
        failurePrincipal,
      );
    }
    const accountTransitionScopeHash =
      currentAccount?.identityHash ??
      retainedTransitionAccount?.identityHash ??
      fallbackPluginAuthTransitionScope(pluginId);
    const operationAccount = pluginAuthOperationAccount(
      pluginId,
      generationId,
      appSessionId,
      accountTransitionScopeHash,
    );
    if (toolName !== auth.loginTool && toolName !== auth.logoutTool) {
      return { epoch, accountTransitionScopeHash, operationAccount };
    }
    if (currentAccount) {
      this.pluginAuthTransitionPrincipals.set(
        transitionKey,
        { ...currentAccount, generationId },
      );
    }
    const invalidatedAccount = authInvalidation(
      currentAccount,
      generationId,
      retainedTransitionAccount,
    );
    this.pluginAccountHashes.delete(key);
    return invalidatedAccount
      ? {
          epoch,
          accountTransitionScopeHash,
          operationAccount,
          ...invalidatedAccount,
        }
      : { epoch, accountTransitionScopeHash, operationAccount };
  }

  /**
   * Observe only manifest-declared auth tools after a successful invocation.
   * The account hash is derived exclusively from statusTool output; login and
   * logout results cannot mint or restore write authority.
   */
  observePluginAuthResult(
    pluginId: string,
    generationId: string,
    toolName: string,
    result: unknown,
    invocationEpoch: number | undefined,
  ): PluginAuthObservation {
    const active = this.requireGenerationAccess("plugin auth result observation").getActive(pluginId);
    if (!active || active.generationId !== generationId) return {};
    const manifest = active.manifest;
    const auth = manifest?.auth;
    if (!auth) return {};
    const key = `${pluginId}\0${generationId}`;
    if (invocationEpoch !== undefined) {
      this.pluginAuthFailurePrincipals.delete(`${key}\0${invocationEpoch}`);
    }
    if (
      (toolName === auth.statusTool || toolName === auth.logoutTool) &&
      (
        invocationEpoch === undefined ||
        this.pluginAuthInvocationEpochs.get(key) !== invocationEpoch
      )
    ) {
      return {};
    }
    if (
      invocationEpoch !== undefined &&
      this.pluginAuthInvocationEpochs.get(key) === invocationEpoch
    ) {
      this.pluginAuthPublishedEpochs.set(key, invocationEpoch);
    }
    if (toolName === auth.logoutTool) {
      const invalidatedAccount = authInvalidation(
        this.pluginAccountHashes.get(key),
        generationId,
        undefined,
      );
      this.pluginAccountHashes.delete(key);
      return invalidatedAccount ?? {};
    }
    if (toolName !== auth.statusTool) return {};
    const outer = result && typeof result === "object" && !Array.isArray(result)
      ? result as Record<string, unknown>
      : undefined;
    const nested = outer?.data && typeof outer.data === "object" && !Array.isArray(outer.data)
      ? outer.data as Record<string, unknown>
      : outer;
    const retainedTransitionAccount =
      this.pluginAuthTransitionPrincipals.get(pluginId);
    if (nested?.authenticated !== true || typeof nested.account !== "string" || !nested.account.trim()) {
      const currentAccount = this.pluginAccountHashes.get(key);
      const invalidatedAccount = authInvalidation(
        currentAccount,
        generationId,
        retainedTransitionAccount,
      );
      this.pluginAccountHashes.delete(key);
      return invalidatedAccount ?? {};
    }
    const identityHash = pluginAccountIdentityHash(nested.account);
    const existing = this.pluginAccountHashes.get(key);
    if (existing?.identityHash === identityHash) {
      this.pluginAuthTransitionPrincipals.set(pluginId, {
        ...existing,
        generationId,
      });
      return {};
    }
    const principalHash = pluginAccountPrincipalHash(identityHash, randomUUID());
    const nextAccount = { identityHash, principalHash };
    this.pluginAccountHashes.set(key, nextAccount);
    this.pluginAuthTransitionPrincipals.set(pluginId, {
      ...nextAccount,
      generationId,
    });
    return authInvalidation(existing, generationId, retainedTransitionAccount) ?? {};
  }

  /**
   * Fail closed on any unsuccessful auth transition. Its result is not
   * authoritative, so the previously cached principal must be removed before
   * the transition lease can release and admit queued governed work.
   */
  invalidateFailedPluginAuthInvocation(
    pluginId: string,
    generationId: string,
    invocationEpoch: number,
  ): PluginAuthObservation {
    const key = `${pluginId}\0${generationId}`;
    const failurePrincipal = this.pluginAuthFailurePrincipals.get(
      `${key}\0${invocationEpoch}`,
    );
    this.pluginAuthFailurePrincipals.delete(`${key}\0${invocationEpoch}`);
    if (!failurePrincipal) return {};
    // A later completed auth result is authoritative. A later *started* status
    // is not: it may still be queued behind governed work that must be denied.
    if ((this.pluginAuthPublishedEpochs.get(key) ?? -1) > invocationEpoch) {
      return {};
    }
    const current = this.pluginAccountHashes.get(key);
    const retained = this.pluginAuthTransitionPrincipals.get(pluginId);
    const currentMatches =
      current?.principalHash === failurePrincipal.principalHash &&
      failurePrincipal.generationId === generationId;
    const retainedMatches =
      retained?.principalHash === failurePrincipal.principalHash &&
      retained.generationId === failurePrincipal.generationId;
    if (!currentMatches && !retainedMatches) return {};
    if (currentMatches && current) {
      this.pluginAuthTransitionPrincipals.set(pluginId, {
        ...current,
        generationId,
      });
      this.pluginAccountHashes.delete(key);
    }
    return {
      invalidatedAccountHash: failurePrincipal.principalHash,
      invalidatedAccountGenerationId: failurePrincipal.generationId,
    };
  }

  clearPluginOperationAccount(pluginId: string): void {
    for (const key of this.pluginAccountHashes.keys()) {
      if (key.startsWith(`${pluginId}\0`)) this.pluginAccountHashes.delete(key);
    }
    for (const key of this.pluginAuthInvocationEpochs.keys()) {
      if (key.startsWith(`${pluginId}\0`)) this.pluginAuthInvocationEpochs.delete(key);
    }
    for (const key of this.pluginAuthPublishedEpochs.keys()) {
      if (key.startsWith(`${pluginId}\0`)) this.pluginAuthPublishedEpochs.delete(key);
    }
    for (const key of this.pluginAuthFailurePrincipals.keys()) {
      if (key.startsWith(`${pluginId}\0`)) this.pluginAuthFailurePrincipals.delete(key);
    }
    this.pluginAuthTransitionPrincipals.delete(pluginId);
  }

}
