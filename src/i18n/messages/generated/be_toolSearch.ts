// AUTO-GENERATED — i18n migration. Source: src/engine/turn/tool-search.ts. Do not edit by hand.
export const en = {
  "be_toolSearch.queryRequired": "tool_search error: query (string) is required.",
  "be_toolSearch.queryTokenTooShort": "tool_search error: query must contain at least one search token of {minLen} or more characters.",
  "be_toolSearch.turnLimitExceeded": "tool_search turn limit exceeded (max {max} per turn). Rejecting query '{query}'.",
  "be_toolSearch.sessionLimitExceeded": "tool_search session limit exceeded (max {max} per session). Rejecting query '{query}'.",
  "be_toolSearch.alreadyLoaded": "{name} is already loaded. Call it directly.",
  "be_toolSearch.alreadyLoadedMultiple": "{names} are already loaded. Call them directly.",
  "be_toolSearch.noMatchFound": "No unloaded tools matched '{query}'. Current catalog: {catalog}",
  "be_toolSearch.catalogEmpty": "(empty)",
  "be_toolSearch.toolsPromoted": "{count} tool(s) loaded: {names}.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_toolSearch.queryRequired": "tool_search 오류: query (string) 필수.",
  "be_toolSearch.queryTokenTooShort": "tool_search 오류: query 에 {minLen}글자 이상의 검색 토큰이 필요합니다.",
  "be_toolSearch.turnLimitExceeded": "tool_search 한도 초과 (턴당 최대 {max}회). '{query}' 검색 거부.",
  "be_toolSearch.sessionLimitExceeded": "tool_search 세션 한도 초과 (세션당 최대 {max}회). '{query}' 검색 거부.",
  "be_toolSearch.alreadyLoaded": "{name} 는 이미 로드되어 있습니다. 바로 호출하세요.",
  "be_toolSearch.alreadyLoadedMultiple": "{names} 는 이미 로드되어 있습니다. 바로 호출하세요.",
  "be_toolSearch.noMatchFound": "'{query}' 에 매치되는 미로드 도구 없음. 현재 카탈로그: {catalog}",
  "be_toolSearch.catalogEmpty": "(없음)",
  "be_toolSearch.toolsPromoted": "{count}개 도구 로드됨: {names}.",
};
