export const TOOL_RESULT_READ_DEFAULT_CHARS = 3_000;
export const TOOL_RESULT_READ_MIN_CHARS = 500;
export const TOOL_RESULT_READ_MAX_CHARS = 5_000;
export const TOOL_RESULT_QUERY_MAX_CHARS = 500;
export const TOOL_RESULT_WIRE_MAX_CHARS = 3_000;
export const TOOL_RESULT_WIRE_PREVIEW_CHARS = 1_600;
const TOOL_RESULT_WIRE_PREVIEW_LINES = 80;

export interface BoundedTextWindow {
  startOffset: number;
  endOffset: number;
  nextOffset: number | null;
  hasMore: boolean;
  text: string;
}

export interface HeadTailPreview {
  head: string;
  tail: string;
  omittedChars: number;
}

/** Offsets use JavaScript string indices, but may not split a surrogate pair. */
export function isUnicodeBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}

export function containsUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function readBoundedTextWindow(
  text: string,
  startOffset: number,
  maxChars: number,
): BoundedTextWindow {
  let endOffset = Math.min(text.length, startOffset + maxChars);
  if (!isUnicodeBoundary(text, endOffset)) endOffset -= 1;
  const hasMore = endOffset < text.length;
  return {
    startOffset,
    endOffset,
    nextOffset: hasMore ? endOffset : null,
    hasMore,
    text: text.slice(startOffset, endOffset),
  };
}

function headEndForLines(text: string, endOffset: number, maxLines: number): number {
  let lines = 1;
  for (let i = 0; i < endOffset; i += 1) {
    if (text.charCodeAt(i) !== 10) continue;
    lines += 1;
    if (lines > maxLines) return i;
  }
  return endOffset;
}

function tailStartForLines(text: string, startOffset: number, maxLines: number): number {
  let lines = 1;
  for (let i = text.length - 1; i >= startOffset; i -= 1) {
    if (text.charCodeAt(i) !== 10) continue;
    lines += 1;
    if (lines > maxLines) return i + 1;
  }
  return startOffset;
}

export function buildHeadTailPreview(
  text: string,
  maxChars: number,
  maxLines = TOOL_RESULT_WIRE_PREVIEW_LINES,
): HeadTailPreview {
  if (maxChars <= 0) return { head: "", tail: "", omittedChars: text.length };
  const newlineCount = text.slice(0, maxChars + 1).split("\n").length - 1;
  if (text.length <= maxChars && newlineCount < maxLines) {
    return { head: text, tail: "", omittedChars: 0 };
  }

  let headEnd = Math.ceil(maxChars / 2);
  if (!isUnicodeBoundary(text, headEnd)) headEnd -= 1;
  headEnd = headEndForLines(text, headEnd, Math.ceil(maxLines / 2));
  let tailStart = text.length - (maxChars - headEnd);
  if (!isUnicodeBoundary(text, tailStart)) tailStart += 1;
  tailStart = tailStartForLines(text, tailStart, Math.floor(maxLines / 2));
  return {
    head: text.slice(0, headEnd),
    tail: text.slice(tailStart),
    omittedChars: tailStart - headEnd,
  };
}
