/**
 * Role Presets — Sprint B
 *
 * Each preset bundles a systemPromptAdd (appended as a pre-prefix to the user
 * message for that turn). The app applies the prompt addition per-turn.
 *
 * User-editable — the full list is stored in SettingsService.roles.presets.
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

export function cloneRolePresets(presets: RolePreset[]): RolePreset[] {
  return presets.map((preset) => ({ ...preset }));
}

export function cloneDefaultRolePresets(): RolePreset[] {
  return cloneRolePresets(DEFAULT_ROLE_PRESETS);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeRolePresets(input: unknown): RolePreset[] {
  if (!Array.isArray(input)) {
    return cloneDefaultRolePresets();
  }

  const seenIds = new Set<string>();
  const normalized: RolePreset[] = [];

  for (const item of input) {
    if (!item || typeof item !== "object") continue;

    const record = item as Partial<RolePreset>;
    const id = normalizeText(record.id);
    const name = normalizeText(record.name);
    if (!id || !name || seenIds.has(id)) continue;

    seenIds.add(id);
    normalized.push({
      id,
      name,
      systemPromptAdd: typeof record.systemPromptAdd === "string" ? record.systemPromptAdd : "",
      ...(record.isDefault ? { isDefault: true } : {}),
    });
  }

  if (normalized.length === 0) {
    return cloneDefaultRolePresets();
  }

  const defaultPreset = DEFAULT_ROLE_PRESETS.find((preset) => preset.id === "default");
  if (defaultPreset && !normalized.some((preset) => preset.id === "default")) {
    normalized.unshift({ ...defaultPreset });
  }

  return normalized;
}

/**
 * Build the injected prefix for a user turn. Returns empty string for the
 * default preset so the message flows through unchanged.
 */
export function buildPresetPrefix(preset: RolePreset | null | undefined): string {
  if (!preset || preset.isDefault || !preset.systemPromptAdd.trim()) return "";
  return `[Role: ${preset.name}]\n${preset.systemPromptAdd}\n\n`;
}
