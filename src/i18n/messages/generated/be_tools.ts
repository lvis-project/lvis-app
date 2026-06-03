// AUTO-GENERATED — i18n migration. Source: src/boot/tools.ts. Do not edit by hand.
export const en = {
  // registerRequestPluginMetaTool — tool description and schema
  "be_tools.requestPluginDescription": "Request selection of an enabled plugin not yet chosen in the current turn, if needed for this task. See the 'Available Plugins' section in the system prompt for the list of requestable plugins. Once selected, that plugin's tools can be called within the same turn.",
  "be_tools.requestPluginIdDescription": "The plugin ID to activate (the bold part of the catalog entry).",
  "be_tools.requestPluginLoopError": "request_plugin error: conversation loop interception is missing.",

  // registerToolSearchMetaTool — tool description and schema
  "be_tools.toolSearchDescription": "Search for tools listed in the '<tool-catalog>' section of the system prompt that have not yet been loaded, and load them for use in the current turn. Provide keywords related to the task (tool name or words from a capability description) in the query to match tools that can be called from the next round.",
  "be_tools.toolSearchQueryDescription": "Name or capability keyword of the tool to find.",
  "be_tools.toolSearchLoopError": "tool_search error: conversation loop interception is missing.",

  // web_search tool — description, schema, error output
  "be_tools.webSearchDescription": "Search the internet to find up-to-date information or knowledge.",
  "be_tools.webSearchQueryDescription": "Search query.",
  "be_tools.webSearchCountDescription": "Number of results to return (1-10).",
  "be_tools.webSearchError": "An error occurred during the search.",

  // web_fetch tool — description, schema, error output
  "be_tools.webFetchDescription": "Fetch the content of a specific URL and convert it to plain text.",
  "be_tools.webFetchUrlDescription": "URL of the web page to fetch.",
  "be_tools.webFetchAllowPrivateNetworkDescription": "After user approval, allow access to RFC1918/ULA private network addresses. Loopback, link-local, and metadata addresses remain blocked.",
  "be_tools.webFetchError": "Unable to read the web page.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_tools.requestPluginDescription": "현재 턴에 아직 선택되지 않은 enabled 플러그인 중 이번 작업에 필요한 것을 선택 요청합니다. 요청 가능한 플러그인 목록은 system prompt '사용 가능한 플러그인' 섹션 참조. 선택 후 같은 턴 내에서 해당 플러그인의 tool을 호출할 수 있습니다.",
  "be_tools.requestPluginIdDescription": "활성화할 플러그인 ID (카탈로그의 bold 부분)",
  "be_tools.requestPluginLoopError": "request_plugin 오류: 대화 루프 interception 이 누락되었습니다.",

  "be_tools.toolSearchDescription": "system prompt 의 '<tool-catalog>' 에 나열된, 아직 로드되지 않은 도구를 검색해 이번 턴에 사용할 수 있도록 로드합니다. query 에 작업과 관련된 키워드(도구 이름 또는 기능 설명의 단어)를 주면 매칭되는 도구를 다음 라운드부터 호출할 수 있습니다.",
  "be_tools.toolSearchQueryDescription": "찾으려는 도구의 이름 또는 기능 키워드",
  "be_tools.toolSearchLoopError": "tool_search 오류: 대화 루프 interception 이 누락되었습니다.",

  "be_tools.webSearchDescription": "인터넷 검색을 통해 최신 정보나 지식을 찾습니다.",
  "be_tools.webSearchQueryDescription": "검색어",
  "be_tools.webSearchCountDescription": "반환할 결과 개수 (1-10)",
  "be_tools.webSearchError": "검색 중 오류 발생",

  "be_tools.webFetchDescription": "특정 URL의 웹 페이지 내용을 읽어 텍스트로 변환합니다.",
  "be_tools.webFetchUrlDescription": "읽어올 웹 페이지 URL",
  "be_tools.webFetchAllowPrivateNetworkDescription": "사용자 승인 후 RFC1918/ULA 사설망 주소 접근을 허용합니다. loopback/link-local/metadata 주소는 계속 차단됩니다.",
  "be_tools.webFetchError": "웹 페이지를 읽을 수 없습니다.",
};
