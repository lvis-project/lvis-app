/**
 * Plugin Deployment Mode — §9.6
 *
 * 상세 설계: lvis-app/docs/architecture/plugin-deployment-model.md
 *
 * - **managed**: 회사(LGE IT)가 원격으로 배포/업데이트/삭제 제어.
 *   사용자는 UI에서 제거·비활성화 불가 (PluginDeploymentGuard가 차단).
 *   정책 서명 검증 필수 (Phase 3+).
 *
 * - **user**: 사용자가 자율적으로 설치. 회사 정책(userInstallPolicy)에 따라
 *   allow / deny / allowlist / denylist / ask로 제어.
 *
 * Backward compatibility: `deployment` 필드가 없는 기존 매니페스트는 "user"로 해석.
 */
export type DeploymentMode = "managed" | "user";

export interface PluginIpcBinding {
  /** IPC channel name exposed by host (legacy compatibility path). */
  channel: string;
  /** Plugin method name to call. Must be present in `methods`. */
  method: string;
  /** Optional payload field names for positional IPC args. */
  args?: string[];
}

// ─── Plugin Tool Schema (§9 v1.2) ──────────────────────────────────────────

export type ToolExecutionType = "command" | "subagent" | "background";

export type PluginIsolationMode = "inline" | "worker" | "process";

/**
 * Capability-based permission scope for PluginHostApi RPC enforcement.
 * Format mirrors Paperclip's manifest capabilities pattern.
 * PermissionManager enforces these at HostApi call time (P2 implementation).
 */
export type CapabilityScope =
  | `audio.${"capture" | "playback"}`
  | `fs.${"read" | "write"}:${string}`
  | `http.outbound:${string}`
  | "llm.invoke"
  | "llm.embed"
  | "ipc.emit"
  | "ipc.subscribe";

export interface PluginToolAnnotations {
  /** Read-only tool — AgentApproval can auto-approve (MCP 2025-06-18) */
  readOnlyHint?: boolean;
  /** Destructive operation — requires explicit user approval */
  destructiveHint?: boolean;
  /** Idempotent — safe to retry */
  idempotentHint?: boolean;
  /** May contact external systems outside declared scope (MCP 2025-06-18) */
  openWorldHint?: boolean;
}

export interface PluginToolExample {
  description?: string;
  input: unknown;
  output?: unknown;
}

export interface PluginSubagentSpec {
  /** System prompt for the spawned sub-agent */
  systemPrompt: string;
  /** Tool names the sub-agent may call (scoped view via ToolRegistry.createScopedView) */
  allowedTools?: string[];
  /** Max conversation turns (default 8, max 50) */
  maxTurns?: number;
  /** Model to use — "inherit" (default) uses parent's provider */
  model?: string;
  /** JSON Schema to validate the sub-agent's final output */
  resultSchema?: object;
  /**
   * How much parent conversation history to pass to the sub-agent.
   * "none" (default): only the userMessage string.
   * "summary": extractCarryover() summary, capped at summaryCutoff chars.
   * "full": complete parent history (use with caution — token cost).
   * Ref: OpenAI Agents SDK input_filter pattern.
   */
  historyPolicy?: "none" | "summary" | "full";
  /** Max chars for historyPolicy="summary" (default 2000) */
  summaryCutoff?: number;
}

export interface PluginBackgroundSpec {
  /** Field name for the immediately-returned job ID (default "jobId") */
  jobIdField?: string;
  /** Event name emitted with progress updates */
  progressEvent?: string;
  /** Event name emitted on completion */
  completionEvent?: string;
  /** Tool name to call for cancellation */
  cancelMethod?: string;
  /**
   * Cron expression for scheduled execution (host manages the scheduler).
   * Example: "0 *\/6 * * *" (every 6 hours).
   * Ref: OpenHarness CronCreate pattern.
   */
  schedule?: string;
  /** Max simultaneous background instances (default 1, prevents schedule overlap) */
  maxConcurrent?: number;
}

export interface PluginToolDefinition {
  // ── Required ──────────────────────────────────────────────────────────────
  /** Stable identifier: [a-zA-Z_][a-zA-Z0-9_]* max 64 chars */
  name: string;
  /** LLM-optimized description: when/what/returns/when-NOT-to-use */
  description: string;
  /** Execution mode — determines which spec block is required */
  executionType: ToolExecutionType;

  // ── MCP 2025-06-18 compatible ─────────────────────────────────────────────
  /** Input JSON Schema (fallback: {payload: object}) */
  inputSchema?: object;
  /** Output JSON Schema — applies to all execution types */
  outputSchema?: object;
  /** Human-readable return value description (auto-appended to description) */
  outputDescription?: string;
  /** MCP 2025-06-18 behavior hints → PermissionManager integration */
  annotations?: PluginToolAnnotations;

