# Tool Result `kind` Sentinels

Some built-in tools return JSON payloads in their `output` field with a `kind`
sentinel that the renderer uses to discriminate among visual treatments. This
is a **cross-cutting contract** between `src/tools/*` (producers) and
`src/ui/renderer/components/*` (consumers). Adding, renaming, or removing a
sentinel requires updates on both sides in the same PR.

## Why a kind sentinel

Most tool results are plain text or JSON metadata that the renderer shows via
`ToolPayloadBlock`. A small subset of tools produce **structured payloads
intended for a custom UI**: an iframe preview, a unified diff card, etc. The
renderer needs an unambiguous discriminator so it can pick the right component
without guessing from path heuristics. The `kind` field is the discriminator,
namespaced with the `lvis.` prefix to avoid collisions with downstream tooling
or MCP server payloads.

## Registered sentinels

### `lvis.render_html`

| | |
|---|---|
| Producer | `src/tools/render-html.ts` — `render_html` tool |
| Consumer | `src/ui/renderer/components/HtmlPreview.tsx` via `parseRenderHtmlResult` |
| Parser | `src/ui/renderer/utils/html-preview.ts` |

```json
{
  "kind": "lvis.render_html",
  "title": "선택적 제목",
  "height": 360,
  "html": "<!doctype html>...",
  "warnings": ["removed <iframe>"]
}
```

Renderer mounts a `<webview>` with a CSP-restricted data: URL inside the
`lvis-render-html` partition. JavaScript execution is opt-in via the
`allowScripts` toggle when the payload contains `<script>` / `on*` handlers.

### `lvis.write_file`

| | |
|---|---|
| Producer | `src/tools/file-tools.ts` — `WriteFileTool` |
| Consumer | `src/ui/renderer/components/FileEditDiff.tsx` via `extractFileEditDiff` |
| Parser | `src/ui/renderer/utils/file-diff.ts` |

```json
{
  "kind": "lvis.write_file",
  "path": "/abs/path/to/file.ts",
  "bytes": 8421,
  "isNewFile": false,
  "truncated": false,
  "before": "/* original UTF-8 contents */",
  "after":  "/* contents now on disk */"
}
```

Fields:

- `path` — absolute resolved path on disk.
- `bytes` — full byte length of the new content (NOT the truncated preview).
- `isNewFile` — true when the target did not exist before the write. When
  true, `before` is absent (no prior content).
- `truncated` — true when either the prior file or the new content exceeded
  `WRITE_DIFF_PREVIEW_LIMIT` (4096 bytes per side). The `before` / `after`
  fields then carry only a leading slice; the renderer surfaces a `truncated`
  marker. See [issue #749] for the planned expand seam.
- `before` — UTF-8 prior content, omitted entirely when `isNewFile` is true
  OR when the prior file was binary / oversized.
- `after` — UTF-8 new content (possibly truncated at the cap).

Token budget: each side is capped at 4 KB (~1k tokens), giving a worst case
of ~2k tokens added to LLM history per `write_file` call.

## Adding a new sentinel

1. Define the type in `src/ui/renderer/types.ts` (`RenderHtmlPayload`-style).
2. Add a producer-side `kind` const in the tool that emits it. Choose a name
   under the `lvis.` namespace.
3. Add a parser util under `src/ui/renderer/utils/` that returns a typed
   payload or `null` and tolerates unknown / non-JSON results without throwing.
4. Wire the consumer into `ToolGroupCard` (both `SingleToolInline` and the
   group path) following the `htmlPreviews` / `fileDiffs` patterns.
5. Add unit tests for the parser (round-trip) + a renderer test for the
   consumer.
6. Update this document.

## Anti-patterns

- ❌ Discriminating on tool name + custom field shape — fragile when a tool's
  result evolves. Use `kind`.
- ❌ Using a non-namespaced sentinel like `"diff"` or `"html"` — collides
  with MCP server payloads and external tool result conventions.
- ❌ Including the full file contents unbounded — bloats LLM history without
  a bounded contract. Always cap and emit `truncated: true`.

[issue #749]: https://github.com/lvis-project/lvis-app/issues/749
