/**
 * Plugin Deployment Mode — §9.6
 *
 * - **managed**: 회사(LGE IT)가 원격으로 배포/업데이트/삭제 제어.
 *   사용자는 UI에서 제거·비활성화 불가 (PluginDeploymentGuard가 차단).
 * - **user**: 사용자가 자율적으로 설치. 회사 정책(userInstallPolicy)에 따라 제어.
 */
export type DeploymentMode = "managed" | "user";

export interface PluginIpcBinding {
  channel: string;
  method: string;
  args?: string[];
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
  config?: Record<string, unknown>;
  ui?: PluginUiExtension[];
  keywords?: Array<{ keyword: string; skillId: string }>;
  capabilities?: string[];
  startupTools?: string[];
  eventSubscriptions?: string[];
  ipcBindings?: PluginIpcBinding[];
  deployment?: DeploymentMode;
  publisher?: string;
  /**
   * LLM이 도구를 호출할 때 사용하는 JSON Schema (draft-07).
   * 키: tool 이름 (tools 배열 내 값과 동일), 값: { description, inputSchema }
   */
  toolSchemas?: Record<
    string,
    {
      description: string;
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
  tools: string[];
  defaultConfig?: Record<string, unknown>;
  ui?: PluginUiExtension[];
  deployment?: DeploymentMode;
  publisher?: string;
}

/**
 * Host API — 플러그인이 호스트 서비스에 접근하는 인터페이스.
 * 플러그인 제거 시 해당 플러그인이 등록한 모든 것이 자동 정리된다.
 */
export interface PluginHostApi {
  registerKeywords(keywords: Array<{ keyword: string; skillId: string }>): void;
  emitEvent(eventType: string, data?: unknown): void;
  onEvent(eventType: string, handler: (data: unknown) => void): void;
  addTask(task: {
    title: string;
    description?: string;
    source: string;
    sourceRef?: string;
    priority?: "high" | "medium" | "low";
  }): void;
  saveNote(title: string, content: string): void;
  getSecret(key: string): string | null;

  // Microsoft Graph 공유 인증 (메일·캘린더 플러그인)
  getMsGraphToken(): Promise<string | null>;
  startMsGraphAuth(openBrowser: (url: string) => Promise<void>): Promise<void>;
  isMsGraphAuthenticated(): boolean;
  getMsGraphAccount(): string | null;
  onMsGraphAuthChange(handler: () => void): void;
}

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
