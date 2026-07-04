# Tool Governance

This English page is the canonical default entry for `architecture/tool-governance.md`. The preserved Korean source is available at [ko/architecture/tool-governance.md](../ko/architecture/tool-governance.md).

## Purpose

Architecture notes describe host boundaries, process ownership, permission seams, plugin contracts, and runtime data flow for the desktop app.

## When To Use This Page

Use this page when changing main-process services, renderer surfaces, plugin runtime contracts, storage layouts, or cross-process IPC.

## Current Contract

- English is the default language for app documentation, UI-facing examples, contributor guidance, and release operations.
- Korean material is retained under the mirrored `docs/ko` path for historical context, Korean review, and local product memory.
- If this page describes behavior that is enforced by code, the source files and tests remain the source of truth. Update both when the contract changes.
- Do not move Korean-only content back into the default documentation path; translate or summarize it here and keep the original mirror linked.

## Maintenance Checklist

- Preserve the host as the policy owner for permissions and audit.
- Keep renderer and plugin code behind explicit preload or HostApi contracts.
- Document storage and migration effects before changing paths.
- Update tests that encode architecture contracts.

## Related Entry Points

- [Documentation Home](../README.md)
- [Architecture Overview](../architecture/README.md)
- [Plugin Development Guide](../guides/plugin-development.md)
- [Korean Mirror](../ko/architecture/tool-governance.md)

## Update Notes

When updating this document, keep the English default useful on its own. The Korean mirror should preserve original review history, but reviewers should not need to open it just to understand the current app contract.
