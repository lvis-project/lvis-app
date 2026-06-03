// AUTO-GENERATED — i18n migration. Source: src/memory/memory-manager.ts. Do not edit by hand.
export const en = {
  "be_memoryManager.defaultAgentsMd": `# LVIS Agent Context

> This file delivers project, organization, and team context to the LVIS agent.
> It can be deployed by an administrator or edited directly by the user.

## Organization

(Enter team, department, or project information here)

## Work Rules

(Rules or guidelines that must be followed consistently)
`,
  "be_memoryManager.defaultMemoryIndex": `# LVIS Memory Index

> This is the long-term memory index that LVIS actively reads at session start.
> Keep urgent notes in the Urgent Memory section below (~500 chars),
> and move detailed notes to individual Markdown files in the same folder, linked under Saved Memories.

## Urgent Memory

(Keep content you need to reference right now to ~500 chars)

## References

(Source links or references for urgent memory items)

## Saved Memories

`,
  "be_memoryManager.defaultUserPrefs": `# User Preferences

> Personal preference settings that LVIS references. Edit freely.

## Communication Style

- Answer in Korean
- Prefer concise explanations

## Frequently Used Tools

(Plugins, tools, commands you use often)
`,
  "be_memoryManager.sessionTitleWithRoutine": "{routineTitle} conversation",
  "be_memoryManager.sessionTitleShort": "Session {id}",
  "be_memoryManager.sessionPreviewTooLarge": "(conversation too large — preview skipped)",
  "be_memoryManager.sessionPreviewEmpty": "(no content)",
  "be_memoryManager.urgentMemoryPlaceholder": "(Keep content you need to reference right now to ~500 chars)",
  "be_memoryManager.referencesPlaceholder": "(Source links or references for urgent memory items)",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_memoryManager.defaultAgentsMd": `# LVIS 에이전트 컨텍스트

> 이 파일은 LVIS 에이전트에게 프로젝트·조직·팀 컨텍스트를 전달합니다.
> 관리자가 배포하거나, 사용자가 직접 편집할 수 있습니다.

## 조직 정보

(여기에 팀·부서·프로젝트 정보를 기입하세요)

## 업무 규칙

(반복적으로 지켜야 하는 규칙이나 가이드라인)
`,
  "be_memoryManager.defaultMemoryIndex": `# LVIS Memory Index

> LVIS가 세션 시작 시 적극적으로 읽는 장기 메모리 인덱스입니다.
> 긴급 기억은 이 파일의 Urgent Memory 섹션에 500자 내외로 유지하고,
> 상세 기억은 같은 폴더의 개별 Markdown 파일로 분리한 뒤 Saved Memories에 링크하세요.

## Urgent Memory

(지금 즉시 참고해야 할 내용을 500자 내외로 유지)

## References

(긴급 기억의 근거 링크 또는 출처)

## Saved Memories

`,
  "be_memoryManager.defaultUserPrefs": `# 사용자 선호

> LVIS가 참고하는 개인 선호 설정입니다. 자유롭게 편집하세요.

## 커뮤니케이션 스타일

- 한국어로 답변
- 간결한 설명 선호

## 자주 쓰는 도구

(자주 사용하는 플러그인, 도구, 명령어 등)
`,
  "be_memoryManager.sessionTitleWithRoutine": "{routineTitle} 대화",
  "be_memoryManager.sessionTitleShort": "세션 {id}",
  "be_memoryManager.sessionPreviewTooLarge": "(대화가 커서 미리보기를 생략했습니다)",
  "be_memoryManager.sessionPreviewEmpty": "(내용 없음)",
  "be_memoryManager.urgentMemoryPlaceholder": "(지금 즉시 참고해야 할 내용을 500자 내외로 유지)",
  "be_memoryManager.referencesPlaceholder": "(긴급 기억의 근거 링크 또는 출처)",
};
