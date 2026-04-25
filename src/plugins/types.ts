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
  /** 플러그인 한 줄 설명 — LLM 카탈로그 및 UI에 표시 */
  description?: string;
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
   * - `background-watcher` — `startupTools` 로 백그라운드 폴러/감시자 기동 (email, calendar)
   * - `worker-client` — 외부 프로세스(Python 등) 워커 래퍼 (pageindex)
   * - `knowledge-index` — 문서 인덱스/검색 기능 제공 (pageindex)
   * - `ms-graph-consumer` — HostApi 의 MS Graph 메서드(`getMsGraphToken`,
   *   `startMsGraphAuth`, `isMsGraphAuthenticated`, `getMsGraphAccount`,
   *   `onMsGraphAuthChange`) 사용. §9.4a 참고. (email, calendar)
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
   * 이 플러그인이 호스트 이벤트 버스로 emit 하는 이벤트 타입 목록.
   * classifySubscription("public") 판정을 통과한 이벤트만 renderer로 전달된다.
   * (host boundary §1: plugin-specific literals forbidden in boot.ts)
   */
  eventPublishes?: string[];
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
}

export interface PluginRegistryEntry {
  id: string;
  manifestPath: string;
  enabled?: boolean;
  installedBy?: InstallPolicy;
  bundleRefs?: string[];
  approvedPluginAccess?: PluginAccessSpec;
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
  eventPublishes?: string[];
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
}

/**
 * Host API — 플러그인이 호스트 서비스에 접근하는 인터페이스.
 * 플러그인 제거 시 해당 플러그인이 등록한 모든 것이 자동 정리된다.
 */
export interface PluginHostApi {
  registerKeywords(keywords: Array<{ keyword: string; skillId: string }>): void;
  emitEvent(eventType: string, data?: unknown): void;
  /**
   * Subscribes to a host event. Returns an `unsubscribe()` disposer so callers
   * (and PluginRuntime.onDisable) can clean up handlers deterministically.
   */
  onEvent(eventType: string, handler: (data: unknown) => void): () => void;
  addTask(task: {
    title: string;
    description?: string;
    source: string;
    sourceRef?: string;
    priority?: "high" | "medium" | "low";
  }): void;
  getSecret(key: string): string | null;

  // Microsoft Graph 공유 인증 (메일·캘린더 플러그인)
  getMsGraphToken(): Promise<string | null>;
  startMsGraphAuth(openBrowser: (url: string) => Promise<void>): Promise<void>;
  isMsGraphAuthenticated(): boolean;
  getMsGraphAccount(): string | null;
  onMsGraphAuthChange(handler: () => void): void;
  callTool<T = unknown>(toolName: string, payload?: unknown): Promise<T>;

  /**
   * Sprint 4-D T1: 한 번만 401 재시도를 수행하는 Graph API 호출 래퍼.
   * 플러그인 (calendar/email) 에서 모든 Graph 호출을 이 함수로 감싼다.
   * 내부적으로 `getMsGraphToken()` 을 사용하며, 호스트의 silent refresh 와
   * 결합되어 토큰 만료 중 in-flight 요청이 자동 복구된다.
   *
   * @throws MsGraphAuthRequiredError 재인증 필요 시
   * @throws 그 외 `fn` 이 던진 에러 (401 두 번이면 원래 에러 재던짐)
   */
  withMsGraphRetry<T>(fn: (token: string) => Promise<T>): Promise<T>;

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
   * IdP 가 `RelayState=.../newep.lge.com/` 같은 파라미터로 목적지를 담아 와도
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
