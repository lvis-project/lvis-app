/**
 * Boot §4.2 Step 3-5 — per-plugin HostApi factory (C6 extraction).
 *
 * Behavior-preserving move of `createHostApi` out of the plugin-runtime barrel.
 * The `enforceMutatingEffects(instrumentEffectsByPath(...))` composition and the
 * hostFetch single-verb snapshot are copied VERBATIM — their nesting order and
 * single-read semantics are security invariants (locked by
 * permissions/__tests__/host-fetch-verb-snapshot.test.ts and
 * permissions/__tests__/hostapi-effect-completeness.test.ts).
 *
 * Lazy binding: `pluginRuntime` is read through the injected `getPluginRuntime`
 * getter (resolved once per createHostApi invocation, which only runs during
 * `startAll()` — after PluginRuntime is assigned). The factory itself is
 * constructed BEFORE PluginRuntime exists, so the value must never be captured
 * at construction time.
 */
import { BrowserWindow as ElectronBrowserWindow } from "electron";
import type { BrowserWindow } from "electron";
import { randomUUID, createHash } from "node:crypto";
import { normalizeAllowedHosts } from "../../../main/host-allow-list.js";
import { evaluateHostFetch } from "../../../main/host-fetch-guard.js";
import type { AuditLogger } from "../../../audit/audit-logger.js";
import type { PluginRuntime } from "../../../plugins/runtime.js";
import { instrumentEffectsByPath } from "../../../permissions/hostapi-effect-recorder.js";
import { enforceMutatingEffects, gateMutatingEffect } from "../../../permissions/effect-enforcement.js";
import { recordEffect } from "../../../permissions/effect-ledger.js";
import { methodEffect } from "../../../permissions/effect-kind.js";
import type { PluginRegistryEntry } from "../../../plugins/types.js";
import type { PluginHostApiIncarnation } from "../../../plugins/runtime/index.js";
import { createPluginStorage } from "../../../plugins/storage.js";
import {
  isPluginInstallLockHeld,
  withPluginInstallLock,
} from "../../../plugins/install-lifecycle.js";
import { probePrivateHost } from "../../../plugins/private-host-probe.js";
import { shouldBlockPluginSecretRead } from "../../../plugins/secret-shape.js";
import {
  canEmitEvent,
  requiredCapabilityForEmit,
  CAPABILITY_EXTERNAL_AUTH_CONSUMER,
} from "../../../plugins/capabilities.js";
import { getDeclaredEmittedEvents } from "../../../plugins/runtime/manifest-validation.js";
import { applyConfigDefaults } from "../../../plugins/config-schema.js";
import { OVERLAY_V1 } from "../../../shared/ipc-channels.js";
import {
  emitPluginConfigChange,
  subscribePluginConfigChange,
} from "../../../plugins/config-change-bus.js";
import type {
  ApprovalChoice,
  AuthWindowCookie,
  ConversationTriggerSpec,
  OpenAuthWindowBaseOptions,
  OpenAuthWindowFinalUrlResult,
  PluginHostApi,
  PluginManifest,
} from "../../../plugins/types.js";
import type { SettingsService } from "../../../data/settings-store.js";
import type { RoutinesStore } from "../../../main/routines-store.js";
import type { KeywordEngine } from "../../../core/keyword-engine.js";
import { emitEvent, onEvent } from "../../types.js";
import { t } from "../../../i18n/index.js";
import { createLogger } from "../../../lib/logger.js";
import { plog, PluginPhase } from "../../../plugins/lifecycle-log.js";
import { incrementHostSecretCounter, sanitizeKeyPrefix } from "../../../telemetry/host-secret-counters.js";
import { canonicalJSON } from "../../../plugins/whitelist/canonical-json.js";
import { runTier3Then4 } from "../../../plugins/whitelist/tier-order.js";
import { isMarketplaceProviderPresetId } from "../../../shared/marketplace-package-assets.js";
import {
  resolveApiKey as resolveApiKeyImpl,
  type ResolveApiKeyPurpose,
  type ResolveApiKeyVendor,
} from "../../../main/host-api/resolve-api-key.js";
import {
  verifyApprovalRequestScope,
  verifyApprovalResponder,
} from "../../../permissions/agent-action-requester.js";
import { spawnWorker } from "../../../permissions/worker-spawn.js";
import { approvalIssuerRegistry, auditApprovalViolation } from "./approval-gating.js";
import { routeExternalUrl } from "./external-url.js";
import {
  deriveOverlaySummaryForDisplay,
  evaluateTriggerSpec,
  formatPluginPendingPrompt,
  triggerConversationDedupe,
  triggerConversationRateLimiter,
  triggerDenyAuditThrottle,
} from "./trigger-gate.js";
import type { LateBindingRefs } from "../plugin-runtime.js";

const log = createLogger("lvis");

function assertActiveHostApi(
  pluginId: string,
  incarnation: PluginHostApiIncarnation,
  memberPath: string,
): void {
  if (incarnation.isActive()) return;
  throw new Error(
    `[plugin:${pluginId}] ${memberPath}: plugin instance is no longer active`,
  );
}

/** Revoke every callable surface of an obsolete HostApi incarnation. */
function enforceActiveHostApi(
  pluginId: string,
  incarnation: PluginHostApiIncarnation,
  hostApi: PluginHostApi,
): PluginHostApi {
  const proxies = new WeakMap<object, object>();
  const wrap = (target: object, path: string): object => {
    const existing = proxies.get(target);
    if (existing) return existing;
    const proxy = new Proxy(target, {
      get(currentTarget, property, receiver) {
        const value = Reflect.get(currentTarget, property, receiver) as unknown;
        const memberPath = `${path}.${String(property)}`;
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            assertActiveHostApi(pluginId, incarnation, memberPath);
            const result = Reflect.apply(value, currentTarget, args) as unknown;
            if (
              memberPath !== "hostApi.config.set"
              && result !== null
              && typeof result === "object"
              && typeof (result as PromiseLike<unknown>).then === "function"
            ) {
              return incarnation.trackOperation(Promise.resolve(result));
            }
            return result;
          };
        }
        if (value !== null && typeof value === "object") {
          return wrap(value, memberPath);
        }
        return value;
      },
    });
    proxies.set(target, proxy);
    return proxy;
  };
  return wrap(hostApi, "hostApi") as PluginHostApi;
}

