import { useEffect, useState, type ComponentType } from "react";
import ReactMarkdown from "react-markdown";
import { useTranslation } from "../../../i18n/react.js";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";
import { wrapRenderHtmlInlineFrameDocument } from "../../../shared/render-html-preview.js";

/**
 * Progressive file/text viewer registry (§6.10.6). A descriptor (text + an
 * optional path/mime hint) resolves to the first matching renderer; `text` is
 * the always-true fallback. New renderers are added by pushing to REGISTRY —
 * the PreviewBody call site never changes.
 *
 * Security posture:
 *  - markdown uses react-markdown v10 (raw HTML is inert text without
 *    rehype-raw, which is DELIBERATELY not added; unsafe URL protocols are
 *    stripped by react-markdown's defaultUrlTransform). Links are rendered
 *    non-navigating so a preview can never hijack the renderer window.
 *  - mermaid renders in the parent (securityLevel:'strict' -> DOMPurify) to a
 *    static SVG, then displays it inside the CSP-locked, script-less,
 *    sandbox="" inline-frame shell (no network, no scripts). mermaid itself is
 *    a local webpack chunk (lazy import) — no external CDN.
 */
export interface PreviewContentDescriptor {
  text: string;
  path?: string;
  mimeType?: string;
  filename?: string;
}

export type PreviewRenderKind = "text" | "markdown" | "mermaid";

export interface PreviewRenderer {
  kind: PreviewRenderKind;
  match: (descriptor: PreviewContentDescriptor) => boolean;
  Component: ComponentType<{ descriptor: PreviewContentDescriptor }>;
}

function extensionOf(descriptor: PreviewContentDescriptor): string {
  const source = descriptor.path ?? descriptor.filename ?? "";
  const base = source.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function TextRenderer({ descriptor }: { descriptor: PreviewContentDescriptor }) {
  return (
    <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/(--opacity-muted) p-3 font-mono text-[11px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
      {descriptor.text}
    </pre>
  );
}

let mermaidIdCounter = 0;

function MermaidBlock({ code }: { code: string }) {
  const { t } = useTranslation();
  const [svgDoc, setSvgDoc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvgDoc(null);
    setFailed(false);
    void (async () => {
      try {
        const mermaid = (await import(/* webpackChunkName: "mermaid" */ "mermaid")).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
        const id = `lvis-mermaid-${mermaidIdCounter++}`;
        const { svg } = await mermaid.render(id, code);
        if (cancelled) return;
        // No bindFunctions() call — interaction/scripts stay disabled. The SVG
        // is displayed in the script-less, no-network sandboxed inline frame.
        setSvgDoc(wrapRenderHtmlInlineFrameDocument(svg, { allowScripts: false }));
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) {
    // Never blank: fall back to the raw fenced source (§6.10.6).
    return (
      <div className="space-y-1" data-testid="chat-side-panel-mermaid-fallback">
        <div className="text-[11px] text-muted-foreground">{t("chatPreviewRail.diagramRenderFailed")}</div>
        <pre className="max-h-[24rem] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/(--opacity-muted) p-3 font-mono text-[11px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
          {code}
        </pre>
      </div>
    );
  }
  if (!svgDoc) {
    return <div className="text-xs text-muted-foreground">{t("chatPreviewRail.diagramRendering")}</div>;
  }
  return (
    <iframe
      data-testid="chat-side-panel-mermaid-frame"
      title="mermaid diagram"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={svgDoc}
      className="block max-h-[36rem] min-h-40 w-full rounded-md border-0 bg-background"
    />
  );
}

function MarkdownRenderer({ descriptor }: { descriptor: PreviewContentDescriptor }) {
  return (
    <div className="markdown-body max-h-[36rem] overflow-auto rounded-md border bg-background p-3 text-sm [overflow-wrap:anywhere]" data-testid="chat-side-panel-markdown">
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        components={{
          code({ className, children, ...props }) {
            if (className === "language-mermaid") {
              return <MermaidBlock code={String(children).replace(/\n$/, "")} />;
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          // Links never navigate the renderer window from a preview surface.
          a({ href, children }) {
            return (
              <a href={href} onClick={(event) => event.preventDefault()} className="underline">
                {children}
              </a>
            );
          },
        }}
      >
        {descriptor.text}
      </ReactMarkdown>
    </div>
  );
}

const textRenderer: PreviewRenderer = {
  kind: "text",
  match: () => true,
  Component: TextRenderer,
};

const markdownRenderer: PreviewRenderer = {
  kind: "markdown",
  match: (descriptor) => {
    const ext = extensionOf(descriptor);
    return ext === "md" || ext === "markdown" || descriptor.mimeType === "text/markdown";
  },
  Component: MarkdownRenderer,
};

const mermaidRenderer: PreviewRenderer = {
  kind: "mermaid",
  match: (descriptor) => {
    const ext = extensionOf(descriptor);
    return ext === "mmd" || ext === "mermaid";
  },
  Component: ({ descriptor }) => <MermaidBlock code={descriptor.text} />,
};

// Ordered — first match wins; `text` is always last (always-true fallback).
const REGISTRY: readonly PreviewRenderer[] = [mermaidRenderer, markdownRenderer, textRenderer];

export function resolvePreviewRenderer(descriptor: PreviewContentDescriptor): PreviewRenderer {
  return REGISTRY.find((renderer) => renderer.match(descriptor)) ?? textRenderer;
}

/** Render `descriptor` with the resolved renderer. Single PreviewBody call site. */
export function PreviewContent({ descriptor }: { descriptor: PreviewContentDescriptor }) {
  const renderer = resolvePreviewRenderer(descriptor);
  return <renderer.Component descriptor={descriptor} />;
}