  // ── LLM quality ──────────────────────────────────────────────────────────
  /** Input/output examples (auto-appended to description) */
  examples?: PluginToolExample[];

  // ── Permissions & metadata ────────────────────────────────────────────────
  /** CapabilityScope[] — PermissionManager enforces at HostApi call time (P2) */
  permissions?: string[];
  tags?: string[];
  /** Timeout in ms (default 30000) */
  timeoutMs?: number;
  /** Human-readable display name for UI slots */
  uiTitle?: string;

  // ── Execution-type-specific specs ─────────────────────────────────────────
  /** Required when executionType="subagent" */
  subagent?: PluginSubagentSpec;
  /** Required when executionType="background" */
  background?: PluginBackgroundSpec;

  // ── Isolation override ────────────────────────────────────────────────────
  /** Per-tool isolation override (takes precedence over manifest isolationMode) */
  isolationMode?: Exclude<PluginIsolationMode, "process">;
}

export interface SpawnSubagentRequest {
  systemPrompt: string;
  userMessage: string;
  allowedTools: string[];
  maxTurns?: number;
  model?: string;
  resultSchema?: object;
  historyPolicy?: "none" | "summary" | "full";
  summaryCutoff?: number;
  parentRequestId?: string;
}

export interface SpawnSubagentResult {
  output: string;
  toolCalls: number;
  stoppedBy: "complete" | "maxTurns" | "error";
  isError?: boolean;
}

export interface PluginManifest {
  /**
   * 플러그인 고유 식별자.
   *
   * 도트(`.`) 형식을 권장합니다. 예: `com.lge.meeting-recorder`, `com.lge.email`
   *
   * 이 값은 **플러그인 식별/패키지 네임스페이스**에 사용되며
   * LLM tool name과는 별개입니다 — 도트를 포함해도 됩니다.
   */
  id: string;
  name: string;
  version: string;
  entry: string;
  /**
   * LLM에 노출되는 도구 이름(tool name) 배열.
   *
  * **반드시 `^[a-zA-Z_][a-zA-Z0-9_]*$` 패턴을 만족해야 합니다 — 도트(`.`), 하이픈(`-`) 금지.**
   * OpenAI, Anthropic, Google 등 모든 LLM 제공자가 이 패턴을 강제합니다.
   *
   * 예: `["meeting_start", "meeting_stop", "meeting_transcript"]`
   *
   * 플러그인 id의 네임스페이스(도트 허용)와 혼동하지 마세요.
   * 런타임이 이 값을 그대로 tool name으로 사용하며 변환하지 않습니다.
   */
  methods: string[];
  config?: Record<string, unknown>;
  ui?: PluginUiExtension[];
  /** 플러그인이 선언하는 키워드 (§9.2). `skillId`는 `methods` 배열의 tool name과 일치해야 함 */
  keywords?: Array<{ keyword: string; skillId: string }>;
  /** 호스트가 capability 기반으로 기능을 찾을 때 사용하는 선언형 태그 */
  capabilities?: string[];
  /** 부팅 직후 자동 실행할 메서드 목록 (선언형 autostart) */
  startupMethods?: string[];
  /** 호스트가 수집해야 할 이벤트 타입 목록 (예: proactive 연동) */
  eventSubscriptions?: string[];
  /** 하드코딩 IPC 제거를 위한 채널↔메서드 바인딩 선언 */
  ipcBindings?: PluginIpcBinding[];

  /**
   * Per-method tool schema declarations (§9 v1.2).
   * Superset of `methods[]` — each entry provides LLM-optimized inputSchema,
   * outputSchema, executionType, and annotations.
   * Legacy `methods[]` entries without a matching `tools[]` entry fall back
   * to the generic {payload: object} schema.
   */
  tools?: PluginToolDefinition[];

  /**
   * Plugin process isolation mode (default "inline").
   * "inline": in-process (current behavior, 1st-party plugins).
   * "worker": Node.js worker_threads isolation (P3, 3rd-party marketplace plugins).
   * "process": child process + JSON-RPC 2.0 (P4, max isolation).
   * Ref: Paperclip plugin isolation pattern.
   */
  isolationMode?: PluginIsolationMode;

  /**
   * Allow plugin reload without app restart (P3 implementation).
   * Used by marketplace install/upgrade flow.
   * Ref: Paperclip hot reload pattern.
   */
  hotReload?: boolean;

  // ─── §9.6 Plugin Deployment Model (Phase 1.5 신규) ─────────────────

  /**
   * 배포 모드 — 기본값 "user" (backward compat).
   * "managed"는 회사 IT가 배포한 플러그인으로 사용자가 제거·비활성화할 수 없다.
   */
  deployment?: DeploymentMode;

  /** managed 배포 시 publisher 식별 (예: "LG Electronics IT") */
  publisher?: string;
  publisherId?: string;
  publishedAt?: string; // ISO 8601

