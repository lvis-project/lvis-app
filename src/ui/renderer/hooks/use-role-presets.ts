import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_ROLE_PRESETS,
  normalizeRolePresets,
  type RolePreset,
} from "../../../data/role-presets.js";
import { isIpcErrorResult, type LvisApi } from "../types.js";

export const LEGACY_ROLE_PRESETS_STORAGE_KEY = "lvis:role-presets:v1";

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
      .then(async (settings) => {
        let presets = settings.roles.presets;
        try {
          presets = await migrateLegacyRolePresets(api, settings.roles.presets);
        } catch {
          presets = settings.roles.presets;
        }
        if (!disposed) setRolePresets(presets);
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

async function migrateLegacyRolePresets(api: LvisApi, currentPresets: RolePreset[]): Promise<RolePreset[]> {
  const storage = getLocalStorage();
  const legacyPresets = readLegacyRolePresets(storage);
  if (!shouldMigrateLegacyRolePresets(currentPresets, legacyPresets)) {
    return currentPresets;
  }

  const updated = await api.updateSettings({ roles: { presets: legacyPresets } });
  if (isIpcErrorResult(updated)) {
    return currentPresets;
  }
  try {
    storage?.removeItem(LEGACY_ROLE_PRESETS_STORAGE_KEY);
  } catch {
    // Migration already reached the SettingsService SSOT; stale cleanup is best-effort.
  }
  return updated.roles.presets;
}

function getLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readLegacyRolePresets(storage: Pick<Storage, "getItem"> | null): RolePreset[] | null {
  const raw = storage?.getItem(LEGACY_ROLE_PRESETS_STORAGE_KEY);
  if (!raw) return null;

  try {
    return normalizeRolePresets(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function shouldMigrateLegacyRolePresets(
  currentPresets: RolePreset[],
  legacyPresets: RolePreset[] | null,
): legacyPresets is RolePreset[] {
  return Boolean(
    legacyPresets &&
    sameRolePresets(currentPresets, DEFAULT_ROLE_PRESETS) &&
    !sameRolePresets(legacyPresets, DEFAULT_ROLE_PRESETS),
  );
}

function sameRolePresets(left: RolePreset[], right: RolePreset[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((preset, index) => {
    const other = right[index];
    return Boolean(
      other &&
      preset.id === other.id &&
      preset.name === other.name &&
      preset.systemPromptAdd === other.systemPromptAdd &&
      Boolean(preset.isDefault) === Boolean(other.isDefault),
    );
  });
}
