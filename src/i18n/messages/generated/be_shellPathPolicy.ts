// Shell path-policy guidance catalog. Aggregate locale barrels are generated.
export const en = {
  // SHELL_TRAVERSAL_GUIDANCE: available tools and explicit capability limits.
  "be_shellPathPolicy.altFind": "glob_files (name pattern matching) or list_files (directory listing)",
  "be_shellPathPolicy.altFd": "glob_files (name pattern matching)",
  "be_shellPathPolicy.altFdfind": "glob_files (name pattern matching)",
  "be_shellPathPolicy.altRg": "grep_files (content search)",
  "be_shellPathPolicy.altTree": "list_files (bounded-depth directory listing)",
  "be_shellPathPolicy.altTar": "For tar or gzip-compressed tar extraction only, use extract_archive({archivePath, destinationPath}). The exact destination must be absent and its parent must already exist; no overwrite or merge. Both paths remain subject to write-scope checks and approval. Archive creation and ZIP extraction have no built-in equivalent; report those operations as unavailable. The tar -tf command with a literal archive path supports listing only, subject to path checks and approval.",
  "be_shellPathPolicy.altUnzip": "ZIP extraction is unavailable through this shell, with no built-in equivalent.",
  "be_shellPathPolicy.altZip": "Archive creation is unavailable through this shell, with no built-in equivalent.",
  "be_shellPathPolicy.altGrep": "grep_files (content search)",
  "be_shellPathPolicy.altEgrep": "grep_files (content search — regex)",
  "be_shellPathPolicy.altFgrep": "grep_files (content search — fixed string)",
  "be_shellPathPolicy.altCp": "copy_path({sourcePath, destinationPath}) copies an ordinary binary/text file or a complete directory tree, including hidden ordinary entries, to the exact destination. Pass the intended final new path as destinationPath; the tool does not append the source basename. The destination must be absent and its parent must already exist; no overwrite or merge. Both paths remain subject to write-scope checks and approval. Symlinks, hard links and special entries fail the operation. The read_file and write_file tools handle UTF-8 text only",
  "be_shellPathPolicy.altMv": "Recursive directory moves are unavailable through this shell, with no built-in equivalent. The move_file tool moves one regular file only.",

  // buildRecursiveBlockMessage — guidance appended to block messages
  "be_shellPathPolicy.guidanceWithAlt": "Recommended LVIS built-in tool: {alt}. Keep the original target path and requested scope.",
  "be_shellPathPolicy.guidanceConditional": "{alt} Keep the original target path and requested scope. Use the named built-in only for the supported operation.",
  "be_shellPathPolicy.guidanceUnavailable": "{alt} Keep the original target path and requested scope. Report the operation as unavailable through this shell; do not claim that a different operation completed it.",
  "be_shellPathPolicy.guidanceNoAlt": "Recursive traversal is blocked because path policy cannot statically verify it. Keep the original target path and requested scope. Use a supported operation only if it fulfills the request; otherwise report the operation as unavailable.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_shellPathPolicy.altFind": "glob_files (이름 패턴 매칭) 또는 list_files (디렉토리 목록)",
  "be_shellPathPolicy.altFd": "glob_files (이름 패턴 매칭)",
  "be_shellPathPolicy.altFdfind": "glob_files (이름 패턴 매칭)",
  "be_shellPathPolicy.altRg": "grep_files (콘텐츠 검색)",
  "be_shellPathPolicy.altTree": "list_files (깊이가 제한된 디렉터리 목록 조회)",
  "be_shellPathPolicy.altTar": "tar 또는 gzip으로 압축한 tar의 압축을 해제할 때만 extract_archive({archivePath, destinationPath})를 사용하세요. 지정한 대상 경로는 존재하지 않아야 하며, 상위 디렉터리는 이미 존재해야 합니다. 덮어쓰기와 병합은 지원하지 않습니다. 두 경로 모두 기존 쓰기 범위 검사와 승인을 거칩니다. 아카이브 생성과 ZIP 압축 해제에는 내장 대안이 없으므로 해당 작업을 지원하지 않는다고 알리세요. 파일 경로를 직접 지정한 tar -tf는 경로 검사와 승인에 따라 목록 조회만 지원합니다.",
  "be_shellPathPolicy.altUnzip": "이 쉘에서는 ZIP 압축 해제를 지원하지 않으며 내장 대안이 없습니다.",
  "be_shellPathPolicy.altZip": "이 쉘에서는 아카이브 생성을 지원하지 않으며 내장 대안이 없습니다.",
  "be_shellPathPolicy.altGrep": "grep_files (콘텐츠 검색)",
  "be_shellPathPolicy.altEgrep": "grep_files (콘텐츠 검색 — 정규식)",
  "be_shellPathPolicy.altFgrep": "grep_files (콘텐츠 검색 — 고정 문자열)",
  "be_shellPathPolicy.altCp": "copy_path({sourcePath, destinationPath})는 일반 바이너리·텍스트 파일 하나 또는 숨김 항목을 포함한 전체 디렉터리 트리를 지정한 대상 경로에 복사합니다. destinationPath에는 최종적으로 생성할 경로를 지정하세요. 도구가 원본 이름을 자동으로 덧붙이지 않습니다. 대상 경로는 존재하지 않아야 하며, 상위 디렉터리는 이미 존재해야 합니다. 덮어쓰기와 병합은 지원하지 않습니다. 두 경로 모두 기존 쓰기 범위 검사와 승인을 거칩니다. 심볼릭 링크, 하드 링크 또는 특수 항목이 있으면 작업이 실패합니다. read_file과 write_file은 UTF-8 텍스트만 처리합니다",
  "be_shellPathPolicy.altMv": "이 쉘에서는 디렉터리 재귀 이동을 지원하지 않으며 내장 대안이 없습니다. move_file은 일반 파일 하나만 이동합니다.",
  "be_shellPathPolicy.guidanceWithAlt": "LVIS 내장 도구 권장: {alt}. 원래 대상 경로와 요청한 작업 범위를 그대로 유지하세요.",
  "be_shellPathPolicy.guidanceConditional": "{alt} 원래 대상 경로와 요청한 작업 범위를 그대로 유지하세요. 안내한 내장 도구는 해당 도구가 지원하는 작업에만 사용하세요.",
  "be_shellPathPolicy.guidanceUnavailable": "{alt} 원래 대상 경로와 요청한 작업 범위를 그대로 유지하세요. 이 쉘에서는 해당 작업을 지원하지 않는다고 알리세요. 다른 작업을 수행한 뒤 요청한 작업을 완료했다고 말하지 마세요.",
  "be_shellPathPolicy.guidanceNoAlt": "경로 정책이 정적으로 검증할 수 없어 재귀 탐색을 차단했습니다. 원래 대상 경로와 요청한 작업 범위를 그대로 유지하세요. 지원하는 작업으로 요청을 충족할 수 있을 때만 해당 작업을 사용하고, 그렇지 않으면 해당 작업을 지원하지 않는다고 알리세요.",
};
