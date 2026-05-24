/**
 * Persona prompt selection types.
 *
 * User-editable persona prompt files live under `~/.lvis/prompts/*.md`.
 * The renderer keeps a synthetic "default" selection meaning "no persona".
 * Agent profiles and skills are intentionally not represented here.
 */

export interface RolePreset {
  id: string;
  name: string;
  /** Injected into the per-turn system prompt when this preset is active. */
  systemPromptAdd: string;
  /** Marks the "no override" entry. */
  isDefault?: boolean;
}

export const DEFAULT_PERSONA_SELECTION: RolePreset = {
  id: "default",
  name: "기본",
  systemPromptAdd: "",
  isDefault: true,
};

export interface ActiveRolePrompt {
  id?: string;
  name: string;
  systemPromptAdd: string;
}

/**
 * Build the selected persona prompt identifier for the chat IPC boundary.
 * The renderer must not send prompt bodies into the main process; the main
 * process resolves the id against `PersonaPromptStore` at turn start.
 */
export function buildActivePersonaPromptId(preset: RolePreset | null | undefined): string | null {
  const id = preset?.id.trim();
  if (!preset || preset.isDefault || !id || id === DEFAULT_PERSONA_SELECTION.id) return null;
  return id;
}
