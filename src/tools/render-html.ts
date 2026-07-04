



import { createDynamicTool, type Tool } from "./base.js";
import { t } from "../i18n/index.js";

export const MAX_HTML_BYTES = 200_000;
export const DEFAULT_HEIGHT = 400;
export const MAX_HEIGHT = 1200;
export const MIN_HEIGHT = 80;

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
  /** CSP-wrapped, sanitized HTML document ready for the preview-window data URL. */
  html: string;
  warnings: string[];
}

export function createRenderHtmlTool(): Tool {
  return createDynamicTool({
    name: "render_html",
    description: t("be_renderHtml.toolDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["html"],
      properties: {
        html: {
          type: "string",
          description: t("be_renderHtml.propHtmlDescription"),
        },
        title: {
          type: "string",
          description: t("be_renderHtml.propTitleDescription"),
        },
        height: {
          type: "integer",
          description: t("be_renderHtml.propHeightDescription", { default: DEFAULT_HEIGHT, min: MIN_HEIGHT, max: MAX_HEIGHT }),
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

export interface SanitizeResult {
  sanitized: string;
  warnings: string[];
}

/**
 * 서버-측 스트리핑. webview 프로세스 격리 + will-navigate 훅 + CSP가 주
 * 방어선이고, 이 단계는 defense-in-depth로 이들 경계가 커버하기 애매한 요소를
 * 선제 제거한다. 인라인 <script>·on* 핸들러·javascript: URL은 webview 내부에서만
 * 실행되므로 허용한다.
 *
 * 제거 항목:
 *   - <iframe>, <object>, <embed>, <frame>, <frameset> — nested browsing
 *     context는 webview sandbox 정책 상속이 불분명해 선제 차단.
 *   - <meta http-equiv="refresh"> — 자동 redirect 경로.
 *   - <script src="..."> — 외부 스크립트 URL 로드.
 *   - <a href="외부URL"> — 유저 클릭 시 webview top-level navigation을 유발.
 *     will-navigate 훅으로도 막히지만 UI 상 dead link로 표시하는 편이 덜 혼란
 *     스럽고, 훅보다 먼저 네트워크 prefetch(rel=prefetch)가 나갈 여지도 사라진다.
 */
export function sanitizeHtml(html: string): SanitizeResult {
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

  // <a href="외부URL"> → href 속성 제거. 허용되는 href는 in-document fragment
  // (#으로 시작) 뿐. 상대 경로조차도 about:blank나 data: base 기준으로 예상
  // 밖의 네트워크 이동을 트리거할 수 있어 모두 제거한다.
  let hrefStripped = false;
  out = out.replace(
    /(<a\b[^>]*?)\s+href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)([^>]*>)/gi,
    (match, before: string, value: string, after: string) => {
      const unquoted = value.replace(/^["']|["']$/g, "");
      if (unquoted.startsWith("#")) return match; // in-page fragment — keep
      hrefStripped = true;
      return `${before}${after}`;
    },
  );
  if (hrefStripped) warnings.push("removed <a href>");

  return { sanitized: out, warnings };
}

export function wrapWithCsp(body: string, title?: string): string {
  const safeTitle = (title ?? "LVIS render").replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
  );
  return (
    "<!doctype html><html><head>" +
    CSP_META +
    '<meta charset="utf-8">' +
    `<title>${safeTitle}</title>` +
    // font-family mirrors HOST_FONT_STACK (src/shared/host-font-stack.ts) — issue #556
    '<style>html,body{margin:0;padding:8px;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif;color:#e5e7eb;background:transparent;}</style>' +
    "</head><body>" +
    body +
    "</body></html>"
  );
}
