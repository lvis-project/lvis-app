# Project Insights Reference Notes

## Source

- https://agent-connector.ai/coverage
- https://code.claude.com/docs/en/memory
- https://goose-docs.ai/docs/guides/managing-projects/
- https://opencode.ai/docs/config/
- https://opencode.ai/docs/permissions/
- https://code.visualstudio.com/docs/editing/workspaces/workspaces

## Relevant Reference Signals

- Per-project data should be keyed by stable project identity, such as a git remote or normalized path.
- Token telemetry should be available by default and should keep host, model, and per-project analysis separable.
- Windows support should avoid POSIX-only assumptions and should use safe process/path handling.
- Host-agent CLI coverage is strongest when the host surfaces are normalized while each host keeps its native escape hatch.
- CLI-style agents commonly derive project context from the process working directory. Claude Code loads project files by walking up from the current working directory, goose CLI records the current directory as a project, and OpenCode looks for per-project config from the current directory toward the nearest git root.
- Desktop applications need a different fallback. VS Code can have an empty window with no folder, but LVIS product semantics require a project identity for memory, conversations, work-board history, and permissions. Therefore "no selected project" is a transient UI state only.

## LVIS Application Mapping

- Project identity is persisted on chat session metadata as `projectRoot` and `projectName`, then reused by session listing and sidebar grouping.
- When the user has not explicitly selected a project, new LVIS desktop conversations bind to the app-managed default workspace project, not to the app process current working directory.
- Explicit renderer-supplied project roots must resolve through the authorized workspace project list before they can scope memory, session history, work-board items, or tool-access directories. Unauthorized roots fail closed instead of silently becoming the default workspace.
- Legacy records without `projectRoot` are treated as default-workspace history only where compatibility requires it, via default-project `includeUnscoped` reads.
- Insights replaces the old starred-only view and combines calendar selection, daily conversations, starred items, token usage, and an LLM-generated daily summary with deterministic fallback.
- The renderer does not call providers directly. The daily summary request is routed through guarded IPC to the main-process `ConversationLoop.generateText` path.
- The chat-top calendar chip is no longer visible in the compact chat chrome; the calendar surface lives in Insights/search-oriented flows.

## Follow-Up Direction

- Normalize project identity from git remotes when a workspace root has one, while retaining normalized path as a Windows-safe fallback.
- Extend Insights filters by host surface or agent CLI once LVIS records external host/CLI provenance per turn.
