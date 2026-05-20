/** Human-readable display names for LLM tool identifiers. */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // Tasks
  task_add: "할 일 추가",
  task_list: "할 일 목록",
  task_update: "할 일 수정",
  task_delete: "할 일 삭제",
  task_today: "오늘 할 일",
  task_overdue: "기한 지난 할 일",
  todo_session_write: "세션 TO-DO 저장",
  schedule_routine: "루틴 등록",

  agent_spawn: "서브에이전트 실행",

  // Web / Search
  web_search: "웹 검색",
  web_fetch: "웹 페이지 가져오기",

  // System
  bash: "터미널 명령",
  powershell: "PowerShell 명령",
  read_file: "파일 읽기",
  list_files: "파일 목록",
  glob_files: "파일 찾기",
  grep_files: "파일 내용 검색",
  write_file: "파일 쓰기",
  edit_file: "파일 편집",
  apply_patch: "파일 패치",
  move_file: "파일 이동",
  delete_file: "파일 삭제",
  request_plugin: "플러그인 실행",
  read_tool_result_chunk: "도구 결과 청크 읽기",

  // Misc
  skill_load: "스킬 로드",
  ask_user_question: "사용자에게 질문",
  noop: "대기",
};

export function getToolDisplayName(toolName: string): string {
  if (TOOL_DISPLAY_NAMES[toolName]) return TOOL_DISPLAY_NAMES[toolName];
  // Unknown tool names render as readable text (underscores -> spaces).
  return toolName.replace(/_/g, " ");
}

/**
 * Replace tool code-names (e.g. `web_search`) with their Korean display names
 * inside free-form LLM response text.  Code spans and fenced code blocks are
 * left untouched so code examples are never mangled.
 * Only underscore-containing names are replaced — single-word names like
 * `bash` are excluded to avoid false positives in normal prose.
 */
export function replaceToolNamesInText(text: string): string {
  // Split into alternating [prose, code-block, prose, …] segments.
  // Regex captures both fenced blocks (``` … ```) and inline backtick spans.
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  return segments
    .map((seg, idx) => {
      if (idx % 2 === 1) return seg; // code segment — leave as-is
      let out = seg;
      for (const [code, display] of Object.entries(TOOL_DISPLAY_NAMES)) {
        if (!code.includes("_")) continue; // single-word names → skip (unsafe to replace in prose)
        out = out.replace(new RegExp(`\\b${code}\\b`, "g"), display);
      }
      return out;
    })
    .join("");
}
