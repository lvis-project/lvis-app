// AUTO-GENERATED — DO NOT EDIT. Regenerate via: bun run sync:from-host
//
// @lvis/plugin-sdk — type-only public surface of the LVIS plugin contract.
// This file mirrors the host plugin type contract.

export type InstallPolicy = "admin" | "user";

export interface DependencySpec {
  pluginId: string;
  versionRange?: string;
  required?: boolean;
}

export interface PluginAccessTarget {
  pluginId: string;
  tools?: string[];
  events?: string[];
}

export interface PluginAccessSpec {
  plugins: PluginAccessTarget[];
}

/**
 * Optional declarative auth contract for plugins that own their OAuth /
 * cookie / session flow but want the host to render a generic 미인증 /
 * signed-in surface in Settings → 플러그인 설정. See lvis-app
 * `architecture.md` §9.4a "Plugin-Owned OAuth — Host UI Surface".
 *
 * The three referenced tool names (`statusTool`, `loginTool`,
 * `logoutTool`) MUST also appear in `PluginManifest.uiCallable[]`;
 * the host validates this cross-field at load time. On state
 * transitions the plugin SHOULD emit `<pluginId>.auth.changed` so
 * the host UI refreshes without polling.
 */
export interface PluginAuthSpec {

  /** Human-readable label shown next to the badge (defaults to plugin `name`). @optional */
  label?: string;

  /** Name of a uiCallable tool returning {@link PluginAuthStatus}. */
  statusTool: string;

  /** Name of a uiCallable tool the host invokes when the user clicks "로그인". The plugin owns the actual auth flow (e.g. MSAL interactive, openAuthWindow). */
  loginTool: string;

  /** Optional uiCallable tool the host invokes when the user clicks "로그아웃". Omit when the plugin has no programmatic sign-out path. @optional */
  logoutTool?: string;
}

/**
 * Recommended return shape of `auth.statusTool`. Plugins MAY return
 * additional fields and the host ignores them. The host parses with a
 * strict `=== true` check on `authenticated` — values like `1` or
 * `"true"` are deliberately treated as unauthenticated to surface
 * contract drift.
 */
export interface PluginAuthStatus {
  /** Strict literal `true` when the plugin has a usable session; otherwise `false`. */
  authenticated: boolean;

  /** Optional human-readable identity (email, login id) shown next to the green badge. Display only — not a stable id. @optional */
  account?: string;
}

/**
 * Optional structured hint attached to an event subscription. Allows the host
 * to surface contextual metadata alongside the subscription.
 */
export interface EventSubscriptionHint {
  /** Broad category the event falls into. */
  category: "task" | "note" | "session" | "meeting" | "email" | "calendar" | "system";
  /** Relative importance used by the host to order or filter subscriptions. */
  priority: "high" | "medium" | "low";
  /** Short human-readable label shown in the host UI for this subscription. */
  title: string;
}

/**
 * Object form of an event subscription entry. Use when you need to attach a
 * hint to a subscription; otherwise prefer the plain string form.
 */
export interface EventSubscription {
  /** Event type name. Must match the string form used in published event declarations. */
  type: string;
  /** Optional structured hint shown by the host alongside the subscription. @optional */
  hint?: EventSubscriptionHint;
}

/**
 * Declarative metadata for a plugin. Describes the tools, capabilities, UI
 * extensions, lifecycle, and permissions a plugin exposes to the host.
 *
 * The manifest is statically parsed by the host before the plugin runtime
 * loads, so keep it free of runtime-only values. All tool names must match
 * the pattern `^[a-zA-Z_][a-zA-Z0-9_]*$` — dots and hyphens are rejected.
 *
 * @example
 * const manifest: PluginManifest = {
 *   id: "com.example.my-plugin",
 *   name: "My Plugin",
 *   version: "1.0.0",
 *   entry: "dist/index.js",
 *   tools: ["my_plugin_ping"],
 *   description: "One-line summary shown to the host LLM and in plugin catalogues.",
 * };
 */
