import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useOnboardingTourController } from "../use-onboarding-tour-controller.js";

function createApi(options: {
  onboardingCompleted?: boolean;
  completedScenario?: boolean;
  hasApiKey?: boolean;
} = {}) {
  const start = vi.fn(async () => ({ ok: true, scenarioId: "first-boot-essentials" }));
  const updateSettings = vi.fn(async () => ({ ok: true }));
  const hasApiKey = vi.fn(async () => options.hasApiKey ?? false);
  const getSettings = vi.fn(async () => ({
    features: { onboardingCompleted: options.onboardingCompleted ?? false },
  }));
  const api = {
    hasApiKey,
    getSettings,
    updateSettings,
    tour: {
      getState: vi.fn(async () => ({
        ok: true,
        state: {
          lastSeenScenario: null,
          completedScenarios: options.completedScenario ? ["first-boot-essentials"] : [],
          dismissedAt: null,
        },
      })),
      start,
    },
  };
  return { api: api as never, getSettings, hasApiKey, start, updateSettings };
}

describe("useOnboardingTourController", () => {
  it("starts the optional tour once for a fresh keyless workspace and persists a dismissal once", async () => {
    const { api, start, updateSettings } = createApi();
    const { result, rerender } = renderHook(() => useOnboardingTourController(api));

    await waitFor(() => expect(start).toHaveBeenCalledWith("first-boot-essentials"));
    rerender();
    expect(start).toHaveBeenCalledTimes(1);

    act(() => result.current.onTourDismiss());
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      features: { onboardingCompleted: true },
    }));
    act(() => result.current.onTourComplete());
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(result.current.tourCompleted).toBe(false);
  });

  it("does not start for a returning user or an already configured provider", async () => {
    const returning = createApi({ completedScenario: true });
    renderHook(() => useOnboardingTourController(returning.api));
    await waitFor(() => expect(returning.getSettings).toHaveBeenCalled());
    expect(returning.start).not.toHaveBeenCalled();

    const configured = createApi({ hasApiKey: true });
    renderHook(() => useOnboardingTourController(configured.api));
    await waitFor(() => expect(configured.hasApiKey).toHaveBeenCalled());
    expect(configured.start).not.toHaveBeenCalled();
  });
});
