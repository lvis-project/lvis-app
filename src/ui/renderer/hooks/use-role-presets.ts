import { useEffect, useMemo, useState } from "react";
import { DEFAULT_PERSONA_SELECTION, type RolePreset } from "../../../data/role-presets.js";
import type { LvisApi } from "../types.js";

function withDefaultPersona(prompts: Array<Pick<RolePreset, "id" | "name">>): RolePreset[] {
  return [
    DEFAULT_PERSONA_SELECTION,
    ...prompts.filter((prompt) => prompt.id !== DEFAULT_PERSONA_SELECTION.id).map((prompt) => ({
      id: prompt.id,
      name: prompt.name,
      systemPromptAdd: "",
    })),
  ];
}

/**
 * Persona prompt list + active selection. The file-backed prompt store under
 * `~/.lvis/prompts/*.md` is the source of truth; the synthetic default entry
 * means "no persona prompt for this turn".
 */
export function useRolePresets(api: LvisApi) {
  const [rolePresets, setRolePresets] = useState<RolePreset[]>([DEFAULT_PERSONA_SELECTION]);
  const [activePresetId, setActivePresetId] = useState<string>(DEFAULT_PERSONA_SELECTION.id);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const { prompts } = await api.listPersonaPromptSummaries();
        if (!disposed) setRolePresets(withDefaultPersona(prompts));
      } catch {
        if (!disposed) setRolePresets([DEFAULT_PERSONA_SELECTION]);
      }
    };

    void load();
    const unsubscribe = api.onPersonaPromptsUpdated?.(() => {
      void load();
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [api]);

  const activePreset = useMemo(
    () => rolePresets.find((p) => p.id === activePresetId) ?? DEFAULT_PERSONA_SELECTION,
    [rolePresets, activePresetId],
  );

  return { rolePresets, activePreset, activePresetId, setActivePresetId };
}
