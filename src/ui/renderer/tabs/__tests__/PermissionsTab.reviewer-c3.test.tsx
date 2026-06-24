/**
 * Permission policy C3 — Settings UI active-LLM following tests.
 *
 * Provider/model are no longer reviewer-local controls. The reviewer follows
 * the active Intelligence LLM identity, so this panel must not query or mutate
 * legacy `permissions.reviewer.provider/model` as if they were authoritative.
 */
import "../../../../../test/renderer/setup.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../components/ui/scroll-area.js", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

import { PermissionsTab } from "../PermissionsTab.js";
import { makeHookTrustRow as hook } from "./test-helpers.js";
import type { HookTrustRow } from "../../types.js";


/**
 * Build a minimal window.lvis mock with controllable providerKeyMap.
 *
 * `providerKeys` maps provider id → whether the key is present.
 * Defaults: openai=true, others=false.
 */
function installApi(providerKeys: Partial<Record<string, boolean>> = {}) {
  const defaults: Record<string, boolean> = {
    openai: true,
    anthropic: false,
    google: false,
    foundry: false,
    "gcp-playground": false,
    ...providerKeys,
  };

  const reviewerProviderHasKey = vi.fn(async (provider: string) => defaults[provider] ?? false);

  const lvis = {
    permission: {
      // The reviewer config only renders under the auto-verification mode now
      // that the permission UI exposes a single axis.
      getMode: vi.fn(async () => ({ mode: "auto" })),
      setMode: vi.fn(async (mode: string) => ({ ok: true, mode })),
      onModeChanged: vi.fn(() => () => undefined),
      listRules: vi.fn(async () => []),
      addRule: vi.fn(async () => ({ ok: true, rule: { pattern: "x", action: "allow" } })),
      removeRule: vi.fn(async () => ({ ok: true })),
      deferredList: vi.fn(async () => ({ ok: true as const, pending: [], total: 0 })),
      deferredResolve: vi.fn(async () => ({ ok: true })),
      onDeferredPending: vi.fn(() => () => undefined),
      hookTrustList: vi.fn(async () => ({
        ok: true as const,
        active: [],
        disabled: [hook("test.sh")],
        totalDisabled: 1,
      })),
      dirDispatch: vi.fn(async () => ({
        ok: true as const,
        verb: "list" as const,
        defaults: [],
        userAdditions: [],
        effective: [],
      })),
      reviewerDispatch: vi.fn(async (rawArgs: string) => {
        if (rawArgs === "show") {
          return {
            ok: true as const,
            verb: "show" as const,
            settings: {
              mode: "disabled" as const,
              provider: "openai" as const,
              model: "gpt-4o-mini",
              fallbackOnError: "deny" as const,
              interactive: { autoApprove: "off" as const },
            },
          };
        }
        // provider change command
        return {
          ok: true as const,
          verb: "provider" as const,
          settings: {
            mode: "disabled" as const,
            provider: "openai" as const,
            model: "gpt-4o-mini",
            fallbackOnError: "deny" as const,
            interactive: { autoApprove: "off" as const },
          },
        };
      }),
      reviewerProviderHasKey,
      sandboxCapability: vi.fn(async () => ({
        platform: "linux" as NodeJS.Platform,
        enabled: false,
        available: true,
        kind: "full" as const,
        reason: "",
        confines: { filesystem: true, process: true, network: true },
      })),
      onManifestViolation: vi.fn(() => () => undefined),
      auditShow: vi.fn(async () => ({
        ok: true as const,
        entries: [],
        total: 0,
        summary: { files: 0, bytes: 0 },
      })),
      auditVerify: vi.fn(async () => ({
        ok: true as const,
        intact: true,
        totalFiles: 0,
        totalEntries: 0,
        perDay: [],
      })),
    },
    policy: {
      get: vi.fn(async () => ({
        requireExplicitApproval: true,
        managed: false,
        source: "defaults",
        adminPath: undefined,
      })),
      set: vi.fn(async () => ({ ok: true })),
    },
  };

  (globalThis as unknown as { window: typeof window }).window.lvis = lvis as never;
  // C3 Round 2 — stub lvisApi.onSettingsUpdated so the PermissionsTab
  // useEffect that subscribes to settings changes doesn't throw.
  const lvisApi = {
    onSettingsUpdated: vi.fn(() => () => undefined),
    getSettings: vi.fn(async () => ({ features: { osToolSandbox: false } })),
    updateSettings: vi.fn(async () => ({})),
  };
  (globalThis as unknown as { window: { lvisApi?: unknown } }).window.lvisApi = lvisApi;
  return lvis;
}

describe("PermissionsTab C3 — active LLM following", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { lvis?: unknown }).lvis;
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { lvis?: unknown }).lvis;
  });

  it("does not query legacy reviewer provider keys on mount", async () => {
    const api = installApi();
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("reviewer-active-llm-source")).toBeInTheDocument(),
    );
    expect(api.permission.reviewerProviderHasKey).not.toHaveBeenCalled();
  });

  it("renders active LLM source instead of reviewer provider/model controls", async () => {
    installApi();
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.queryByTestId("reviewer-active-llm-source")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("reviewer-provider-select")).toBeNull();
    expect(screen.queryByTestId("reviewer-model-input")).toBeNull();
  });

  it("shows that provider/model are controlled by Intelligence settings", async () => {
    installApi();
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.queryByText(/지능 설정의 현재 공급자\/모델/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/provider\/model 은 지능 설정의 활성 LLM을 따릅니다/)).toBeInTheDocument();
  });

  it("does not refresh legacy provider keys after a successful reviewerDispatch", async () => {
    const api = installApi({ openai: true });
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("reviewer-active-llm-source")).toBeInTheDocument(),
    );

    // Re-selecting the auto-verification mode auto-wires `mode llm`.
    await act(async () => {
      fireEvent.click(screen.getByTestId("exec-mode-default"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("exec-mode-auto"));
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("mode llm");
    expect(api.permission.reviewerProviderHasKey).not.toHaveBeenCalled();
  });

  it("does not call reviewerProviderHasKey for a failed dispatch", async () => {
    const api = installApi();
    // Override reviewerDispatch to return an error for 'mode llm'
    api.permission.reviewerDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "show") {
        return {
          ok: true as const,
          verb: "show" as const,
          settings: {
            mode: "disabled" as const,
            provider: "openai" as const,
            model: "gpt-4o-mini",
            fallbackOnError: "deny" as const,
            interactive: { autoApprove: "off" as const },
          },
        };
      }
      return { ok: false as const, error: "reviewer-rewire-failed: test error" };
    });

    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("reviewer-active-llm-source")).toBeInTheDocument(),
    );

    // Toggle away and back to re-trigger the auto-wired `mode llm` (which fails).
    await act(async () => {
      fireEvent.click(screen.getByTestId("exec-mode-default"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("exec-mode-auto"));
    });

    expect(api.permission.reviewerProviderHasKey).not.toHaveBeenCalled();
  });
});
