// Phase 2: React-free constants extracted from src/renderer.tsx.

import type { ExecMode, Task } from "./types.js";

export const PRIORITY_CLASS: Record<Task["priority"], string> = {
  high: "text-red-400",
  medium: "text-amber-400",
  low: "text-slate-400",
};

export const SOURCE_LABEL: Record<string, string> = {
  email: "메일",
  meeting: "미팅",
  calendar: "일정",
  teams: "Teams",
  manual: "직접",
};

export const PRIORITY_EMOJI: Record<string, string> = {
  high: "🔴",
  medium: "🟡",
  low: "🔵",
};

export const SOURCE_BADGE: Record<string, string> = {
  builtin: "내장",
  plugin: "플러그인",
  mcp: "MCP",
};

export const VENDORS = [
  { id: "claude", label: "Anthropic Claude", placeholder: "sk-ant-...", defaultModel: "claude-sonnet-4-6", needsBaseUrl: false },
  { id: "openai", label: "OpenAI", placeholder: "sk-...", defaultModel: "gpt-4o", needsBaseUrl: false },
  { id: "gemini", label: "Google Gemini", placeholder: "AIza...", defaultModel: "gemini-2.0-flash", needsBaseUrl: false },
  { id: "copilot", label: "GitHub Copilot", placeholder: "ghp_...", defaultModel: "gpt-4o", needsBaseUrl: false },
  { id: "azure-foundry", label: "Azure AI Foundry", placeholder: "Azure API key...", defaultModel: "gpt-4o", needsBaseUrl: true, baseUrlPlaceholder: "https://{resource}.openai.azure.com/openai/deployments/{deployment}/" },
  { id: "vertex-ai", label: "Google Vertex AI", placeholder: "service account (unused — uses ADC)", defaultModel: "gemini-2.5-flash", needsBaseUrl: false },
] as const;

export const WEB_PROVIDERS = [
  { id: "duckduckgo", label: "DuckDuckGo", placeholder: "키 불필요", needsKey: false },
  { id: "tavily", label: "Tavily AI", placeholder: "tvly-...", needsKey: true },
  { id: "serper", label: "Serper.dev", placeholder: "키 입력...", needsKey: true },
  { id: "google", label: "Google Search", placeholder: "API Key...", needsKey: true },
] as const;

// Reasoning effort slider steps. Budget values are chosen to land cleanly in
// both `mapReasoningEffort()` (OpenAI: ≤3000=low, ≤8000=medium, >8000=high)
// and `mapBudgetToEffort()` (Claude adaptive: ≤3000=low, ≤6000=medium,
// ≤16000=high, >16000=max) in vercel/adapter.ts. Keep values in sync if those
// thresholds change.
export const REASONING_EFFORT_STEPS = [
  { label: "Low", budget: 2000 },
  { label: "Medium", budget: 6000 },
  { label: "High", budget: 12_000 },
  { label: "Max", budget: 24_000 },
] as const;

export function budgetToEffortIndex(budget: number): number {
  let closest = 0;
  let minDiff = Math.abs(REASONING_EFFORT_STEPS[0]!.budget - budget);
  for (let i = 1; i < REASONING_EFFORT_STEPS.length; i++) {
    const diff = Math.abs(REASONING_EFFORT_STEPS[i]!.budget - budget);
    if (diff < minDiff) {
      minDiff = diff;
      closest = i;
    }
  }
  return closest;
}

export const EXEC_MODE_OPTIONS: { value: ExecMode; label: string; description: string }[] = [
  { value: "default", label: "기본 (Default)", description: "위험한 도구만 승인 요구" },
  { value: "strict", label: "엄격 (Strict)", description: "모든 도구 승인 요구" },
  { value: "auto", label: "자동 (Auto)", description: "신뢰도 기반 자동 허용 (builtin 자동, plugin 승인, mcp 차단)" },
];

// Keep in sync with src/tools/render-html.ts — the server already clamps,
// but reloaded history could deliver forged/NaN values and we must not
// trust them at render time.
export const RENDER_HTML_MIN_HEIGHT = 80;
export const RENDER_HTML_MAX_HEIGHT = 1200;
export const RENDER_HTML_DEFAULT_HEIGHT = 400;

export const formatTaskSource = (source: string): string => SOURCE_LABEL[source] ?? source;
