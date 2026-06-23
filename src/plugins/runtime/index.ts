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
import { isDevModeUnlocked } from "../../boot/dev-flags.js";
import { verifyInstallReceipt } from "../plugin-install-receipt.js";
import { updatePluginRegistry } from "../registry.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

/**
 * Run a plugin's `start()` lifecycle hook under a host-enforced timeout. The
 * manifest's declared `startupTimeoutMs` is honored when present and clamped
 * to `pluginStartupMaxMs`; an undeclared value falls back to
 * `pluginStartupDefaultMs`. The two call sites in this file share this helper
 * — when they diverge, fix it here, not in two places.
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
      reject(new Error(`startup timeout (>${hardTimeoutMs}ms)`));
    }, hardTimeoutMs);
  });
  try {
    await Promise.race([Promise.resolve(start()), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

import {
  buildManifestValidator,
  getDeclaredEmittedEvents,
  normalizeInstallPolicy,
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
import type { LoadedPlugin, ManifestLoadPlan, ManifestSnapshot } from "./types.js";
import { createLogger } from "../../lib/logger.js";
import { plog, PluginPhase } from "../lifecycle-log.js";
import { t } from "../../i18n/index.js";
const log = createLogger("plugin-runtime");
const START_FAILURE_STOP_TIMEOUT_MS = 2_000;

function declaredRuntimeMethods(manifest: PluginManifest): string[] {
  return [...new Set([...(manifest.tools ?? []), ...(manifest.uiCallable ?? [])])];
}

export type { InstallPolicy };
export { normalizeInstallPolicy, getDeclaredEmittedEvents };
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
  /** tool name → description from manifest.toolSchemas */
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

export interface PluginToolInvocationContext {
  origin: "plugin" | "ui";
  callerPluginId?: string;
  ownerPluginId?: string;
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
   */
  parentOrigin?: "plugin" | "ui";
}

export type PluginToolInvocationDelegate = (
  method: string,
  payload: unknown,
  context: PluginToolInvocationContext,
) => Promise<unknown>;

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
  /**
   * Fires after a plugin's instance is in the `loaded + started` state and
   * the runtime considers it callable — symmetric to {@link onDisable}.
   * Currently invoked after a successful `restartPlugin`, `addPlugin`, or
   * `reloadPlugin`. The host wires this to targeted ToolRegistry sync so a
   * post-restart sync re-registers the tools that the tear-down phase
   * removed; without it the ToolRegistry stays empty and every chat-surface
   * tool call reports `도구를 찾을 수 없습니다: <tool>` until the next
   * install / uninstall event. The boot path's initial `startAll` is NOT
   * covered here — boot registration now flows through PluginLoopbackManager
   * (each plugin runs as an in-process MCP server), wired in
   * `boot/steps/plugin-runtime.ts`, which owns that one-shot registration.
   * See `architecture.md §9.3a`.
   */
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

interface PendingPreparedStart {
  generation: number;
  task: Promise<void>;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (err: Error) => void;
}

type SinglePluginStartResult = "started" | "deferred" | "failed" | "cancelled";
type RestartPluginResult = "started" | "deferred" | "failed" | undefined;

