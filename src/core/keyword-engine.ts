/**
 * Keyword Detecting Engine — §6.1
 *
 * 사용자 입력에서 의도·키워드·엔티티를 감지하는 첫 번째 관문.
 * TypeScript 구현 — 향후 Rust NAPI-RS 포팅 대비 인터페이스 분리.
 *
 * 감지 우선순위 (§6.1):
 * 1. 명시적 명령어 (/command)
 * 2. 스킬 키워드 (플러그인 등록)
 * 3. 에이전트 멘션 (@사람) — Phase 5
 * 4. 의도 + 엔티티 — Phase 4
 * 5. 일반 대화 (fallback)
 */

// ─── Types ──────────────────────────────────────────

export type InputClassification =
  | { type: "command"; command: string; args: string }
  | { type: "skill"; keyword: string; skillId: string; pluginId?: string; input: string }
  | { type: "mention"; target: string; message: string }
  | { type: "general"; input: string };

export interface SkillKeyword {
  /** 트리거 키워드 (예: "회의록", "번역", "이메일") */
  keyword: string;
  /** 매핑될 스킬/플러그인 ID */
  skillId: string;
  /**
   * Plugin 식별자. null/undefined = builtin 스킬.
   * Lazy tool scoping (Phase 1) — classify 결과에서 active plugin 집합을
   * 도출할 때 사용된다. boot.ts createHostApi.registerKeywords가
   * 플러그인 호출 시 자동 주입한다.
   */
  pluginId?: string;
}

// ─── Engine ─────────────────────────────────────────

export class KeywordEngine {
  private skillKeywords: SkillKeyword[] = [];

  /** 플러그인 로드 시 스킬 키워드 등록 */
  registerKeywords(keywords: SkillKeyword[]): void {
    this.skillKeywords.push(...keywords);
  }

  /** 키워드 초기화 (플러그인 리로드 시) */
  clearKeywords(): void {
    this.skillKeywords = [];
  }

  /**
   * Phase 1 Lazy Tool Scoping — 입력에 포함된 모든 키워드의 pluginId 집합을 반환.
   * classify()는 첫 매치만 반환하지만, scope 결정은 "이 턴에서 필요한 모든
   * 플러그인"을 수집해야 한다. builtin 스킬(pluginId undefined)은 제외된다.
   */
  matchAllPluginIds(input: string): Set<string> {
    const lowerInput = input.trim().toLowerCase();
    const result = new Set<string>();
    for (const sk of this.skillKeywords) {
      if (sk.pluginId && lowerInput.includes(sk.keyword.toLowerCase())) {
        result.add(sk.pluginId);
      }
    }
    return result;
  }

  /** 사용자 입력 분류 — §6.1 우선순위 기반 */
  classify(input: string): InputClassification {
    const trimmed = input.trim();

    // 1. 명시적 명령어: /command [args]
    const cmdMatch = trimmed.match(/^\/(\S+)\s*(.*)?$/s);
    if (cmdMatch) {
      return {
        type: "command",
        command: cmdMatch[1],
        args: cmdMatch[2]?.trim() ?? "",
      };
    }

    // 2. 스킬 키워드 매칭 (첫 매치 반환 — routing 용)
    const lowerInput = trimmed.toLowerCase();
    for (const sk of this.skillKeywords) {
      if (lowerInput.includes(sk.keyword.toLowerCase())) {
        return {
          type: "skill",
          keyword: sk.keyword,
          skillId: sk.skillId,
          pluginId: sk.pluginId,
          input: trimmed,
        };
      }
    }

    // 3. @멘션 (Phase 5 — Agent Hub 의존)
    const mentionMatch = trimmed.match(/^@(\S+)\s+(.+)$/s);
    if (mentionMatch) {
      return {
        type: "mention",
        target: mentionMatch[1],
        message: mentionMatch[2].trim(),
      };
    }

    // 5. 일반 대화 (fallback)
    return { type: "general", input: trimmed };
  }
}
