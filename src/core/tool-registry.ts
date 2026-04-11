/**
 * Tool Registry — §6.4 도구 통합 레지스트리
 *
 * 빌트인 도구 + 플러그인 도구 + (향후) MCP 도구를 단일 레지스트리에서 관리.
 * SystemPromptBuilder가 도구 스키마를 조립할 때 이 레지스트리를 참조.
 * ConversationLoop이 tool_use 블록을 실행할 때 findByName()으로 도구를 찾음.
 *
 * §6.3 Layer 1 Filter: filterByDenyRules()로 Lgenie에 노출할 도구를 제어.
 * "차단된 도구는 Lgenie가 존재 자체를 알 수 없다" — 아키텍처 핵심 보안 원칙.
 */

export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required?: boolean;
}

export interface ToolDefinition {
  /** 고유 이름 (예: "index.scan", "meeting.start", "memory.save") */
  name: string;
  /** LLM에 표시되는 설명 */
  description: string;
  /** JSON Schema 형태의 파라미터 정의 */
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  /** 도구 실행 함수 */
  execute: (args: Record<string, unknown>) => Promise<unknown>;
  /** 도구 출처 */
  source: "builtin" | "plugin" | "mcp";
  /** 출처 플러그인 ID (source가 plugin일 때) */
  pluginId?: string;
}

export interface DenyRule {
  /** 차단할 도구 이름 패턴 (glob-like: "meeting.*", "*.delete") */
  pattern: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private denyRules: DenyRule[] = [];

  /** 도구 등록 */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** 도구 일괄 등록 (플러그인 로드 시) */
  registerBatch(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** 도구 제거 (플러그인 언로드 시) */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /** 플러그인의 모든 도구 제거 */
  unregisterByPlugin(pluginId: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.pluginId === pluginId) {
        this.tools.delete(name);
      }
    }
  }

  /** 이름으로 도구 조회 — §4.5.6 findByName() */
  findByName(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** 전체 도구 목록 */
  listAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** §6.3 Layer 1 — deny 규칙 적용 후 Lgenie에 노출할 도구만 반환 */
  getVisibleTools(): ToolDefinition[] {
    return this.listAll().filter((tool) => !this.isDenied(tool.name));
  }

  /** LLM에 전달할 도구 스키마 배열 생성 — SystemPromptBuilder에서 사용 */
  getToolSchemas(): Array<{
    name: string;
    description: string;
    input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  }> {
    return this.getVisibleTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  /** deny 규칙 설정 */
  setDenyRules(rules: DenyRule[]): void {
    this.denyRules = rules;
  }

  /** 등록된 도구 수 */
  get size(): number {
    return this.tools.size;
  }

  // ─── Private ──────────────────────────────────────

  private isDenied(toolName: string): boolean {
    return this.denyRules.some((rule) => this.matchPattern(rule.pattern, toolName));
  }

  private matchPattern(pattern: string, name: string): boolean {
    // 간단한 glob 매칭: "*" = 모든 문자, "." = 리터럴
    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
    );
    return regex.test(name);
  }
}
