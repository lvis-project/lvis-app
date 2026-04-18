/**
 * render_html — 대화형 HTML 렌더링 툴 (네트워크 차단, 스크립트 허용).
 *
 * LLM이 작성한 HTML을 채팅창 내 iframe으로 삽입한다.
 * 보안 모델 (이중 방어):
 *   1) 클라이언트: renderer가 iframe을 sandbox="allow-scripts"(allow-same-origin
 *      미부여) + srcdoc 으로 로드한다. 스크립트는 opaque origin에서 실행되어
 *      parent document·cookie·localStorage에 접근할 수 없다.
 *   2) CSP <meta>: default-src 'none' 으로 모든 네트워크 요청(fetch / XHR /
 *      WebSocket / <img src=http> / <script src=http> / font / form submit)을
 *      원천 차단. script-src 'unsafe-inline' 'unsafe-eval' 만 허용해 인라인
 *      <script> · on* 핸들러 · Function/eval 기반 계산이 동작한다.
 *   3) 서버: <iframe>, <object>, <embed>, <frame>, <meta http-equiv=refresh>
 *      등 sandbox·CSP로도 커버가 애매한 요소와 <script src=...> 외부 로드
 *      속성을 선제 제거한다.
 *
 * 허용: inline CSS, data: URI 이미지/폰트, 인라인 <script>, on* 이벤트 핸들러,
 *        <input>/<button>/<canvas>/<svg> 동적 조작.
 * 불가: 네트워크 fetch, 외부 스크립트/스타일/이미지/폰트 로드, 부모 문서 접근,
 *        top-level navigation, form submit.
 */
import { createDynamicTool, type Tool } from "./base.js";

const MAX_HTML_BYTES = 200_000;
const DEFAULT_HEIGHT = 400;
const MAX_HEIGHT = 1200;
const MIN_HEIGHT = 80;

const CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="` +
  `default-src 'none'; ` +
  `script-src 'unsafe-inline' 'unsafe-eval'; ` +
  `style-src 'unsafe-inline' data:; ` +
  `img-src data:; ` +
  `font-src data:; ` +
  `base-uri 'none'; ` +
  `form-action 'none'; ` +
  `frame-ancestors 'none'` +
  `">`;

export interface RenderHtmlResult {
  /** marker so the renderer can detect this tool's payload. */
  kind: "lvis.render_html";
  title?: string;
  height: number;
  /** CSP-wrapped, sanitized HTML document ready for iframe srcdoc. */
  html: string;
  warnings: string[];
}

export function createRenderHtmlTool(): Tool {
  return createDynamicTool({
    name: "render_html",
    description:
      "HTML을 채팅창에 삽입해 사용자에게 시각적으로 보여줍니다. sandbox iframe(allow-scripts, allow-same-origin 없음) + 엄격한 CSP로 격리되며 네트워크 요청은 모두 차단됩니다. " +
      "허용: 인라인 CSS, data: URI 이미지/폰트, 인라인 <script>, on* 이벤트 핸들러, Function/eval, <input>/<canvas>/<svg> 등을 이용한 동적 상호작용(슬라이더로 차트 갱신 등). " +
      "불가: 외부 URL 로드(script/css/img/font/fetch/WebSocket 전부), 부모 문서 접근, 폼 제출, top-level navigation, localStorage. " +
      "차트·대시보드·인터랙티브 데모·표·다이어그램처럼 마크다운으로 표현하기 어려운 결과에 사용하세요. 라이브러리가 필요하면 코드 전체를 인라인으로 포함시켜야 합니다.",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["html"],
      properties: {
        html: {
          type: "string",
          description:
            "완전한 HTML 조각 또는 <html> 문서. 인라인 <script>와 on* 이벤트는 허용됩니다. <iframe>/<object>/<embed>/<meta http-equiv=refresh>와 <script src=...> 외부 로드는 자동 제거됩니다.",
        },
        title: {
          type: "string",
          description: "채팅창 프리뷰 상단에 표시할 제목 (60자 이내).",
        },
        height: {
          type: "integer",
          description: `iframe 높이(px). 기본 ${DEFAULT_HEIGHT}, 범위 ${MIN_HEIGHT}-${MAX_HEIGHT}.`,
        },
      },
    },
    execute: async (rawInput) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      const rawHtml = typeof args.html === "string" ? args.html : "";
      if (!rawHtml.trim()) {
        return {
          output: JSON.stringify({ error: "html is required" }),
          isError: true,
        };
      }
      if (Buffer.byteLength(rawHtml, "utf8") > MAX_HTML_BYTES) {
        return {
          output: JSON.stringify({
            error: `html too large (>${MAX_HTML_BYTES} bytes)`,
          }),
          isError: true,
        };
      }

      const rawTitle = typeof args.title === "string" ? args.title.trim() : "";
      const title = rawTitle ? rawTitle.slice(0, 60) : undefined;

      const rawHeight = Number(args.height);
      const height = Number.isFinite(rawHeight)
        ? Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.floor(rawHeight)))
        : DEFAULT_HEIGHT;

      const { sanitized, warnings } = sanitizeHtml(rawHtml);
      const wrapped = wrapWithCsp(sanitized, title);

      const result: RenderHtmlResult = {
        kind: "lvis.render_html",
        title,
        height,
        html: wrapped,
        warnings,
      };
      return { output: JSON.stringify(result), isError: false };
    },
  });
}