export interface PluginManifest {

  /** Globally unique identifier. Reverse-DNS style recommended (for example `com.example.my-plugin`). Must be stable across versions. */
  id: string;
  /** Human-readable display name shown in the host UI and plugin pickers. */
  name: string;
  /** SemVer version string (for example `1.2.3`). Used by the host to detect updates and enforce compatibility. */
  version: string;
  /** Path (relative to the plugin root) to the JavaScript module whose default export is a `RuntimePluginFactory`. */
  entry: string;

  /** Tool names exposed to the host LLM. Each name must match `^[a-zA-Z_][a-zA-Z0-9_]*$` — dots and hyphens are not allowed. */
  tools: string[];

  /** One-line summary (1-280 chars) of what the plugin does. **Required** since v3.0.0 — the LLM uses this in the inactive-plugin catalogue to decide whether to surface the plugin to the user. */
  description: string;
  /** Arbitrary JSON configuration merged into `PluginRuntimeContext.config` at startup. Treat as untrusted user data. @optional */
  config?: Record<string, unknown>;
  /** Sidebar / panel UI extensions contributed by this plugin. @optional */
  ui?: PluginUiExtension[];
  /** Skill keywords registered with the host keyword engine. Each entry binds a surface keyword to a `skillId` the plugin handles. @optional */
  keywords?: Array<{ keyword: string; skillId: string }>;

  /** Free-form capability tags declared by the plugin (for example `"calendar"`, `"email"`). Hosts may gate features on these. @optional */
  capabilities?: string[];
  /** Tools that should be invoked once during plugin startup, before the first user interaction. @optional */
  startupTools?: string[];

  /** Event type names this plugin subscribes to. The host delivers matching events via `PluginHostApi.onEvent`. @optional */
  eventSubscriptions?: string[] | EventSubscription[];

  /** Tools that the UI is permitted to invoke directly (bypassing the LLM). Use sparingly — prefer LLM-mediated calls. @optional */
  uiCallable?: string[];

  /** Declarative auth contract — see {@link PluginAuthSpec}. When present, the host renders a generic 미인증 / signed-in badge + login/logout button in Settings. @optional */
  auth?: PluginAuthSpec;

  /** Event type names this plugin may emit on the host event bus. Used by the host for validation and ownership checks. @optional */
  emittedEvents?: string[];

  /** Events that should be surfaced as host notifications. Each entry names the event and maps fields of its payload to notification title and body. @optional */
  notificationEvents?: Array<{
    event: string;
    titleField?: string;
    bodyField?: string;
  }>;
  installPolicy?: InstallPolicy;
  dependencies?: Array<string | DependencySpec>;
  pluginAccess?: PluginAccessSpec;
  requires?: RequiresSpec;
  /** Display string identifying the plugin publisher (for example an organization or author). @optional */
  publisher?: string;

  /** Maximum time in milliseconds the host will wait for `RuntimePlugin.start` to resolve. Plugins exceeding this are considered failed. @optional */
  startupTimeoutMs?: number;

  /** JSON Schema descriptions of each tool's input. Used by the host to advertise tools to the LLM and to validate arguments before dispatch. Keys must appear in `tools`. @optional */
  toolSchemas?: Record<
    string,
    {
      /** LLM-facing tool description (when/what/returns). Minimum 10 characters per JSON Schema. */
      description: string;

      /** Optional stable SemVer (MAJOR.MINOR.PATCH) for this tool — §6.4 Tool versioning. Falls back to the manifest top-level `version` when omitted. @optional */
      version?: string;

      /** Stable SemVer marking the manifest version that deprecated this tool. Triggers a runtime warn on call. @optional */
      deprecatedSince?: string;

      /** Tool name that supersedes this deprecated tool — host transparently redirects calls. @optional */
      replacedBy?: string;
      inputSchema: {
        $schema?: string;
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
    }
  >;

  configSchema?: PluginConfigSchema;

  icon?: string;
  python?: {
    managedBy?: "lvis-app" | "self";
    requirementsLock?: string;
    interpreter?: string;
  };
  packageName?: string;
  /** Plugin author — individual maintainer name or contact (distinct from `publisher`). */
  author?: string;
  /** Top-level advertisement of UI slot names this plugin participates in. Marketplace metadata only — actual extension binding lives in `ui[].slot`. */
  uiSlots?: string[];
}

/**
 * §9.2 Track B — declarative settings schema. JSON Schema draft-07 subset
 * rendered as a typed form in the host's `PluginConfigTab`.
 * `format: "secret"` routes values through the encrypted keychain instead
 * of the cleartext `pluginConfigs` map.
 */
export interface PluginConfigSchema {