  /**
   * managed 매니페스트 서명 (Phase 3부터 필수).
   * ECDSA-P256-SHA256 기준, canonicalize된 manifest body에 대한 base64 signature.
   * 검증 실패 시 플러그인 로드 거부 + CRITICAL audit.
   */
  signature?: string;
  signatureAlgorithm?: "ECDSA-P256-SHA256";

  /** 앱 버전 호환 범위 (semver) */
  minAppVersion?: string;
  maxAppVersion?: string;
}

/**
 * 런타임에서 추적하는 플러그인 배포 메타데이터.
 * 매니페스트 필드 + LVIS가 설치 시점에 기록한 정보를 결합.
 */
export interface PluginDeploymentMetadata {
  mode: DeploymentMode;
  publisher?: string;
  publisherId?: string;
  publishedAt?: string;
  /** LVIS가 실제 설치한 시점 (보존/롤백 판단용) */
  installedAt: string;
  lastUpdatedAt?: string;
  /** IT가 강제 설치했는지 (정책 forceInstall) */
  forceInstalled?: boolean;
  /** 다운로드 URL (managed only, 재설치 시 참조) */
  managedSource?: string;
  /** 서명 검증 상태 */
  signatureStatus: "verified" | "unverified" | "failed" | "skipped";
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
}

export interface PluginRegistry {
  version: number;
  plugins: PluginRegistryEntry[];
}

export interface PluginMarketplaceItem {
  id: string;
  name: string;
  description: string;
  packageSpec: string;
  packageName: string;
  methods: string[];
  defaultConfig?: Record<string, unknown>;
  ui?: PluginUiExtension[];
  /** Phase 1.5 §9.6: catalog item's deployment mode (propagated to installed manifest) */
  deployment?: DeploymentMode;
  publisher?: string;
}

/**
 * Host API — 플러그인이 호스트 서비스에 접근하는 인터페이스
 *
 * 플러그인은 이 API를 통해 자신을 등록하고 호스트 기능을 사용합니다.
 * 플러그인 제거 시 해당 플러그인이 등록한 모든 것이 자동 정리됩니다.
 */
export interface PluginHostApi {
  /** 스킬 키워드 등록 (플러그인 제거 시 자동 해제) */
  registerKeywords(keywords: Array<{ keyword: string; skillId: string }>): void;
  /** 이벤트 발행 (다른 플러그인/호스트가 구독 가능) */
  emitEvent(eventType: string, data?: unknown): void;
  /** 이벤트 구독 */
  onEvent(eventType: string, handler: (data: unknown) => void): void;
  /** 태스크 생성 */
  addTask(task: {
    title: string;
    description?: string;
    source: string;
    sourceRef?: string;
    priority?: "high" | "medium" | "low";
  }): void;
  /** 메모 저장 (notes/) */
  saveNote(title: string, content: string): void;
  /** 설정에서 시크릿 조회 (API 키 등) */
  getSecret(key: string): string | null;

  // ─── Microsoft Graph 공유 인증 ───────────────────────────────────────
  /** 현재 유효한 MS Graph 액세스 토큰 반환. 미인증 시 null */
  getMsGraphToken(): Promise<string | null>;
  /** 브라우저 인터랙티브 인증 시작 (이미 인증된 경우 즉시 반환) */
  startMsGraphAuth(openBrowser: (url: string) => Promise<void>): Promise<void>;
  /** 현재 MS Graph 인증 여부 */
  isMsGraphAuthenticated(): boolean;
  /** 인증된 계정 이름 (이메일 주소) */
  getMsGraphAccount(): string | null;
  /** 인증 상태 변경 시 콜백 등록 */
  onMsGraphAuthChange(handler: () => void): void;

  /**
   * Spawn a scoped sub-agent ConversationLoop (P2 implementation).
   * Creates a new loop with ToolRegistry.createScopedView(allowedTools),
   * max depth 2, shared AbortSignal from parent.
   * Result is validated against resultSchema via ajv if provided.
   */
  spawnSubagent(req: SpawnSubagentRequest): Promise<SpawnSubagentResult>;
}

export interface PluginRuntimeContext {
  pluginId: string;
  pluginRoot: string;
  hostRoot: string;
  config?: Record<string, unknown>;
  log: (message: string, meta?: unknown) => void;
  /** 호스트 서비스 API — 플러그인이 자기 등록에 사용 */
  hostApi: PluginHostApi;
}

export type PluginMethodHandler = (payload?: unknown) => Promise<unknown> | unknown;

export interface RuntimePlugin {
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
  handlers: Record<string, PluginMethodHandler>;
}

export type RuntimePluginFactory = (context: PluginRuntimeContext) => Promise<RuntimePlugin> | RuntimePlugin;
