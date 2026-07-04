# Local Demo Setup

This English page is the canonical default entry for `onboarding/local-demo-setup.md`. The preserved Korean source is available at [ko/onboarding/local-demo-setup.md](../ko/onboarding/local-demo-setup.md).

## Purpose

Onboarding pages describe first-run activation, demo credentials, and local setup paths that help users reach a working app quickly.

## When To Use This Page

Use this page when changing login, demo activation, or first-run setup.

## Current Contract

- English is the default language for app documentation, UI-facing examples, contributor guidance, and release operations.
- Korean material is retained under the mirrored `docs/ko` path for historical context, Korean review, and local product memory.
- If this page describes behavior that is enforced by code, the source files and tests remain the source of truth. Update both when the contract changes.
- Do not move Korean-only content back into the default documentation path; translate or summarize it here and keep the original mirror linked.

## Maintenance Checklist

- Keep instructions safe for public docs.
- State what is stored locally and what is never committed.
- Verify copy against current UI labels.
- Keep fallbacks deterministic when network or credentials are missing.

## Related Entry Points

- [Documentation Home](../README.md)
- [Architecture Overview](../architecture/README.md)
- [Plugin Development Guide](../guides/plugin-development.md)
- [Korean Mirror](../ko/onboarding/local-demo-setup.md)

## Update Notes

When updating this document, keep the English default useful on its own. The Korean mirror should preserve original review history, but reviewers should not need to open it just to understand the current app contract.
