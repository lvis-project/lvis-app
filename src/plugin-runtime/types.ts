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
