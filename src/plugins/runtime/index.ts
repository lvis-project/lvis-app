/**
 * PluginRuntime orchestrator.
 *
 * This class is a thin coordinator that delegates to domain modules:
 *   - manifest-validation.ts  — AJV + MUST/SHOULD checks
 *   - snapshots.ts            — readEnabledManifestSnapshots, load plan, trust boundary
 *   - sandbox.ts              — entry-path resolution, data-dir, noop HostApi
 */

import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  InstallPolicy,
  PluginAccessSpec,
  PluginAuthSpec,
  PluginConfigSchema,
  PluginHostApi,
  PluginManifest,
  PluginOnboardingSpec,
  PluginRegistryEntry,
  PluginToolHandler,
  PluginUiExtension,
  RuntimePlugin,
} from "../types.js";
import { createPluginStorage } from "../storage.js";
import type { PluginDeploymentGuard } from "../deployment-guard.js";
import { installReceiptPath } from "../plugin-install-receipt.js";
import type { HostApiGenerationScope } from "../plugin-host-effect-scope.js";
import { withResolvedPluginInstallLocks } from "../install-lifecycle.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import type { PluginInstallFailureKind } from "../../shared/plugin-install-failure.js";
import { updatePluginRegistry } from "../registry.js";
import { runWithCeiling } from "../../tools/executor-ceiling.js";
import { manifestIntegrityState } from "../../permissions/manifest-integrity.js";
import { sessionContext } from "../../engine/session-context.js";
import {
  runPluginImportWithTimeout,
  runPluginFactoryWithTimeout,
  runStartWithTimeout,
  SessionActivationTracker,
} from "./lifecycle-timeout.js";

import {
  readEnabledManifestSnapshots,
  resolveManifestLoadPlan,
} from "./snapshots.js";
import type { LoadedPlugin, ManifestLoadPlan, ManifestSnapshot } from "./types.js";
import { buildPluginCard } from "./cards.js";
import type { PluginPerfStats } from "./perf-stats.js";
import {
  assertEventEmitAccess,
  assertEventSubscribeAccess,
  assertUiActionInvokable,
} from "./access-control.js";
import {
  declaredUiInvokableMethods,
} from "./plugin-loader.js";
import type { InvocationOrigin } from "./origin-chain.js";
import { createLogger } from "../../lib/logger.js";
import { PluginRuntimeLifecycle } from "./runtime-lifecycle.js";
const log = createLogger("plugin-runtime");

/**
 * Hard cap on the HTML one {@link RuntimePlugin.readUiResource} call may return
 * (see {@link PluginRuntime.readUiResource}). An MCP App card inlines its own
 * JS/CSS, so it is legitimately large — but it is a CARD, not a payload channel:
 * bounding it keeps a runaway hook from ballooning the render path. Exported so
 * the test pins the boundary rather than re-deriving it.
 */
export const MAX_UI_RESOURCE_HTML_BYTES = 4 * 1024 * 1024;

export { runPluginFactoryWithTimeout, runPluginImportWithTimeout, runStartWithTimeout };
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
  /** Host-admitted runtime activation; never inferred from mutable live state. */
  ownerGenerationId?: string;
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

export interface PluginStartPreparationContext {
  pluginId: string;
  manifest: PluginManifest;
  manifestPath: string;
  pluginRoot: string;
  reportProgress?: (status: PluginPreparationProgressInput) => void;
}

