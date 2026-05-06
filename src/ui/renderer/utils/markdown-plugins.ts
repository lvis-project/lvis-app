// Shared remark plugin config for every ReactMarkdown surface in the
// renderer. All chat surfaces (assistant card, trigger card, imported
// trigger summary/response, routine card, etc.) MUST import from here so
// markdown behavior stays in lockstep — copying the tuple inline lets one
// component drift while the others stay correct.
//
// `singleTilde: false` forces strikethrough to require `~~text~~` (GFM
// standard). Without it remark-gfm renders `7~12℃` style ranges as a
// `<del>` between the tildes.

import remarkGfm from "remark-gfm";
import type { Options } from "react-markdown";

type MarkdownNode = {
  type?: string;
  value?: string;
  children?: MarkdownNode[];
  [key: string]: unknown;
};

/**
 * CommonMark leaves `**강조**로` as literal text because the closing marker is
 * followed by a Hangul postposition. Korean assistant prose naturally writes
 * that way, so normalize only still-literal text nodes after remark has parsed
 * the standard cases.
 */
export function remarkKoreanAdjacentStrong() {
  return (tree: MarkdownNode) => {
    transformChildren(tree);
  };
}

function transformChildren(node: MarkdownNode): void {
  if (!node.children) return;
  const next: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      next.push(...splitLiteralStrong(child.value));
      continue;
    }
    transformChildren(child);
    next.push(child);
  }
  node.children = next;
}

function splitLiteralStrong(value: string): MarkdownNode[] {
  const out: MarkdownNode[] = [];
  let cursor = 0;
  let changed = false;

  const appendText = (text: string) => {
    if (text.length > 0) out.push({ type: "text", value: text });
  };

  while (cursor < value.length) {
    const start = value.indexOf("**", cursor);
    if (start < 0) break;
    const end = value.indexOf("**", start + 2);
    if (end < 0) break;

    const inner = value.slice(start + 2, end);
    if (!inner.trim() || inner.trim() !== inner) {
      appendText(value.slice(cursor, start + 2));
      cursor = start + 2;
      continue;
    }

    appendText(value.slice(cursor, start));
    out.push({
      type: "strong",
      children: [{ type: "text", value: inner }],
    });
    cursor = end + 2;
    changed = true;
  }

  if (!changed) return [{ type: "text", value }];
  appendText(value.slice(cursor));
  return out;
}

// Use the type from `react-markdown` (a direct dependency) rather than
// `unified` (a transitive one) so the package boundary stays clean.
export const MARKDOWN_REMARK_PLUGINS: Options["remarkPlugins"] = [
  [remarkGfm, { singleTilde: false }],
  remarkKoreanAdjacentStrong,
];
