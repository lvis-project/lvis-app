// Pure parsing + highlight helpers.

import React from "react";
import type { RenderHtmlPayload } from "../types.js";
import {
  RENDER_HTML_DEFAULT_HEIGHT,
  RENDER_HTML_MAX_HEIGHT,
  RENDER_HTML_MIN_HEIGHT,
} from "../constants.js";

export function clampPreviewHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return RENDER_HTML_DEFAULT_HEIGHT;
  }
  return Math.min(
    RENDER_HTML_MAX_HEIGHT,
    Math.max(RENDER_HTML_MIN_HEIGHT, Math.floor(value)),
  );
}

export function parseRenderHtmlResult(raw: string | undefined): RenderHtmlPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { kind?: unknown }).kind === "lvis.render_html" &&
      typeof (parsed as { html?: unknown }).html === "string"
    ) {
      const p = parsed as RenderHtmlPayload;
      return { ...p, height: clampPreviewHeight(p.height) };
    }
  } catch {
    return null;
  }
  return null;
}

export function highlightText(
  text: string,
  query?: string,
  opts?: { caseSensitive?: boolean },
): React.ReactNode {
  if (!query || !text) return null;
  const caseSensitive = opts?.caseSensitive ?? false;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const found = haystack.indexOf(needle, i);
    if (found < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (found > i) parts.push(text.slice(i, found));
    parts.push(
      React.createElement(
        "mark",
        { key: found, className: "bg-emphasis/(--opacity-strong) text-foreground" },
        text.slice(found, found + query.length),
      ),
    );
    i = found + query.length;
  }
  return React.createElement(React.Fragment, null, ...parts);
}