export class PluginRuntime {
  private readonly hostRoot: string;
  private readonly manifestPaths: string[];
  private readonly registryPath?: string;
  private readonly pluginsRoot?: string;
  private configOverrides: Record<string, Record<string, unknown>>;
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
  private readonly perfStats = new Map<string, PluginPerfStats>();
  private readonly disposers = new Map<string, Array<() => void>>();
  private readonly knownPluginManifests = new Map<string, PluginManifest>();
  private readonly knownPluginAccessGrants = new Map<string, PluginAccessSpec | undefined>();
  private readonly knownInstallAliases = new Map<string, Set<string>>();
  private readonly knownToolOwners = new Map<string, string>();
  private readonly knownEventOwners = new Map<string, string>();
  private readonly failedPluginIds = new Set<string>();
  private readonly failedPluginStubs = new Map<string, { name: string; description: string }>();
  private readonly disabledPluginIds = new Set<string>();
  /**
   * #1176 active/inactive — plugins toggled inactive at runtime via
   * {@link setPluginEnabled}. Orthogonal to {@link disabledPluginIds} (the
   * load/unload state): an inactive plugin stays *loaded* but its tools are
   * hidden from the model's per-turn scope. `enabled !== false` is the active
   * predicate, so absence from this set means active (migration-safe default).
   */
  private readonly inactivePluginIds = new Set<string>();
  private readonly preparingPluginIds = new Set<string>();
  private readonly preparationStatuses = new Map<string, PluginPreparationStatus>();
  private readonly preparationFailures = new Map<string, string>();
  private readonly pendingPreparedStarts = new Map<string, PendingPreparedStart>();
  private readonly pendingRestarts = new Map<string, Promise<RestartPluginResult>>();
  private readonly pendingRestartPreparations = new Map<string, Promise<void>>();
  private readonly preparationGenerations = new Map<string, number>();
  private nextPreparationGeneration = 0;
  private readonly pluginUiRevisions = new Map<string, number>();
  private nextPluginUiRevision = 0;
  private toolInvocationDelegate: PluginToolInvocationDelegate | null = null;
  private loaded = false;
  /** §B-1 — lazily-compiled AJV validator for plugin.schema.json. */
  private manifestValidator: ValidateFunction | null = null;

  constructor(options: PluginRuntimeOptions) {
    this.hostRoot = resolve(options.hostRoot);
    this.manifestPaths = (options.manifestPaths ?? []).map((path) => resolve(path));
    this.registryPath = options.registryPath ? resolve(options.registryPath) : undefined;
    this.pluginsRoot = options.pluginsRoot ? resolve(options.pluginsRoot) : undefined;
    this.configOverrides = options.configOverrides ?? {};
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
  }

  // ─── Manifest Validator (lazy) ─────────────────────────────────────────────

  private async getManifestValidator(): Promise<ValidateFunction> {
    if (this.manifestValidator) return this.manifestValidator;
    this.manifestValidator = await buildManifestValidator();
    return this.manifestValidator;
  }

