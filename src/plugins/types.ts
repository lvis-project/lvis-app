export type InstallPolicy = "admin" | "user";

/**
 * Single source of truth for how a registry entry arrived on this device.
 * Supersedes the legacy combination of `installedBy` + `_devLinked`.
 *
 * - "admin"     — installPolicy="admin" manifest, via marketplace or installLocal
 * - "user"      — marketplace install triggered by the end user
 * - "local-dev" — installLocal (Settings UI "로컬 폴더에서 설치") with user policy, dev-mode only
 *
 * The pre-2026-05 `"dev-link"` value (created by the now-removed
 * `bun run dev:link`) is no longer accepted. Existing registries with
 * `installSource: "dev-link"` are migrated to `"local-dev"` on read with
 * a loud audit warning — see `readPluginRegistry`.
 */
export type PluginRegistryEntryInstallSource = "admin" | "user" | "local-dev";

export type AuthWindowCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
};

export type OpenAuthWindowBaseOptions = {
  url: string;
  completionUrlPatterns: string[];
  cookieHosts: string[];
  timeoutMs?: number;
  windowTitle?: string;
  persistPartition?: string;
};

export type OpenAuthWindowWithFinalUrlOptions = OpenAuthWindowBaseOptions & {
  returnFinalUrl: true;
};

export type OpenAuthWindowCookieOptions = OpenAuthWindowBaseOptions & {
  returnFinalUrl?: false | undefined;
};

export type OpenAuthWindowFinalUrlResult = {
  cookies: AuthWindowCookie[];
  finalUrl: string;
};

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
  /**
   * §8 P0 security — approval action scopes this plugin is permitted to
   * issue via `requestAgentApproval()` / `hostApi.agentApproval.respond()`.
   *
   * Defaults to empty array (no approval scopes allowed) when omitted.
   * The host verifies at respond-time that the issuer's declared scopes
   * include the scope recorded at request-time — violations throw
   * ApprovalOriginError (no silent fallback).
   *
   * Known scopes: "agent_file_share", "agent_task_delegate", "agent_external_api_call"
   */
  agentApprovalScopes?: string[];
}

/**
 * Declarative auth contract for plugins that own their OAuth/cookie/session
 * flow but want the host to render a generic 미인증 / signed-in surface in
 * Settings → 플러그인 설정. See architecture.md §9.4a "Plugin-Owned OAuth —
 * Host UI Surface" and `manifest.auth` schema description.
 */
export interface PluginAuthSpec {
  /** Human-readable label shown next to the badge (defaults to plugin `name`). */
  label?: string;
  /** uiCallable tool returning {@link PluginAuthStatus}. */
  statusTool: string;
  /** uiCallable tool the host invokes when the user clicks 로그인. */
  loginTool: string;
  /** Optional uiCallable tool the host invokes when the user clicks 로그아웃. */
  logoutTool?: string;
}

/**
 * Recommended return shape of `auth.statusTool`. Host parses with a strict
 * identity check: `result?.authenticated === true`. Plugins MUST return the
 * literal boolean `true` — truthy values such as `1` or the string `"true"`
 * are NOT accepted (string `"false"` is truthy in JS and would be
 * misclassified by `Boolean()`). Account is read as a string when present.
 * The shape is documented but not AJV-validated in v1 — outputSchema
 * validation is a separate cross-cutting change. Plugins MAY return
 * additional fields; the host ignores them.
 */
export interface PluginAuthStatus {
  authenticated: boolean;
  /** Human-readable identity (email, login id) shown next to the green badge. */
  account?: string;
}

export interface EventSubscriptionHint {
  category: "task" | "note" | "session" | "meeting" | "email" | "calendar" | "system";
  priority: "high" | "medium" | "low";
  title: string;
}

export interface EventSubscription {
  type: string;
  hint?: EventSubscriptionHint;
}


