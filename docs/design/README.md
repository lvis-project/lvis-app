# Design

Status: Active English default. The Korean archive keeps earlier review history and original discussion, but this page must be usable on its own.

Korean archive: [docs/ko mirror](../ko/design/README.md).

## What This Page Owns

This page owns the current contract for Design. Use it as the first review surface when changing this area; use the archive for background, not as a substitute for current English guidance.

## Current Operating Contract

- English is the default review and contributor language for this app surface.
- The document must name the behavior that still matters today, the code or test locations that enforce it, and the conditions that make the note stale.
- Source files and tests are authoritative when this prose and implementation disagree.
- Korean-only material stays in the mirrored archive unless it is translated or summarized here.

## Pages In This Directory

- [Tiled chat groups](./tiled-chat-groups.md) — the source of truth for the main area's workbench model: up to four framed chat groups in work mode and one in chat mode, what is per group and what is per window, how `lvis:chat:*` divides along that line, the split tree and its geometry, edge drops, gutter resizing, and the shape the work panel takes inside a tile. Change this page in the same commit that changes that behavior.
- The `.html` files here are static mockups kept as provenance for reviews that have already landed. They record a proposal at the time it was made and are not maintained against the shipped UI; read the markdown pages and the source for current behavior.

## Implementation Anchors

- `src/ui/renderer/components/ChatGroupFrame.tsx` — the frame, its header controls, the split tree, and the shared conversation action set
- `src/ui/renderer/App.tsx` — tile layout, focus, and the wiring from the sidebar to the tile holding a session
- `src/ui/renderer/components/Sidebar.tsx` — the Features and Plugins nav groups, each a flyout anchored to its row (the collapsed rail opens the same flyout from its icon; only the projects folder icon expands the sidebar), conversation and project rows, their actions, and the reveal-on-scroll list
- `src/ui/renderer/components/ChatSidePanel.tsx` — the work panel card and its tabs
- `src/ui/renderer/tabs/`
- `src/ui/renderer/__tests__/`

## Update Checklist

- State whether the document is active, implemented, superseded, or historical before adding new detail.
- Keep links relative to the current file depth; mirrored files under `docs/ko` need different paths from default docs.
- Add or update tests when a documented behavior is enforced by code.
- Remove template language and stale plan wording instead of carrying it forward.

## Related Entry Points

- [LVIS Project Documentation](../README.md)
- [Getting Started](../guides/getting-started.md)

## Review Notes

This English page should let a reviewer understand scope, risk, and validation without opening the Korean archive. If the archive contains rationale that still matters, translate the relevant part into this page and keep the archive link as provenance.
