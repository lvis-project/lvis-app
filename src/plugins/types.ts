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

export type PluginToolCategory = "read" | "write" | "shell" | "network";

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
  /**
   * Whether the auth window is rendered visibly. Default `true` for
   * interactive logins (the user must see + interact with the IdP page).
   * Set to `false` for silent-SSO warmups where the page is expected to
   * complete via residual IdP cookies in `persistPartition` and never
   * requires user input — the BrowserWindow still loads + harvests
   * cookies + emits navigation events but is never shown.
   *
   * `show: false` MUST pair with an explicit `timeoutMs` so a hidden
   * SSO challenge (captcha, MFA prompt) cannot hang the warmup forever
   * invisible to the user.
   *
   * @default true
   * @since SDK 5.6.0
   */
  show?: boolean;
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

/**
 * Marketplace install preflight metadata. The host does NOT auto-install
 * declared dependencies (issue #92, 2026-05).
 *
 * - `required: true` (default — `required` 누락 object 와 legacy
 *   string-form `"<pluginId>"` 모두 `normalizeDependencies` 가 동일
 *   의미로 정규화): the referenced plugin MUST already be installed
 *   when this plugin is installed, otherwise marketplace install
 *   throws `MissingPluginDependenciesError` and aborts.
 * - `required: false`: informational only. Install proceeds even if
 *   the referenced plugin is absent; the consumer plugin MUST
 *   runtime-degrade its feature surface (e.g. detector idle, tool
 *   returns `{status:'<dep>_unavailable'}` envelope) when the dep is
 *   missing.
 *
 * Cross-plugin tool/event access is governed separately via
 * `PluginAccessSpec` — prefer `dependencies: [{ pluginId, required: false }]`
 * paired with `pluginAccess.plugins[]` for soft cross-plugin integration.
 */
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
  /**
   * Hostname allow-list (suffix-match) for `hostApi.openAuthPartitionViewer`.
   * Required when the plugin calls that method — host rejects calls if this
   * field is missing or the target URL host falls outside the list.
   *
   * Each entry must contain at least one dot; wildcards, single-label hosts,
   * bare public-suffix entries (`com`, `co.kr`, …), and IDN-punycode labels
   * (`xn--*`) are refused at manifest load time. Up to 16 entries. Suffix
   * match is dot-boundary (`outlook.office.com` allows
   * `mail.outlook.office.com` but not `outlook.office.com.attacker.com`).
   *
   * See `docs/references/plugin-tool-schema-design.md` §2.4.1 for the full
   * contract (rejection table, three-layer defense, ms-graph example).
   */
  partitionDomains?: string[];
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
  /** 플러그인 고유 식별자. 도트(`.`) 형식 권장: `com.example.meeting-recorder`. */
  id: string;
  name: string;
  version: string;
  entry: string;
  /**
   * LLM에 노출되는 도구 이름 배열. `^[a-zA-Z_][a-zA-Z0-9_]*$` 필수 — 도트/하이픈 금지.
   * UI 전용 runtime method는 여기에 넣지 말고 `uiCallable[]`에만 선언한다.
   */
  tools: string[];
  /** 플러그인 한 줄 설명 — LLM 카탈로그 및 UI에 표시. MUST 필드. */
  description: string;
  config?: Record<string, unknown>;
  ui?: PluginUiExtension[];
  keywords?: Array<{ keyword: string; skillId: string }>;
  /**
   * 플러그인이 요구/제공하는 capability 태그. 정책·UI·게이팅에 사용되며
   * kebab-case 컨벤션을 따른다.
   *
   * 현재 사용 중인 capability:
   * - `meeting-recorder` — 실시간 음성 캡처 및 STT
   * - `mail-source` — 이메일 소스 연결
   * - `calendar-source` — 캘린더 소스 연결
   * - `background-watcher` — 플러그인 자체 lifecycle (`start()` hook) 에서 백그라운드 폴러/감시자 기동
   * - `worker-client` — 외부 프로세스(Python 등) 워커 래퍼
   * - `knowledge-index` — 문서 인덱스/검색 기능 제공
   * - `ms-graph-consumer` — Microsoft Graph 를 사용하는 플러그인의 자기-식별
   *   라벨 (advisory). Host 측 provider-auth HostApi 메서드는 없으므로
   *   강제할 게이트가 없다. §9.4a "Plugin-Owned OAuth Authentication" 참고.
   */
  capabilities?: string[];
  /**
   * 플러그인이 구독하는 이벤트 타입 목록.
   * 두 가지 형태를 모두 지원한다:
   *   - 구형 호환: `string[]` — 호스트가 중립 fallback hint를 적용.
   *   - 신형: `{ type: string; hint?: EventSubscriptionHint }[]` — 플러그인이 hint 메타데이터를 직접 선언.
   */
  eventSubscriptions?: string[] | EventSubscription[];
  /**
   * UI가 ipcRenderer 를 통해 직접 호출할 수 있는 plugin method 의 allowlist.
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
   * bypassFocusGate (#843): true 일 경우 활성 LVIS 윈도우가 있어도 OS 알림이
   * 그대로 뜬다. 중요 surface (`meeting.starting-soon`,
   * `approval.deadline-imminent`, `incident.page`) 에만 true. 기본 false.
   */
  notificationEvents?: Array<{
    event: string;
    titleField?: string;
    bodyField?: string;
    bypassFocusGate?: boolean;
  }>;
  installPolicy?: InstallPolicy;
  dependencies?: Array<string | DependencySpec>;
  pluginAccess?: PluginAccessSpec;
  requires?: RequiresSpec;
  publisher?: string;
  /**
   * Optional hard startup timeout (ms, positive integer).
   * When declared, PluginRuntime enforces a `Promise.race`-based timeout on
   * the plugin's `start()` call — the running task is NOT cancelled
   * (no AbortController is wired through); the host simply drops the slow
   * plugin fail-soft while leaving other plugins untouched. When absent, the
   * runtime still emits a slow-plugin warning after a default threshold
   * (5000ms).
   */
  startupTimeoutMs?: number;
  /**
   * LLM이 도구를 호출할 때 사용하는 JSON Schema (draft-07)와
   * 권한 정책 메타데이터. 키: tool 이름 (tools 배열 내 값과 동일).
   * UI 전용 runtime method는 `toolSchemas`에 넣지 않는다.
   */
  toolSchemas?: Record<
    string,
    {
      description: string;
      /** Permission category declared by the SDK manifest schema. `meta` is host-only. */
      category: PluginToolCategory;
      /** Filesystem argument names that must be checked against allowed directories. */
      pathFields?: string[];
      /**
       * Issue #664 P1 — sandbox-write self-attestation. When true AND the
       * runtime verifies that every resolved `pathFields` value stays
       * inside the owning plugin's sandbox root
       * (`~/.lvis/plugins/<pluginId>/`), the reviewer auto-LOWs the
       * verdict so plugins can write to their own data dir without
       * round-tripping the user. The runtime still verifies path
       * containment — a tool that declares the flag but emits an
       * out-of-sandbox path falls back to the normal write rules.
       */
      writesToOwnSandbox?: boolean;
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
  /**
   * Optional short text (1-4 chars) rendered in place of a Lucide icon — e.g.
   * `"EP"`, `"MTG"`. Takes precedence over `icon` when both are declared.
   * Use when no Lucide glyph matches the plugin's domain identity.
   */
  iconText?: string;
  /**
   * #893 — Declarative allowlist of host-owned secret keys this plugin is
   * allowed to read via `hostApi.getSecret(key)`. The runtime gate matches
   * the requested key against `hostSecrets.read[]` (`audit.log` on
   * allow + deny) and currently only accepts entries shaped
   * `llm.apiKey.<vendor>` — enforced both here at manifest load time and
   * by the SDK JSON-schema so plugins can't grant themselves wildcard
   * access by shipping an older SDK build.
   *
   * Keys outside the namespace are rejected at manifest load
   * (`manifest_schema` reason) so a misconfigured plugin never reaches the
   * runtime gate. A plugin's own `plugin.<id>.*` namespace remains
   * always-allowed and does NOT need an entry here.
   */
  hostSecrets?: {
    /** Allowlisted secret keys this plugin can read via `hostApi.getSecret`. */
    read?: string[];
  };
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
  kind: "embedded-module" | "embedded-page" | "info-card" | "action";
  displayName?: string;
  title: string;
  description?: string;
  defaults?: Record<string, unknown>;
  entry?: string;
  exportName?: string;
  page?: string;
  /**
   * kind="action" 전용. 플러그인 패널 아이콘 클릭 시 host 가 직접 디스패치할
   * plugin tool 이름. action entry 는 panel webview 를 *생성하지 않고*
   * 곧바로 `api.callPluginMethod(tool)` 만 호출한다. tool 은 manifest의
   * `uiCallable[]` 에 등록되어야 하며, runtime/index.ts 의 callFromUi
   * 게이트가 그대로 enforce 한다.
   */
  tool?: string;
  /**
   * Detached window defaults. `defaultMode: "detached"` opens the extension
   * in a magnetic-snap BrowserWindow instead of rendering it inline.
   * Width/height values are initial defaults; saved user bounds still win.
   */
  window?: {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    resizable?: boolean;
    alwaysOnTop?: boolean;
    defaultMode?: "embedded" | "detached";
  };
}

