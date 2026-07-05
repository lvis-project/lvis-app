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

## Public/External Build — Embedded Demo Activation Key Ban

`scripts/build-main-esbuild.mjs` can embed a demo activation key
(`LVIS_EMBED_DEMO_ACTIVATION` env, or an encrypted repo-root `.env.demo`) into
the packaged bundle so an internal-distribution build authenticates against
the internal Azure Foundry demo endpoint with zero user input. That safety
model depends entirely on the endpoint being reachable only from inside the
internal network (host-resolver-rules) — embedding the same key into a build
that reaches an external audience would collapse the codec's 2-factor
delivery to 1-factor for people outside that network boundary.

- `LVIS_DISTRIBUTION_CHANNEL` is the build-time signal for this. It defaults
  to `internal` when unset — every existing internal/CI/dev build keeps
  today's behavior unchanged.
- Setting `LVIS_DISTRIBUTION_CHANNEL=public` on a build whose environment
  also carries `LVIS_EMBED_DEMO_ACTIVATION` or a repo-root `.env.demo` fails
  the build immediately (`process.exit(1)`) with an actionable message,
  before any embed resolution happens.
- A public/external release pipeline MUST set `LVIS_DISTRIBUTION_CHANNEL=public`
  and MUST NOT provide either embed source. There is no override — the guard
  never silently drops the embed and continues; it fails the build so the
  misconfiguration is caught at build time, not in a later security review.
- Enforced in `scripts/build-main-esbuild.mjs` (`assertNoPublicEmbed`); the
  threat model is documented in `src/main/demo-embedded-activation.ts`.

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