export interface PluginManifest {
  /** 플러그인 고유 식별자. 도트(`.`) 형식 권장: `com.lge.meeting-recorder`. */
  id: string;
  name: string;
  version: string;
  entry: string;
  /**
   * LLM에 노출되는 도구 이름 배열. `^[a-zA-Z_][a-zA-Z0-9_]*$` 필수 — 도트/하이픈 금지.
   * 런타임이 이 값을 그대로 tool name으로 사용한다.
   */
  tools: string[];
  /** 플러그인 한 줄 설명 — LLM 카탈로그 및 UI에 표시. Phase 1 MUST 필드. */
  description: string;
  config?: Record<string, unknown>;
  ui?: PluginUiExtension[];
  keywords?: Array<{ keyword: string; skillId: string }>;
  /**
   * 플러그인이 요구/제공하는 capability 태그. 정책·UI·게이팅에 사용되며
   * kebab-case 컨벤션을 따른다.
   *
   * 현재 사용 중인 capability:
   * - `meeting-recorder` — 실시간 음성 캡처 및 STT (meeting)
   * - `mail-source` — 이메일 소스 연결 (email)
   * - `calendar-source` — 캘린더 소스 연결 (calendar)
   * - `background-watcher` — `startupTools` 로 백그라운드 폴러/감시자 기동 (ms-graph)
   * - `worker-client` — 외부 프로세스(Python 등) 워커 래퍼 (local-indexer)
   * - `knowledge-index` — 문서 인덱스/검색 기능 제공 (local-indexer)
   * - `ms-graph-consumer` — Microsoft Graph 를 사용하는 플러그인의 자기-식별
   *   라벨 (advisory). PR 3 이후 host 측 MS Graph HostApi 메서드는 모두 제거되어
   *   강제할 게이트가 없음 — ms-graph 플러그인이 자체 MSAL + safeStorage 로
   *   인증 처리. §9.4a "Plugin-Owned OAuth Authentication" 참고.
   */
  capabilities?: string[];
  startupTools?: string[];
  /**
   * 플러그인이 구독하는 이벤트 타입 목록.
   * 두 가지 형태를 모두 지원한다:
   *   - 구형 호환: `string[]` — 호스트가 중립 fallback hint를 적용.
   *   - 신형: `{ type: string; hint?: EventSubscriptionHint }[]` — 플러그인이 hint 메타데이터를 직접 선언.
   */
  eventSubscriptions?: string[] | EventSubscription[];
  /**
   * H2: UI가 ipcRenderer 를 통해 직접 호출할 수 있는 plugin method 의 allowlist.
   * 이 배열에 없는 method 는 `lvis:plugins:call` IPC 를 통해 호출할 수 없다.
   * (ConversationLoop 의 permission/scope/expansion cap 을 우회하는 경로 차단.)
   */
  uiCallable?: string[];
  /**
   * Optional declarative auth contract — see architecture.md §9.4a "Plugin-Owned
   * OAuth — Host UI Surface". Lets the host render a generic 미인증 / signed-in
   * badge + login/logout button in Settings → 플러그인 설정. The three referenced
   * tools must also appear in `uiCallable[]` (cross-validated in
   * `manifest-validation.ts`). On state transitions the plugin SHOULD emit
   * `<pluginId>.auth.changed` so the host UI can refresh without polling.
   */
  auth?: PluginAuthSpec;
  /**
   * 이 플러그인이 호스트 이벤트 버스로 emit 하는 이벤트 타입 목록.
   * classifySubscription("public") 판정을 통과한 이벤트만 renderer로 전달된다.
   * (host boundary §1: plugin-specific literals forbidden in boot.ts)
   */
  emittedEvents?: string[];
  /**
   * OS 네이티브 알림으로 표시할 이벤트 선언.
   * titleField / bodyField 는 이벤트 데이터의 점(.) 경로.
   */
  notificationEvents?: Array<{
    event: string;
    titleField?: string;
    bodyField?: string;
  }>;
  installPolicy?: InstallPolicy;
  dependencies?: Array<string | DependencySpec>;
  pluginAccess?: PluginAccessSpec;
  requires?: RequiresSpec;
  publisher?: string;
  /**
   * Sprint 1-A A1 — optional hard startup timeout (ms, positive integer).
   * When declared, PluginRuntime enforces a `Promise.race`-based timeout on
   * the plugin's `start()` call — the running task is NOT cancelled
   * (no AbortController is wired through); the host simply drops the slow
   * plugin fail-soft while leaving other plugins untouched. When absent, the
   * runtime still emits a slow-plugin warning after a default threshold
   * (5000ms).
   */
  startupTimeoutMs?: number;
  /**
   * LLM이 도구를 호출할 때 사용하는 JSON Schema (draft-07).
   * 키: tool 이름 (tools 배열 내 값과 동일), 값: { description, inputSchema }
   */
  toolSchemas?: Record<
    string,
    {
      description: string;
      /**
       * Permission category used by the host executor. Omitted categories
       * are treated as "write" at registration time so plugin tools fail
       * closed until authors declare read-only intent explicitly.
       */
      category?: "read" | "write" | "dangerous";
      /**
       * §6.4 Tool versioning — optional semver string for this tool. When
       * omitted, the plugin manifest's top-level `version` is used as the
       * tool version so plugins that ship tools in lock-step with their
       * release don't need to repeat themselves.
       */
      version?: string;
      /** §6.4 — semver string marking deprecation; triggers runtime warn. */
      deprecatedSince?: string;
      /** §6.4 — name of the replacement tool (transparent redirect). */
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

  /**
   * §9.2 Track B — declarative settings schema. When present, the host
   * renders a typed configuration form in `PluginConfigTab` (string →
   * TextInput, number → NumberInput, boolean → Switch, enum → Select,
   * array of strings → TagInput, `format: "secret"` → masked SecretInput
   * that lands in the encrypted keychain — never in cleartext
   * `pluginConfigs`). Plugins without `configSchema` keep the legacy raw
   * key/value editor (back-compat).
   */
  configSchema?: PluginConfigSchema;
  /**
   * Optional Lucide icon name for the plugin grid UI. When present, the host
   * dynamically looks up the named icon from `lucide-react` and renders it as
   * a monochrome stroke icon in the plugin grid popover. Falls back to `Plug`
   * when omitted or when the name doesn't match any Lucide export.
   *
   * Example values: `"Mic"`, `"FileText"`, `"Share2"`.
   * Full list: https://lucide.dev/icons/
   */
  icon?: string;
}

/**
 * §9.2 Track B — declarative settings schema. JSON Schema draft-07 subset
 * (the same dialect already used by `toolSchemas` at line 113-136 above)
 * with one UI/storage hint: `format: "secret"` routes the field through
 * `hostApi.setSecret` / `getSecret` so the cleartext `pluginConfigs`
 * record never sees the value.
 */
export interface PluginConfigSchema {
  /** Optional `$schema` identifier; informational only. @optional */
  $schema?: string;
  /** Property declarations keyed by config key. */
  properties: Record<string, PluginConfigSchemaProperty>;
  /** Property keys that must have a value after merging defaults + saved values. @optional */
  required?: string[];
  /**
   * Optional escape hatch — when declared, the host renders a custom React
   * panel underneath the auto-generated form. `entry` is a path relative
   * to the plugin root; `exportName` is the named export to mount. The
   * panel runs inside the same UI Slot System as `manifest.ui[]` (§9.3).
   * Use sparingly — schema fields cover the common case.
   * @optional
   */
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
  /** Default value used when the saved config has no entry for this key. @optional */
  default?: unknown;
  /** Closed list of allowed values; renders a select. @optional */
  enum?: Array<string | number | boolean>;
  /** Minimum value (`number` / `integer`). @optional */
  minimum?: number;
  /** Maximum value (`number` / `integer`). @optional */
  maximum?: number;
  /** Minimum string length (`string`). @optional */
  minLength?: number;
  /** Maximum string length (`string`). @optional */
  maxLength?: number;
  /** Regex pattern (`string`). @optional */
  pattern?: string;
  /**
   * UI/storage hint:
   * - `"secret"` → masked input; saved via `hostApi.setSecret(plugin.<id>.<key>)`
   *   into `lvis-secrets.json` (Electron `safeStorage`). Never written to
   *   cleartext `settings.pluginConfigs`. Plugins read via `hostApi.getSecret`.
   * - other formats are advisory and rendered as plain inputs today.
   * @optional
   */
  format?: "secret" | "uri" | "email" | "date-time";
  /** Item schema when `type === "array"`. Only string-item arrays are auto-rendered as a tag input. @optional */
  items?: { type: "string" | "number" | "integer" | "boolean"; enum?: Array<string | number | boolean> };
}

export interface PluginUiExtension {
  id: string;
  slot: "sidebar";
  kind: "embedded-module" | "embedded-page" | "info-card";
  displayName?: string;
  title: string;
  description?: string;
  defaults?: Record<string, unknown>;
  entry?: string;
  exportName?: string;
  page?: string;
  /**
   * Window placement preference. When `defaultMode` is `"detached"` the host
   * opens the extension in a magnetic-snap BrowserWindow on sidebar click
   * instead of rendering it inline. Omitting this field or setting
   * `"embedded"` preserves the existing behaviour.
   */
  window?: {
    defaultMode?: "embedded" | "detached";
  };
}

export interface PluginRegistryEntry {
  id: string;
  manifestPath: string;
  enabled?: boolean;
  bundleRefs?: string[];
  approvedPluginAccess?: PluginAccessSpec;
  installSource?: PluginRegistryEntryInstallSource;
}

export interface PluginRegistry {
  version: number;
  plugins: PluginRegistryEntry[];
}

/**
 * S2 — Signature envelope sidecar served by `/api/v1/plugins/{slug}/download.sig`.
 * Matches the server's §0.1 dual-sign format.
 */
export interface SignatureEnvelope {
  version: 1;
  /** Unix seconds. Used for clock-skew guard + revocation. */
  iat: number;
  /** Hex-encoded SHA-256 of the tarball bytes. */
  artifact_sha256: string;
  signatures: Array<{
    key_id: string;
    alg: "ed25519";
    /** Base64-encoded raw 64-byte signature. */
    sig: string;
  }>;
}

/** S2 — result of verifying a {@link SignatureEnvelope} against a tarball. */
export interface VerifyResult {
  ok: boolean;
  key_id?: string;
  reason?: string;
}

/**
 * S14 — dependency specification extracted from plugin manifest's `requires` block.
 * Capabilities are kebab-case tags matching `^[a-z][a-z0-9-]*$`.
 */
export interface RequiresSpec {
  capabilities: string[];
}

/**
 * S14 — thrown by marketplace install preflight when required capabilities
 * are not satisfied by currently-installed plugins.
 */
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

/**
 * Mirror of the `runtime` block from `mcp.schema.json` (lvis-marketplace#52).
 * Two transport branches; tokens in `args` (`$PLUGIN_DIR`, `$PYTHON`, `$NODE`)
 * are substituted by the host at install time.
 */
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

export interface PluginMarketplaceItem {
  id: string;
  /** Web marketplace slug — used when installing via lvis:// URI from the web catalog. */
  slug?: string;
  name: string;
  description: string;
  packageSpec: string;
  packageName: string;
  tools: string[];
  /** Latest stable version string (semver). Present in remote catalog; may be absent in local mock. */
  version?: string;
  /** S8 — release channel. "stable" (default) or "canary". */
  channel?: "stable" | "canary";
  defaultConfig?: Record<string, unknown>;
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
  publisher?: string;
  toolSchemas?: PluginManifest["toolSchemas"];
  /** S14: dependency capabilities this plugin requires. */
  requires?: RequiresSpec;
  /**
   * lvis-marketplace#52 — catalog entries are either a regular plugin or
   * an MCP server. Defaults to `"plugin"` when the server omits the field
   * (back-compat with pre-#52 catalogs).
   */
  pluginType?: "plugin" | "mcp";
  /**
   * MCP runtime block — present when `pluginType === "mcp"` and the
   * server has the schema extension. The host materializes this into
   * the user's mcp-servers.json after install. The authoritative copy
   * always lives in the extracted manifest's `runtime` field; the
   * catalog row may carry a duplicate as advisory metadata.
   */
  mcpRuntime?: McpRuntimeSpec;
}

/**
 * Error thrown by every `PluginStorage` method when a path violates the
 * sandbox rules: absolute paths, lexical `..` escapes, and symlinks whose
 * realpath escapes `pluginDataDir` (including dangling symlinks whose target
 * cannot be verified). Plugin authors writing TypeScript can branch on this
 * class via `instanceof`:
 *
 * ```ts
 * try {
 *   await ctx.hostApi.storage.write(rel, data);
 * } catch (err) {
 *   if (err instanceof PluginStorageError) {
 *     // err.pluginId, err.attemptedPath available for diagnostics
 *   }
 * }
 * ```
 *
 * `name` is always `"PluginStorageError"` for plugins that prefer string
 * matching across realm boundaries.
 */
export class PluginStorageError extends Error {
  readonly pluginId: string;
  readonly attemptedPath: string;
  constructor(message: string, pluginId: string, attemptedPath: string) {
    super(`[plugin-storage:${pluginId}] ${message}: ${attemptedPath}`);
    this.name = "PluginStorageError";
    this.pluginId = pluginId;
    this.attemptedPath = attemptedPath;
  }
}

/**
 * Supported text encodings for PluginStorage read/write operations.
 * Defined explicitly to avoid leaking @types/node into the SDK public surface.
 */
export type StorageEncoding =
  | "utf-8"
  | "utf8"
  | "ascii"
  | "base64"
  | "base64url"
  | "hex"
  | "latin1"
  | "binary";

/**
 * Sandboxed storage rooted at `pluginDataDir`. All paths are resolved relative
 * to that root. Path traversal via `..`, absolute paths, and symlinks
 * escaping the root via realpath checks are rejected with `PluginStorageError`
 * (exported from this module — plugin authors can `instanceof`-check it).
 *
 * The realpath check walks up from the resolved target until it finds an
 * existing entry, then verifies that entry's canonical path stays inside the
 * root — this catches both "reads through a symlink that points outside" and
 * "writes whose closest existing ancestor is a symlink that points outside".
 * Dangling symlinks (probe lstat = symlink, realpath ENOENT) are rejected
 * conservatively because the host cannot validate where they would resolve to.
 *
 * Plugins should prefer this over `node:fs` so the host can audit / sandbox /
 * restrict writes uniformly. Every operation throws if the resolved path
 * escapes `pluginDataDir`.
 */
export interface PluginStorage {
  /**
   * Resolve `segments` to an absolute path inside the plugin's data root.
   * Throws if the resolved path escapes the root.
   */
  resolve(...segments: string[]): string;
  /** Read raw bytes; throws ENOENT if the file does not exist. */
  read(relPath: string): Promise<Uint8Array>;
  /** Read text; throws ENOENT if the file does not exist. */
  readText(relPath: string, encoding?: StorageEncoding): Promise<string>;
  /** Read + parse JSON; returns `null` on missing file, throws on bad JSON. */
  readJson<T = unknown>(relPath: string): Promise<T | null>;
  /** Write bytes / text; ensures parent directories exist. */
  write(relPath: string, data: string | Uint8Array, encoding?: StorageEncoding): Promise<void>;
  /** Stringify + write JSON; ensures parent directories exist. */
  writeJson<T>(relPath: string, value: T, indent?: number): Promise<void>;
  /** Remove a file or directory tree; missing paths are ignored. */
  rm(relPath: string, options?: { recursive?: boolean }): Promise<void>;
  /** List entries in `relPath` (directories included). Empty for missing dir. */
  list(relPath?: string): Promise<string[]>;
  /** Test whether the path exists. */
  exists(relPath: string): Promise<boolean>;
  /** Ensure a directory exists (recursive mkdir). */
  mkdir(relPath: string): Promise<void>;
}

/**
 * Discriminated event delivered to `PluginHostApi.onPluginsChanged` handlers.
 * `source: "local-dev"` indicates the install came from the dev-mode
 * "Settings → 로컬 폴더에서 설치" path (LVIS_DEV=1 only); production
 * consumers should ignore it.
 *
 * The `_future` sentinel variant is NEVER produced at runtime — it exists
 * purely to force exhaustive `switch (event.type)` consumers to add a
 * `default:` branch, so the host can add a new variant (e.g. `"updated"`
 * for version bumps) without silently breaking subscribers. Plugins that
 * narrow with `if (event.type === "installed") ... else if (...)` pick up
 * the same forward-compat for free.
 */
export type PluginLifecycleEvent =
  | { type: "installed"; pluginId: string; source: "marketplace" | "local-dev" }
  | { type: "uninstalled"; pluginId: string }
  | { type: "_future"; readonly __exhaustive: never };

/**
 * Payload shape for the `plugin.installed` / `plugin.uninstalled` host
 * event-bus emissions (consumed internally by `onPluginsChanged` and by
 * any host-side telemetry subscriber). Mirror of `PluginLifecycleEvent`
 * minus the `type` field — the event type lives in the event name.
 */
export type PluginLifecycleEventPayload =
  | { pluginId: string; source: "marketplace" | "local-dev" }
  | { pluginId: string };

/**
 * Host API — 플러그인이 호스트 서비스에 접근하는 인터페이스.
 * 플러그인 제거 시 해당 플러그인이 등록한 모든 것이 자동 정리된다.
 */
export interface PluginHostApi {
  /**
   * Sandboxed filesystem API scoped to this plugin's `pluginDataDir`. Plugins
   * SHOULD prefer this over `node:fs` so the host can audit/restrict writes
   * uniformly. Direct `node:fs` use is still possible but bypasses sandbox
   * protections and is subject to future deprecation.
   */
  storage: PluginStorage;
  /**
   * §9.2 Track B — typed access to this plugin's saved config. Reads return
   * the merged `manifest.config` defaults + saved overrides, scoped strictly
   * to the calling plugin's id (plugin A cannot read plugin B's config).
   * Writes persist via the same `setPluginConfig` IPC bridge used by the
   * settings UI and trigger a plugin reload so handlers see the new values
   * on next tool call. `format: "secret"` schema entries are rejected from
   * `set()` — secrets MUST go through `hostApi.setSecret` so they land in
   * the encrypted keychain, never in cleartext `pluginConfigs`.
   */
  config: {
    /** Read a single config key. Returns `undefined` when unset. */
    get<T = unknown>(key: string): T | undefined;
    /**
     * Persist a config key. Triggers a plugin reload so the new value is
     * visible to the plugin on next handler invocation.
     */
    set<T = unknown>(key: string, value: T): Promise<void>;
    /**
     * Subscribe to changes for a single key. Returns an `unsubscribe()`
     * disposer. The subscription is scoped to the caller's pluginId — a
     * change in plugin A cannot fire plugin B's listener.
     */
    onChange<T = unknown>(key: string, callback: (value: T | undefined) => void): () => void;
  };
  registerKeywords(keywords: Array<{ keyword: string; skillId: string }>): void;
  emitEvent(eventType: string, data?: unknown): void;
  /**
   * Subscribes to a host event. Returns an `unsubscribe()` disposer so callers
   * (and PluginRuntime.onDisable) can clean up handlers deterministically.
   */
  onEvent(eventType: string, handler: (data: unknown) => void): () => void;
  /**
   * Snapshot of plugin IDs currently loaded into the runtime, in load order.
   * The calling plugin's own id is excluded. Order is insertion-stable but
   * MUST NOT be treated as priority — use `.includes(id)` for membership
   * checks. Pair with `onPluginsChanged` to react to plugin lifecycle (e.g.
   * proactive detectors that depend on a specific plugin being installed).
   */
  getInstalledPluginIds(): string[];
  /**
   * Subscribe to plugin install / uninstall events. Returns an `unsubscribe()`
   * disposer (also cleared automatically on plugin disable).
   *
   * Fires AFTER the host has finished mounting (install) or unmounting
   * (uninstall) the plugin — `getInstalledPluginIds()` already reflects the
   * new state when the handler runs. Self-events (this plugin being the
   * subject) are filtered out.
   *
   * P0 only delivers `installed` / `uninstalled`. Future versions may add
   * `updated` (version bump) — handlers should branch with a `default:` to
   * stay forward-compatible.
   *
   * `source` distinguishes marketplace install from local-dev install
   * (LVIS_DEV=1 + Settings → 로컬 폴더에서 설치). Production consumers
   * SHOULD ignore `source: "local-dev"` events to avoid letting a local
   * test plugin trigger downstream cascades against marketplace expectations.
   */
  onPluginsChanged(handler: (event: PluginLifecycleEvent) => void): () => void;
  getSecret(key: string): string | null;

