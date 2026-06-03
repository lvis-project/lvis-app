// AUTO-GENERATED — i18n migration. Source: src/tools/shell-path-policy.ts. Do not edit by hand.
export const en = {
  // LVIS_ALTERNATIVE_BY_COMMAND — per-command builtin tool suggestions
  "be_shellPathPolicy.altFind": "glob_files (name pattern matching) or list_files (directory listing)",
  "be_shellPathPolicy.altFd": "glob_files (name pattern matching)",
  "be_shellPathPolicy.altFdfind": "glob_files (name pattern matching)",
  "be_shellPathPolicy.altRg": "grep_files (content search)",
  "be_shellPathPolicy.altTree": "list_files (with recursive option)",
  "be_shellPathPolicy.altTar": "(no direct LVIS built-in equivalent — decompose into non-recursive ls/cat etc.)",
  "be_shellPathPolicy.altUnzip": "(no direct LVIS built-in equivalent)",
  "be_shellPathPolicy.altZip": "(no direct LVIS built-in equivalent)",
  "be_shellPathPolicy.altGrep": "grep_files (content search)",
  "be_shellPathPolicy.altEgrep": "grep_files (content search — regex)",
  "be_shellPathPolicy.altFgrep": "grep_files (content search — fixed string)",
  "be_shellPathPolicy.altCp": "(no direct LVIS built-in equivalent — handle individual files with read_file + write_file)",
  "be_shellPathPolicy.altMv": "move_file (one file at a time)",

  // buildRecursiveBlockMessage — guidance appended to block messages
  "be_shellPathPolicy.guidanceWithAlt": "Recommended LVIS built-in tool: {alt}. Keep the original target path as-is — do not narrow to a subdirectory.",
  "be_shellPathPolicy.guidanceNoAlt": "Recursive walk is blocked because path-policy cannot statically verify it. Retry with a non-recursive command, or use LVIS built-in file tools while keeping the original target path as-is.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_shellPathPolicy.altFind": "glob_files (이름 패턴 매칭) 또는 list_files (디렉토리 목록)",
  "be_shellPathPolicy.altFd": "glob_files (이름 패턴 매칭)",
  "be_shellPathPolicy.altFdfind": "glob_files (이름 패턴 매칭)",
  "be_shellPathPolicy.altRg": "grep_files (콘텐츠 검색)",
  "be_shellPathPolicy.altTree": "list_files (재귀 옵션 포함)",
  "be_shellPathPolicy.altTar": "(LVIS 내장 대안 없음 — 비재귀 ls/cat 등으로 분해하세요)",
  "be_shellPathPolicy.altUnzip": "(LVIS 내장 대안 없음)",
  "be_shellPathPolicy.altZip": "(LVIS 내장 대안 없음)",
  "be_shellPathPolicy.altGrep": "grep_files (콘텐츠 검색)",
  "be_shellPathPolicy.altEgrep": "grep_files (콘텐츠 검색 — 정규식)",
  "be_shellPathPolicy.altFgrep": "grep_files (콘텐츠 검색 — 고정 문자열)",
  "be_shellPathPolicy.altCp": "(LVIS 내장 대안 없음 — read_file + write_file 조합으로 개별 파일 처리)",
  "be_shellPathPolicy.altMv": "move_file (개별 파일 단위로)",
  "be_shellPathPolicy.guidanceWithAlt": "LVIS 내장 도구 권장: {alt}. 원래 target path 를 그대로 유지하세요 — 하위 디렉토리로 좁히지 마세요.",
  "be_shellPathPolicy.guidanceNoAlt": "재귀 walk 는 path-policy 가 정적으로 검증할 수 없어 차단됩니다. 비재귀 명령으로 다시 시도하거나, 원래 target path 를 그대로 유지한 채 LVIS 내장 파일 도구를 사용하세요.",
};
