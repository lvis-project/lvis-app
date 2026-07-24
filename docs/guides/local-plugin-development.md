# Local Plugin Development

Status: Active English default. The Korean archive keeps earlier review history and original discussion, but this page must be usable on its own.

Korean archive: [docs/ko mirror](../ko/guides/local-plugin-development.md).

## What This Page Owns

This page owns the local plugin authoring loop, manifest shape, HostApi use, UI actions, and reload behavior. Use it as the first review surface when changing this area; use the archive for background, not as a substitute for current English guidance.

## Current Operating Contract

- English is the default review and contributor language for this app surface.
- The document must name the behavior that still matters today, the code or test locations that enforce it, and the conditions that make the note stale.
- Source files and tests are authoritative when this prose and implementation disagree.
- Korean-only material stays in the mirrored archive unless it is translated or summarized here.

## Implementation Anchors

- `package.json`
- `src/plugins/public-contract.ts`
- `schemas/plugin-manifest.schema.json`
- `src/plugins/runtime/manifest-validation.ts`
- `src/main/`
- `src/ui/renderer/`

## Update Checklist

- State whether the document is active, implemented, superseded, or historical before adding new detail.
- Keep links relative to the current file depth; mirrored files under `docs/ko` need different paths from default docs.
- Add or update tests when a documented behavior is enforced by code.
- Remove template language and stale plan wording instead of carrying it forward.

## Related Entry Points

- [LVIS Project Documentation](../README.md)
- [Getting Started](./getting-started.md)

## Review Notes

This English page should let a reviewer understand scope, risk, and validation without opening the Korean archive. If the archive contains rationale that still matters, translate the relevant part into this page and keep the archive link as provenance.