  // PR 3 이후: Microsoft Graph 인증은 ms-graph 플러그인이 자체 소유한다.
  // host 측 HostApi 메서드 (getMsGraphToken, startMsGraphAuth, signOutMsGraph,
  // withMsGraphRetry 등) 는 모두 제거됨. ms-graph plugin 은 자체 MSAL 인스턴스 +
  // safeStorage 토큰 캐시 + loopback HTTP redirect 로 직접 처리.
  callTool<T = unknown>(toolName: string, payload?: unknown): Promise<T>;

  // ─── LLM 접근 (선제성 기능용) ────────────────────────────────────────
  /**
   * 호스트 LLM 프로바이더를 통한 텍스트 생성.
   * 플러그인이 직접 LLM 키를 관리하지 않고도 인텔리전트 기능 구현 가능.
   * LLM이 준비되지 않은 경우 에러를 던진다.
   */
  callLlm(prompt: string, options?: { maxTokens?: number; systemPrompt?: string }): Promise<string>;

  /**
   * Sprint 1-A A3 — structured log event routed through AuditLogger.
   * Automatically tagged with `plugin:${pluginId}` context (sessionId = "plugin").
   */
  logEvent(level: "info" | "warn" | "error", message: string, data?: unknown): void;

  /**
   * Sprint 1-A A3 — register a handler fired before app shutdown (Electron
   * `before-quit`). Host enforces a 5s timeout on each handler; slow handlers
   * are logged but do not block quit.
   */
  onShutdown(handler: () => void | Promise<void>): void;
  // ─── 외부 포털 interactive 인증 (쿠키 수집) ──────────────────────────
  /**
   * Electron BrowserWindow로 외부 포털 로그인 페이지를 띄우고,
   * 사용자가 직접 로그인 완료한 시점(`completionUrlPatterns` 매칭)의 쿠키를 수집.
   *
   * Selenium/webdriver 없이 Electron 내장 Chromium을 사용한다.
   * 반환된 쿠키는 플러그인이 직접 HTTP 요청에 싣는다 — 호스트가 세션을 보관하지 않는다.
   *
   * **완료 URL 매칭 규칙:** 호스트는 현재 URL 의 `origin + pathname` 에 대해서만
   * `completionUrlPatterns` substring 매칭을 수행한다. query / hash 는 제외되므로
   * IdP 가 `RelayState=.../portal.example.com/` 같은 파라미터로 목적지를 담아 와도
   * IdP 도메인에 있는 동안에는 "완료" 로 오인하지 않는다.
   *
   * **Capability gate:** `manifest.capabilities[]` 에 `external-auth-consumer`
   * 선언 필수.
   *
   * **Session partition:** `persistPartition` 미지정 시 호스트가 plugin 별
   * 비영속 partition (`plugin-auth:${encodeURIComponent(pluginId)}`) 을 주입한다.
   * 플러그인이 영속 partition 을 요청하려면 자기 네임스페이스 안에서만 가능 —
   * `persist:plugin-auth:${encodeURIComponent(pluginId)}` 또는 그 하위 suffix
   * (`persist:plugin-auth:${encodeURIComponent(pluginId)}:<sub>`) 만 허용된다.
   * 다른 값은 runtime 에서 거부된다 (cross-plugin 쿠키 탈취 방지).
   *
   * §6.1 "3+ 플러그인 규칙" 예외 #2 (보안·감사 통제 필요)로 정당화 — 외부 포털 쿠키
   * 수집은 민감 자산 취급이므로 단일 플러그인 사용처여도 HostApi에서 제공한다.
   */
  openAuthWindow(options: OpenAuthWindowWithFinalUrlOptions): Promise<OpenAuthWindowFinalUrlResult>;
  openAuthWindow(options: OpenAuthWindowCookieOptions): Promise<AuthWindowCookie[]>;