export interface PreparedArtifactRuntimeActivationInput<T> {
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
    candidateRegistryEntry?: Readonly<
      Pick<PluginRegistryEntry, "installSource" | "manifestSha256">
    >,
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
  preparePluginStart?: (context: PluginStartPreparationContext) => Promise<void> | void | null | undefined;
}

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
    return this.withPinnedGeneration(entry.pluginId, async (projection) => {
      assertUiActionInvokable({
        method,
        pluginId: entry.pluginId,
        uiInvokable: declaredUiInvokableMethods(projection.manifest),
      });
      const handler = projection.methods.get(method);
      if (!handler) throw new Error(`Plugin method not found in active generation: ${method}`);
      this.auditLog?.("info", "plugin_ui_action_invoked", {
        pluginId: entry.pluginId,
        method,
      });
      const outcome = await runWithCeiling(
        async () => handler(payload),
        ceilingMs,
        undefined,
        method,
      );
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    });
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
      assertUiActionInvokable({
        method,
        pluginId: entry.pluginId,
        uiInvokable: declaredUiInvokableMethods(manifest),
      });
      if (!this.toolInvocationDelegate) {
        throw new Error("Plugin tool executor is not wired; UI plugin call denied");
      }
      return this.toolInvocationDelegate(method, payload, {
        origin: "ui",
        ownerPluginId: entry.pluginId,
        ownerGenerationId: generationId,
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
      assertUiActionInvokable({
        method,
        pluginId: entry.pluginId,
        uiInvokable: declaredUiInvokableMethods(manifest),
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
    expectedGenerationId?: string,
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
        const generationLifecycle = this.requireGenerationLifecycle(
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
          if (!enabled) {
            if (!generationLifecycle.getActive(canonicalPluginId)) {
              throw new Error(
                `cannot disable plugin without an active generation: ${canonicalPluginId}`,
              );
            }
            const { retirement } = await generationLifecycle.deactivateWithCommit(
              canonicalPluginId,
              persist,
            );
            this.inactivePluginIds.add(canonicalPluginId);
            this.disabledPluginIds.add(canonicalPluginId);
            retirementError = await this.captureCommittedRetirementFailure(
              canonicalPluginId,
              retirement,
              "plugin enabled-state disable",
            );
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
            const integrity = await this.verifyReceiptAndDevGuard(
              receiptPluginId,
              pluginRoot,
            );
            if (!integrity.ok) {
              throw new Error(
                `plugin re-enable receipt verification failed: ${canonicalPluginId}`,
              );
            }
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

  async callForPlugin(
    pluginId: string,
    method: string,
    payload?: unknown,
    expectedGenerationId?: string,
  ): Promise<unknown> {
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

  getPluginOperationAccountHash(pluginId: string, generationId: string): string | undefined {
    return this.pluginAccountHashes.get(`${pluginId}\0${generationId}`)?.principalHash;
  }

  /**
   * Claim publication order for any auth lifecycle invocation. Starting login
   * or logout immediately removes the current principal, so neither a failed
   * nor partial transition can retain stale write authority. The caller must
   * synchronously revoke grants for the returned hash before awaiting plugin
   * execution and pass the epoch to {@link observePluginAuthResult}.
   */
  beginPluginAuthInvocation(
    pluginId: string,
    generationId: string,
    toolName: string,
  ): {
    epoch: number;
    invalidatedAccountHash?: string;
  } | undefined {
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
    this.pluginAuthInvocationEpochs.set(key, epoch);
    if (toolName !== auth.loginTool && toolName !== auth.logoutTool) {
      return { epoch };
    }
    const invalidatedAccountHash = this.pluginAccountHashes.get(key)?.principalHash;
    this.pluginAccountHashes.delete(key);
    return invalidatedAccountHash
      ? { epoch, invalidatedAccountHash }
      : { epoch };
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
  ): { invalidatedAccountHash?: string } {
    const active = this.requireGenerationAccess("plugin auth result observation").getActive(pluginId);
    if (!active || active.generationId !== generationId) return {};
    const manifest = active.manifest;
    const auth = manifest?.auth;
    if (!auth) return {};
    const key = `${pluginId}\0${generationId}`;
    if (
      (toolName === auth.statusTool || toolName === auth.logoutTool) &&
      (
        invocationEpoch === undefined ||
        this.pluginAuthInvocationEpochs.get(key) !== invocationEpoch
      )
    ) {
      return {};
    }
    if (toolName === auth.logoutTool) {
      const invalidatedAccountHash = this.pluginAccountHashes.get(key)?.principalHash;
      this.pluginAccountHashes.delete(key);
      return invalidatedAccountHash ? { invalidatedAccountHash } : {};
    }
    if (toolName !== auth.statusTool) return {};
    const outer = result && typeof result === "object" && !Array.isArray(result)
      ? result as Record<string, unknown>
      : undefined;
    const nested = outer?.data && typeof outer.data === "object" && !Array.isArray(outer.data)
      ? outer.data as Record<string, unknown>
      : outer;
    if (nested?.authenticated !== true || typeof nested.account !== "string" || !nested.account.trim()) {
      const invalidatedAccountHash = this.pluginAccountHashes.get(key)?.principalHash;
      this.pluginAccountHashes.delete(key);
      return invalidatedAccountHash ? { invalidatedAccountHash } : {};
    }
    const identityHash = createHash("sha256")
      .update("plugin-account-identity/v1\0")
      .update(nested.account.trim().toLowerCase())
      .digest("hex");
    const existing = this.pluginAccountHashes.get(key);
    if (existing?.identityHash === identityHash) return {};
    const principalHash = createHash("sha256")
      .update("plugin-account-session/v1\0")
      .update(identityHash)
      .update("\0")
      .update(randomUUID())
      .digest("hex");
    this.pluginAccountHashes.set(key, { identityHash, principalHash });
    return existing ? { invalidatedAccountHash: existing.principalHash } : {};
  }

  clearPluginOperationAccount(pluginId: string): void {
    for (const key of this.pluginAccountHashes.keys()) {
      if (key.startsWith(`${pluginId}\0`)) this.pluginAccountHashes.delete(key);
    }
    for (const key of this.pluginAuthInvocationEpochs.keys()) {
      if (key.startsWith(`${pluginId}\0`)) this.pluginAuthInvocationEpochs.delete(key);
    }
  }

}
