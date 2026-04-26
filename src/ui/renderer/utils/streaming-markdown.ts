// Streaming-safe markdown helpers.
//
// During an LLM stream, ReactMarkdown re-parses the partial text on every
// chunk. For an in-progress markdown link `[label](URL` (with the closing
// `)` not yet emitted), the parser falls back to literal text — and remark-gfm
// then autolinks the bare URL. The user sees:
//
//   [여기서 확인하세요](https://outlook.live.com/…%3D%3D&exvsurl=1&path=/calendar/item
//
// flash by as a giant base64-ish blob until the closing `)` arrives. For
// long URLs (Microsoft Graph webLinks especially) this looks broken to a
// user who happens to glance mid-stream.
//
// This helper rewrites the dangling tail to `[label](…)` so the URL is
// hidden until the link is structurally complete; the post-stream final
// render goes through the original (unmodified) text.

const DANGLING_LINK = /(\[[^\]\n]*\])\(([^)\n]*)$/;

export function clampDanglingMarkdownLink(text: string): string {
  return text.replace(DANGLING_LINK, "$1(…)");
}