  /**
   * §B3 — Open an arbitrary external URL routed through the host's webView
   * preference policy (`settings.webView.preferredFlow`):
   *   - `"in-app"` → host opens a lightweight BrowserWindow (no cookieHosts /
   *     completionUrlPatterns enforcement; this is *not* `openAuthWindow`).
   *   - `"system-browser"` → host shells out to the OS default browser via
   *     Electron's `shell.openExternal`.
   *
   * The policy is read fresh from `settingsService` on every call so users can
   * toggle the preference live (no plugin reload required).
   *
   * Plugins SHOULD use this for "view this link" affordances (calendar webLink,
   * help docs, etc.) instead of calling `shell.openExternal` directly — that
   * bypasses the user's stated preference and breaks the §B1 toggle.
   */
  openExternalUrl?(url: string): Promise<void>;

  /**
   * §B3 — Read a host-level user preference exposed via the explicit
   * `HOST_PUBLIC_PREFERENCE_KEYS` allowlist (currently only
   * `"webView.preferredFlow"`).
   *
   * Returns `undefined` for unknown / non-allowlisted keys — never throws —
   * so plugins can safely probe forward-compat keys. The host emits a single
   * warn log per (pluginId, key, session) pair when a non-allowlisted key is
   * requested, to aid auditing without flooding logs.
   *
   * This is deliberately read-only and narrow: secrets, plugin configs, and
   * private host state stay invisible. To expose a new key, edit
   * `HOST_PUBLIC_PREFERENCE_KEYS` in `boot/steps/plugin-runtime.ts` and the
   * matching reader in this method's implementation — both must be updated.
   */
  getAppPreference?<T = unknown>(key: string): T | undefined;

