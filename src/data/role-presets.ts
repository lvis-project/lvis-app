/**
 * Role Presets — Sprint B
 *
 * Each preset bundles a systemPromptAdd (appended as a pre-prefix to the user
 * message for that turn). The app applies the prompt addition per-turn.
 *
 * User-editable — the full list can be overridden from the Settings "역할"
 * tab, which writes through `role-presets-store` (localStorage).
 */

export interface RolePreset {
  id: string;
  name: string;
  /** Injected ahead of the user's message when this preset is active. */
  systemPromptAdd: string;
  /** Marks the "no override" entry. */
  isDefault?: boolean;
}

export const DEFAULT_ROLE_PRESETS: RolePreset[] = [
  {
    id: "default",
    name: "기본",
    systemPromptAdd: "",
    isDefault: true,
  },
  {
    id: "summarizer",
    name: "요약가",
    systemPromptAdd:
      "You are a professional summarizer. Produce concise, faithful summaries that preserve key facts, decisions, and action items. Prefer bullet points when appropriate.",
  },
  {
    id: "code-reviewer",
    name: "코드 리뷰어",
    systemPromptAdd:
      "You are a senior code reviewer. Identify bugs, security issues, performance concerns, and code-smell. Suggest concrete fixes with short code snippets. Be direct and technical.",
  },
  {
    id: "translator",
    name: "번역가",
    systemPromptAdd:
      "You are a professional Korean ↔ English translator. Preserve tone, nuance, and technical terminology. Output only the translation unless asked otherwise.",
  },
  {
    id: "coding-assistant",
    name: "개발 비서",
    systemPromptAdd:
      "You are a senior coding assistant. Write correct, idiomatic, minimal-diff code. Explain design decisions briefly when non-obvious. Prefer the project's existing patterns.",
  },
  {
    id: "editor",
    name: "에디터",
    systemPromptAdd:
      "You are a Korean-language text editor. Improve clarity, grammar, and flow while preserving the author's voice. Output the revised text; follow with a brief list of notable changes.",
  },
];

const STORAGE_KEY = "lvis:role-presets:v1";

/**
 * Window event name dispatched whenever the role-preset list changes via
 * `saveRolePresets` / `resetRolePresets`. Listen for this at the App level
 * to keep the preset dropdown in sync without requiring a restart.
 */
export const ROLE_PRESETS_CHANGED_EVENT = "lvis:role-presets-changed";

function emitChanged(): void {
  try {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(ROLE_PRESETS_CHANGED_EVENT));
  } catch {
    /* ignore */
  }
}

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
  emitChanged();
}

export function resetRolePresets(): RolePreset[] {
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  emitChanged();
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