  /** Optional `$schema` identifier; informational only. @optional */
  $schema?: string;

  /** Property declarations keyed by config key. */
  properties: Record<string, PluginConfigSchemaProperty>;

  /** Property keys that must have a value after merging defaults + saved values. @optional */
  required?: string[];

  /** Optional escape hatch — when declared the host renders a custom React panel underneath the auto-generated form. `entry` is a path relative to the plugin root; `exportName` is the named export to mount. Use sparingly — schema fields cover the common case. @optional */
  customPanel?: { entry: string; exportName: string };
}

/** Schema for a single configuration property. */
export interface PluginConfigSchemaProperty {

  /** JSON Schema-compatible value type. */
  type: "string" | "number" | "integer" | "boolean" | "array";

  /** Short human-readable label. @optional */
  title?: string;

  /** Long-form description rendered as helper text. @optional */
  description?: string;

  /** Default value seeded into the form when no saved value exists. @optional */
  default?: unknown;

  /** Closed list of valid values (renders as Select). @optional */
  enum?: Array<string | number | boolean>;

  /** Inclusive lower bound for numeric / integer types. @optional */
  minimum?: number;

  /** Inclusive upper bound for numeric / integer types. @optional */
  maximum?: number;

  /** Minimum string length. @optional */
  minLength?: number;

  /** Maximum string length. @optional */
  maxLength?: number;

  /** Regex the string value must match. @optional */
  pattern?: string;

  /** UI/storage hint. `"secret"` routes the value through `hostApi.setSecret` / `getSecret` instead of cleartext config. `"uri"`, `"email"`, `"date-time"` enable typed inputs. @optional */
  format?: "secret" | "uri" | "email" | "date-time";

  /** Item schema for `type: "array"` properties. @optional */
  items?: { type: "string" | "number" | "integer" | "boolean"; enum?: Array<string | number | boolean> };
}

/**
 * Declaration of a UI surface contributed by a plugin. The host renders the
 * extension inside the requested slot and loads the referenced module or
 * page lazily when the surface becomes visible.
 */
export interface PluginUiExtension {
  /** Identifier unique within the plugin. Used as a stable key for persistence and host routing. */
  id: string;
  /** UI slot into which the extension is mounted. Currently only `"sidebar"` is supported. */
  slot: "sidebar";
  /**
   * Rendering strategy:
   * - `"embedded-module"` — module exporting a component mounted in-process.
   * - `"embedded-page"` — full-page HTML loaded in an isolated frame.
   * - `"info-card"` — lightweight read-only card rendered from `defaults`.
   */
  kind: "embedded-module" | "embedded-page" | "info-card";
  /** Name shown in navigation. Falls back to `title` when omitted. @optional */
  displayName?: string;
  /** Title shown at the top of the extension surface. */
  title: string;
  /** Short description shown alongside the title. @optional */
  description?: string;
  /** Default data passed to the extension on mount. For `info-card` kinds this is the rendered content. @optional */
  defaults?: Record<string, unknown>;
  /** Path (relative to the plugin root) of the module to load for `embedded-module`. @optional */
  entry?: string;
  /** Named export within `entry` to mount. Defaults to the module's default export. @optional */
  exportName?: string;
  /** Path (relative to the plugin root) of the HTML page to load for `embedded-page`. @optional */
  page?: string;