  /**
   * Proactive Brain — start a host ConversationLoop turn from a plugin-observed
   * signal. Unlike chat which is user-initiated, this lets a (read-only)
   * "brain" plugin make LVIS speak first when an event warrants action
   * (e.g., a meeting-request mail arrives).
   *
   * Capability gate: `conversation-trigger`. The plugin's manifest must
   * declare it; otherwise the host returns `{ accepted: false, reason:
   * "capability_denied" }`. Callers should branch on `accepted` rather than
   * expecting an exception for this condition.
   *
   * Safety contract — caller MUST follow:
   * - `prompt` is a templated message, NOT raw third-party content (mail body,
   *   attachment text, etc.). The host has no way to validate this; injecting
   *   raw bodies makes prompt-injection trivial. Pass IDs in `context` and let
   *   the loop fetch raw content via tools.
   * - `source` MUST start with `proactive:` to keep the source-aware
   *   permission model (§6.3) able to enforce per-origin policies.
   * - `dedupeKey` should be set when the same observation can fire multiple
   *   times (e.g., the same mail re-emitting events) — host will reject the
   *   second call within a short window.
   */
  triggerConversation(spec: ConversationTriggerSpec): Promise<ConversationTriggerResult>;

  /**
   * §8 Agent Approval System — main-process–side approval management.
   *
   * Plugins use this namespace to interact with the host's §8 ApprovalGate
   * from the main process. This is the correct path for plugin→host approval
   * responses. The renderer-only preload bridge (`context.bridge.approval`)
   * is NOT accessible from plugin handlers running in the main process.
   *
   * Usage pattern (lvis-plugin-agent-hub decide-approval-with-host):
   *   await context.hostApi.agentApproval.respond(approvalId, choice, nonce, hmac)
   */
  /**
   * M6: Q10 overlay extensibility — show an overlay card from a plugin.
   * Returns an OverlayHandle with a dismiss() disposer.
   * Advisory: `host:overlay` capability should be declared in manifest.capabilities[].
   *
   * running=true shows spinner + "진행 중…"; false (default) shows summary + actions.
   */
  showOverlay?: (input: {
    title: string;
    summary: string;
    running?: boolean;
    primaryActionLabel?: string;
    onPrimaryAction?: () => void;
    onDismiss?: () => void;
  }) => { dismiss(): void };

