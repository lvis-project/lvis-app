# Overlay Trigger

This English page is the canonical default entry for `references/overlay-trigger.md`. The preserved Korean source is available at [ko/references/overlay-trigger.md](../ko/references/overlay-trigger.md).

## Purpose

Reference pages document stable contracts that other code, tests, plugins, or operators rely on.

## When To Use This Page

Use this page to understand behavior that must remain compatible across app releases.

## Current Contract

- English is the default language for app documentation, UI-facing examples, contributor guidance, and release operations.
- Korean material is retained under the mirrored `docs/ko` path for historical context, Korean review, and local product memory.
- If this page describes behavior that is enforced by code, the source files and tests remain the source of truth. Update both when the contract changes.
- Do not move Korean-only content back into the default documentation path; translate or summarize it here and keep the original mirror linked.

## Maintenance Checklist

- Name the source of truth and the dependent tests.
- Describe compatibility expectations and migration rules.
- Keep examples English-first and deterministic.
- Preserve Korean source history in the mirror.

## Related Entry Points

- [Documentation Home](../README.md)
- [Architecture Overview](../architecture/README.md)
- [Plugin Development Guide](../guides/plugin-development.md)
- [Korean Mirror](../ko/references/overlay-trigger.md)

## Update Notes

When updating this document, keep the English default useful on its own. The Korean mirror should preserve original review history, but reviewers should not need to open it just to understand the current app contract.
