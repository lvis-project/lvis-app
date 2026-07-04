# Windows Setup

This English page is the canonical default entry for `guides/windows-setup.md`. The preserved Korean source is available at [ko/guides/windows-setup.md](../ko/guides/windows-setup.md).

## Purpose

Guides are operator and contributor runbooks. They should describe the concrete commands, expected state, and verification evidence for app work.

## When To Use This Page

Use this page when onboarding contributors, publishing plugins, testing marketplace flows, or setting up Windows development.

## Current Contract

- English is the default language for app documentation, UI-facing examples, contributor guidance, and release operations.
- Korean material is retained under the mirrored `docs/ko` path for historical context, Korean review, and local product memory.
- If this page describes behavior that is enforced by code, the source files and tests remain the source of truth. Update both when the contract changes.
- Do not move Korean-only content back into the default documentation path; translate or summarize it here and keep the original mirror linked.

## Maintenance Checklist

- Prefer exact commands over narrative.
- Call out required environment variables and secrets without storing values.
- Keep verification steps current with package scripts.
- Link to the Korean mirror for historical context.

## Related Entry Points

- [Documentation Home](../README.md)
- [Architecture Overview](../architecture/README.md)
- [Plugin Development Guide](../guides/plugin-development.md)
- [Korean Mirror](../ko/guides/windows-setup.md)

## Update Notes

When updating this document, keep the English default useful on its own. The Korean mirror should preserve original review history, but reviewers should not need to open it just to understand the current app contract.
