/**
 * L1–L4 snapshot parity tests for VercelUnifiedProvider.
 *
 * Per docs/references/vercel-ai-sdk-migration.md §11:
 *   L1 — Structural: StreamEvent type sequence matches legacy provider
 *   L2 — Content:    text/reasoning concatenated output matches
 *   L3 — Tool:       tool_call id/name/input matches
 *   L4 — Signature:  assistant.thinkingBlocks (thinking + signature) round-trips
 *
 * All tests are `.todo` in P0. They will be filled as each vendor lands
 * (Anthropic P1, OpenAI P2, Gemini P3). Baselines live in
 * test/fixtures/vercel-migration/.
 */
import { describe, it } from "vitest";

describe("VercelUnifiedProvider — L1 structural parity", () => {
  it.todo("claude: StreamEvent order matches ClaudeProvider baseline");
  it.todo("openai: StreamEvent order matches OpenAIProvider baseline");
  it.todo("gemini: StreamEvent order matches GeminiProvider baseline");
});

describe("VercelUnifiedProvider — L2 content parity", () => {
  it.todo("claude: concatenated text_delta equals baseline");
  it.todo("openai: concatenated text_delta equals baseline");
  it.todo("gemini: concatenated text_delta equals baseline");
});

describe("VercelUnifiedProvider — L3 tool payload parity", () => {
  it.todo("claude: tool_call id/name/input matches baseline");
  it.todo("openai: tool_call id/name/input matches baseline (responses API)");
  it.todo("gemini: tool_call id/name/input matches baseline");
});

describe("VercelUnifiedProvider — L4 signature round-trip", () => {
  it.todo("claude: thinkingBlocks[].signature survives stream + echo");
});
