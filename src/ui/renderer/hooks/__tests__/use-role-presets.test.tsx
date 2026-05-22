import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import {
  cloneDefaultRolePresets,
  normalizeRolePresets,
  type RolePreset,
} from "../../../../data/role-presets.js";
import type { AppSettings, LvisApi } from "../../types.js";
import { LEGACY_ROLE_PRESETS_STORAGE_KEY, useRolePresets } from "../use-role-presets.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

describe("useRolePresets", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("migrates legacy localStorage role presets into SettingsService", async () => {
    const legacyPresets: RolePreset[] = [
      { id: "default", name: "기본", systemPromptAdd: "", isDefault: true },
      { id: "legacy-reviewer", name: "Legacy Reviewer", systemPromptAdd: "Review legacy code." },
    ];
    localStorage.setItem(LEGACY_ROLE_PRESETS_STORAGE_KEY, JSON.stringify(legacyPresets));
    const api = rolePresetsApi(cloneDefaultRolePresets());

    const { result } = renderHook(() => useRolePresets(api));

    await waitFor(() => {
      expect(result.current.rolePresets.map((preset) => preset.id)).toEqual(["default", "legacy-reviewer"]);
    });
    expect(api.updateSettings).toHaveBeenCalledWith({
      roles: { presets: normalizeRolePresets(legacyPresets) },
    });
    expect(localStorage.getItem(LEGACY_ROLE_PRESETS_STORAGE_KEY)).toBeNull();
  });

  it("does not overwrite SettingsService roles with stale legacy storage", async () => {
    localStorage.setItem(
      LEGACY_ROLE_PRESETS_STORAGE_KEY,
      JSON.stringify([{ id: "legacy", name: "Legacy", systemPromptAdd: "legacy" }]),
    );
    const currentPresets = normalizeRolePresets([
      { id: "current", name: "Current", systemPromptAdd: "current" },
    ]);
    const api = rolePresetsApi(currentPresets);

    const { result } = renderHook(() => useRolePresets(api));

    await waitFor(() => {
      expect(result.current.rolePresets.map((preset) => preset.id)).toEqual(["default", "current"]);
    });
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(localStorage.getItem(LEGACY_ROLE_PRESETS_STORAGE_KEY)).not.toBeNull();
  });

  it("keeps SettingsService roles visible when legacy migration fails", async () => {
    localStorage.setItem(
      LEGACY_ROLE_PRESETS_STORAGE_KEY,
      JSON.stringify([{ id: "legacy", name: "Legacy", systemPromptAdd: "legacy" }]),
    );
    const api = rolePresetsApi(cloneDefaultRolePresets());
    vi.mocked(api.updateSettings).mockRejectedValueOnce(new Error("disk locked"));

    const { result } = renderHook(() => useRolePresets(api));

    await waitFor(() => {
      expect(result.current.rolePresets.map((preset) => preset.id)).toEqual([
        "default",
        "summarizer",
        "code-reviewer",
        "translator",
        "coding-assistant",
        "editor",
      ]);
    });
    expect(localStorage.getItem(LEGACY_ROLE_PRESETS_STORAGE_KEY)).not.toBeNull();
  });
});

function rolePresetsApi(initialRolePresets: RolePreset[]): LvisApi {
  let settings = rolePresetSettings(initialRolePresets);
  const handlers = new Set<(settings: AppSettings) => void>();
  const { api } = makeMockLvisApi({ settings });
  Object.assign(api, {
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (patch: Partial<AppSettings>) => {
      if (patch.roles?.presets) {
        settings = rolePresetSettings(normalizeRolePresets(patch.roles.presets));
      }
      for (const handler of handlers) handler(settings);
      return settings;
    }),
    onSettingsUpdated: vi.fn((handler: (settings: AppSettings) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
  });
  return api as unknown as LvisApi;
}

function rolePresetSettings(rolePresets: RolePreset[]): AppSettings {
  return {
    llm: {
      provider: "openai",
      vendors: {
        openai: {
          model: "gpt-4.1",
          enableThinking: true,
          thinkingBudgetTokens: 10_000,
        },
      },
      streamSmoothing: "none",
      fallbackChain: [],
    },
    chat: { systemPrompt: "", autoCompact: true },
    roles: { presets: rolePresets },
    webSearch: { provider: "duckduckgo" },
    privacy: { piiRedactEnabled: false },
    features: {},
  };
}