  window?: {
    defaultMode?: "embedded" | "detached";
  };
}

/**
 * Entry in the host's local plugin registry. The registry records which
 * plugins are installed, where their manifests live, and whether they are
 * currently enabled.
 *
 * Note: host-internal install-source bookkeeping (`_devLinked`,
 * `installSource`) is intentionally stripped from the SDK public surface —
 * see `stripHostInternalRegistryFields()` in `scripts/sync-from-host.mjs`.
 * Plugins should not branch on those fields.
 */
export interface PluginRegistryEntry {
  /** Plugin identifier, matching `PluginManifest.id`. */
  id: string;
  /** Absolute or host-relative filesystem path to the plugin's `manifest.json`. */
  manifestPath: string;
  /** Whether the plugin should be loaded at host startup. Defaults to `true` when omitted. @optional */
  enabled?: boolean;

  bundleRefs?: string[];
  approvedPluginAccess?: PluginAccessSpec;

}

/**
 * Persisted collection of installed plugins. Serialized to disk by the host
 * and read at boot time to determine which plugins to load.
 */
export interface PluginRegistry {
  /** Schema version of this registry file. Increment on breaking layout changes. */
  version: number;
  /** Installed plugins, in the order the host should consider them. */
  plugins: PluginRegistryEntry[];
}

export interface SignatureEnvelope {
  version: 1;

  iat: number;

