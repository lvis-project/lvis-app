// Phase 2: React-free constants extracted from src/renderer.tsx.

// ── Toast / Banner TTL ────────────────────────────────────────────────────────
/**
 * Default auto-dismiss duration for inline toasts and banners (ms).
 * Most callsites use 4 s; those that need a longer read window (complex
 * permission banners, MCP status) override explicitly with a comment.
 */
export const DEFAULT_TOAST_TTL_MS = 4000;

import type { ExecMode } from "./types.js";
import {
  LLM_VENDOR_DEFAULTS,
  LLM_VENDORS,
  type LLMVendor,
} from "../../shared/llm-vendor-defaults.js";

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

// Settings-dialog UI metadata per vendor. Typed as `Record<LLMVendor, ...>`
// so adding a new entry to `LLM_VENDORS` without updating this object is
// a compile error — keeps the dropdown in lockstep with the canonical
// vendor list. `defaultModel` derives from LLM_VENDOR_DEFAULTS so the
// placeholder stays in sync with the data layer's seed values.
interface VendorUiMeta {
  label: string;
  placeholder: string;
  needsBaseUrl: boolean;
  baseUrlPlaceholder?: string;
}

const VENDOR_UI: Record<LLMVendor, VendorUiMeta> = {
  claude: { label: "Anthropic Claude", placeholder: "sk-ant-...", needsBaseUrl: false },
  openai: { label: "OpenAI", placeholder: "sk-...", needsBaseUrl: false },
  gemini: { label: "Google Gemini", placeholder: "AIza...", needsBaseUrl: false },
  copilot: { label: "GitHub Copilot", placeholder: "ghp_...", needsBaseUrl: false },
  "azure-foundry": {
    label: "Azure AI Foundry",
    placeholder: "Azure API key...",
    needsBaseUrl: true,
    baseUrlPlaceholder: "https://{resource}.openai.azure.com/openai/deployments/{deployment}/",
  },
  "vertex-ai": {
    label: "Google Vertex AI",
    placeholder: "service account (unused — uses ADC)",
    needsBaseUrl: false,
  },
};

export const VENDORS = LLM_VENDORS.map((id) => ({
  id,
  ...VENDOR_UI[id],
  defaultModel: LLM_VENDOR_DEFAULTS[id].model,
}));

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
  { value: "default", label: "기본", description: "읽기 도구는 허용하고 변경·셸·네트워크는 승인 요청" },
  { value: "strict", label: "전체 물어보기", description: "읽기까지 포함해 모든 도구 실행 전 승인 요청" },
  { value: "auto", label: "자동 검증", description: "저위험 작업은 감사 기록으로 처리하고 헤드리스 작업은 백그라운드 리뷰어가 검증" },
  { value: "allow", label: "전체 허용", description: "하드 차단 밖 도구는 자동 허용하고 허용 디렉터리 밖 접근은 별도 승인" },
];

// Keep in sync with src/tools/render-html.ts — the server already clamps,
// but reloaded history could deliver forged/NaN values and we must not
// trust them at render time.
export const RENDER_HTML_MIN_HEIGHT = 80;
export const RENDER_HTML_MAX_HEIGHT = 1200;
export const RENDER_HTML_DEFAULT_HEIGHT = 400;

export const formatTaskSource = (source: string): string => SOURCE_LABEL[source] ?? source;
