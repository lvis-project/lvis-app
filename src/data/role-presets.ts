/**
 * Role Presets — Sprint B
 *
 * Each preset bundles a systemPromptAdd (appended as a pre-prefix to the user
 * message for that turn), a recommended reasoning effort level, and a
 * temperature hint. The app applies the prompt addition per-turn; effort /
 * temperature are advisory hints surfaced in the UI for future wiring.
 *
 * User-editable — the full list can be overridden from the Settings "역할"
 * tab, which writes through `role-presets-store` (localStorage).
 */

export type ReasoningEffort = "low" | "medium" | "high";

export interface RolePreset {
  id: string;
  name: string;
  /** Injected ahead of the user's message when this preset is active. */
  systemPromptAdd: string;
  /** Advisory — UI surfaces the hint; engine wiring is follow-up. */
  effort: ReasoningEffort;
  /** Advisory — 0.0 ~ 1.0. */
  temperature: number;
  /** Marks the "no override" entry. */
  isDefault?: boolean;
}

export const DEFAULT_ROLE_PRESETS: RolePreset[] = [
  {
    id: "default",
    name: "기본",
    systemPromptAdd: "",
    effort: "medium",
    temperature: 0.7,
    isDefault: true,
  },
  {
    id: "summarizer",
    name: "요약가",
    systemPromptAdd:
      "You are a professional summarizer. Produce concise, faithful summaries that preserve key facts, decisions, and action items. Prefer bullet points when appropriate.",
    effort: "low",
    temperature: 0.3,
  },
  {
    id: "code-reviewer",
    name: "코드 리뷰어",
    systemPromptAdd:
      "You are a senior code reviewer. Identify bugs, security issues, performance concerns, and code-smell. Suggest concrete fixes with short code snippets. Be direct and technical.",
    effort: "high",
    temperature: 0.5,
  },
  {
    id: "translator",
    name: "번역가",
    systemPromptAdd:
      "You are a professional Korean ↔ English translator. Preserve tone, nuance, and technical terminology. Output only the translation unless asked otherwise.",
    effort: "medium",
    temperature: 0.3,
  },
  {
    id: "coding-assistant",
    name: "개발 비서",
    systemPromptAdd:
      "You are a senior coding assistant. Write correct, idiomatic, minimal-diff code. Explain design decisions briefly when non-obvious. Prefer the project's existing patterns.",
    effort: "high",
    temperature: 0.5,
  },
  {
    id: "editor",
    name: "에디터",
    systemPromptAdd:
      "You are a Korean-language text editor. Improve clarity, grammar, and flow while preserving the author's voice. Output the revised text; follow with a brief list of notable changes.",
    effort: "medium",
    temperature: 0.4,
  },
];

const STORAGE_KEY = "lvis:role-presets:v1";

export function loadRolePresets(): RolePreset[] {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return DEFAULT_ROLE_PRESETS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_ROLE_PRESETS;
    return parsed as RolePreset[];
  } catch {
    return DEFAULT_ROLE_PRESETS;
  }
}

export function saveRolePresets(list: RolePreset[]): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore quota / serialization errors */
  }
}

export function resetRolePresets(): RolePreset[] {
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return DEFAULT_ROLE_PRESETS;
}

/**
 * Build the injected prefix for a user turn. Returns empty string for the
 * default preset so the message flows through unchanged.
 */
export function buildPresetPrefix(preset: RolePreset | null | undefined): string {
  if (!preset || preset.isDefault || !preset.systemPromptAdd) return "";
  return `[Role: ${preset.name}]\n${preset.systemPromptAdd}\n\n`;
}
