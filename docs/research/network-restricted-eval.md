# Network Restricted Eval

This English page is the canonical default entry for `research/network-restricted-eval.md`. The preserved Korean source is available at [ko/research/network-restricted-eval.md](../ko/research/network-restricted-eval.md).

## Purpose

Research pages capture implementation options, constraints, and decisions that informed current app behavior.

## When To Use This Page

Use this page before re-opening a technical decision or replacing a runtime boundary.

## Current Contract

- English is the default language for app documentation, UI-facing examples, contributor guidance, and release operations.
- Korean material is retained under the mirrored `docs/ko` path for historical context, Korean review, and local product memory.
- If this page describes behavior that is enforced by code, the source files and tests remain the source of truth. Update both when the contract changes.
- Do not move Korean-only content back into the default documentation path; translate or summarize it here and keep the original mirror linked.

## Maintenance Checklist

- Separate observed facts from recommendations.
- Keep security and platform assumptions explicit.
- Point to current source files when research has been implemented.
- Move stale or superseded claims to the Korean mirror only if they are historical.

## Related Entry Points

- [Documentation Home](../README.md)
- [Architecture Overview](../architecture/README.md)
- [Plugin Development Guide](../guides/plugin-development.md)
- [Korean Mirror](../ko/research/network-restricted-eval.md)

## Update Notes

When updating this document, keep the English default useful on its own. The Korean mirror should preserve original review history, but reviewers should not need to open it just to understand the current app contract.
