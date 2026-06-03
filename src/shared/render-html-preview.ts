import { t } from "../i18n/index.js";

export const RENDER_HTML_WINDOW_MIN_WIDTH = 420;
export const RENDER_HTML_WINDOW_MAX_WIDTH = 1600;
export const RENDER_HTML_WINDOW_DEFAULT_WIDTH = 960;
export const RENDER_HTML_WINDOW_MIN_HEIGHT = 240;
export const RENDER_HTML_WINDOW_MAX_HEIGHT = 1400;
export const RENDER_HTML_WINDOW_DEFAULT_HEIGHT = 640;
export const RENDER_HTML_WINDOW_MAX_HTML_BYTES = 2 * 1024 * 1024;
export const RENDER_HTML_PARTITION = "lvis-render-html";

export const RENDER_HTML_THEME_TOKEN_NAMES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "border",
  "input",
  "ring",
  "destructive",
  "destructive-foreground",
  "warning",
  "success",
  "info",
] as const;

export type RenderHtmlThemeTokenName = (typeof RENDER_HTML_THEME_TOKEN_NAMES)[number];
export type RenderHtmlThemeTokens = Partial<Record<RenderHtmlThemeTokenName, string>>;

export type OpenHtmlPreviewWindowPayload = {
  title?: string;
  html: string;
  width?: number;
  height?: number;
  allowScripts?: boolean;
  requiresScripts?: boolean;
  warnings?: string[];
  themeTokens?: RenderHtmlThemeTokens;
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

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const DEFAULT_RENDER_HTML_THEME_TOKENS: Required<RenderHtmlThemeTokens> = {
  background: "0 0% 100%",
  foreground: "222.2 84% 4.9%",
  card: "0 0% 100%",
  "card-foreground": "222.2 84% 4.9%",
  primary: "338 78% 68%",
  "primary-foreground": "0 0% 100%",
  secondary: "210 40% 96.1%",
  "secondary-foreground": "222.2 47.4% 11.2%",
  muted: "210 40% 96.1%",
  "muted-foreground": "215.4 16.3% 46.9%",
  accent: "210 40% 96.1%",
  "accent-foreground": "222.2 47.4% 11.2%",
  border: "214.3 31.8% 91.4%",
  input: "214.3 31.8% 91.4%",
  ring: "338 78% 68%",
  destructive: "0 84.2% 60.2%",
  "destructive-foreground": "0 0% 100%",
  warning: "38 92% 50%",
  success: "142 71% 45%",
  info: "199 89% 48%",
};

function isSafeCssTokenValue(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 160 &&
    !/[;{}<>]/.test(trimmed) &&
    /^[\w\s.%#(),+\-/]+$/.test(trimmed)
  );
}

function normalizeThemeTokens(candidate: unknown): RenderHtmlThemeTokens | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const input = candidate as Record<string, unknown>;
  const out: RenderHtmlThemeTokens = {};
  for (const name of RENDER_HTML_THEME_TOKEN_NAMES) {
    const value = input[name];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!isSafeCssTokenValue(trimmed)) continue;
    out[name] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildRenderHtmlThemeStyle(themeTokens?: RenderHtmlThemeTokens): string {
  const merged = { ...DEFAULT_RENDER_HTML_THEME_TOKENS, ...(themeTokens ?? {}) };
  const declarations = RENDER_HTML_THEME_TOKEN_NAMES
    .map((name) => `--${name}:${merged[name]};`)
    .join("");
  return (
    `<style id="lvis-render-html-theme">` +
    `:root{${declarations}color-scheme:light dark;}` +
    `html,body{min-height:100%;background:hsl(var(--background));color:hsl(var(--foreground));}` +
    `body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}` +
    `</style>`
  );
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

export function wrapRenderHtmlDocument(
  html: string,
  allowScripts: boolean,
  themeTokens?: RenderHtmlThemeTokens,
): string {
  const cspMeta = buildRenderHtmlCspMeta(allowScripts);
  const themeStyle = buildRenderHtmlThemeStyle(themeTokens);
  const { head, body } = extractRenderHtmlDocumentParts(html);
  return `<!doctype html><html><head>${cspMeta}${themeStyle}${head}</head><body>${body}</body></html>`;
}

function buildRenderHtmlPreviewShellCspMeta(): string {
  const directives = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "frame-src 'self' data: about:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return `<meta http-equiv="Content-Security-Policy" content="${escapeMetaAttribute(directives)}">`;
}

function encodeUtf8Base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function buildRenderHtmlPreviewShell({
  html,
  title,
  allowScripts,
  requiresScripts,
  warnings,
  themeTokens,
}: {
  html: string;
  title?: string;
  allowScripts: boolean;
  requiresScripts: boolean;
  warnings?: string[];
  themeTokens?: RenderHtmlThemeTokens;
}): string {
  const scriptsBlockedDocument = wrapRenderHtmlDocument(html, false, themeTokens);
  const scriptsAllowedDocument = wrapRenderHtmlDocument(html, true, themeTokens);
  const shellTitle = title?.trim() || t("be_renderHtmlPreview.defaultTitle");
  const initialScriptsAllowed = allowScripts === true;
  const warningsHtml = warnings && warnings.length > 0
    ? `<div class="lvis-warning" title="${escapeHtmlText(warnings.join(", "))}">${escapeHtmlText(t("be_renderHtmlPreview.warningsPrefix"))}${escapeHtmlText(warnings.join(", "))}</div>`
    : "";

  return `<!doctype html><html><head>${buildRenderHtmlPreviewShellCspMeta()}<meta charset="utf-8"><title>${escapeHtmlText(shellTitle)}</title>${buildRenderHtmlThemeStyle(themeTokens)}<style>
body{display:flex;min-height:100vh;flex-direction:column;overflow:hidden;background:hsl(var(--background));color:hsl(var(--foreground));}
.lvis-toolbar{display:flex;min-height:48px;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid hsl(var(--border));background:hsl(var(--background) / .96);padding:0 14px;box-sizing:border-box;}
.lvis-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;}
.lvis-controls{display:flex;align-items:center;gap:10px;color:hsl(var(--muted-foreground));font-size:12px;}
.lvis-pill{display:inline-flex;align-items:center;border:1px solid hsl(var(--border));border-radius:999px;background:hsl(var(--muted) / .62);padding:4px 8px;font-size:11px;line-height:1;}
.lvis-switch{display:inline-flex;align-items:center;gap:8px;border:1px solid hsl(var(--border));border-radius:999px;background:hsl(var(--card));padding:4px 8px;color:hsl(var(--foreground));}
.lvis-switch input{width:32px;height:18px;accent-color:hsl(var(--primary));}
.lvis-switch strong{font-size:11px;font-weight:600;color:hsl(var(--primary));}
.lvis-warning{border-bottom:1px solid hsl(var(--border));background:hsl(var(--warning) / .1);color:hsl(var(--foreground));padding:6px 14px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.lvis-frame{min-height:0;flex:1;border:0;background:hsl(var(--background));}
</style></head><body data-script-enabled="${initialScriptsAllowed ? "true" : "false"}">
<div class="lvis-toolbar">
  <div class="lvis-title">${escapeHtmlText(shellTitle)}</div>
  <div class="lvis-controls">
    <span class="lvis-pill">${escapeHtmlText(t("be_renderHtmlPreview.networkBlocked"))}</span>
    ${requiresScripts ? `<label class="lvis-switch"><span>JavaScript</span><input data-render-html-script-toggle type="checkbox" ${initialScriptsAllowed ? "checked" : ""}><strong data-render-html-script-state>${initialScriptsAllowed ? escapeHtmlText(t("be_renderHtmlPreview.jsAllowed")) : escapeHtmlText(t("be_renderHtmlPreview.jsBlocked"))}</strong></label>` : `<span class="lvis-pill">${escapeHtmlText(t("be_renderHtmlPreview.jsNone"))}</span>`}
  </div>
</div>
${warningsHtml}
<iframe data-render-html-frame class="lvis-frame" title="${escapeHtmlText(shellTitle)}" sandbox=""></iframe>
<script>
(() => {
  const documents = {
    scriptsBlocked: "${encodeUtf8Base64(scriptsBlockedDocument)}",
    scriptsAllowed: "${encodeUtf8Base64(scriptsAllowedDocument)}",
  };
  const frame = document.querySelector("[data-render-html-frame]");
  const toggle = document.querySelector("[data-render-html-script-toggle]");
  const state = document.querySelector("[data-render-html-script-state]");
  const decode = (value) => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };
  const render = (allowScripts) => {
    if (!frame) return;
    if (allowScripts) frame.setAttribute("sandbox", "allow-scripts");
    else frame.setAttribute("sandbox", "");
    frame.srcdoc = decode(allowScripts ? documents.scriptsAllowed : documents.scriptsBlocked);
    document.body.dataset.scriptEnabled = allowScripts ? "true" : "false";
    if (toggle) toggle.checked = allowScripts;
    if (state) state.textContent = allowScripts ? "${escapeHtmlText(t("be_renderHtmlPreview.jsAllowed"))}" : "${escapeHtmlText(t("be_renderHtmlPreview.jsBlocked"))}";
  };
  if (toggle) toggle.addEventListener("change", (event) => render(event.currentTarget.checked));
  render(${initialScriptsAllowed ? "true" : "false"});
})();
</script>
</body></html>`;
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
    requiresScripts: candidate.requiresScripts === true,
    warnings,
    themeTokens: normalizeThemeTokens(candidate.themeTokens),
  };
}
