import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_ROLE_PRESETS,
  ROLE_PRESETS_CHANGED_EVENT,
  loadRolePresets,
  type RolePreset,
} from "../../../data/role-presets.js";

/**
 * Role preset list + active selection. Subscribes to ROLE_PRESETS_CHANGED_EVENT
 * so edits from the Settings "역할" tab propagate without a restart.
 */
export function useRolePresets() {
  const [rolePresets, setRolePresets] = useState<RolePreset[]>(() => DEFAULT_ROLE_PRESETS);
  const [activePresetId, setActivePresetId] = useState<string>("default");

  useEffect(() => {
    setRolePresets(loadRolePresets());
    const onChanged = () => setRolePresets(loadRolePresets());
    window.addEventListener(ROLE_PRESETS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ROLE_PRESETS_CHANGED_EVENT, onChanged);
  }, []);

  const activePreset = useMemo(
    () => rolePresets.find((p) => p.id === activePresetId) ?? rolePresets[0] ?? null,
    [rolePresets, activePresetId],
  );

  return { rolePresets, activePreset, activePresetId, setActivePresetId };
}
