# Project Insights Reference Notes

## Source

- https://agent-connector.ai/coverage

## Relevant Reference Signals

- Per-project data should be keyed by stable project identity, such as a git remote or normalized path.
- Token telemetry should be available by default and should keep host, model, and per-project analysis separable.
- Windows support should avoid POSIX-only assumptions and should use safe process/path handling.
- Host-agent CLI coverage is strongest when the host surfaces are normalized while each host keeps its native escape hatch.

## LVIS Application Mapping

- Project identity is persisted on chat session metadata as `projectRoot` and `projectName`, then reused by session listing and sidebar grouping.
- Insights replaces the old starred-only view and combines calendar selection, daily conversations, starred items, token usage, and an LLM-generated daily summary with deterministic fallback.
- The renderer does not call providers directly. The daily summary request is routed through guarded IPC to the main-process `ConversationLoop.generateText` path.
- The chat-top calendar chip is no longer visible in the compact chat chrome; the calendar surface lives in Insights/search-oriented flows.

## Follow-Up Direction

- Normalize project identity from git remotes when a workspace root has one, while retaining normalized path as a Windows-safe fallback.
- Extend Insights filters by host surface or agent CLI once LVIS records external host/CLI provenance per turn.
