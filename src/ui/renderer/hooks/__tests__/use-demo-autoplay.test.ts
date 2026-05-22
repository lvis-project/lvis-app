/**
 * Decoupling regression test — `onFinished` must NOT mark onboarding done.
 *
 * Root cause history: prior to this branch the autoplay hook's `onFinished`
 * callback flipped `features.onboardingCompleted = true`, which caused the
 * first-boot probe in `App.tsx` to dispatch `probe-skip` on the next mount
 * and bypass the ScenarioShowcase → MemorySeed → tour → plugins chain
 * entirely. demoAutoplay and the onboarding chain are separate paths; only
 * explicit chain completion (`markOnboardingCompleted` in `App.tsx`) is
 * allowed to mark onboarding as done.
 *
 * The contract enforced here:
 *   1. `onFinished` only patches `features.demoAutoplayEnabled = false`.
 *   2. `onFinished` never includes `onboardingCompleted` in the patch.
 *   3. Repeat invocations are idempotent (single settings write).
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDemoAutoplay } from "../use-demo-autoplay.js";
import type { LvisApi } from "../../types.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

function demoAutoplayApi(options: {
  demoActivated?: boolean;
  onboardingCompleted?: boolean;
  demoAutoplayEnabled?: boolean;
} = {}): { api: LvisApi; updateSettings: ReturnType<typeof vi.fn>; getSettings: ReturnType<typeof vi.fn>; demoStatus: ReturnType<typeof vi.fn> } {
  const { api } = makeMockLvisApi({
    settings: {
      // Fresh-install shape — both flags undefined. The hook should still
      // refuse to touch `onboardingCompleted` even when activation succeeds.
      features: {
        demoAutoplayEnabled: options.demoAutoplayEnabled,
        onboardingCompleted: options.onboardingCompleted,
      },
    },
  });
  const demoStatus = vi.fn().mockResolvedValue({
    ok: true,
    activated: options.demoActivated ?? false,
    vendor: options.demoActivated ? "azure-foundry" : null,
  });
  api.demo = {
    ...((api.demo as object) ?? {}),
      status: demoStatus,
  };
  return {
    api: api as unknown as LvisApi,
    updateSettings: api.updateSettings as ReturnType<typeof vi.fn>,
    getSettings: api.getSettings as ReturnType<typeof vi.fn>,
    demoStatus,
  };
}

describe("useDemoAutoplay.onFinished — onboarding chain decoupling", () => {
  it("patches only demoAutoplayEnabled=false (never onboardingCompleted)", async () => {
    const { api, updateSettings } = demoAutoplayApi();
    const { result } = renderHook(() => useDemoAutoplay(api));

    await act(async () => {
      result.current.onFinished("completed");
      await Promise.resolve();
    });

    // At least one updateSettings invocation must carry the demoAutoplayEnabled=false patch.
    const finishCalls = updateSettings.mock.calls.filter(
      ([patch]) => patch?.features?.demoAutoplayEnabled === false,
    );
    expect(finishCalls.length).toBeGreaterThanOrEqual(1);

    // Critical contract: no call from onFinished may set onboardingCompleted.
    for (const [patch] of updateSettings.mock.calls) {
      expect(patch?.features?.onboardingCompleted).toBeUndefined();
    }
  });

  it("is idempotent — second onFinished does not emit another flag flip", async () => {
    const { api, updateSettings } = demoAutoplayApi();
    const { result } = renderHook(() => useDemoAutoplay(api));

    await act(async () => {
      result.current.onFinished("completed");
      await Promise.resolve();
    });
    const callsAfterFirst = updateSettings.mock.calls.length;

    await act(async () => {
      result.current.onFinished("external");
      await Promise.resolve();
    });
    expect(updateSettings.mock.calls.length).toBe(callsAfterFirst);
  });

  it("activates from main demo.status even when renderer env is scrubbed", async () => {
    const { api, updateSettings, demoStatus } = demoAutoplayApi({
      demoActivated: true,
      onboardingCompleted: true,
    });

    const { result } = renderHook(() => useDemoAutoplay(api));

    await act(async () => {
      await Promise.resolve();
    });

    expect(demoStatus).toHaveBeenCalledOnce();
    expect(result.current.turn?.id).toBeTruthy();
    expect(updateSettings).toHaveBeenCalledWith({
      features: { demoAutoplayRotationIndex: expect.any(Number) },
    });
  });

  it("does not activate when main demo.status reports inactive", async () => {
    const { api, updateSettings, demoStatus } = demoAutoplayApi({
      demoActivated: false,
      onboardingCompleted: true,
    });

    const { result } = renderHook(() => useDemoAutoplay(api));

    await act(async () => {
      await Promise.resolve();
    });

    expect(demoStatus).toHaveBeenCalledOnce();
    expect(result.current.turn).toBeNull();
    expect(updateSettings).not.toHaveBeenCalledWith({
      features: { demoAutoplayRotationIndex: expect.any(Number) },
    });
  });
});
