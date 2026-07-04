# Design

This English page is the canonical default entry for `design/README.md`. The preserved Korean source is available at [ko/design/README.md](../ko/design/README.md).

## Purpose

Design artifacts define screen-level contracts, interaction states, and visual QA expectations for app surfaces.

## When To Use This Page

Use this page before changing renderer layout, dialogs, cards, or design-system primitives.

## Current Contract

- English is the default language for app documentation, UI-facing examples, contributor guidance, and release operations.
- Korean material is retained under the mirrored `docs/ko` path for historical context, Korean review, and local product memory.
- If this page describes behavior that is enforced by code, the source files and tests remain the source of truth. Update both when the contract changes.
- Do not move Korean-only content back into the default documentation path; translate or summarize it here and keep the original mirror linked.

## Maintenance Checklist

- Preserve test hooks and accessibility labels that tests rely on.
- Keep interaction states explicit.
- Avoid decorative-only changes without a workflow reason.
- Update screenshots or HTML artifacts when UI contracts change.

## Related Entry Points

- [Documentation Home](../README.md)
- [Architecture Overview](../architecture/README.md)
- [Plugin Development Guide](../guides/plugin-development.md)
- [Korean Mirror](../ko/design/README.md)

## Update Notes

When updating this document, keep the English default useful on its own. The Korean mirror should preserve original review history, but reviewers should not need to open it just to understand the current app contract.
