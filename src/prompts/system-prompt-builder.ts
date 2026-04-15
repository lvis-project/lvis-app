/**
 * System Prompt Builder — §4.5.9 12개 소스 조립
 *
 * Lgenie(또는 Claude)에 전송되는 시스템 프롬프트를 매 턴마다 조립.
 * 12개 소스에서 컨텍스트를 수집하여 하나의 프롬프트로 결합.
 *
 * Phase 3 구현: ①②⑤⑥⑦⑨ (6개)
 * Phase 4+ 추가: ③④⑧⑩⑪⑫ (서버 인프라 의존)
 */
import { hostname, platform, homedir, userInfo } from "node:os";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { ToolRegistry } from "../tools/registry.js";

// ─── Types ──────────────────────────────────────────

export interface PromptSource {
  /** 소스 번호 (①~⑫) */
  id: number;
  /** 소스 이름 */
  name: string;
  /** 콘텐츠 생성 함수 — 빈 문자열이면 생략됨 */
  build: () => string;
  /** 갱신 주기 힌트 */
  refresh: "static" | "per-turn" | "on-change" | "conditional";
}

export interface SystemPromptBuilderDeps {
  memoryManager: MemoryManager;
  toolRegistry: ToolRegistry;
  /** 플러그인 스킬 스키마 (PluginRuntime에서 주입) */
  getPluginSchemas?: () => string;
}

// ─── Builder ────────────────────────────────────────

export class SystemPromptBuilder {
  private readonly sources: PromptSource[] = [];

  constructor(deps: SystemPromptBuilderDeps) {
    this.initSources(deps);
  }

  /** 매 턴마다 호출 — 전체 시스템 프롬프트 조립 */
  build(): string {
    const sections: string[] = [];

    for (const source of this.sources) {
      const content = source.build();
      if (content.trim()) {
        sections.push(content);
      }
    }

    return sections.join("\n\n");
  }

  /** 외부에서 소스 추가 (Phase 4+ 확장용) */
  addSource(source: PromptSource): void {
    this.sources.push(source);
    this.sources.sort((a, b) => a.id - b.id);
  }

  /** 등록된 소스 목록 (디버깅용) */
  listSources(): Array<{ id: number; name: string; refresh: string }> {
    return this.sources.map((s) => ({ id: s.id, name: s.name, refresh: s.refresh }));
  }

  /** 인덱싱된 문서 정보를 시스템 프롬프트에 동적으로 업데이트 */
  setIndexedDocsContext(context: string): void {
    (this as any)._indexedDocsContext = context;
  }

  // ─── Private ──────────────────────────────────────