  artifact_sha256: string;
  signatures: Array<{
    key_id: string;
    alg: "ed25519";

    sig: string;
  }>;
}

export interface VerifyResult {
  ok: boolean;
  key_id?: string;
  reason?: string;
}

export interface RequiresSpec {
  capabilities: string[];
}

export class MissingDependenciesError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Plugin requires capabilities not provided by installed plugins: ${missing.join(", ")}`,
    );
    this.missing = missing;
    this.name = "MissingDependenciesError";
  }
}

export type McpRuntimeSpec =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      auth?: "none" | "api-key" | "sso";
    }
  | {
      transport: "http";
      url: string;
      auth?: "none" | "api-key" | "sso";
      allowPrivateNetworks?: boolean;
    };

/**
 * Catalog entry describing a plugin available for installation through the
 * host marketplace. This is the user-facing summary of a plugin before it is
 * downloaded — not the full manifest.
 */
export interface PluginMarketplaceItem {
  /** Plugin identifier, matching the `PluginManifest.id` the plugin will declare once installed. */
  id: string;

  slug?: string;
  /** Human-readable display name. */
  name: string;
  /** Marketing description shown in the marketplace UI. */
  description: string;
  /** Installable package specifier (for example an npm spec or tarball URL) used to acquire the plugin artifact. */
  packageSpec: string;
  /** Canonical package name (for example the npm package name) used to identify updates. */
  packageName: string;
  /** Tools the plugin will expose — mirrors `PluginManifest.tools` for preview purposes. */
  tools: string[];

  version?: string;

  channel?: "stable";
  /** Default configuration seeded into the plugin on first install. Users may override this. @optional */
  defaultConfig?: Record<string, unknown>;
  /** UI extensions the plugin will contribute once installed. @optional */
  ui?: PluginUiExtension[];
  capabilities?: string[];
  keywords?: Array<{ keyword: string; skillId: string }>;
  startupTools?: string[];
  uiCallable?: string[];
  auth?: PluginAuthSpec;
  emittedEvents?: string[];
  notificationEvents?: Array<{
    event: string;
    titleField?: string;
    bodyField?: string;
  }>;
  installPolicy?: InstallPolicy;
  dependencies?: Array<string | DependencySpec>;
  pluginAccess?: PluginAccessSpec;
  /** Display string identifying the publisher. @optional */
  publisher?: string;
  toolSchemas?: PluginManifest["toolSchemas"];

  requires?: RequiresSpec;

  pluginType?: "plugin" | "mcp";

  mcpRuntime?: McpRuntimeSpec;
}

export type StorageEncoding =
  | "utf-8"
  | "utf8"
  | "ascii"
  | "base64"
  | "base64url"
  | "hex"
  | "latin1"
  | "binary";

export interface PluginStorage {

  resolve(...segments: string[]): string;

  read(relPath: string): Promise<Uint8Array>;

  readText(relPath: string, encoding?: StorageEncoding): Promise<string>;

  readJson<T = unknown>(relPath: string): Promise<T | null>;

  write(relPath: string, data: string | Uint8Array, encoding?: StorageEncoding): Promise<void>;

  writeJson<T>(relPath: string, value: T, indent?: number): Promise<void>;

  rm(relPath: string, options?: { recursive?: boolean }): Promise<void>;

  list(relPath?: string): Promise<string[]>;

  exists(relPath: string): Promise<boolean>;

  mkdir(relPath: string): Promise<void>;
}

export type PluginLifecycleEvent =
  | { type: "installed"; pluginId: string; source: "marketplace" | "local-dev" }
  | { type: "uninstalled"; pluginId: string }
  | { type: "_future"; readonly __exhaustive: never };

/**
 * Services exposed by the host to a running plugin. An instance is provided
 * on `PluginRuntimeContext.hostApi` when the host calls the plugin's
 * `RuntimePluginFactory`.
 *
 * All methods are safe to call after `RuntimePlugin.start` resolves. Treat
 * every handler returned to the host as potentially long-lived: the host may
 * keep references across the plugin's lifetime.
 */
export interface PluginHostApi {

  storage: PluginStorage;

  config: {

    get<T = unknown>(key: string): T | undefined;

    set<T = unknown>(key: string, value: T): Promise<void>;

    onChange<T = unknown>(key: string, callback: (value: T | undefined) => void): () => void;
  };
  /**
   * Register skill keywords with the host's keyword engine. When the user
   * types or says one of the registered keywords the host routes the request
   * to the associated `skillId`, which the plugin must handle via a tool
   * dispatch.
   *
   * @param keywords - Keyword/skill pairs to register. Calling again appends;
   *                   duplicate keywords are deduplicated by the host.
   * @example
   * hostApi.registerKeywords([
   *   { keyword: "weather", skillId: "forecast.today" },
   * ]);
   */
  registerKeywords(keywords: Array<{ keyword: string; skillId: string }>): void;
  /**
   * Emit a host-wide event. Other plugins subscribed to `eventType` via
   * `onEvent` receive the payload. The host also bridges events to its own
   * internal listeners.
   *
   * @param eventType - Dot-delimited event name (for example `"calendar.updated"`).
   * @param data - JSON-serializable payload. @optional
   */
  emitEvent(eventType: string, data?: unknown): void;

  /**
   * Subscribe to host events. The returned function removes the subscription
   * when invoked. Call it during `RuntimePlugin.stop` to avoid leaking
   * handlers.
   *
   * @param eventType - Event name to listen for.
   * @param handler - Invoked with the emitted payload.
   * @returns Unsubscribe function.
   */
  onEvent(eventType: string, handler: (data: unknown) => void): () => void;

  /**
   * Snapshot of plugin ids currently loaded into the host runtime, in insertion
   * (load) order. The calling plugin's own id is excluded. Treat the result as
   * a SET (`includes()`); insertion order is NOT priority and is subject to
   * change. Pair with `onPluginsChanged` to react to lifecycle.
   *
   * Capability-gated by `lifecycle-observer` in the plugin manifest (advisory
   * in v3.x — not enforced yet, but declare it to stay forward-compatible).
   *
   * @returns Plugin ids of all currently-loaded plugins except the caller.
   */
  getInstalledPluginIds(): string[];

  /**
   * Subscribe to plugin install / uninstall lifecycle events. Returns an
   * `unsubscribe()` disposer; the host also auto-clears the subscription when
   * the calling plugin is disabled.
   *
   * Fires AFTER the host has finished mounting (install) or unmounting
   * (uninstall) the subject plugin — `getInstalledPluginIds()` already
   * reflects the new state when the handler runs. Self-events (this plugin
   * being the subject) are filtered out.
   *
   * P0 only delivers `installed` and `uninstalled`. Future versions may add
   * `updated` (version bump). Handlers SHOULD branch with a `default:` to
   * stay forward-compatible.
   *
   * The `installed` event carries `source: "marketplace" | "local-dev"`.
   * Production consumers SHOULD ignore `source: "local-dev"` to avoid
   * letting a developer's local test plugin trigger downstream cascades.
   *
   * Capability-gated by `lifecycle-observer` in the plugin manifest (advisory
   * in v3.x — not enforced yet, but declare it to stay forward-compatible).
   */
  onPluginsChanged(handler: (event: PluginLifecycleEvent) => void): () => void;
  /**
   * Create a task in the host's task list.
   *
   * @param task - Task metadata. `source` identifies the originating plugin
   *               or feature; `sourceRef` is an optional stable pointer back
   *               to the originating entity (for example an email id).
   */
  addTask(task: {
    title: string;
    description?: string;
    source: string;
    sourceRef?: string;
    priority?: "high" | "medium" | "low";
  }): void;
  /**
   * Retrieve an encrypted secret previously stored by the host or the user
   * (for example an API key).
   *
   * @param key - Secret key.
   * @returns The secret value, or `null` if no secret exists for `key`.
   */
  getSecret(key: string): string | null;

  callTool<T = unknown>(toolName: string, payload?: unknown): Promise<T>;

  /**
   * Invoke the host's configured language model.
   *
   * @param prompt - User prompt string.
   * @param options.maxTokens - Upper bound on completion tokens. @optional
   * @param options.systemPrompt - System instructions prepended to the call. @optional
   * @returns The model's completion text.
   */
  callLlm(prompt: string, options?: { maxTokens?: number; systemPrompt?: string }): Promise<string>;

  /**
   * Emit a structured log entry to the host log pipeline.
   *
   * @param level - Severity.
   * @param message - Human-readable message.
   * @param data - Arbitrary structured payload. @optional
   */
  logEvent(level: "info" | "warn" | "error", message: string, data?: unknown): void;

  /**
   * Register a handler invoked when the host is shutting down. The host waits
   * for returned promises to resolve before exiting, giving the plugin a
   * chance to flush state.
   */
  onShutdown(handler: () => void | Promise<void>): void;

  openAuthWindow(options: {
    url: string;
    completionUrlPatterns: string[];
    cookieHosts: string[];
    timeoutMs?: number;
    windowTitle?: string;
    persistPartition?: string;
  }): Promise<Array<{
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    expirationDate?: number;
  }>>;

  /**
   * Start a conversation turn from a proactive plugin signal.
   *
   * Capability-gated by `conversation-trigger` in the plugin manifest; missing
   * capability returns `{ accepted: false, reason: "capability_denied" }` (no
   * exception). `spec.prompt` MUST be a templated, plugin-owned message — NOT
   * raw third-party content (mail body, transcript). `spec.source` MUST match
   * `^proactive:[a-z][a-z0-9-]*$`.
   */
  triggerConversation(spec: ConversationTriggerSpec): Promise<ConversationTriggerResult>;
}

/** Spec for `PluginHostApi.triggerConversation()`. */
export interface ConversationTriggerSpec {

  /** Templated, plugin-owned message. NEVER raw third-party content (mail body, transcript). Recorded into audit. */
  prompt: string;

  /** Origin tag. Must match `^proactive:[a-z][a-z0-9-]*$`. */
  source: string;

  /** Audit-only side-channel. NOT plumbed into the conversation loop — embed any ID needed by the LLM or tools in `prompt` instead. @optional */
  context?: Record<string, unknown>;

  /** UI mode: `silent` / `summary-only` (default) / `user-visible`. P0 treats all three identically. @optional */
  visibility?: "silent" | "summary-only" | "user-visible";

  /** Queueing hint when multiple triggers compete. Audit-only in P0. @optional */
  priority?: "low" | "normal" | "high";

  /** Suppress duplicate triggers for the same observation; dedupe window enforced by host. @optional */
  dedupeKey?: string;
}

/** Outcome of `PluginHostApi.triggerConversation()`. */
export interface ConversationTriggerResult {

  /** Whether the trigger was accepted for execution. */
  accepted: boolean;

  /**
   * Cause when `accepted` is `false`:
   *  - `capability_denied` — plugin lacks `conversation-trigger`.
   *  - `invalid_source` — `source` does not match `^proactive:[a-z][a-z0-9-]*$`, or `prompt` empty/oversized.
   *  - `duplicate` — `dedupeKey` matched a recent trigger.
   *  - `rate_limited` — per-plugin call cap exceeded.
   *  - `loop_unavailable` — ConversationLoop not yet bound at boot.
   *
   * @optional
   */
  reason?:
    | "capability_denied"
    | "invalid_source"
    | "duplicate"
    | "rate_limited"
    | "loop_unavailable";

  /** Echoed from the request so callers can correlate logs. */
  source: string;
}

/**
 * Execution context supplied by the host when instantiating a plugin through
 * its `RuntimePluginFactory`. The context gives the plugin access to its
 * configuration, its filesystem roots, a scoped logger, and the full host
 * API.
 */
export interface PluginRuntimeContext {
  /** Plugin identifier, matching `PluginManifest.id`. */
  pluginId: string;
  /** Absolute filesystem path to the plugin's installed root directory. Safe for the plugin to read from. */
  pluginRoot: string;
  /** Absolute filesystem path to the host's working directory. Plugins should avoid writing here directly. */
  hostRoot: string;

  pluginDataDir: string;
  /** Merged configuration (manifest defaults + user overrides) for this plugin instance. @optional */
  config?: Record<string, unknown>;
  /**
   * Scoped logger that prefixes entries with the plugin id. Prefer this over
   * `console.*` so host log routing and filtering work correctly.
   */
  log: (message: string, meta?: unknown) => void;
  /** Host services exposed to the plugin. */
  hostApi: PluginHostApi;
}

/**
 * Function signature for a tool or method exposed by a plugin. The handler
 * receives the tool's invocation payload (already validated against the
 * tool's JSON Schema, if declared) and returns a result that the host
 * serializes back to the caller.
 *
 * Handlers may be synchronous or asynchronous. Thrown errors are surfaced
 * to the caller as tool errors.
 */
export type PluginToolHandler = (payload?: unknown) => Promise<unknown> | unknown;

/**
 * Runtime object produced by a `RuntimePluginFactory`. Exposes lifecycle
 * hooks and the map of tool handlers the host can dispatch to.
 */
export interface RuntimePlugin {
  /** Invoked once after construction. Perform asynchronous setup here (opening connections, restoring state, etc.). @optional */
  start?: () => Promise<void> | void;
  /** Invoked during host shutdown or plugin unload. Release resources and flush state. @optional */
  stop?: () => Promise<void> | void;
  /**
   * Map of tool name to handler. Keys must match entries in
   * `PluginManifest.tools`. The host rejects calls to missing handlers.
   */
  handlers: Record<string, PluginToolHandler>;
}

/**
 * Factory function exported (as default) from a plugin's `entry` module.
 * The host invokes the factory once with a `PluginRuntimeContext` and
 * expects a `RuntimePlugin` (possibly asynchronously).
 *
 * @example
 * const factory: RuntimePluginFactory = async (ctx) => ({
 *   async start() { ctx.log("ready"); },
 *   handlers: {
 *     my_plugin_ping: async () => ({ ok: true }),
 *   },
 * });
 * export default factory;
 */
export type RuntimePluginFactory = (context: PluginRuntimeContext) => Promise<RuntimePlugin> | RuntimePlugin;
