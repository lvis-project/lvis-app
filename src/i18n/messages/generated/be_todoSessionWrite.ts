// AUTO-GENERATED — i18n migration. Source: src/tools/todo-session-write.ts. Do not edit by hand.
export const en = {
  "be_todoSessionWrite.toolDescription": "Write/update the checklist the assistant follows during the current turn. " +
    "Distinct from user task_* (volatile plan cleared after all items complete at the next explicit user input or user-queued auto-turn boundary). Send id to merge, " +
    "omit to create a new item. beforeId/afterId allow mid-list insertion or reordering. " +
    "status: pending | in_progress | completed | deleted. " +
    "Do NOT use this tool when the user asks to register, record, or add their own tasks/todos — " +
    "if a plugin tool for registering permanent task items is available, call that first. This tool is for " +
    "*internal step tracking* as the assistant works through a multi-step response only.",
  "be_todoSessionWrite.schemaIdDesc": "Existing item id — omit to create new. If id is provided, content may be omitted (existing content preserved).",
  "be_todoSessionWrite.schemaContentDesc": "Item content. Required when creating a new item.",
  "be_todoSessionWrite.schemaBeforeIdDesc": "Reference id to insert/move this item before. Takes priority over afterId.",
  "be_todoSessionWrite.schemaAfterIdDesc": "Reference id to insert/move this item after. If reference is absent, appended at the end.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_todoSessionWrite.toolDescription": "현재 턴 동안 어시스턴트가 따라갈 체크리스트를 작성/갱신합니다. " +
    "사용자 task_* 와 다름 (모든 항목이 완료된 뒤 다음 명시 사용자 입력 또는 사용자 큐 자동 인입 턴 시작 시 비워지는 휘발성 plan). id 를 같이 보내면 merge, " +
    "생략하면 새 항목 생성. beforeId/afterId 로 중간 삽입 또는 이동 가능. " +
    "status: pending | in_progress | completed | deleted. " +
    "사용자가 본인의 업무·할 일·태스크를 등록·기록·추가해달라는 요청에는 " +
    "이 도구를 사용하지 마세요 — 영구 업무 항목 등록을 지원하는 플러그인 " +
    "도구가 노출되어 있으면 그쪽을 우선 호출하세요. 본 도구는 어시스턴트가 " +
    "다단계 응답을 풀어가는 *내부 단계 추적* 용도로만 사용합니다.",
  "be_todoSessionWrite.schemaIdDesc": "기존 항목 id — 생략 시 신규 생성. id 전달 시 content 생략 가능(기존 내용 유지).",
  "be_todoSessionWrite.schemaContentDesc": "항목 내용. 신규 생성 시 필수.",
  "be_todoSessionWrite.schemaBeforeIdDesc": "이 항목 앞에 삽입/이동할 기준 id. afterId 보다 우선.",
  "be_todoSessionWrite.schemaAfterIdDesc": "이 항목 뒤에 삽입/이동할 기준 id. 기준이 없으면 뒤에 추가.",
};