// ─── Sanitization ───────────────────────────────────

interface SanitizeResult {
  sanitized: string;
  warnings: string[];
}

/**
 * 서버-측 스트리핑. iframe sandbox + CSP가 주 방어선이고, 이 단계는
 * depth-in-defense로 sandbox·CSP가 커버하기 애매한 요소를 선제 제거한다.
 * 인라인 <script>·on* 핸들러·javascript: URL은 opaque sandbox 안에서만
 * 실행되므로 허용한다.
 *
 * 제거 항목:
 *   - <iframe>, <object>, <embed>, <frame>, <frameset> — nested browsing
 *     context는 sandbox 상속이 보장되지 않아 차단.
 *   - <meta http-equiv="refresh"> — sandbox는 top-nav는 막지만 meta refresh는
 *     케이스 by 케이스라 선제 제거.
 *   - <script src=...> — 외부 스크립트 URL 로드. CSP가 차단하지만 콘솔 noise
 *     방지 및 명시적 정책 표현을 위해 속성 제거.
 */
function sanitizeHtml(html: string): SanitizeResult {
  const warnings: string[] = [];
  let out = html;

  const tagBlocks: Array<[RegExp, string]> = [
    [/<iframe\b[\s\S]*?<\/iframe\s*>/gi, "iframe"],
    [/<iframe\b[^>]*\/?>/gi, "iframe"],
    [/<object\b[\s\S]*?<\/object\s*>/gi, "object"],
    [/<embed\b[^>]*\/?>/gi, "embed"],
    [/<frame\b[^>]*\/?>/gi, "frame"],
    [/<frameset\b[\s\S]*?<\/frameset\s*>/gi, "frameset"],
  ];
  for (const [pattern, label] of tagBlocks) {
    if (pattern.test(out)) {
      warnings.push(`removed <${label}>`);
      out = out.replace(pattern, "");
    }
  }

  // <meta http-equiv="refresh">
  if (/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(out)) {
    warnings.push("removed <meta refresh>");
    out = out.replace(
      /<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi,
      "",
    );
  }

  // <script src="..."> → drop src attribute (keep the tag body if any).
  const scriptSrcRe =
    /(<script\b[^>]*?)\ssrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)([^>]*>)/gi;
  if (scriptSrcRe.test(out)) {
    warnings.push("removed <script src>");
    out = out.replace(scriptSrcRe, "$1$2");
  }

  return { sanitized: out, warnings };
}

function wrapWithCsp(body: string, title?: string): string {
  const safeTitle = (title ?? "LVIS render").replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
  );
  return (
    "<!doctype html><html><head>" +
    CSP_META +
    '<meta charset="utf-8">' +
    `<title>${safeTitle}</title>` +
    '<style>html,body{margin:0;padding:8px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e5e7eb;background:transparent;}</style>' +
    "</head><body>" +
    body +
    "</body></html>"
  );
}
