# Release Process

This English page is the canonical default entry for `development/release-process.md`. The preserved Korean source is available at [ko/development/release-process.md](../ko/development/release-process.md).

## Purpose

Development notes capture maintenance policies, verification discipline, theme contracts, release flow, and cleanup rules for app contributors.

## When To Use This Page

Use this page before changing shared development workflows, generated assets, test gates, or theme/design primitives.

## Current Contract

- English is the default language for app documentation, UI-facing examples, contributor guidance, and release operations.
- Korean material is retained under the mirrored `docs/ko` path for historical context, Korean review, and local product memory.
- If this page describes behavior that is enforced by code, the source files and tests remain the source of truth. Update both when the contract changes.
- Do not move Korean-only content back into the default documentation path; translate or summarize it here and keep the original mirror linked.

## Maintenance Checklist

- Keep policy language enforceable by tests or CI where possible.
- Avoid process labels that naming-gate blocks in production docs.
- Separate current requirements from historical notes.
- Update the corresponding app scripts or tests when policy changes.

## Related Entry Points

- [Documentation Home](../README.md)
- [Architecture Overview](../architecture/README.md)
- [Plugin Development Guide](../guides/plugin-development.md)
- [Korean Mirror](../ko/development/release-process.md)

## Update Notes

When updating this document, keep the English default useful on its own. The Korean mirror should preserve original review history, but reviewers should not need to open it just to understand the current app contract.
