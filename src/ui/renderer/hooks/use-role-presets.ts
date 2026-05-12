import { useEffect, useMemo, useState } from "react";
import type { RolePreset } from "../../../data/role-presets.js";
import type { LvisApi } from "../types.js";

/**
 * Role preset list + active selection. SettingsService is the single source of
 * truth; updates arrive through the normal settings broadcast.
 */
export function useRolePresets(api: LvisApi) {
  const [rolePresets, setRolePresets] = useState<RolePreset[]>([]);
  const [activePresetId, setActivePresetId] = useState<string>("default");

  useEffect(() => {
    let disposed = false;
    api.getSettings()
      .then((settings) => {
        if (!disposed) setRolePresets(settings.roles.presets);
      })
      .catch(() => {
        if (!disposed) setRolePresets([]);
      });
    const unsubscribe = api.onSettingsUpdated((settings) => {
      setRolePresets(settings.roles.presets);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [api]);

  const activePreset = useMemo(
    () => rolePresets.find((p) => p.id === activePresetId) ?? rolePresets[0] ?? null,
    [rolePresets, activePresetId],
  );

  return { rolePresets, activePreset, activePresetId, setActivePresetId };
}
