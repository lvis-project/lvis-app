# Vercel AI SDK Migration — Baseline Fixtures

Per `docs/references/vercel-ai-sdk-migration.md` §11.

## Format

Each fixture is a JSON file:

```json
{
  "name": "short-slug",
  "vendor": "claude | openai | gemini",
  "model": "claude-sonnet-4-6 | gpt-5.4-mini | gemini-2.5-flash",
  "prompt": "system prompt text",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "...", "toolCalls": [...] },
    { "role": "tool_result", "toolUseId": "...", "content": "..." }
  ],
  "tools": [
    { "name": "tool_name", "description": "...", "inputSchema": { ... } }
  ],
  "expectedEvents": [
    { "type": "reasoning_delta", "text": "..." },
    { "type": "text_delta", "text": "..." },
    { "type": "tool_call", "id": "...", "name": "...", "input": {} },
    { "type": "message_complete", "stopReason": "tool_use" }
  ]
}
```

## Planned fixtures (6 total; 2 per vendor)

Empty for now — populated as each phase lands.

- [ ] `claude-tool-call.json`        — single tool call + thinking blocks
- [ ] `claude-tool-loop.json`        — multi-turn tool use with signature echo
- [ ] `openai-reasoning-tool.json`   — gpt-5.x reasoning before tool
- [ ] `openai-plain-text.json`       — non-reasoning text-only
- [ ] `gemini-tool-call.json`        — single tool call
- [ ] `gemini-multiturn.json`        — follow-up with history

## Usage

Consumed by `src/engine/llm/vercel/__tests__/snapshot.test.ts` for L1–L4
parity checks against the legacy providers.
