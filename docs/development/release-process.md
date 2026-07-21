# Release Process

Status: Active English default. The Korean archive keeps earlier review history and original discussion, but this page must be usable on its own.

Korean archive: [docs/ko mirror](../ko/development/release-process.md).

## What This Page Owns

This page owns release readiness, merge ordering, dependency bumps, lockfiles, CI checks, and post-merge evidence. Use it as the first review surface when changing this area; use the archive for background, not as a substitute for current English guidance.

## Current Operating Contract

- English is the default review and contributor language for this app surface.
- The document must name the behavior that still matters today, the code or test locations that enforce it, and the conditions that make the note stale.
- Source files and tests are authoritative when this prose and implementation disagree.
- Korean-only material stays in the mirrored archive unless it is translated or summarized here.

## Implementation Anchors

- `package.json`
- `bun.lock`
- `.github/workflows/`
- `scripts/`

## Immutable Public Tag Release Profile

The current public tag profile is deliberately **unsigned only**. The
`release-profile` job checks the tagged `package.json#lvisRelease` only after
checking out the immutable GitHub event SHA. It fails unless the tag is exactly
`v` plus `package.json.version`, `tagDistribution` is `public`, and `signing`
is `unsigned`.

- Tag installers are checked out at `github.sha`, verify `HEAD` matches that
  SHA, receive no signing credentials, and always
  use `--skip-code-sign`.
- Before a public tag is pushed, an active `v*` tag ruleset must prohibit
  creation, updates, and deletions, and permit bypass only for designated
  release operators. The workflow fails closed unless
  `github.ref_protected` is true, and the publisher re-reads the annotated
  tag's peeled commit through the GitHub API immediately before attaching the
  draft Release assets. It must still equal `github.sha`.
- `workflow_dispatch` remains a secret-free internal candidate and never
  creates a GitHub Release.
- The draft uses the tracked unsigned disclosure template. Before publication,
  the operator must replace both `PENDING` entries with the approval and
  deferred signed Windows-evidence reference. This is a manual publish gate.

A future signed/notarized release requires a separate reviewed workflow and
positive platform signature/notarization evidence. It must not be enabled by
adding secrets to this unsigned workflow.

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
