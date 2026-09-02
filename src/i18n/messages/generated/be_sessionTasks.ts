// AUTO-GENERATED — i18n migration. Source: src/tools/session-tasks.ts. Do not edit by hand.
export const en = {
  "be_sessionTasks.toolDescription": "Manage the checklist the assistant follows in this session. " +
    "Tasks are numbered from 1 in the order listed; the user sees the same numbers, so \"task 2\" means the same thing to both of you. " +
    "Every action returns the full numbered list. Completed tasks stay in the list (struck through); the list is saved with the session and comes back when it is reopened. " +
    "Actions: create (replace the list with steps), add (insert steps after task N; 0 = front; omitted = end), " +
    "edit (change a task's text and/or status: pending | in_progress), delete (remove task N), complete (mark task N done). " +
    "Do NOT use this tool when the user asks to register, record, or add their own tasks — " +
    "if a plugin tool for registering permanent task items is available, call that first. This tool is for " +
    "*tracking the assistant's own steps* while working through a multi-step request.",
  "be_sessionTasks.actionDesc": "create | add | edit | delete | complete.",
  "be_sessionTasks.stepsDesc": "create/add: the tasks, comma-separated, in order (e.g. \"scan folder, summarize findings, write report\"). A JSON array of strings is also accepted.",
  "be_sessionTasks.afterDesc": "add only: insert after this task number (1-based). 0 inserts at the front. Omit to append at the end.",
  "be_sessionTasks.indexDesc": "edit/delete/complete: the task number as shown in the list (1-based).",
  "be_sessionTasks.textDesc": "edit only: the new text for the task.",
  "be_sessionTasks.statusDesc": "edit only: pending or in_progress. Set in_progress on the step you are working on now; use action=complete when it is done.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_sessionTasks.toolDescription": "이 세션에서 어시스턴트가 따라갈 체크리스트를 관리합니다. " +
    "작업은 나열된 순서대로 1번부터 번호가 붙고 사용자도 같은 번호를 보므로 \"2번 작업\" 은 서로 같은 것을 가리킵니다. " +
    "모든 action 은 번호가 붙은 전체 목록을 돌려줍니다. 완료된 작업은 목록에 남고(취소선), 목록은 세션과 함께 저장되어 다시 열면 그대로 돌아옵니다. " +
    "action: create (목록을 steps 로 교체), add (N번 뒤에 steps 삽입; 0 = 맨 앞; 생략 = 맨 뒤), " +
    "edit (작업의 text 와/또는 status 변경: pending | in_progress), delete (N번 제거), complete (N번 완료 표시). " +
    "사용자가 본인의 업무·할 일을 등록·기록·추가해달라는 요청에는 이 도구를 사용하지 마세요 — " +
    "영구 업무 항목 등록을 지원하는 플러그인 도구가 노출되어 있으면 그쪽을 우선 호출하세요. 본 도구는 어시스턴트가 " +
    "다단계 요청을 풀어가는 *내부 단계 추적* 용도입니다.",
  "be_sessionTasks.actionDesc": "create | add | edit | delete | complete.",
  "be_sessionTasks.stepsDesc": "create/add: 작업 목록을 쉼표로 구분해 순서대로 (예: \"폴더 스캔, 결과 요약, 보고서 작성\"). 문자열 JSON 배열도 허용.",
  "be_sessionTasks.afterDesc": "add 전용: 이 번호(1부터) 의 작업 뒤에 삽입. 0 이면 맨 앞. 생략하면 맨 뒤에 추가.",
  "be_sessionTasks.indexDesc": "edit/delete/complete: 목록에 표시된 작업 번호(1부터).",
  "be_sessionTasks.textDesc": "edit 전용: 작업의 새 텍스트.",
  "be_sessionTasks.statusDesc": "edit 전용: pending 또는 in_progress. 지금 진행 중인 단계에 in_progress 를 지정하고, 끝나면 action=complete 를 사용.",
};