/** Explicit deps the HostApi factory needs. Lazy bindings arrive as getters. */
export interface CreateHostApiFactoryDeps {
  /** Getter for the mutable `pluginRuntime` binding (assigned after this factory is built). */
  getPluginRuntime: () => PluginRuntime;
  lateBinding: LateBindingRefs;
  getRegistryEntry: (
    pluginId: string,
  ) => Pick<PluginRegistryEntry, "installSource" | "manifestSha256"> | undefined;
  hostClassifiesRiskEnabled: () => boolean;
  keywordEngine: KeywordEngine;
  pluginShutdownHandlers: Array<{ pluginId: string; handler: () => void | Promise<void> }>;
  readAppPreference: (pluginId: string, key: string) => unknown;
  settingsService: SettingsService;
  bootAuditLogger: AuditLogger;
  networkFetch: typeof fetch;
  mainWindow: BrowserWindow;
  openAuthWindowService: (
    parent: BrowserWindow,
    opts: OpenAuthWindowBaseOptions & { returnFinalUrl?: boolean },
  ) => Promise<AuthWindowCookie[] | OpenAuthWindowFinalUrlResult>;
  openLinkWindowService: (
    parent: BrowserWindow,
    opts: { url: string; windowTitle?: string; persistPartition?: string },
  ) => Promise<void>;
  openAuthPartitionViewerService: (
    parent: BrowserWindow,
    opts: import("../../../main/auth-partition-viewer-service.js").OpenAuthPartitionViewerOptions,
  ) => Promise<void>;
  clearAuthPartitionService: (partition: string) => Promise<void>;
  shellOpenExternal: (url: string) => Promise<void>;
  approvalGate: import("../../../permissions/approval-gate.js").ApprovalGate;
  permissionManager?: import("../../../permissions/permission-manager.js").PermissionManager;
  routinesStore: RoutinesStore;
}

/**
 * Build the per-plugin `createHostApi` closure passed to `new PluginRuntime`.
 * Returned function is invoked once per plugin during `startAll()`.
 */
