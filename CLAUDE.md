# LVIS App (Host) — Claude Code Directives

## Architecture Reference

This is the Electron host app. ALL implementation follows `docs/architecture/architecture.md` (v4 Final).
Always check `../TODO.md` for current status across all components.

## Project Structure

See `docs/architecture/architecture.md` §4.6 and `docs/blueprints/phase3-folder-refactor-plan.md` for the canonical layout and module boundary rules.

```
src/
  main.ts                     — Electron entry point
  boot.ts                     — §4.2 Boot Sequence (service init, plugin loading)
  ipc-bridge.ts               — All IPC handlers (settings, chat, memory, plugins, tasks)
  preload.ts / preload.cjs    — Electron preload scripts
  renderer.tsx                — React UI (chat, vendor selector, tool display)
  plugin-ui-host.tsx          — Dynamic plugin UI mounting

  engine/                     — Agent loop + LLM providers (was src/agent/)
    conversation-loop.ts      — §4.5 Core agentic cycle (stream + tool loop)
    conversation-history.ts   — In-memory message management
    auto-compact.ts           — Token-aware history compression
    llm/
      types.ts                — Vendor-agnostic LLM interfaces
      claude-provider.ts      — Anthropic SDK
      openai-provider.ts      — OpenAI SDK (+ reasoning models)
      gemini-provider.ts      — Google Generative AI
      provider-factory.ts     — Vendor selection factory

  tools/                      — 1-file-per-tool (Tier S3 BaseTool pattern)
    executor.ts               — §4.5.6 8-step pipeline with hooks (was tool-executor.ts)
    knowledge-search.ts       — LLM agentic knowledge search (was knowledge-search-tool.ts)

  prompts/                    — System prompt assembly
    system-prompt-builder.ts  — §4.5.9 12-source prompt assembly

  hooks/                      — PreTool / PostTool interception
    hook-runner.ts            — Pre/Post tool execution hooks
    post-turn-hook-chain.ts   — compact → save → extract → audit → idle-poke

  permissions/                — Full permission stack (was partly in core/, partly in agent/)
    permission-manager.ts     — §6.3 Source-aware permission model
    permissions-store.ts      — ~/.lvis/permissions.json persistence
    policy-store.ts           — Admin policy + governance rules
    approval-gate.ts          — §8 Layer 3 ask-user modal gate
    agent-action-requester.ts — §8 Agent Hub approval caller skeleton

  sandbox/                    — Path boundary enforcement (Tier A3 — placeholder)

  memory/                     — §5 File-based memory (~/.lvis/)
    memory-manager.ts

  audit/                      — Audit logger + DLP filter (was in agent/)
    audit-logger.ts
    dlp-filter.ts

  core/                       — Remaining cross-cutting engines
    keyword-engine.ts         — §6.1 Input classification
    route-engine.ts           — §6.2 Routing resolution
    tool-registry.ts          — §6.4 Unified tool registry (deprecated by tools/base.ts eventually)
    proactive-engine.ts       — §7 Proactive briefing

  mcp/                        — Model Context Protocol client (unchanged)

  plugins/                    — Plugin runtime (was plugin-runtime/)
    types.ts                  — PluginManifest, HostApi, RuntimePlugin
    runtime.ts                — Plugin loading, HostApi injection
    marketplace.ts            — Install/remove plugins
    registry.ts               — Plugin registry file management
    deployment-guard.ts       — Deployment mode enforcement

  data/
    settings-store.ts         — Multi-vendor settings + encrypted API keys

  main/                       — Electron main-process helpers (corp-ca, python-runtime, ...)
  lib/                        — Pure TS utilities (approval-queue-reducer, utils)
  components/ui/              — shadcn
  ui/                         — LVIS-custom UI components/views
```

## Key Principles

1. **NO plugin-specific code in host** — All plugin integration via HostApi self-registration
2. **Two naming namespaces** — Plugin IDs use dot format (`com.lge.meeting-recorder`); LLM tool names use underscore-only (`meeting_start`). No runtime conversion — methods must be declared in underscore form in the manifest.
3. **Multi-vendor LLM** — GenericMessage abstraction, never vendor-specific in core logic
4. **Config wildcard** — `configOverrides["*"]` passes API keys to all plugins

## Build

```bash
npm run build          # TypeScript + esbuild renderer + Tailwind CSS
npm run start          # Full build + Electron launch
npm run prepare:plugins  # Build all 3 plugins in parallel
```

## TODO Tracking

Always update `../TODO.md` when completing or discovering work items.
Relevant sections: 1 (Boot), 2 (ConversationLoop), 6 (Core Engines), 9 (Plugin System), 10 (LLM), 11 (Memory), 12 (UI).
