import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import type { RolePreset } from "../../../../data/role-presets.js";
import type { LvisApi } from "../../types.js";
import { useRolePresets } from "../use-role-presets.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

describe("useRolePresets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads persona prompts from the file-backed prompt store with a synthetic default selection", async () => {
    const api = personaPromptsApi([
      { id: "reviewer", name: "Reviewer", systemPromptAdd: "Review carefully." },
    ]);

    const { result } = renderHook(() => useRolePresets(api));

    await waitFor(() => {
      expect(result.current.rolePresets.map((preset) => preset.id)).toEqual(["default", "reviewer"]);
    });
    expect(result.current.rolePresets[1].systemPromptAdd).toBe("");
    expect(api.listPersonaPromptSummaries).toHaveBeenCalled();
    expect(api.listPersonaPrompts).not.toHaveBeenCalled();
    expect(api.getSettings).not.toHaveBeenCalled();
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it("reloads prompts when the prompt store broadcasts an update", async () => {
    const api = personaPromptsApi([
      { id: "reviewer", name: "Reviewer", systemPromptAdd: "Review carefully." },
    ]);

    const { result } = renderHook(() => useRolePresets(api));
    await waitFor(() => {
      expect(result.current.rolePresets.map((preset) => preset.id)).toEqual(["default", "reviewer"]);
    });

    await api.savePersonaPrompt({ id: "editor", name: "Editor", systemPromptAdd: "Edit tightly." });

    await waitFor(() => {
      expect(result.current.rolePresets.map((preset) => preset.id)).toEqual(["default", "reviewer", "editor"]);
    });
  });
});

function personaPromptsApi(initialPrompts: RolePreset[]): LvisApi {
  const { api } = makeMockLvisApi({ personaPrompts: initialPrompts });
  return api as unknown as LvisApi;
}