export function createHostApiFactory(
  deps: CreateHostApiFactoryDeps,
): (
  pluginId: string,
  manifest: PluginManifest,
  pluginDataDir: string,
  incarnation: PluginHostApiIncarnation,
) => PluginHostApi {
  const {
    getPluginRuntime,
    lateBinding,
    getRegistryEntry,
    hostClassifiesRiskEnabled,
    keywordEngine,
    pluginShutdownHandlers,
    readAppPreference,
    settingsService,
    bootAuditLogger,
    networkFetch,
    mainWindow,
    openAuthWindowService,
    openLinkWindowService,
    openAuthPartitionViewerService,
    clearAuthPartitionService,
    shellOpenExternal,
    approvalGate,
    permissionManager,
    routinesStore,
  } = deps;

  return (
    pluginId: string,
    manifest: PluginManifest,
    pluginDataDir: string,
    incarnation: PluginHostApiIncarnation,
  ): PluginHostApi => {
    // Lazy binding — resolve the eventual `pluginRuntime` assignment (this
    // closure only runs during startAll, after the barrel assigns it). All
    // body references below read this single resolved value; `pluginRuntime` is
    // assigned exactly once so this is byte-identical to a per-reference read.
    const pluginRuntime = getPluginRuntime();
    const hostIncarnation = incarnation;
    const assertIssuedCapabilityActive = (memberPath: string): void => {
      if (!hostIncarnation.isActive()) {
        throw new Error(
          `[plugin:${pluginId}] ${memberPath}: plugin instance is no longer active`,
        );
      }
    };
    const bindApiKeyResult = (
      result: Awaited<ReturnType<NonNullable<PluginHostApi["resolveApiKey"]>>>,
    ): Awaited<ReturnType<NonNullable<PluginHostApi["resolveApiKey"]>>> => {
      if (!result.ok) return result;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        result.release();
      };
      hostIncarnation.registerDisposer(release);
      return {
        ...result,
        bearer: () => {
          assertIssuedCapabilityActive("hostApi.resolveApiKey().bearer");
          return result.bearer();
        },
        release,
      };
    };
    const bindWorkerHandle = (
      worker: Awaited<ReturnType<NonNullable<PluginHostApi["spawnWorker"]>>>,
    ): Awaited<ReturnType<NonNullable<PluginHostApi["spawnWorker"]>>> => {
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        worker.stop();
      };
      hostIncarnation.registerDisposer(stop);
      return {
        socketPath: worker.socketPath,
        pid: worker.pid,
        stop,
        onStdout: (listener) => {
          assertIssuedCapabilityActive("hostApi.spawnWorker().onStdout");
          worker.onStdout((chunk) => {
            if (hostIncarnation.isActive()) listener(chunk);
          });
        },
        onStderr: (listener) => {
          assertIssuedCapabilityActive("hostApi.spawnWorker().onStderr");
          worker.onStderr((chunk) => {
            if (hostIncarnation.isActive()) listener(chunk);
          });
        },
        onExit: (listener) => {
          assertIssuedCapabilityActive("hostApi.spawnWorker().onExit");
          worker.onExit((info) => {
            if (hostIncarnation.isActive()) listener(info);
          });
        },
      };
    };
      // #893 Stage 2 — manifest sha256 pin (Tier-3 whitelist check). The
      // whitelist registry stores `approvedManifestSha256` per pluginId; we
      // compare against the canonicalized JSON of the running manifest so a
      // post-install manifest swap (different tools / wider hostSecrets.read)
      // forces a fresh whitelist roll.
      //
      // Ralph cycle 1 fix — previously this used the REPLACER-ARRAY form of
      // `JSON.stringify(manifest, Object.keys(manifest).sort())` which only
      // filters top-level keys and emits every nested object as `{}`. As a
      // result every plugin's manifest hashed to (nearly) the same sha and
      // the Tier-3 pin was defeated. Switching to a recursive canonical
      // JSON serializer (RFC 8785 JCS-style — sort keys at every depth,
      // preserve array element order) restores the pin.
      const canonical = canonicalJSON(manifest);
      const manifestSha256 = createHash("sha256").update(canonical).digest("hex");
      // Structural effect observability — wrap the whole hostApi so EVERY method
      // (and any future-added one) auto-records its host-observed effect on the
      // ambient per-invocation ledger, looked up by method PATH in the
      // classification SOT. This is the SINGLE recording point: it replaces the
      // per-closure manual `recordChokepoint` calls that kept missing methods
      // across review rounds. The wrapper is a PURE side-effect (records, never
      // alters behavior), and the completeness test + fail-closed default
      // guarantee no method can be silently un-instrumented. `storage` is already
      // instrumented at its own construction boundary, so the wrapper's
      // idempotence guard leaves it untouched (no double-recording).
      //
      // Effect-boundary ENFORCEMENT wraps the recorder as the OUTER layer: a
      // host-classified WRITE awaits a user approval AT THE EFFECT (foreground) /
      // fails closed (headless) before the mutation runs, but ONLY when
      // `hostClassifiesRisk` is ON (the shipped default) — flag OFF (only when
      // disabled/unset) is a byte-for-byte pass-through. OUTER (not inner) so the pure recorder is untouched and a
      // DENIED effect is never recorded as a host-observed mutation. The lone
      // verb-derived chokepoint (hostFetch) is gated INLINE in its closure from
      // the single verb snapshot; the wrapper skips it.
      return enforceActiveHostApi(pluginId, hostIncarnation, enforceMutatingEffects<PluginHostApi>(
        instrumentEffectsByPath<PluginHostApi>({
      storage: createPluginStorage(pluginId, pluginDataDir, (msg, meta) => {
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "warn",
            input: `[plugin:${pluginId}] storage_${msg.replace(/\s+/g, "_")} ${typeof meta === "object" ? JSON.stringify(meta) : ""}`.trim(),
          });
        } catch { /* audit must not break host */ }
      }),
      // §9.2 Track B — typed plugin config access, scoped to this pluginId.
      // `get` reads the live merged config (manifest defaults + saved
      //   overrides) directly from settingsService so a write from another
      //   surface (renderer, IPC, sibling plugin) is visible without reload.
      // `set` persists via the same `setPluginConfig` IPC bridge used by the
      //   settings UI and triggers a plugin reload so the plugin's `config`
      //   snapshot in `PluginRuntimeContext.config` is rebuilt with the new
      //   value. `format: "secret"` keys are rejected here — secrets MUST go
      //   through `hostApi.setSecret` so they land encrypted, never in
      //   cleartext `pluginConfigs`.
      // `onChange` listeners are registered against the plugin's own id only;
      //   the underlying bus rejects cross-plugin observation.
      config: {
        get: <T = unknown>(key: string): T | undefined => {
          // PR #894 B2 follow-up — merge wildcard slot (`hostApiVendor` etc.)
          // BETWEEN manifest defaults and plugin-specific overrides so a
          // plugin's own config can shadow a host-injected value (rare, but
          // useful for test fixtures and explicit per-plugin overrides),
          // while shipping a sensible default for plugins that don't set it.
          //
          // AB1 — apply `configSchema` defaults as the LOWEST layer (under
          // manifest.config < wildcard < saved settings). Without this the live
          // getter returned `undefined` for a schema-defaulted key that the user
          // hasn't set, while `ctx.config` (built via applyConfigDefaults in
          // runtime/sandbox.ts) returned the author-declared default — the two
          // now agree. applyConfigDefaults only backfills keys still undefined,
          // so it never changes the precedence of the higher layers.
          const merged = applyConfigDefaults(manifest.configSchema, {
            ...(manifest.config ?? {}),
            ...(pluginRuntime.getWildcardConfigOverride?.() ?? {}),
            ...(settingsService.getPluginConfig(pluginId) ?? {}),
          });
          return merged[key] as T | undefined;
        },
        set: <T = unknown>(key: string, value: T): Promise<void> => {
          const schemaProp = manifest.configSchema?.properties?.[key];
          if (schemaProp?.type === "string" && schemaProp.format === "secret") {
            return Promise.reject(new Error(
              `[plugin:${pluginId}] config.set('${key}'): secret fields must be saved via hostApi.setSecret(), not config.set().`,
            ));
          }
          const nestedLifecycleMutation =
            isPluginInstallLockHeld(pluginId) || hostIncarnation.isLifecycleHookActive();
          const persistence = withPluginInstallLock(pluginId, async () => {
            // The HostApi object belongs to this exact manifest incarnation.
            // A queued write from a stopped/uninstalled instance must not
            // recreate persisted config for a removed or reinstalled plugin.
            if (!hostIncarnation.isActive()) {
              throw new Error(
                `[plugin:${pluginId}] config.set('${key}'): plugin instance is no longer active`,
              );
            }
            const current = settingsService.getPluginConfig(pluginId) ?? {};
            // structuredClone so we never accidentally hand the plugin our
            // internal record reference.
            const nextRecord = structuredClone({
              ...current,
              [key]: value as unknown,
            });
            await settingsService.setPluginConfig(pluginId, nextRecord);
            // Mirror the IPC handler — refresh the runtime's per-plugin
            // override so the next reload picks up the new value, then emit
            // the change so existing listeners observe it without waiting
            // for the reload.
            pluginRuntime.setConfigOverride(pluginId, nextRecord);
            emitPluginConfigChange(pluginId, key, value);
          });
          // Return the tracked chain directly. Crossing an async/await wrapper
          // here would transfer a detached rejection to an untracked native
          // Promise and let the owning lifecycle mutation resolve early.
          const operation = persistence.then(async () => {
            // Lifecycle hooks inherit the owning mutation context. Persist
            // their write, but never recursively restart the instance whose
            // start/stop Promise is currently being awaited.
            if (
              nestedLifecycleMutation
              || pluginRuntime.isPluginRestartPending?.(pluginId)
            ) {
              return;
            }
            try {
              const restartResult = await pluginRuntime.restartPlugin(
                pluginId,
                { skipPreparation: true },
              );
              if (restartResult !== "started") {
                throw new Error(
                  `runtime reload returned ${restartResult ?? "not-loaded"}`,
                );
              }
            } catch (err) {
              throw new Error(
                `[plugin:${pluginId}] config.set('${key}'): runtime reload failed: ${(err as Error).message}`,
              );
            }
          });
          return hostIncarnation.trackOperation(operation);
        },
        onChange: <T = unknown>(
          key: string,
          callback: (value: T | undefined) => void,
        ): (() => void) => {
          const unsubscribe = subscribePluginConfigChange(
            pluginId,
            key,
            (_changedKey, value) => {
              if (!hostIncarnation.isActive()) return;
              callback(value as T | undefined);
            },
          );
          // Auto-cleanup on plugin disable to mirror onEvent semantics.
          hostIncarnation.registerDisposer(unsubscribe);
          return unsubscribe;
        },
      },
      registerKeywords: (keywords) => {
        // #1176 M3: inactive plugins must not register keywords at start() time.
        // onActiveStateChange(true) re-registers them if the plugin is later
        // activated without a runtime restart.
        if (!pluginRuntime.isPluginEnabled(pluginId)) {
          log.debug(`plugin:${pluginId} skipping keyword registration — plugin inactive`);
          return;
        }
        keywordEngine.registerKeywords(
          keywords.map((k) => ({ ...k, pluginId })),
        );
        log.info(`plugin:${pluginId} registered ${keywords.length} keywords`);
      },
      emitEvent: (type, data) => {
        plog("debug", { pluginId, phase: PluginPhase.CAPABILITY_CHECK, eventType: type }, "checking emit capability");
        const manifest = pluginRuntime?.getPluginManifest(pluginId);
        const declaredEmittedEvents = manifest ? getDeclaredEmittedEvents(manifest) : [];
        if (!canEmitEvent(type, declaredEmittedEvents)) {
          const requiredCap = requiredCapabilityForEmit(type);
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] plugin_emit_capability_denied eventType=${type} required=${requiredCap} declaredEmittedEvents=${declaredEmittedEvents.join("|")}`,
            });
          } catch { /* audit must not break host */ }
          plog("warn", { pluginId, phase: PluginPhase.CAPABILITY_DENY, capability: requiredCap ?? type, eventType: type, reason: "missing_capability" }, "capability denied");
          throw new Error(`Plugin '${pluginId}' is not allowed to emit undeclared event '${type}'`);
        }
        pluginRuntime.assertPluginEventEmitAccess(pluginId, type);
        plog("debug", { pluginId, phase: PluginPhase.EVENT_EMIT, eventType: type }, "event emitted");
        emitEvent(type, { ...((data as Record<string, unknown>) ?? {}), pluginId });
      },
      onEvent: (type, handler) => {
        pluginRuntime.assertPluginEventAccess(pluginId, type);
        const unsubscribe = onEvent(type, (data) => {
          if (hostIncarnation.isActive()) handler(data);
        });
        hostIncarnation.registerDisposer(unsubscribe);
        plog("debug", { pluginId, phase: PluginPhase.EVENT_LISTEN, eventType: type }, "event listener registered");
        return unsubscribe;
      },
      getInstalledPluginIds: () => {
        return pluginRuntime.listPluginIds().filter((id) => id !== pluginId);
      },
      onPluginsChanged: (handler) => {
        const dispatchInstalled = (data: unknown) => {
          if (!hostIncarnation.isActive()) return;
          const payload = data as { pluginId?: string; source?: "marketplace" | "local-dev" } | null | undefined;
          const subjectId = payload?.pluginId;
          if (typeof subjectId !== "string" || subjectId === pluginId) return;
          const source = payload?.source === "local-dev" ? "local-dev" : "marketplace";
          handler({ type: "installed", pluginId: subjectId, source });
        };
        const dispatchUninstalled = (data: unknown) => {
          if (!hostIncarnation.isActive()) return;
          const subjectId = (data as { pluginId?: string } | null | undefined)?.pluginId;
          if (typeof subjectId !== "string" || subjectId === pluginId) return;
          handler({ type: "uninstalled", pluginId: subjectId });
        };
        const unsubInstalled = onEvent("plugin.installed", dispatchInstalled);
        const unsubUninstalled = onEvent("plugin.uninstalled", dispatchUninstalled);
        const unsubscribe = () => { unsubInstalled(); unsubUninstalled(); };
        hostIncarnation.registerDisposer(unsubscribe);
        return unsubscribe;
      },
      // #893 Stage 2 — Host implementation of the SDK's `resolveApiKey`.
      // Returns the SDK `ResolveApiKeyResult` discriminated union (bearer +
      // release on success; typed reason on failure). Plugins read the
      // key via `result.bearer()` and SHOULD call `result.release()` in a
      // `finally` so the captured string has a deterministic lifetime.
      // All four tiers are evaluated in-line inside `resolveApiKeyImpl`;
      // the call here is a thin closure capture of pluginId + manifest +
      // manifestSha256 + the shared audit/settings services.
      resolveApiKey: async (opts) => {
        const result = await resolveApiKeyImpl(
          {
            purpose: opts.purpose as ResolveApiKeyPurpose,
            vendor: opts.vendor as ResolveApiKeyVendor | undefined,
            signal: opts.signal,
          },
          {
            pluginId,
            manifest,
            manifestSha256,
            settingsService,
            auditLogger: bootAuditLogger,
            // #958/#959 — feed the registry-anchored installSource and
            // install-time manifest SHA so admin bypasses skip only the
            // host-secret ACL, never the manifest tamper check.
            ...((): {
              registryInstallSource?: "admin" | "user" | "local-dev";
              registryManifestSha256?: string;
            } => {
              const entry = getRegistryEntry(pluginId);
              return {
                ...(entry?.installSource !== undefined ? { registryInstallSource: entry.installSource } : {}),
                ...(entry?.manifestSha256 !== undefined ? { registryManifestSha256: entry.manifestSha256 } : {}),
              };
            })(),
            // Cluster review M1 — bind the permission-manager revoke signal
            // accessor so an in-flight bearer aborts when permissions
            // change for this plugin. When permissionManager is not wired
            // (test runtimes) the host-api falls back to caller-signal-only.
            ...(permissionManager
              ? {
                  getPluginRevokeSignal: (id: string) =>
                    permissionManager.getPluginRevokeSignal(id),
                }
              : {}),
          },
        );
        if (!hostIncarnation.isActive() && result.ok) {
          result.release();
          throw new Error(
            `[plugin:${pluginId}] hostApi.resolveApiKey: plugin instance is no longer active`,
          );
        }
        return bindApiKeyResult(result);
      },
      getSecret: (key) => {
        // #893 Stage 2 — Four-tier secret access gate:
        //   (1) Plugin's own `plugin.<pluginId>.*` namespace — always allowed.
        //       ADDITIVE WHITELIST: this tier intentionally never consults the
        //       whitelist registry so non-whitelisted plugins still get to hold
        //       their own keys under their own namespace.
        //   (2) Host secret declared in `manifest.hostSecrets.read[]` — must
        //       match the static manifest allowlist. Manifest-only check.
        //   (3) Whitelist registry — `whitelistRegistry.isAllowed(pluginId,
        //       key, manifestSha256)`. Tier-3 was added in Stage 2 of the
        //       #893 redesign so a remote-signed policy roll can pull a
        //       grant without shipping a host build. Manifest sha pin
        //       prevents post-install manifest swaps from inheriting the
        //       grant.
        //   (4) Active-vendor cross-check — `settings.llm.provider` must
        //       equal the vendor in the requested `llm.apiKey.<vendor>` key.
        //       Stops a plugin from harvesting idle credentials for a
        //       non-active provider.
        //
        // PR #894 review B7 — `keyPrefix` is folded through `sanitizeKeyPrefix`
        // before it reaches the in-process counter map. An attacker plugin
        // could otherwise call `hostApi.getSecret("<random-prefix>.x")` in a
        // loop and grow the counter map unboundedly via the `denied` branch
        // (one entry per attacker-controlled prefix). Folding unknown
        // prefixes to the bucket `"other"` caps the cardinality.
        //
        // Audit log lines additionally cap `key` to 64 chars so an attacker
        // can't bloat the JSONL with megabyte-long denied keys.
        const auditKey = key.slice(0, 64);
        // Tier 1 — own namespace.
        if (key.startsWith(`plugin.${pluginId}.`)) {
          const value = settingsService.getSecret(key);
          if (shouldBlockPluginSecretRead({ pluginId, storageKey: key, value })) {
            try {
              bootAuditLogger.log({
                timestamp: new Date().toISOString(),
                sessionId: "plugin",
                type: "warn",
                input: `[plugin:${pluginId}] pluginSecret_denied reason=endpoint-url-in-api-key-like-secret key=${auditKey}`,
              });
            } catch { /* audit must not break host */ }
            return null;
          }
          return value;
        }
        const allowlist = manifest.hostSecrets?.read ?? [];
        const keyPrefix = sanitizeKeyPrefix(key);
        // Tier 2 — manifest allowlist.
        if (allowlist.includes(key)) {
          // Tier 3 + Tier 4 — shared helper (`runTier3Then4`) keeps the
          // order identical with `resolveApiKey`: whitelist registry
          // (coarse signed ACL) before vendor cross-check (per-call
          // dynamic state). Ralph cycle 1 MEDIUM fix.
          //
          const llmKeyPrefix = "llm.apiKey.";
          const isLlmKey = key.startsWith(llmKeyPrefix);
          const marketplaceProviderKeyPrefix = "llm.marketplaceProvider.";
          const marketplaceProviderKeySuffix = ".apiKey";
          const marketplaceProviderPresetId =
            key.startsWith(marketplaceProviderKeyPrefix) &&
            key.endsWith(marketplaceProviderKeySuffix)
              ? key.slice(
                  marketplaceProviderKeyPrefix.length,
                  -marketplaceProviderKeySuffix.length,
                )
              : "";
          const isMarketplaceProviderKey = marketplaceProviderPresetId.length > 0;
          let vendor = "";
          let activeProvider = "";
          if (isLlmKey) {
            vendor = key.slice(llmKeyPrefix.length);
            const llm = settingsService.get("llm");
            activeProvider =
              vendor === "openai-compatible" &&
              llm.provider === "openai-compatible" &&
              isMarketplaceProviderPresetId(llm.marketplaceProviderPresetId)
                ? llm.marketplaceProviderPresetId
                : (llm.provider as string);
          } else if (isMarketplaceProviderKey) {
            vendor = marketplaceProviderPresetId;
            const llm = settingsService.get("llm");
            const installedPreset = isMarketplaceProviderPresetId(marketplaceProviderPresetId)
              ? (settingsService
                .get("marketplace")
                .installedProviderPresets ?? [])
                .some((preset) => preset.providerId === marketplaceProviderPresetId)
              : false;
            activeProvider =
              installedPreset &&
              llm.provider === "openai-compatible" &&
              llm.marketplaceProviderPresetId === marketplaceProviderPresetId
                ? marketplaceProviderPresetId
                : "";
          } else {
            activeProvider = vendor;
          }
          // #958/#959 security — registry-recorded `installSource` is the
          // only source that can activate admin secret-access bypass.
          // The registry file is host-managed; `plugin.json` is inside
          // the plugin's writable surface so a malicious post-install
          // patch could flip `installPolicy:"admin"` and inherit Tier-3
          // bypass if manifest-only metadata were trusted here.
          const registryEntry = getRegistryEntry(pluginId);
          const registryInstallSource = registryEntry?.installSource;
          const effectiveInstallPolicy: "admin" | "user" =
            registryInstallSource === "admin" ? "admin" : "user";
          const outcome = runTier3Then4({
            pluginId,
            key,
            manifestSha256,
            installedManifestSha256: registryEntry?.manifestSha256,
            vendor,
            activeProvider,
            // #955/#959 — admin-installed plugins bypass only the Tier-3
            // signed whitelist registry ACL. The registry manifest SHA and
            // Tier-4 vendor cross-check still apply via the same helper.
            installPolicy: effectiveInstallPolicy,
          });
          if (outcome.kind === "deny") {
            const auditReason =
              outcome.tier === "tier-4" ? "non-active-vendor" : outcome.reason;
            try {
              bootAuditLogger.log({
                timestamp: new Date().toISOString(),
                sessionId: "plugin",
                type: "warn",
                input: `[plugin:${pluginId}] hostSecret_denied reason=${auditReason} key=${auditKey}`,
              });
            } catch { /* audit must not break host */ }
            incrementHostSecretCounter("hostSecret_denied", pluginId, keyPrefix);
            return null;
          }
          // #958 round-1 security MEDIUM — admin-bypass audit + counter.
          // Emit BEFORE the host-secret read line so operators can pivot
          // on `policy=admin manifest-allowlist-bypassed` in the audit log. The
          // dedicated `hostSecret_admin_bypass` counter is on top of the
          // regular `hostSecret_read` increment below so totals stay
          // comparable across bypass and non-bypass reads.
          if (outcome.via === "admin-bypass") {
            try {
              bootAuditLogger.log({
                timestamp: new Date().toISOString(),
                sessionId: "plugin",
                type: "info",
                input: `[plugin:${pluginId}] policy=admin manifest-allowlist-bypassed key=${auditKey} source=registry.installSource`,
              });
            } catch { /* audit must not break host */ }
            incrementHostSecretCounter(
              "hostSecret_admin_bypass",
              pluginId,
              keyPrefix,
            );
          }
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "info",
              input: `[plugin:${pluginId}] hostSecret_read key=${auditKey}`,
            });
          } catch { /* audit must not break host */ }
          incrementHostSecretCounter("hostSecret_read", pluginId, keyPrefix);
          return settingsService.getSecret(key);
        }
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "warn",
            input: `[plugin:${pluginId}] hostSecret_denied reason=not-allowlisted key=${auditKey}`,
          });
        } catch { /* audit must not break host */ }
        incrementHostSecretCounter("hostSecret_denied", pluginId, keyPrefix);
        return null;
      },
      callLlm: async (prompt, opts) => {
        if (lateBinding.pluginCallLlmRef.fn) {
          return lateBinding.pluginCallLlmRef.fn(pluginId, prompt, opts);
        }
        if (!lateBinding.llmCallerRef.fn) throw new Error("LLM provider not ready");
        return lateBinding.llmCallerRef.fn(prompt, opts);
      },
      hostFetch: async (input, init) => {
        // Capability-gated host-mediated egress through Electron net (Chromium
        // stack → OS proxy incl. PAC/WPAD + OS trust store), for plugins whose
        // Node libraries (e.g. MSAL) can't be configured for the corporate
        // proxy/CA.
        //
        // The layered policy (scheme/credential reject → https-only →
        // deny-by-default allow-list → DNS-aware SSRF guard) lives in the pure
        // `evaluateHostFetch` core so it is unit-testable without the runtime.
        // Audit + telemetry side effects stay here, the host chokepoint.
        // Egress denial: bump the per-(plugin, reason) telemetry counter +
        // write the authoritative audit line. `reasonBucket` goes through
        // sanitizeKeyPrefix so an unknown bucket folds to "other" — the same
        // cardinality guard the host-secret path uses (no raw string reaches
        // the counter map).
        const auditEgressDeny = (reasonBucket: string, detail: string) => {
          incrementHostSecretCounter("hostFetch_denied", pluginId, sanitizeKeyPrefix(reasonBucket));
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] host_fetch_denied ${detail}`,
            });
          } catch { /* audit must not break host */ }
        };
        // ─── Verb snapshot — SINGLE read of the (plugin-controlled) HTTP method.
        // Destructuring `method` out of `init` invokes its getter EXACTLY ONCE;
        // `restInit` carries every OTHER field by value and NO LONGER holds the
        // `method` getter, so the wire spread below cannot re-invoke it. The
        // recorded effect, the audit verb, and the wire verb are ALL derived from
        // this one primitive, so a stateful getter (GET to the recorder, POST to
        // the wire) can no longer record a confirmed READ for an executed WRITE.
        // The host owns the verb here — non-forgeable. Default "GET" mirrors
        // `fetch`'s default when init.method is omitted/empty/non-string.
        const { method: rawVerb, ...restInit } = init ?? {};
        const methodSnapshot =
          typeof rawVerb === "string" && rawVerb.length > 0 ? rawVerb.toUpperCase() : "GET";
        // hostFetch is the ONLY verb-derived chokepoint, so the generic recorder
        // skips it (effect-kind.ts marks it `selfRecorded`) and THIS is the single
        // recording point — no second read, no double-record. Recorded BEFORE the
        // capability/SSRF gates so a denied egress still surfaces its attempted
        // effect, matching the prior wrapper-records-first ordering. Target is the
        // ORIGIN only (no path/query that can carry tokens); string input only,
        // mirroring the previous urlOriginArg extractor.
        let effectTarget: string | undefined;
        if (typeof input === "string") {
          try {
            effectTarget = new URL(input).origin;
          } catch {
            /* best-effort forensic origin — never blocks the record */
          }
        }
        recordEffect({
          kind: "hostFetch",
          effect: methodEffect(methodSnapshot),
          ...(effectTarget !== undefined ? { target: effectTarget } : {}),
        });
        if (!manifest.capabilities?.includes(CAPABILITY_EXTERNAL_AUTH_CONSUMER)) {
          auditEgressDeny("capability", "capability external-auth-consumer not declared");
          throw new Error(
            `[plugin:${pluginId}] capability not declared: external-auth-consumer (hostFetch)`,
          );
        }
        const raw = input instanceof URL ? input.toString() : input;
        // SSRF defense: an allow-listed host that resolves to a private /
        // loopback / link-local / metadata address is rejected unless the
        // manifest explicitly opts into `networkAccess.allowPrivateNetworks`
        // (the declarative, user-approved governance gate). The host-suffix
        // allow-list alone cannot stop an attacker-controlled or DNS-rebound
        // name from pivoting to 169.254.169.254 / 127.0.0.1 / RFC1918 when
        // `net.fetch` resolves DNS directly (off-corp, no proxy).
        const decision = await evaluateHostFetch({
          pluginId,
          rawUrl: raw,
          method: methodSnapshot,
          allowedDomains: manifest.networkAccess?.allowedDomains ?? [],
          allowPrivateNetworks: manifest.networkAccess?.allowPrivateNetworks === true,
        });
        if (!decision.ok) {
          auditEgressDeny(decision.reason, decision.detail);
          throw new Error(decision.message);
        }
        const url = decision.url;
        // Effect-boundary ENFORCEMENT — hostFetch is the lone VERB-derived
        // chokepoint, so it is gated INLINE here (not by the generic
        // wrapper) from the SAME single `methodSnapshot` that self-recorded the
        // effect and pins the wire below — the gate's read/write class can never
        // diverge from what is sent. A mutating verb (non GET/HEAD/OPTIONS) under
        // an ON flag in the foreground awaits a user approval AT THE EFFECT before
        // the egress; deny throws (the wire call is skipped). GET/HEAD/OPTIONS are
        // reads and never prompt; flag OFF (default) is a pass-through. Placed
        // AFTER the capability + SSRF gates so only an egress that would actually
        // happen can prompt. Origin-only target (no path/query that can carry tokens).
        //
        // Flag-OFF short-circuit BEFORE the approval await: when
        // `hostClassifiesRisk` is OFF, the gate is skipped entirely. The
        // synchronous incarnation recheck remains mandatory because upstream
        // capability/SSRF validation can itself cross async boundaries.
        if (hostClassifiesRiskEnabled()) {
          await gateMutatingEffect({
            pluginId,
            methodPath: "hostFetch",
            effect: methodEffect(methodSnapshot),
            target: effectTarget,
            approvalGate,
            flagEnabled: hostClassifiesRiskEnabled,
          });
        }
        assertActiveHostApi(pluginId, hostIncarnation, "hostApi.hostFetch");
        // The host-observed effect for this egress was recorded above from the
        // SAME verb snapshot that drives `decision` and pins the wire below, so
        // the recorded effect == decision.effect == the wire verb (no divergence).
        incrementHostSecretCounter("hostFetch_egress", pluginId, "egress");
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "tool_call",
            input: `[plugin:${pluginId}] host_fetch ${url.origin} method=${decision.method} effect=${decision.effect}`,
          });
        } catch { /* audit must not break host */ }
        // redirect:"error" — a plugin egress path must not silently follow
        // cross-origin redirects (mirrors the host LLM/auth fetch posture).
        // method PINNED to the snapshot: `restInit` excludes the original
        // `method` getter, so the wire verb is the single-read primitive, never a
        // re-read of a live (possibly stateful) getter.
        return networkFetch(url.toString(), {
          ...restInit,
          method: methodSnapshot,
          redirect: "error",
        });
      },
      logEvent: (level, message, data) => {
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: level === "error" ? "error" : "tool_call",
            input: `[plugin:${pluginId}] [${level.toUpperCase()}] ${message}`,
            output: data === undefined ? undefined : JSON.stringify(data).slice(0, 500),
          });
        } catch (err) {
          log.warn(`logEvent failed: %s`, (err as Error).message);
        }
      },
      onShutdown: (handler) => {
        const registration = { pluginId, handler };
        pluginShutdownHandlers.push(registration);
        hostIncarnation.registerDisposer(() => {
          const index = pluginShutdownHandlers.indexOf(registration);
          if (index >= 0) pluginShutdownHandlers.splice(index, 1);
        });
      },
      // ─── Host-mediated worker spawn ───────────────────────────────────
      // HOST PRIMITIVE — Tool.workerId producer is intentionally NOT wired here.
      // Exposes the host's spawnWorker on the per-plugin hostApi surface with
      // `pluginId` bound from THIS hostApi instance (a plugin can never name
      // another plugin's namespace). A future host-routed tool producer must
      // prove that its call path actually uses this worker before setting
      // Tool.workerId; a plugin-self-claimed worker id is advisory only (#885 v6
      // removed the manifest field — normalize drops any legacy `workerId`).
      spawnWorker: async (workerSpec) => {
        const worker = await spawnWorker({ ...workerSpec, pluginId });
        if (!hostIncarnation.isActive()) {
          worker.stop();
          throw new Error(
            `[plugin:${pluginId}] hostApi.spawnWorker: plugin instance is no longer active`,
          );
        }
        return bindWorkerHandle(worker);
      },
      // ─── §B3 External URL viewer + host public preference read ─────────
      // openExternalUrl: follows the Settings → webView.preferredFlow toggle:
      //   "in-app"  → light BrowserWindow (link-window-service)
      //   "system-browser" → shell.openExternal
      // Reads from settingsService on every call so live updates are reflected.
      //
      // getAppPreference: only HOST_PUBLIC_PREFERENCE_KEYS allowlist reads are allowed.
      //   Denied keys return undefined instead of throwing and warn once per key/session.
      openExternalUrl: async (url: string): Promise<void> => {
        await routeExternalUrl({
          url,
          pluginId,
          settingsService,
          bootAuditLogger,
          openLinkWindowService: (opts) => openLinkWindowService(mainWindow, opts),
          shellOpenExternal,
        });
      },
      getAppPreference: <T = unknown>(key: string): T | undefined => {
        return readAppPreference(pluginId, key) as T | undefined;
      },
      // ─── Corp-network presence probe ───────────────────────────────────
      // Lands the SDK `runtime/network.ts#detectViaPrivateDnsProbe` shim in
      // hostApi so plugins never reach `dns.lookup` (or a raw corp-network
      // presence probe) directly. Pure DNS race with host-side host validation
      // + timeout clamping; UX hint only, NOT a trust boundary (see the impl
      // header). Module-level dedup/no-cache/unref'd-timer semantics live in
      // private-host-probe.ts.
      //
      // Durable audit: the probe is classified `read`, so it never reaches the
      // executor's AuditLogger path — yet it is a network-adjacent oracle that
      // reveals which INTERNAL host a plugin is targeting. Record host + outcome
      // here (the host chokepoint) so operators keep a trail. The host is capped
      // to 64 chars so an attacker-controlled name cannot bloat the JSONL, and
      // the audit write is best-effort (must never break the probe).
      probePrivateHost: async (host: string, opts?: { timeoutMs?: number }): Promise<boolean> => {
        const auditHost = (typeof host === "string" ? host : String(host)).slice(0, 64);
        try {
          const resolved = await probePrivateHost(host, opts);
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "tool_call",
              input: `[plugin:${pluginId}] probe_private_host host=${auditHost} resolved=${resolved}`,
            });
          } catch { /* audit must not break host */ }
          return resolved;
        } catch (err) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "warn",
              input: `[plugin:${pluginId}] probe_private_host_rejected host=${auditHost} reason=${(err as Error).message.slice(0, 120)}`,
            });
          } catch { /* audit must not break host */ }
          throw err;
        }
      },
      // ─── External portal interactive auth (cookie collection) ──────────
      // Gated by the `external-auth-consumer` capability. Cookies are sensitive
      // assets, so calls are rejected without declarative opt-in. Both denial
      // and approval are recorded in AuditLogger.
      //
      // Logs record only origin + path. Sensitive SAML/OAuth query values
      // (SAMLRequest, code, state, session id, etc.) are excluded to avoid leaks.
      openAuthWindow: (async (opts: OpenAuthWindowBaseOptions & { returnFinalUrl?: boolean }) => {
        const safeUrlForLog = (() => {
          try {
            const parsed = new URL(opts.url);
            return `${parsed.origin}${parsed.pathname}`;
          } catch {
            return "[invalid-url]";
          }
        })();
        const cookieHostCount = Array.isArray(opts.cookieHosts) ? opts.cookieHosts.length : 0;

        if (!manifest.capabilities?.includes(CAPABILITY_EXTERNAL_AUTH_CONSUMER)) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] open_auth_window_capability_denied url=${safeUrlForLog} missingCapability=external-auth-consumer`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] capability not declared: external-auth-consumer`,
          );
        }

        log.info(
          `plugin:${pluginId} openAuthWindow url=${safeUrlForLog} cookieHostCount=${cookieHostCount}`,
        );
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "tool_call",
            input:
              `[plugin:${pluginId}] openAuthWindow ` +
              `url=${safeUrlForLog} cookieHostCount=${cookieHostCount}`,
          });
        } catch { /* audit must not break host */ }

        // Default to a per-plugin non-persistent partition. Using Electron's default
        // session would (a) share cookies across BrowserWindow instances so other
        // plugins could observe captured sessions, and (b) persist them to disk.
        // Both violate openAuthWindow's "the host does not retain sessions" principle.
        //
        // An explicitly requested persistPartition must stay inside the plugin's
        // own namespace (`persist:plugin-auth:<pluginId>` or a `:<sub>` beneath it).
        // Otherwise plugin A could request `plugin-auth:pluginB` and open a
        // cross-plugin cookie exfiltration path.
        const encodedId = encodeURIComponent(pluginId);
        const defaultPartition = `plugin-auth:${encodedId}`;
        const allowedPersistBase = `persist:${defaultPartition}`;
        const requested = opts.persistPartition;
        if (
          requested !== undefined &&
          requested !== allowedPersistBase &&
          !requested.startsWith(`${allowedPersistBase}:`)
        ) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input:
                `[plugin:${pluginId}] open_auth_window_invalid_partition ` +
                `persistPartition=${requested} allowed=${allowedPersistBase}[:<sub>]`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] openAuthWindow: persistPartition must be '${allowedPersistBase}' or '${allowedPersistBase}:<sub>'`,
          );
        }
        const effectiveOpts = requested
          ? opts
          : { ...opts, persistPartition: defaultPartition };
        return openAuthWindowService(ElectronBrowserWindow.getFocusedWindow() ?? mainWindow, effectiveOpts);
      }) as PluginHostApi["openAuthWindow"],

      // ─── Issue #649 — Auth-partition viewer ───────────────────────────
      // Opens a hardened BrowserWindow inside the *caller plugin's*
      // `persist:plugin-auth:<pluginId>` partition so a re-load of an
      // SSO-protected URL (e.g. Outlook calendar after ms-graph login)
      // does not force the user through AAD again. Same `external-auth-
      // consumer` capability gate as openAuthWindow — both surfaces grant
      // access to the plugin's auth partition cookie jar.
      //
      // The partition is computed from `pluginId` of *this* HostApi
      // instance (one HostApi per plugin per `PluginRuntime.start` call)
      // — plugins cannot reuse another plugin's cookie partition.
      openAuthPartitionViewer: async (opts: { url: string; windowTitle?: string }) => {
        const safeUrlForLog = (() => {
          try {
            const parsed = new URL(opts.url);
            return `${parsed.origin}${parsed.pathname}`;
          } catch {
            return "[invalid-url]";
          }
        })();
        if (!manifest.capabilities?.includes(CAPABILITY_EXTERNAL_AUTH_CONSUMER)) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] open_auth_partition_viewer_capability_denied url=${safeUrlForLog} missingCapability=external-auth-consumer`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] capability not declared: external-auth-consumer`,
          );
        }
        const declared = manifest.auth?.partitionDomains ?? [];
        let allowedHosts: string[];
        try {
          allowedHosts = normalizeAllowedHosts(declared);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] open_auth_partition_viewer_manifest_invalid reason=${reason}`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] openAuthPartitionViewer: manifest.auth.partitionDomains invalid (${reason})`,
          );
        }
        if (allowedHosts.length === 0) {
          throw new Error(
            `[plugin:${pluginId}] openAuthPartitionViewer: manifest.auth.partitionDomains must be a non-empty list`,
          );
        }
        return openAuthPartitionViewerService(
          ElectronBrowserWindow.getFocusedWindow() ?? mainWindow,
          {
            pluginId,
            url: opts.url,
            allowedHosts,
            windowTitle: opts.windowTitle,
            parent: ElectronBrowserWindow.getFocusedWindow() ?? mainWindow,
            audit: (event) => {
              try {
                bootAuditLogger.log({
                  timestamp: event.timestamp,
                  sessionId: "plugin",
                  type: event.type === "open_auth_partition_viewer" ? "tool_call" : "error",
                  input:
                    `[plugin:${event.pluginId}] ${event.type} ` +
                    `url=${event.url}` +
                    (event.deniedHost ? ` deniedHost=${event.deniedHost}` : "") +
                    ` allowedHosts=${event.allowedHosts.join(",")}`,
                });
              } catch { /* audit must not break host */ }
            },
          },
        );
      },

      // ─── SDK 5.6.0 — clearAuthPartition ──────────────────────────────
      // Wipe cookies / storage / cache / HTTP-auth from one of the calling
      // plugin's own `persist:plugin-auth:<pluginId>[:<sub>]` partitions.
      // Used after a user-triggered plugin sign-out so a subsequent
      // `openAuthWindow` cannot silently SSO via residual IdP cookies.
      // Capability + partition allow-list mirror `openAuthWindow`.
      clearAuthPartition: async (partition: string): Promise<void> => {
        if (!manifest.capabilities?.includes(CAPABILITY_EXTERNAL_AUTH_CONSUMER)) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] clear_auth_partition_capability_denied missingCapability=external-auth-consumer`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] capability not declared: external-auth-consumer`,
          );
        }
        if (typeof partition !== "string" || partition.length === 0) {
          throw new Error(
            `[plugin:${pluginId}] clearAuthPartition: partition must be a non-empty string`,
          );
        }
        const encodedId = encodeURIComponent(pluginId);
        const allowedPersistBase = `persist:plugin-auth:${encodedId}`;
        if (
          partition !== allowedPersistBase &&
          !partition.startsWith(`${allowedPersistBase}:`)
        ) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input:
                `[plugin:${pluginId}] clear_auth_partition_invalid_partition ` +
                `partition=${partition} allowed=${allowedPersistBase}[:<sub>]`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] clearAuthPartition: partition must be '${allowedPersistBase}' or '${allowedPersistBase}:<sub>'`,
          );
        }
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "tool_call",
            input: `[plugin:${pluginId}] clearAuthPartition partition=${partition}`,
          });
        } catch { /* audit must not break host */ }
        await clearAuthPartitionService(partition);
      },

      // ─── §8 Agent Approval — hostApi.agentApproval ────────────────────
      // Exposes the main-process ApprovalGate to plugins so they can request
      // and resolve pending approval entries from handler code (NOT from the
      // renderer-only preload bridge). approvalGate is REQUIRED at construction
      // time — there is no noop fallback. A missing gate would mean the boot
      // order is wrong, which is a programming error to surface loudly.
      //
      // §8 P0 security (issue #71):
      //   request(): verifies scope against the approved install grant, then records
      //              (requestId → pluginId + scope) in registry.
      //   respond(): verifies (a) requestId was issued by THIS plugin
      //              (b) scope is still in the approved install grant.
      //   Violations throw ApprovalOriginError (no silent fallback, §No-Fallback).
      agentApproval: {
        request: async (input: {
          toolName: string;
          args: unknown;
          reason: string;
          scope: string;
        }): Promise<ApprovalChoice> => {
          const approvedAccess = pluginRuntime.getApprovedPluginAccess(pluginId);
          const allowedScopes: string[] =
            Array.isArray(approvedAccess?.agentApprovalScopes)
              ? approvedAccess.agentApprovalScopes
              : [];
          try {
            verifyApprovalRequestScope(pluginId, input.scope, allowedScopes);
          } catch (err) {
            auditApprovalViolation(err, bootAuditLogger, pluginId, `request:${input.scope}`);
          }
          const { requestAgentApproval } = await import(
            "../../../permissions/agent-action-requester.js"
          );
          return requestAgentApproval(
            approvalGate,
            {
              toolName: input.toolName,
              args: input.args,
              reason: input.reason,
              source: "plugin",
              sourcePluginId: pluginId,
              scope: input.scope,
            },
            approvalIssuerRegistry,
          );
        },

        respond: async (
          requestId: string,
          choice: ApprovalChoice,
          nonce?: string,
          hmac?: string,
        ): Promise<void> => {
          const approvedAccess = pluginRuntime.getApprovedPluginAccess(pluginId);
          const allowedScopes: string[] =
            Array.isArray(approvedAccess?.agentApprovalScopes)
              ? approvedAccess.agentApprovalScopes
              : [];
          try {
            verifyApprovalResponder(
              approvalIssuerRegistry,
              requestId,
              pluginId,
              allowedScopes,
            );
          } catch (err) {
            auditApprovalViolation(err, bootAuditLogger, pluginId, requestId);
          }
          approvalGate.resolve(requestId, { requestId, choice, nonce, hmac });
        },
      },

      // ─── Overlay runner — hostApi.triggerConversation() ────────────────
      // Overlay runner: gate body lives in evaluateTriggerSpec() so prod
      // and tests share one implementation. On allow, the host holds the spec
      // in OverlayContext staging via IPC (fresh ConversationLoop is NOT
      // started). The user's confirm action inserts the prompt as a user
      // message into main chat via the imported_trigger mechanism.
      //
      triggerConversation: async (spec: ConversationTriggerSpec) => {
        const decision = evaluateTriggerSpec({
          spec,
          pluginId,
          capabilities: manifest.capabilities ?? [],
          dedupe: triggerConversationDedupe,
          rateLimiter: triggerConversationRateLimiter,
          denyAuditThrottle: triggerDenyAuditThrottle,
          auditLogger: bootAuditLogger,
        });

        if (decision.kind === "deny") {
          return decision.result;
        }

        // Allow path — push to renderer OverlayContext via IPC instead of
        // spawning a fresh ConversationLoop.
        const eventId = randomUUID();
        const overlayId = `plugin:${pluginId}:${eventId}`;
        const derivedSummary = deriveOverlaySummaryForDisplay(spec);
        const overlayItem = {
          id: overlayId,
          source: { kind: "plugin" as const, pluginId, eventId },
          title: spec.title ?? spec.source.replace(/^overlay:/, ""),
          summary: derivedSummary,
          running: false,
          primaryActionLabel: spec.primaryActionLabel ?? t("be_pluginRuntime.overlayPrimaryActionLabel"),
          pendingPrompt: formatPluginPendingPrompt(spec.prompt, decision.source),
          createdAt: new Date().toISOString(),
        };
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(OVERLAY_V1.show, overlayItem);
        }

        return { accepted: true, source: decision.source, eventId };
      },

      // ─── Idempotency SOT query — hostApi.hasRoutineBySource() ───────────
      // Least-privilege boolean probe scoped to the caller's own
      // `suggestion:<pluginId>:` prefix. A plugin uses this as its "propose
      // once" gate without ever seeing routine contents or another plugin's
      // routines. The prefix check is the security boundary: an out-of-prefix
      // source returns false with NO enumeration.
      hasRoutineBySource: async (source: string): Promise<boolean> => {
        if (typeof source !== "string" || source.length === 0) return false;
        const callerPrefix = `suggestion:${pluginId}:`;
        if (!source.startsWith(callerPrefix)) {
          return false;
        }
        return routinesStore.list().some((r) => r.source === source);
      },
        }),
        {
          pluginId,
          approvalGate,
          flagEnabled: hostClassifiesRiskEnabled,
          assertActive: () =>
            assertActiveHostApi(pluginId, hostIncarnation, "hostApi.approvedEffect"),
        },
      ));
  };
}
