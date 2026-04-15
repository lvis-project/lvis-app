# LVIS App (Host) — Claude Code Directives

## Architecture Reference

This is the Electron host app. ALL implementation follows `docs/architecture/architecture.md` (v4 Final).
Always check `../TODO.md` for current status across all components.

## Project Structure

```
src/
  main.ts                     — Electron entry point
  boot.ts                     — §4.2 Boot Sequence (service init, plugin loading)
  ipc-bridge.ts               — All IPC handlers (settings, chat, memory, plugins, tasks)
  preload.ts / preload.cjs    — Electron preload scripts
  renderer.tsx                — React UI (chat, vendor selector, tool display)
  plugin-ui-host.tsx          — Dynamic plugin UI mounting

  agent/
    conversation-loop.ts      — §4.5 Core agentic cycle (stream + tool loop)
    system-prompt-builder.ts  — §4.5.9 12-source prompt assembly
    conversation-history.ts   — In-memory message management
    tool-executor.ts          — §4.5.6 8-step pipeline with hooks
    hook-runner.ts            — Pre/Post tool execution hooks
    auto-compact.ts           — Token-aware history compression
    llm/
      types.ts                — Vendor-agnostic LLM interfaces
      claude-provider.ts      — Anthropic SDK
      openai-provider.ts      — OpenAI SDK (+ reasoning models)
      gemini-provider.ts      — Google Generative AI
      provider-factory.ts     — Vendor selection factory

  core/
    keyword-engine.ts         — §6.1 Input classification
    route-engine.ts           — §6.2 Routing resolution
    tool-registry.ts          — §6.4 Unified tool registry
    memory-manager.ts         — §5 File-based memory (~/.lvis/)

  data/
    settings-store.ts         — Multi-vendor settings + encrypted API keys

  plugin-runtime/
    types.ts                  — PluginManifest, HostApi, RuntimePlugin
    runtime.ts                — Plugin loading, HostApi injection
    marketplace.ts            — Install/remove plugins
    registry.ts               — Plugin registry file management
```

## Key Principles

1. **NO plugin-specific code in host** — All plugin integration via HostApi self-registration
2. **Tool names use underscore** — `meeting_start` not `meeting.start` (vendor compatibility)
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
