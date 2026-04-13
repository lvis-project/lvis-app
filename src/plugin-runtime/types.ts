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

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  methods: string[];
  config?: Record<string, unknown>;
  ui?: PluginUiExtension[];
  /** 플러그인이 선언하는 키워드 (§9.2) */
  keywords?: Array<{ keyword: string; skillId: string }>;

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
