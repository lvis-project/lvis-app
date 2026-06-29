// AUTO-GENERATED — i18n migration. Source: src/tools/render-html.ts. Do not edit by hand.
export const en = {
  "be_renderHtml.toolDescription":
    "Opens HTML in a separate window to display it visually to the user. " +
    "Isolated via an Electron BrowserWindow (separate process) + strict CSP — infinite loops won't freeze the main UI, and all network requests are blocked. " +
    "Allowed: inline CSS, data: URI images/fonts, inline <script>, on* event handlers, Function/eval, dynamic interaction via <input>/<canvas>/<svg> (e.g. slider-driven chart updates). " +
    "Not allowed: loading external URLs (script/css/img/font/fetch/WebSocket), accessing the parent document, form submission, top-level navigation, <a> external links, localStorage. " +
    "Use for results that are hard to express in Markdown — charts, dashboards, interactive demos, tables, diagrams. Libraries must be inlined in full. " +
    "Design guide: compose the page to match the current LVIS app theme colors. " +
    "Use CSS variables such as hsl(var(--background)), hsl(var(--foreground)), hsl(var(--primary)), hsl(var(--muted)), hsl(var(--border)) for background, text, and accent colors where possible. " +
    "For cards, charts, and buttons, prioritize clear hierarchy, spacing, and contrast over heavy gradients to match the app's calm, task-oriented UI tone.",
  "be_renderHtml.propHtmlDescription":
    "A complete HTML fragment or <html> document. " +
    "Inline <script> and on* events are allowed. " +
    "<iframe>/<object>/<embed>/<meta http-equiv=refresh>, external <script src=...> loads, and <a href=external-URL> are stripped automatically. " +
    "Match the page colors to the current app theme tokens (--background, --foreground, --primary, --muted, --border, etc.).",
  "be_renderHtml.propTitleDescription": "Window title for the HTML preview (max 60 chars).",
  "be_renderHtml.propHeightDescription":
    "Preview height in pixels. Default {default}, range {min}–{max}.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_renderHtml.toolDescription":
    "HTML을 별도 창으로 열어 사용자에게 시각적으로 보여줍니다. Electron BrowserWindow(별도 프로세스) + 엄격한 CSP로 격리되며, 무한 루프가 있어도 메인 UI는 멈추지 않고 모든 네트워크 요청은 차단됩니다. " +
    "허용: 인라인 CSS, data: URI 이미지/폰트, 인라인 <script>, on* 이벤트 핸들러, Function/eval, <input>/<canvas>/<svg> 등을 이용한 동적 상호작용(슬라이더로 차트 갱신 등). " +
    "불가: 외부 URL 로드(script/css/img/font/fetch/WebSocket 전부), 부모 문서 접근, 폼 제출, top-level navigation, <a> 외부 링크, localStorage. " +
    "차트·대시보드·인터랙티브 데모·표·다이어그램처럼 마크다운으로 표현하기 어려운 결과에 사용하세요. 라이브러리가 필요하면 코드 전체를 인라인으로 포함시켜야 합니다. " +
    "디자인 가이드: 현재 LVIS 앱 테마 색상과 어울리도록 페이지를 구성하세요. 배경·텍스트·강조색은 가능하면 CSS 변수 hsl(var(--background)), hsl(var(--foreground)), hsl(var(--primary)), hsl(var(--muted)), hsl(var(--border)) 등을 사용하고, 카드/차트/버튼은 앱의 차분한 작업형 UI 톤에 맞춰 과한 그라데이션보다 명확한 계층·여백·대비를 우선하세요.",
  "be_renderHtml.propHtmlDescription":
    "완전한 HTML 조각 또는 <html> 문서. 인라인 <script>와 on* 이벤트는 허용됩니다. <iframe>/<object>/<embed>/<meta http-equiv=refresh>, <script src=...> 외부 로드, <a href=external-URL>은 자동 제거됩니다. 현재 앱 테마 토큰(--background, --foreground, --primary, --muted, --border 등)을 기준으로 페이지 색상을 맞추세요.",
  "be_renderHtml.propTitleDescription": "HTML 창 제목 (60자 이내).",
  "be_renderHtml.propHeightDescription":
    "프리뷰 높이(px). 기본 {default}, 범위 {min}-{max}.",
};