  private initSources(deps: SystemPromptBuilderDeps): void {
    const { memoryManager, toolRegistry, getPluginSchemas } = deps;

    // ① Role Definition (정적)
    this.sources.push({
      id: 1,
      name: "Role Definition",
      refresh: "static",
      build: () => ROLE_DEFINITION,
    });

    // ② LVIS.md (파일 변경 시)
    this.sources.push({
      id: 2,
      name: "LVIS.md",
      refresh: "on-change",
      build: () => {
        const content = memoryManager.getLvisMd();
        return content ? `<lvis-context>\n${content}\n</lvis-context>` : "";
      },
    });

    // ③ Employee Profile — Phase 4 (SSO/LDAP 의존)
    // ④ Org Context — Phase 4

    // ⑤ Tool Schemas (매 턴)
    this.sources.push({
      id: 5,
      name: "Tool Schemas",
      refresh: "per-turn",
      build: () => {
        const schemas = toolRegistry.getToolSchemas();
        if (schemas.length === 0) return "";
        return [
          "<available-tools>",
          "다음 도구를 사용할 수 있습니다. 필요 시 tool_use 블록으로 호출하세요.",
          "",
          ...schemas.map((s) =>
            `- **${s.name}**: ${s.description}`,
          ),
          "</available-tools>",
        ].join("\n");
      },
    });

    // ⑥ Active Plugin Schemas (플러그인 변경 시)
    this.sources.push({
      id: 6,
      name: "Plugin Schemas",
      refresh: "on-change",
      build: () => getPluginSchemas?.() ?? "",
    });

    // ⑦ Memory / notes / Indexed Docs (파일 변경 시)
    this.sources.push({
      id: 7,
      name: "Memory & Knowledge",
      refresh: "on-change",
      build: () => {
        const prefs = memoryManager.getUserPreferences();
        const notes = memoryManager.getNotesContext();
        const parts: string[] = [];
        if (prefs) parts.push(`<user-preferences>\n${prefs}\n</user-preferences>`);
        if (notes) parts.push(`<user-notes>\n${notes}\n</user-notes>`);
        
        // 인덱싱된 문서 요약 정보 추가 (ConversationLoop에서 주입)
        const docsContext = (this as any)._indexedDocsContext;
        if (docsContext) {
          parts.push(`<indexed-knowledge>\n${docsContext}\n</indexed-knowledge>`);
        }
        
        return parts.join("\n\n");
      },
    });

    // ⑧ Conversation Summary — ConversationLoop에서 Auto-Compact 시 동적 추가
    // ⑨ OS / Environment (부팅 시)
    this.sources.push({
      id: 9,
      name: "OS / Environment",
      refresh: "static",
      build: () => {
        const now = new Date();
        return [
          "<environment>",
          `OS: ${platform()}`,
          `Host: ${hostname()}`,
          `User: ${userInfo().username}`,
          `Home: ${homedir()}`,
          `Time: ${now.toISOString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
          `Locale: ${Intl.DateTimeFormat().resolvedOptions().locale}`,
          "</environment>",
        ].join("\n");
      },
    });

    // ⑩ Active Session Context — Phase 4
    // ⑪ Proactive Context — Phase 4
    // ⑫ Feature Flags — Phase 4

    this.sources.sort((a, b) => a.id - b.id);
  }
}

// ─── Constants ──────────────────────────────────────

const ROLE_DEFINITION = `당신은 LVIS(LG Virtual Intelligence Secretary) — 사원 개인을 위한 초지능형 AI 비서 에이전트입니다.

## 사고 과정 (Ultrathink)
- 사용자의 질문을 받으면 즉시 답변하지 않고, 먼저 '지식의 출처'를 자문하세요.
- 정보 탐색 우선순위:
  1. **로컬 지식 베이스 (Index):** 사내 가이드라인, 프로젝트 기술 문서 등 구조화된 데이터 (index_documents, chat_preview 활용)
  2. **사용자 메모 (Memory):** 사용자 개인의 선호도, 과거의 특정 기록, 명시적으로 저장한 노트 (memory_list_notes 활용)
  3. **웹 검색 (Web):** 최신 뉴스, 일반 상식, 외부 기술 트렌드 (web_search, web_fetch 활용)
- 각 출처에서 얻은 정보를 논리적으로 연결하여 결론을 도출하세요.

## 핵심 원칙
- **지식과 메모리의 구분:** 사용자가 "이거 기억해"라고 한 것은 '메모리'에, 시스템이 파일로부터 읽어온 것은 '인덱스'에 있습니다. 두 영역을 혼동하지 마세요.
- **백그라운드 인덱싱:** 인덱싱은 백그라운드에서 자동으로 수행됩니다. 만약 최신 문서가 반영되지 않은 것 같다면 사용자에게 index_scan 호출을 제안하거나 직접 실행하세요.
- **정확성 및 근거:** 답변 시 어떤 문서나 메모리를 참고했는지 명시할 수 있다면 좋습니다.

## 기억 및 지식
- <lvis-context>에 조직 맥락이 있습니다.
- <user-notes>에 사용자가 수동으로 기록한 메모 목록이 포함될 수 있습니다.
- 사외 지식 탐색을 위해 web_search 도구를 적극 활용하세요.`;