export interface PluginRegistryEntry {
  id: string;
  manifestPath: string;
  /**
   * Canonical JSON SHA-256 of plugin.json recorded at install time. Runtime
   * HostApi gates compare the running manifest against this host-owned value
   * before honoring admin secret-access bypasses.
   */
  manifestSha256?: string;
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
 * Thrown by marketplace install preflight when a plugin declares
 * `dependencies[].required = true` and the referenced plugin id is not
 * present in the installed registry. `required: false` entries are
 * informational — the host does NOT auto-install dependencies (issue #92),
 * the consumer plugin must degrade its feature surface when a soft
 * dependency is absent.
 */
export class MissingPluginDependenciesError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Plugin requires the following plugins to be installed first: ${missing.join(", ")}`,
    );
    this.missing = missing;
    this.name = "MissingPluginDependenciesError";
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
      /** Safe env var name that receives the user-supplied apiKey at launch. */
      apiKeyEnv?: string;
    }
  | {
      transport: "http";
      url: string;
      auth?: "none" | "api-key" | "sso" | "oauth";
      /** Safe header name that receives the user-supplied apiKey on requests. */
      apiKeyHeader?: string;
      allowPrivateNetworks?: boolean;
      oauth?: McpOAuthMetadata;
    };

export interface McpOAuthMetadata {
  /** RFC 8707 resource identifier for the target MCP server. */
  resource?: string;
  /** RFC 9728 protected resource metadata URL, when advertised by the server/catalog. */
  resourceMetadataUrl?: string;
  /** Authorization server issuers discovered from protected resource metadata. */
  authorizationServers?: string[];
  /** Initial least-privilege scopes requested for this MCP server. */
  scopes?: string[];
  clientRegistration?: "client-id-metadata-document" | "dynamic" | "preregistration" | "manual";
}

export interface McpAuthMetadata extends McpOAuthMetadata {
  mode: "none" | "api-key" | "sso" | "oauth";
  transport?: "stdio" | "http";
}

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
  /** SHA-256 of the latest stable marketplace artifact. Used to invalidate stale same-version cache entries. */
  artifactSha256?: string;
  /** S8 — release channel. "stable" (default) or "canary". */
  channel?: "stable" | "canary";
  defaultConfig?: Record<string, unknown>;
  ui?: PluginUiExtension[];
  capabilities?: string[];
  keywords?: Array<{ keyword: string; skillId: string }>;
  uiCallable?: string[];
  auth?: PluginAuthSpec;
  emittedEvents?: string[];
  /**
   * Mirrors `PluginManifest.notificationEvents` so marketplace cards can
   * render the same field. See PluginManifest JSDoc above for semantics.
   * `bypassFocusGate` (#843) on marketplace items is informational only;
   * the runtime contract is enforced by the manifest field at install time.
   */
  notificationEvents?: Array<{
    event: string;
    titleField?: string;
    bodyField?: string;
    bypassFocusGate?: boolean;
  }>;
  installPolicy?: InstallPolicy;
  dependencies?: Array<string | DependencySpec>;
  pluginAccess?: PluginAccessSpec;
  publisher?: string;
  toolSchemas?: PluginManifest["toolSchemas"];
  /** S14: dependency capabilities this plugin requires. */
  requires?: RequiresSpec;
  /**
   * lvis-marketplace#52/#456 — catalog entries are regular plugins, MCP
   * servers, agent profiles, or skills. Defaults to `"plugin"` when the
   * server omits the field (back-compat with pre-#52 catalogs).
   */
  pluginType?: "plugin" | "mcp" | "agent" | "skill";
  /**
   * MCP runtime block — present when `pluginType === "mcp"` and the
   * server has the schema extension. The host materializes this into
   * the user's mcp-servers.json after install. The authoritative copy
   * always lives in the extracted manifest's `runtime` field; the
   * catalog row may carry a duplicate as advisory metadata.
   */
  mcpRuntime?: McpRuntimeSpec;
  /** Safe login metadata surfaced by lvis-marketplace for MCP entries. */
  mcpAuth?: McpAuthMetadata;
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
   * overlay-trigger detectors that depend on a specific plugin being installed).
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

  /**
   * #893 Stage 2 — Host-managed LLM key resolver. Mirrors the SDK's
   * `PluginHostApi.resolveApiKey` (optional, may be undefined on older host
   * builds — plugins guard with `typeof hostApi.resolveApiKey === "function"`).
   *
   * Implementation in `src/main/host-api/resolve-api-key.ts` runs the four-tier
   * gate and returns the SDK's discriminated union (`ResolveApiKeyResult`).
   * The host interface accepts a structurally compatible shape so the SDK
   * import stays optional at the type level — callers receive the same
   * `ok: true | false` discriminator either way.
   */
  resolveApiKey?(opts: {
    purpose: "llm" | "stt" | "embedding" | "vision";
    vendor?: "openai" | "azure-openai" | "vertex" | "anthropic";
    signal?: AbortSignal;
  }): Promise<
    | {
        ok: true;
        vendor: string;
        bearer: () => string;
        baseUrl?: string;
        release: () => void;
      }
    | {
        ok: false;
        reason:
          | "no-host-vendor"
          | "vendor-mismatch"
          | "not-whitelisted"
          | "user-mode-plugin"
          | "aborted"
          | "user-endpoint-with-host-key";
      }
  >;

  // Plugin-owned OAuth keeps provider-specific auth inside plugins; the host
  // exposes only generic HostApi surfaces.
  callTool<T = unknown>(toolName: string, payload?: unknown): Promise<T>;

  // ─── LLM 접근 (선제성 기능용) ────────────────────────────────────────
  /**
   * 호스트 LLM 프로바이더를 통한 텍스트 생성.
   * 플러그인이 직접 LLM 키를 관리하지 않고도 인텔리전트 기능 구현 가능.
   * LLM이 준비되지 않은 경우 에러를 던진다.
   */
  callLlm(prompt: string, options?: { maxTokens?: number; systemPrompt?: string; signal?: AbortSignal }): Promise<string>;
  /**
   * Host-mediated outbound HTTPS through Electron's `net` (Chromium network
   * stack). Unlike a plugin's own Node `fetch`/undici, this honors the OS proxy
   * resolution INCLUDING PAC/WPAD auto-config and the OS trust store on every
   * platform — so a plugin whose Node libraries can't be configured for the
   * corporate proxy/CA (e.g. MSAL) can still reach the network on a
   * TLS-inspecting corporate network. Capability-gated (external-auth-consumer)
   * + SSRF-validated + audited host-side.
   *
   * OPTIONAL: undefined on host builds that predate this capability — plugins
   * MUST guard (`typeof hostApi.hostFetch === "function"`) and fall back to bare
   * fetch, mirroring `resolveApiKey?`.
   */
  hostFetch?(input: string | URL, init?: RequestInit): Promise<Response>;

  /**
   * Structured log event routed through AuditLogger.
   * Automatically tagged with `plugin:${pluginId}` context (sessionId = "plugin").
   */
  logEvent(level: "info" | "warn" | "error", message: string, data?: unknown): void;

  /**
   * Register a handler fired before app shutdown (Electron
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
   * Open a hardened viewer BrowserWindow that loads `url` inside the
   * caller plugin's `persist:plugin-auth:<pluginId>` partition. The
   * existing cookies in that partition (typically deposited by an
   * earlier `openAuthWindow` IdP flow) make the load silent-SSO — no
   * re-login.
   *
   * **Caller binding:** the partition is decided by the host from the
   * plugin id of the HostApi instance — plugins cannot name a different
   * plugin's partition. Cross-plugin chaining must go through `callTool`
   * to a tool owned by the partition-owning plugin (the target tool's
   * handler receives that plugin's HostApi instance and so opens the
   * viewer in the right partition).
   *
   * **Allow-list:** `url` host must match `manifest.auth.partitionDomains`
   * (dot-boundary suffix). Navigation outside the allow-list is canceled
   * (`will-navigate` + `will-redirect` + `setWindowOpenHandler: deny`).
   * Downloads from the partition session are canceled. Cookies are never
   * read back into plugin code.
   *
   * **Capability gate:** `manifest.capabilities[]` must include
   * `external-auth-consumer`. Shared with `openAuthWindow` because both
   * surfaces grant access to the same plugin auth partition cookie jar.
   *
   * Resolves once the window has loaded or been closed; rejects only on a
   * hard load failure (not on user close).
   *
   * **Required (not `?`-optional)** unlike `openExternalUrl?` /
   * `showOverlay?` / `getAppPreference?`. Convention: HostApi methods are
   * declared required when the SDK + host wiring land in the same release
   * window (lockstep shipping); methods are declared optional only when
   * the SDK legitimately ships ahead of host adoption. Declaring this
   * method required forces plugins to call it directly — a missing host
   * wiring throws loudly at runtime instead of being silently optional-
   * chained, matching CLAUDE.md "No Fallback Code" + the security
   * "fail-closed" principle (silent fallback could route the user to a
   * less-protected window).
   */
  openAuthPartitionViewer(opts: {
    url: string;
    windowTitle?: string;
  }): Promise<void>;

  /**
   * Wipe all credential state (cookies, storage, cache, HTTP-auth, NTLM/
   * Kerberos credentials) from a `persist:plugin-auth:<pluginId>[:<sub>]`
   * partition. Use after a user-triggered sign-out so subsequent
   * `openAuthWindow` calls against the same partition cannot silently
   * SSO via residual IdP cookies — without this, plugin "sign out"
   * only clears the plugin's in-memory + on-disk shadow state while the
   * host Chromium keeps the federated session alive.
   *
   * **Allow-list:** the `partition` argument must equal
   * `persist:plugin-auth:<pluginId>` or `persist:plugin-auth:<pluginId>:<sub>`
   * for the calling plugin. The host rejects any other partition string.
   * Direct cross-plugin partition wipes are not allowed.
   *
   * **Capability gate:** `manifest.capabilities[]` must include
   * `external-auth-consumer` (same gate as `openAuthWindow`).
   *
   * **Required (not `?`-optional)** — declared in lockstep with SDK
   * `@lvis/plugin-sdk@5.6.0`. Plugin authors get a typed signature; a
   * missing host wiring throws loudly. Matches the "No Fallback Code"
   * rule (CLAUDE.md) — silent optional-chain would let sign-out look
   * successful while leaving the partition populated.
   */
  clearAuthPartition(partition: string): Promise<void>;

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
   * Overlay trigger — ask the host to stage a plugin-authored suggestion in
   * the overlay. The plugin does not start a conversation turn; only a user's
   * overlay confirmation imports the prompt into the normal chat loop.
   *
   * Capability gate: `host:overlay`. The plugin's manifest must declare it;
   * otherwise the host returns `{ accepted: false, reason:
   * "capability_denied" }`. Callers should branch on `accepted` rather than
   * expecting an exception for this condition.
   *
   * Safety contract — caller MUST follow:
   * - `prompt` is a templated message, NOT raw third-party content (mail body,
   *   attachment text, etc.). The host has no way to validate this; injecting
   *   raw bodies makes prompt-injection trivial. Pass IDs in `context` and let
   *   the loop fetch raw content via tools.
   * - `source` MUST start with `overlay:` to keep the source-aware
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
   * Usage pattern:
   *   await context.hostApi.agentApproval.respond(approvalId, choice, nonce, hmac)
   */
  /**
   * Overlay extensibility — show an overlay card from a plugin.
   * Returns an OverlayHandle with a dismiss() disposer.
   * `host:overlay` capability must be declared in manifest.capabilities[].
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
     * The gate generates nonce + HMAC internally (confused-deputy defense).
     * Plugin MUST NOT compute nonce/HMAC.
     *
     * `scope` must be present in the host-approved install grant
     * (`approvedPluginAccess.agentApprovalScopes`), not merely in the manifest.
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
     * Nonce + hmac MUST be echoed back verbatim as issued by the host with
     * the original ApprovalRequest — the gate re-verifies them before honoring
     * the decision. A mismatch forces deny-once (confused-deputy defense).
     *
     * §8 P0 security: host verifies (a) requestId was issued by this plugin,
     * (b) scope is still in the host-approved install grant. Violations throw.
     *
     * NOTE: a `list()` method was deliberately NOT exposed. Listing pending
     * approvals from a plugin would surface gate-issued nonces/HMACs (confused-deputy
     * material) to plugin code with no current use case.
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
  | "allow-session"
  | "allow-always"
  | "deny-once"
  | "deny-always";

/**
 * Spec for `hostApi.triggerConversation()`. Passed by a plugin when it decides
 * a signal warrants staging a host overlay suggestion.
 */
export interface ConversationTriggerSpec {
  /** Templated message — NEVER raw third-party content. See safety contract. */
  prompt: string;
  /** Origin tag, must start with `overlay:` (e.g. `overlay:meeting-detection`). */
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
   * Current limitation: all three values currently produce identical UI
   * behaviour; the field is recorded into audit only.
   */
  visibility?: "silent" | "summary-only" | "user-visible";
  /** Routing hint for queueing when multiple triggers compete (audit-only today). */
  priority?: "low" | "normal" | "high";
  /** Suppress duplicate triggers for the same observation (window enforced by host). */
  dedupeKey?: string;
  /**
   * Overlay Runner — display title for the OverlayCard.
   * Defaults to the source tag with the `overlay:` prefix stripped.
   */
  title?: string;
  /**
   * Overlay Runner — one-line summary shown in the OverlayCard body.
   * Defaults to the first 200 chars of `prompt`.
   */
  summary?: string;
  /**
   * Overlay Runner — label for the OverlayCard primary action button.
   * Defaults to "확인하기" (host-level generic). Plugins targeting a
   * specific user intent (e.g. mail reply) may override per-detector
   * (예: `"답장하기"`).
   */
  primaryActionLabel?: string;
}

export interface ConversationTriggerResult {
  /** Whether the trigger was accepted for execution. */
  accepted: boolean;
  /**
   * When `accepted=false`, why:
   *   `capability_denied` — plugin lacks `host:overlay`.
   *   `invalid_source`    — `source` does not match `^overlay:[a-z][a-z0-9-]*$`,
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
   * Overlay Runner — present when `accepted=true` and the trigger was
   * staged as an OverlayItem instead of starting a fresh ConversationLoop.
   * Callers can use this to correlate the overlay item (e.g. for dismiss).
   */
  eventId?: string;
}

/**
 * Canonical alias for the tool-handler function type exposed
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