  private async readManifest(path: string): Promise<PluginManifest> {
    const validator = await this.getManifestValidator();
    try {
      return await parsePluginJson(path, validator);
    } catch (err) {
      // Supply-chain visibility — manifest schema reject / cross-field violation /
      // JSON parse failure 가 발생하면 operator/security 채널이 *어느 plugin* 이
      // *왜* 드랍됐는지 추적할 수 있어야 한다. fail-soft drop 자체는 보존
      // (re-throw 으로 기존 load loop 의 catch path 가 그 plugin 을 skip 하고
      // 호스트는 계속 동작).
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
    for (const toolName of manifest.tools ?? []) {
      this.knownToolOwners.set(toolName, pluginId);
    }
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

  private deferPluginStartUntilPrepared(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    startOpts: { cacheBust?: boolean } = {},
  ): boolean {
    if (!this.preparePluginStart) return false;
    if (this.pendingPreparedStarts.has(manifest.id)) return true;
    const pluginRoot = dirname(plan.manifestPath);
    const generation = ++this.nextPreparationGeneration;
    this.preparationGenerations.set(manifest.id, generation);
    let result: Promise<void> | void | null | undefined;
    try {
      result = this.preparePluginStart({
        pluginId: manifest.id,
        manifest,
        manifestPath: plan.manifestPath,
        pluginRoot,
        reportProgress: (status) => this.setPreparationStatus(manifest.id, status, generation),
      });
    } catch (err) {
      this.markPreparationFailed(manifest, err);
      return true;
    }
    if (!result || typeof (result as Promise<void>).then !== "function") {
      this.preparationStatuses.delete(manifest.id);
      return false;
    }

    this.preparingPluginIds.add(manifest.id);
    this.preparationFailures.delete(manifest.id);
    if (!this.preparationStatuses.has(manifest.id)) {
      this.setPreparationStatus(manifest.id, {
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
      .then(async () => {
        if (this.preparationGenerations.get(manifest.id) !== generation) return;
        const startResult = await this.instantiateAndStartSinglePlugin(plan, manifest, approvedPluginAccess, {
          skipPreparation: true,
          cacheBust: startOpts.cacheBust,
          shouldCommit: () => this.preparationGenerations.get(manifest.id) === generation,
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

  private setPreparationStatus(pluginId: string, status: PluginPreparationProgressInput, generation: number): void {
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
    const message = err instanceof Error ? err.message : String(err);
    this.preparingPluginIds.delete(manifest.id);
    this.preparationStatuses.delete(manifest.id);
    this.preparationFailures.set(manifest.id, message);
    this.markFailed(manifest.id, {
      name: manifest.name,
      description: `Plugin dependencies failed: ${message}`,
    });
    this.onDisable?.(manifest.id);
    plog("error", { pluginId: manifest.id, phase: PluginPhase.START_FAIL, reason: message }, "plugin dependency preparation failed");
  }

  private clearPluginPreparationState(pluginId: string): void {
    const pending = this.pendingPreparedStarts.get(pluginId);
    pending?.rejectReady(new Error(`plugin '${pluginId}' runtime dependency preparation was cancelled`));
    this.preparationGenerations.set(pluginId, ++this.nextPreparationGeneration);
    this.preparingPluginIds.delete(pluginId);
    this.preparationStatuses.delete(pluginId);
    this.preparationFailures.delete(pluginId);
    this.pendingPreparedStarts.delete(pluginId);
  }

  waitForPluginReady(pluginId: string): Promise<void> {
    if (this.plugins.has(pluginId)) return Promise.resolve();
    const pending = this.pendingPreparedStarts.get(pluginId);
    if (pending) {
      return pending.ready;
    }
    const failure = this.preparationFailures.get(pluginId);
    if (failure) return Promise.reject(new Error(failure));
    return Promise.reject(new Error(`plugin '${pluginId}' is not preparing or loaded`));
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const loadPlan = await this.resolveManifestLoadPlanInternal();
    const enabledManifestSnapshots = await this.readSnapshotsInternal(loadPlan);
    for (const [pluginId, snapshot] of enabledManifestSnapshots) {
      const { manifest, approvedPluginAccess } = snapshot;
      this.rememberPluginInstallAlias(manifest.id, pluginId);
      this.knownPluginManifests.set(pluginId, manifest);
      this.knownPluginAccessGrants.set(pluginId, approvedPluginAccess);
      for (const toolName of manifest.tools ?? []) {
        this.knownToolOwners.set(toolName, pluginId);
      }
      for (const eventType of getDeclaredEmittedEvents(manifest)) {
        this.knownEventOwners.set(eventType, pluginId);
      }
    }
    for (const plan of loadPlan) {
      const manifestPath = plan.manifestPath;
      const pluginRoot = dirname(manifestPath);
      // pluginId starts as hint (may be "<unresolved:basename>"); reassigned to
      // manifest.id once the manifest is parsed so all post-read phases are consistent.
      let pluginId = plan.pluginIdHint ?? `<unresolved:${basename(dirname(manifestPath))}>`;
      plog("debug", { pluginId, phase: PluginPhase.LOAD_START }, "loading plugin");
      if (plan.pluginIdHint) {
        const integrityResult = await this.verifyReceiptAndDevGuard(
          plan.pluginIdHint,
          pluginRoot,
        );
        if (!integrityResult.ok) {
          this.markFailed(plan.pluginIdHint);
          continue;
        }
      }
      let manifest: PluginManifest;
      try {
        manifest = await this.readManifest(manifestPath);
      } catch (err) {
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
          });
        }
        continue;
      }
      // Reassign to manifest.id so all subsequent phases use the canonical id.
      pluginId = manifest.id;
      this.rememberPluginInstallAlias(manifest.id, plan.pluginIdHint);
      const approvedPluginAccess =
        enabledManifestSnapshots.get(manifest.id)?.approvedPluginAccess ?? plan.approvedPluginAccess;
      this.knownPluginManifests.set(manifest.id, manifest);
      this.failedPluginStubs.delete(manifest.id);
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
        const availableManifests = [...enabledManifestSnapshots.entries()]
          .filter(([pluginId]) => pluginId !== manifest.id)
          .map(([, candidate]) => candidate.manifest);
        const dependencyResult = resolveDependencies(requiredCapabilities, availableManifests);
        if (!dependencyResult.ok) {
          const reason = `missing required capabilities: ${dependencyResult.missing.join(", ")}`;
          log.error(`${manifest.id} rejected — ${reason}`);
          this.auditLog?.("error", "plugin_dependency_missing", {
            pluginId: manifest.id,
            missing: dependencyResult.missing,
          });
          this.markFailed(manifest.id, {
            name: manifest.name,
            description: `Missing capabilities: ${dependencyResult.missing.join(", ")}`,
          });
          continue;
        }
      }
      if (this.deferPluginStartUntilPrepared(plan, manifest, approvedPluginAccess)) {
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
      let module: { default?: RuntimePluginFactory; createPlugin?: RuntimePluginFactory };
      try {
        module = (await import(buildImportUrl(resolvedEntryPath))) as {
          default?: RuntimePluginFactory;
          createPlugin?: RuntimePluginFactory;
        };
      } catch (err) {
        plog("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, err, reason: "import" }, "import failed");
        this.auditLog?.("error", "plugin_import_failed", {
          pluginId: manifest.id,
          reason: (err as Error).message,
        });
        this.markFailed(manifest.id);
        continue;
      }
      const createPlugin = module.default ?? module.createPlugin;
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
        if (!this.perfStats.has(id)) {
          this.perfStats.set(id, { startupMs: 0, toolCallCount: 0, errorCount: 0, totalExecMs: 0, lastCallAt: null });
        }
        try {
          if (!plugin.instance.start) {
            this.perfStats.get(id)!.startupMs = Date.now() - startedAt;
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
        const stats = this.perfStats.get(id);
        if (stats) stats.startupMs = elapsed;
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
    const importUrl = buildImportUrl(resolvedEntryPath, true);

    let module: { default?: RuntimePluginFactory; createPlugin?: RuntimePluginFactory };
    try {
      module = (await import(importUrl)) as {
        default?: RuntimePluginFactory;
        createPlugin?: RuntimePluginFactory;
      };
      plog("debug", { pluginId, phase: PluginPhase.RESTART_RELOAD_OK }, "module re-imported");
    } catch (err) {
      plog("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err }, "module re-import failed");
      return "failed";
    }

    const createPlugin = module.default ?? module.createPlugin;
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

    const methods = new Map<string, PluginToolHandler>();
    for (const toolName of declaredRuntimeMethods(manifest)) {
      const handler = instance.handlers[toolName];
      if (!handler) {
        plog("warn", { pluginId, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" }, "tool disabled — missing handler after restart");
        continue;
      }
      methods.set(toolName, handler);
    }

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

  setConfigOverride(pluginId: string, config: Record<string, unknown>): void {
    if (Object.keys(config).length === 0) {
      delete this.configOverrides[pluginId];
      return;
    }
    this.configOverrides[pluginId] = { ...config };
  }

  mergeConfigOverride(pluginId: string, config: Record<string, unknown>): void {
    if (Object.keys(config).length === 0) return;
    this.configOverrides[pluginId] = {
      ...(this.configOverrides[pluginId] ?? {}),
      ...config,
    };
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
    if (Object.keys(config).length === 0) return;
    this.configOverrides["*"] = {
      ...(this.configOverrides["*"] ?? {}),
      ...config,
    };
  }

  /**
   * #893 / PR #894 B2 — Read the wildcard slot so `hostApi.config.get(...)`
   * can merge host-injected values (e.g. `hostApiVendor`) into every
   * plugin's effective config map. Returns an empty object when no wildcard
   * overrides have been set so callers can spread the result unconditionally.
   * The returned object is a shallow copy — callers MUST NOT mutate it.
   */
  getWildcardConfigOverride(): Record<string, unknown> {
    return { ...(this.configOverrides["*"] ?? {}) };
  }

  /**
   * #893 — Inverse of `setWildcardConfigOverride`. Clears ONLY the keys
   * named in `keys` from the wildcard slot, preserving other injected
   * values. When `keys` is empty the call is a no-op so the unrelated
   * `pythonExecutable` slot survives a vendor swap.
   */
  clearWildcardConfigOverride(keys: string[]): void {
    const current = this.configOverrides["*"];
    if (!current) return;
    for (const key of keys) {
      delete current[key];
    }
    if (Object.keys(current).length === 0) {
      delete this.configOverrides["*"];
    }
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
    for (const toolName of manifest.tools ?? []) {
      this.knownToolOwners.set(toolName, pluginId);
    }
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
    this.clearPluginPreparationState(pluginId);
    delete this.configOverrides[pluginId];
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
   * the dev-signer-in-packaged-build guard. Emits all relevant audit log
   * entries so callers cannot forget them.
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
  ): Promise<{ ok: true } | { ok: false }> {
    if (!this.installReceiptCacheRoot) {
      return { ok: true };
    }
    const receiptResult = await verifyInstallReceipt(
      this.installReceiptCacheRoot,
      pluginId,
      pluginRoot,
    );
    if (!receiptResult.ok) {
      log.error({ pluginId, reason: receiptResult.reason }, `${pluginId} rejected — install receipt integrity failed`);
      this.auditLog?.("error", "plugin_integrity_rejected", {
        pluginId,
        reason: receiptResult.reason,
      });
      return { ok: false };
    }
    const { installSource, signerKeyId, artifactSha256 } = receiptResult.receipt;
    // Policy gate: local-dev receipts are only valid in unpackaged dev builds.
    // verifyInstallReceipt is a pure integrity verifier; environment-based
    // policy (packaged vs dev) is enforced here in the runtime layer.
    if (installSource === "local-dev" && !isDevModeUnlocked()) {
      const reason = "local-dev install rejected in packaged build";
      log.error({ pluginId, reason }, `${pluginId} rejected — ${reason}`);
      this.auditLog?.("error", "plugin_integrity_rejected", { pluginId, reason });
      return { ok: false };
    }
    this.auditLog?.("info", "plugin_integrity_verified", {
      pluginId,
      installSource,
      artifactSha256,
      signerKeyId,
    });
    return { ok: true };
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
          name: manifest.name,
          description: `Missing capabilities: ${dependencyResult.missing.join(", ")}`,
        });
        return "failed";
      }
    }

    if (!opts.skipPreparation && this.deferPluginStartUntilPrepared(plan, manifest, approvedPluginAccess, opts)) {
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

    let module: { default?: RuntimePluginFactory; createPlugin?: RuntimePluginFactory };
    try {
      module = (await import(buildImportUrl(resolvedEntryPath, opts.cacheBust))) as {
        default?: RuntimePluginFactory;
        createPlugin?: RuntimePluginFactory;
      };
    } catch (err) {
      log.error(`${manifest.id} import failed: %s`, (err as Error).message);
      this.auditLog?.("error", "plugin_import_failed", {
        pluginId: manifest.id,
        reason: (err as Error).message,
      });
      this.markFailed(manifest.id);
      return "failed";
    }
    const createPlugin = module.default ?? module.createPlugin;
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
    this.disabledPluginIds.delete(manifest.id);

    if (!this.perfStats.has(manifest.id)) {
      this.perfStats.set(manifest.id, { startupMs, toolCallCount: 0, errorCount: 0, totalExecMs: 0, lastCallAt: null });
    } else {
      this.perfStats.get(manifest.id)!.startupMs = startupMs;
    }
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
    const importUrl = buildImportUrl(resolvedEntryPath, true); // cache-bust for dev reload
    const module = (await import(importUrl)) as {
      default?: RuntimePluginFactory;
      createPlugin?: RuntimePluginFactory;
    };
    const createPlugin = module.default ?? module.createPlugin;
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

    const methods = new Map<string, PluginToolHandler>();
    for (const toolName of declaredRuntimeMethods(manifest)) {
      const handler = instance.handlers[toolName];
      if (!handler) {
        log.warn(`missing handler '${toolName}' after reload — tool disabled`);
        continue;
      }
      methods.set(toolName, handler);
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

    if (this.registryPath) {
      await updatePluginRegistry(this.registryPath, (registry) => {
        const entry = registry.plugins.find((p) => p.id === pluginId);
        if (entry) {
          entry.enabled = false;
        }
      });
    }

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
    let stats = this.perfStats.get(pluginId);
    if (!stats) {
      stats = { startupMs: 0, toolCallCount: 0, errorCount: 0, totalExecMs: 0, lastCallAt: null };
      this.perfStats.set(pluginId, stats);
    }
    stats.toolCallCount += 1;
    stats.lastCallAt = Date.now();
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

  /**
   * Resolve the manifest for a pluginId from either the loaded set or the
   * known-manifest cache (a plugin may be declared/known before it is fully
   * loaded). Returns undefined when neither holds it.
   */
  private manifestForPlugin(pluginId: string): PluginManifest | undefined {
    return this.plugins.get(pluginId)?.manifest ?? this.knownPluginManifests.get(pluginId);
  }

  /**
   * Auth-class classifier consumed by the permission pipeline (ToolExecutor).
   * A tool is auth-class iff it equals the owning plugin manifest's
   * `auth.loginTool` or `auth.logoutTool` — the deliberate sign-in / sign-out
   * actions. `auth.statusTool` is intentionally EXCLUDED: status is a read-only
   * probe that must stay silent (no approval modal). Auth-class tools surface
   * the SAME ApprovalGate modal on every lane (UI click + agent-triggered).
   */
  isAuthClassTool(toolName: string): boolean {
    const pluginId = this.resolveToolOwner(toolName);
    if (!pluginId) return false;
    const auth = this.manifestForPlugin(pluginId)?.auth;
    if (!auth) return false;
    return toolName === auth.loginTool || toolName === auth.logoutTool;
  }

  assertPluginToolAccess(callerPluginId: string, method: string): void {
    const targetPluginId = this.resolveToolOwner(method);
    if (!targetPluginId || targetPluginId === callerPluginId) return;
    const rule = this.getPluginAccessGrant(callerPluginId)?.plugins.find((entry) => entry.pluginId === targetPluginId);
    if (rule?.tools?.includes(method)) return;
    this.auditLog?.("error", "plugin_tool_access_denied", {
      callerPluginId,
      targetPluginId,
      method,
    });
    throw new Error(
      `Plugin '${callerPluginId}' is not allowed to call tool '${method}' on plugin '${targetPluginId}'`,
    );
  }

  assertPluginEventAccess(callerPluginId: string, eventType: string): void {
    const targetPluginId = this.inferEventOwner(eventType);
    if (!targetPluginId || targetPluginId === callerPluginId) return;
    const rule = this.getPluginAccessGrant(callerPluginId)?.plugins.find((entry) => entry.pluginId === targetPluginId);
    if (rule?.events?.includes(eventType)) return;
    this.auditLog?.("error", "plugin_event_access_denied", {
      callerPluginId,
      targetPluginId,
      eventType,
    });
    throw new Error(
      `Plugin '${callerPluginId}' is not allowed to subscribe to event '${eventType}' from plugin '${targetPluginId}'`,
    );
  }

  assertPluginEventEmitAccess(callerPluginId: string, eventType: string): void {
    const ownerPluginId = this.inferEventOwner(eventType);
    if (!ownerPluginId || ownerPluginId === callerPluginId) return;
    this.auditLog?.("error", "plugin_event_emit_denied", {
      callerPluginId,
      ownerPluginId,
      eventType,
    });
    throw new Error(
      `Plugin '${callerPluginId}' is not allowed to emit event '${eventType}' owned by plugin '${ownerPluginId}'`,
    );
  }

  /**
   * Invoke a plugin method from the renderer, enforcing the uiCallable allowlist
   * so only explicitly declared methods are reachable via the IPC bridge.
   */
  async callFromUi(method: string, payload?: unknown): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      this.throwIfToolOwnerNotReady(method);
      throw new Error(`Plugin method not found: ${method}`);
    }
    const plugin = this.plugins.get(entry.pluginId);
    this.throwIfPluginNotStarted(entry.pluginId);
    const uiCallable = plugin?.manifest.uiCallable ?? [];
    if (!uiCallable.includes(method)) {
      throw new Error(
        `Method '${method}' is not UI-callable for plugin '${entry.pluginId}'. ` +
        `Declare it in manifest.uiCallable[] to allow renderer invocation.`,
      );
    }
    if (!this.toolInvocationDelegate) {
      throw new Error("Plugin tool executor is not wired; UI plugin call denied");
    }
    return this.toolInvocationDelegate(method, payload, {
      origin: "ui",
      ownerPluginId: entry.pluginId,
    });
  }

  getMethodMap(): ReadonlyMap<string, { pluginId: string; handler: PluginToolHandler }> {
    return this.methodMap;
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  getPerfStats(): Record<string, PluginPerfStats> {
    const result: Record<string, PluginPerfStats> = {};
    for (const [id, stats] of this.perfStats) {
      result[id] = { ...stats };
    }
    return result;
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
        tools: [toolName],
      },
      pluginRoot: "/tmp/test-inject",
      instance: {} as import("../types.js").RuntimePlugin,
      methods: new Map([[toolName, handler as import("../types.js").PluginToolHandler]]),
      started: true,
    };
    this.plugins.set(pluginId, stub);
    this.markPluginUiRevision(pluginId);
    this.methodMap.set(toolName, { pluginId, handler: handler as import("../types.js").PluginToolHandler });
    if (!this.perfStats.has(pluginId)) {
      this.perfStats.set(pluginId, {
        startupMs: 0,
        toolCallCount: 0,
        errorCount: 0,
        totalExecMs: 0,
        lastCallAt: null,
      });
    }
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

  listPluginCards(toolRegistry?: { getVisibleTools(): Array<{ name: string }> }): PluginCard[] {
    const visibleNames = toolRegistry
      ? new Set(toolRegistry.getVisibleTools().map((t) => t.name))
      : null;
    const cards = new Map<string, PluginCard>();
    for (const [pluginId, manifest] of this.knownPluginManifests) {
      const runtimeLoaded = this.plugins.has(pluginId);
      const enabled = !this.inactivePluginIds.has(pluginId);
      const active = enabled && runtimeLoaded;
      const loadStatus = this.preparingPluginIds.has(pluginId)
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
      cards.set(pluginId, this.buildPluginCard(pluginId, manifest, loadStatus, visibleNames, {
        active,
        runtimeLoaded,
      }));
    }
    for (const [pluginId, stub] of this.failedPluginStubs) {
      if (cards.has(pluginId)) continue;
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
      });
    }
    return [...cards.values()];
  }

  listPluginManifests(): Array<{ pluginId: string; manifest: PluginManifest }> {
    const result: Array<{ pluginId: string; manifest: PluginManifest }> = [];
    for (const pluginId of this.preparingPluginIds) {
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
    this.disabledPluginIds.clear();
    for (const [pluginId, pending] of this.pendingPreparedStarts) {
      pending.rejectReady(new Error(`plugin '${pluginId}' runtime dependency preparation was cancelled by runtime reset`));
      this.preparationGenerations.set(pluginId, ++this.nextPreparationGeneration);
    }
    this.preparingPluginIds.clear();
    this.preparationStatuses.clear();
    this.preparationFailures.clear();
    this.pendingPreparedStarts.clear();
    this.pendingRestarts.clear();
    this.pendingRestartPreparations.clear();
    this.preparationGenerations.clear();
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
    if (this.preparingPluginIds.has(pluginId)) {
      throw new Error(
        `Plugin '${pluginId}' is still installing its runtime dependencies. ` +
        `Try again after the plugin is ready.`,
      );
    }
    const failure = this.preparationFailures.get(pluginId);
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
  ): void {
    this.failedPluginIds.add(pluginId);
    this.disabledPluginIds.delete(pluginId);
    if (stub) {
      this.failedPluginStubs.set(pluginId, stub);
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
      name: manifest.name,
      description: `plugin requires LVIS >= ${minAppVersion}, current ${currentAppVersion}`,
    });
    return true;
  }

  private buildPluginCard(
    pluginId: string,
    manifest: PluginManifest,
    loadStatus: PluginCard["loadStatus"],
    visibleNames: Set<string> | null,
    state: { active: boolean; runtimeLoaded: boolean },
  ): PluginCard {
    const allTools = manifest.tools ?? [];
    const filteredTools = !state.active
      ? []
      : visibleNames
      ? allTools.filter((t) => visibleNames.has(t))
      : allTools;
    const sampleTools = filteredTools.slice(0, 3);
    let description: string;
    if (manifest.description) {
      description = manifest.description;
    } else {
      const schemas = manifest.toolSchemas;
      if (schemas) {
        const parts: string[] = [];
        for (const toolName of sampleTools) {
          const desc = schemas[toolName]?.description;
          if (desc) parts.push(desc);
        }
        description = parts.length > 0 ? parts.join(" / ") : `Plugin: ${manifest.name}`;
      } else {
        description = `Plugin: ${manifest.name}`;
      }
    }
    const toolDescriptions: Record<string, string> = {};
    if (manifest.toolSchemas) {
      for (const toolName of filteredTools) {
        const desc = manifest.toolSchemas[toolName]?.description;
        if (desc) toolDescriptions[toolName] = desc;
      }
    }
    const uiExtensions = manifest.ui?.filter((extension) => extension.slot === "sidebar");
    return {
      id: pluginId,
      name: manifest.name,
      description,
      sampleTools,
      tools: filteredTools,
      capabilities: manifest.capabilities ?? [],
      toolDescriptions: Object.keys(toolDescriptions).length > 0 ? toolDescriptions : undefined,
      isManaged: normalizeInstallPolicy(manifest) === "admin",
      installPolicy: manifest.installPolicy ?? "user",
      loadStatus,
      active: state.active,
      runtimeLoaded: state.runtimeLoaded,
      preparationStatus: loadStatus === "preparing" ? this.preparationStatuses.get(pluginId) : undefined,
      icon: manifest.icon,
      iconText: manifest.iconText,
      uiExtensions: uiExtensions && uiExtensions.length > 0 ? uiExtensions : undefined,
      version: manifest.version,
      publisher: manifest.publisher,
      configSchema: manifest.configSchema,
      auth: manifest.auth,
      installAliases: this.getPluginInstallAliases(pluginId),
    };
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
