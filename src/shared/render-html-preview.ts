export const RENDER_HTML_WINDOW_MIN_WIDTH = 420;
export const RENDER_HTML_WINDOW_MAX_WIDTH = 1600;
export const RENDER_HTML_WINDOW_DEFAULT_WIDTH = 960;
export const RENDER_HTML_WINDOW_MIN_HEIGHT = 240;
export const RENDER_HTML_WINDOW_MAX_HEIGHT = 1400;
export const RENDER_HTML_WINDOW_DEFAULT_HEIGHT = 640;
export const RENDER_HTML_WINDOW_MAX_HTML_BYTES = 2 * 1024 * 1024;
export const RENDER_HTML_PARTITION = "lvis-render-html";

export type OpenHtmlPreviewWindowPayload = {
  title?: string;
  html: string;
  width?: number;
  height?: number;
  allowScripts?: boolean;
  warnings?: string[];
};

export type OpenHtmlPreviewWindowResult =
  | { ok: true; windowId: number }
  | { ok: false; error: string };

export function clampRenderHtmlWindowSize(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function escapeMetaAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

export function buildRenderHtmlCspMeta(allowScripts: boolean): string {
  const directives = [
    "default-src 'none'",
    allowScripts ? "script-src 'unsafe-inline' 'unsafe-eval'" : "",
    "style-src 'unsafe-inline' data:",
    "img-src data:",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].filter(Boolean).join("; ");
  return `<meta http-equiv="Content-Security-Policy" content="${escapeMetaAttribute(directives)}">`;
}

function extractTagInner(html: string, tagName: "head" | "body"): string | null {
  const match = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i").exec(html);
  return match?.[1] ?? null;
}

function extractRenderHtmlDocumentParts(html: string): { head: string; body: string } {
  const head = extractTagInner(html, "head") ?? "";
  const body = extractTagInner(html, "body");
  if (body !== null) {
    return { head, body };
  }

  const bodyOnly = html
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<\/?html\b[^>]*>/gi, "")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, "")
    .replace(/<\/?body\b[^>]*>/gi, "");

  return { head, body: bodyOnly };
}

export function wrapRenderHtmlDocument(html: string, allowScripts: boolean): string {
  const cspMeta = buildRenderHtmlCspMeta(allowScripts);
  const { head, body } = extractRenderHtmlDocumentParts(html);
  return `<!doctype html><html><head>${cspMeta}${head}</head><body>${body}</body></html>`;
}

export function normalizeOpenHtmlPreviewWindowPayload(
  payload: unknown,
): OpenHtmlPreviewWindowPayload | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "invalid-payload" };
  }
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.html !== "string" || candidate.html.trim().length === 0) {
    return { ok: false, error: "invalid-html" };
  }
  if (Buffer.byteLength(candidate.html, "utf8") > RENDER_HTML_WINDOW_MAX_HTML_BYTES) {
    return { ok: false, error: "html-too-large" };
  }
  const warnings = Array.isArray(candidate.warnings)
    ? candidate.warnings.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    html: candidate.html,
    title: typeof candidate.title === "string" && candidate.title.trim().length > 0
      ? candidate.title.slice(0, 120)
      : undefined,
    width: clampRenderHtmlWindowSize(
      candidate.width,
      RENDER_HTML_WINDOW_MIN_WIDTH,
      RENDER_HTML_WINDOW_MAX_WIDTH,
      RENDER_HTML_WINDOW_DEFAULT_WIDTH,
    ),
    height: clampRenderHtmlWindowSize(
      candidate.height,
      RENDER_HTML_WINDOW_MIN_HEIGHT,
      RENDER_HTML_WINDOW_MAX_HEIGHT,
      RENDER_HTML_WINDOW_DEFAULT_HEIGHT,
    ),
    allowScripts: candidate.allowScripts === true,
    warnings,
  };
}