  agentApproval: {
    /**
     * Request an approval via the §8 ApprovalGate on behalf of this plugin.
     *
     * Records (requestId → issuerPluginId + scope) in the host's
     * ApprovalIssuerRegistry BEFORE calling the gate, so the respond path
     * can verify cross-plugin hijack and scope violations.
     *
     * The gate generates nonce + HMAC internally (§D2 confused-deputy defense).
     * Plugin MUST NOT compute nonce/HMAC.
     *
     * `scope` must be declared in `manifest.pluginAccess.agentApprovalScopes`.
     */
    request(input: {
      toolName: string;
      args: unknown;
      reason: string;
      scope: string;
    }): Promise<ApprovalChoice>;
    /**
     * Resolve a pending ApprovalGate entry from the main process.
     *
     * Equivalent to `approvalGate.resolve(requestId, { requestId, choice, nonce, hmac })`.
     * §D2: nonce + hmac MUST be echoed back verbatim as issued by the host with
     * the original ApprovalRequest — the gate re-verifies them before honoring
     * the decision. A mismatch forces deny-once (confused-deputy defense).
     *
     * §8 P0 security: host verifies (a) requestId was issued by this plugin,
     * (b) scope is in manifest.pluginAccess.agentApprovalScopes. Violations throw.
     *
     * NOTE: a `list()` method was deliberately NOT exposed. Listing pending
     * approvals from a plugin would surface gate-issued nonces/HMACs (§D2
     * confused-deputy material) to plugin code with no current use case.
     * If a future flow legitimately needs the snapshot, add it then with a
     * scoped capability — do not pre-expose dead surface.
     */
    respond(requestId: string, choice: ApprovalChoice, nonce?: string, hmac?: string): Promise<void>;
  };
}

/**
 * §8 ApprovalChoice — mirrors `approval-gate.ts` ApprovalChoice.
 * Duplicated here so the plugin SDK surface does not need to import
 * from `permissions/approval-gate.ts` directly.
 */
export type ApprovalChoice =
  | "allow-once"
  | "allow-always"
  | "deny-once"
  | "deny-always";

/**
 * Spec for `hostApi.triggerConversation()`. Passed by a brain plugin when it
 * decides a signal warrants starting a conversation.
 */
export interface ConversationTriggerSpec {
  /** Templated message — NEVER raw third-party content. See safety contract. */
  prompt: string;
  /** Origin tag, must start with `proactive:` (e.g. `proactive:meeting-detection`). */
  source: string;
  /**
   * Side-channel metadata (IDs, references) recorded with the trigger.
   *
   * **Current limitation:** the host records `context` only into the
   * audit chain — the ConversationLoop pipeline (system-prompt builder,
   * tools, history) does NOT receive it. Plugins that need the LLM/tools
   * to act on an ID (e.g., `emailId`) MUST embed the ID in `prompt`
   * itself so it survives the trip into the loop. The field is kept on
   * the spec so future plumbing is non-breaking.
   */
  context?: Record<string, unknown>;
  /**
   * UI behaviour:
   * - `silent`         — run without surfacing to the user; only audit + result tools.
   * - `summary-only`   — show one-line completion notice (default).
   * - `user-visible`   — surface as if the user opened a turn, modal-style.
   *
   * **P0 limitation:** all three values currently produce identical UI
   * behaviour — the field is recorded into audit only. P2 will add the
   * actual UI branching.
   */
  visibility?: "silent" | "summary-only" | "user-visible";
  /** Routing hint for queueing when multiple triggers compete (audit-only in P0). */
  priority?: "low" | "normal" | "high";
  /** Suppress duplicate triggers for the same observation (window enforced by host). */
  dedupeKey?: string;
  /**
   * Q11 Overlay Runner — display title for the OverlayCard.
   * Defaults to the source tag with the `proactive:` prefix stripped.
   */
  title?: string;
  /**
   * Q11 Overlay Runner — one-line summary shown in the OverlayCard body.
   * Defaults to the first 200 chars of `prompt`.
   */
  summary?: string;
  /**
   * Q11 Overlay Runner — label for the OverlayCard primary action button.
   * Defaults to "지금 답하기".
   */
  primaryActionLabel?: string;
}

export interface ConversationTriggerResult {
  /** Whether the trigger was accepted for execution. */
  accepted: boolean;
  /**
   * When `accepted=false`, why:
   *   `capability_denied` — plugin lacks `conversation-trigger` or `host:overlay`.
   *   `invalid_source`    — `source` does not match `^proactive:[a-z][a-z0-9-]*$`,
   *                         `prompt` empty, or other shape problem.
   *   `duplicate`         — `dedupeKey` matched a recent trigger.
   *   `rate_limited`      — per-plugin call cap exceeded (sliding window).
   *   `loop_unavailable`  — ConversationLoop not yet bound (boot ordering, legacy).
   */
  reason?:
    | "capability_denied"
    | "invalid_source"
    | "duplicate"
    | "rate_limited"
    | "loop_unavailable";
  /** Echoed back so callers can correlate logs across plugin/host. */
  source: string;
  /**
   * Q11 Overlay Runner — present when `accepted=true` and the trigger was
   * staged as an OverlayItem instead of starting a fresh ConversationLoop.
   * Callers can use this to correlate the overlay item (e.g. for dismiss).
   */
  eventId?: string;
}

/**
 * Sprint 1-A A2 — canonical alias for the tool-handler function type exposed
 * through `@lvis/plugin-sdk`. Kept identical to `PluginToolHandler` so the SDK
 * surface can evolve without breaking the existing runtime name.
 */
export type PluginMethodHandler = PluginToolHandler;

export interface PluginRuntimeContext {
  pluginId: string;
  pluginRoot: string;
  hostRoot: string;
  /**
   * Absolute filesystem path to the plugin's writable data directory at
   * `<pluginsRoot>/<pluginId>/data/`. The host creates this directory before
   * calling the plugin factory. Plugins MUST write all runtime state (sessions,
   * caches, downloaded artefacts, oauth tokens, etc.) under this path so user
   * data stays scoped to the plugin and is not mixed with the install root
   * (`pluginRoot`) which is overwritten on plugin updates.
   */
  pluginDataDir: string;
  config?: Record<string, unknown>;
  log: (message: string, meta?: unknown) => void;
  hostApi: PluginHostApi;
}

export type PluginToolHandler = (payload?: unknown) => Promise<unknown> | unknown;

export interface RuntimePlugin {
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
  handlers: Record<string, PluginToolHandler>;
}

export type RuntimePluginFactory = (context: PluginRuntimeContext) => Promise<RuntimePlugin> | RuntimePlugin;
