/**
 * Permission policy C3 — Settings UI key-driven dynamic activation tests.
 *
 * Verifies that:
 *   - `reviewerProviderHasKey` is called for all 5 providers on mount
 *   - `reviewerProviderHasKey` is called again after a successful reviewerDispatch
 *   - The provider select is rendered
 *   - The footnote for Foundry/GCP key storage is present
 *
 * NOTE: SelectItem content renders in a Radix portal that is not in the DOM
 * until the Select is opened. Per-item disabled state tests are covered in
 * the provider-adapters unit tests (reviewerProviderKeyPresent predicate).
 * The UI integration tests verify the IPC call pattern and rendered elements.
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
import type { HookTrustRow } from "../../types.js";

function hook(name: string): HookTrustRow {
  return {
    fileName: name,
    hookType: "pre",
    sha256: "a".repeat(64),
    state: "disabled",
  };
}

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
      getMode: vi.fn(async () => ({ mode: "default" })),
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
  return lvis;
}

describe("PermissionsTab C3 — provider key-driven activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { lvis?: unknown }).lvis;
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { lvis?: unknown }).lvis;
  });

  it("calls reviewerProviderHasKey for all 5 providers on mount", async () => {
    const api = installApi();
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(api.permission.reviewerProviderHasKey).toHaveBeenCalled(),
    );
    expect(api.permission.reviewerProviderHasKey).toHaveBeenCalledWith("openai");
    expect(api.permission.reviewerProviderHasKey).toHaveBeenCalledWith("anthropic");
    expect(api.permission.reviewerProviderHasKey).toHaveBeenCalledWith("google");
    expect(api.permission.reviewerProviderHasKey).toHaveBeenCalledWith("foundry");
    expect(api.permission.reviewerProviderHasKey).toHaveBeenCalledWith("gcp-playground");
    // Exactly 5 key checks — one per provider
    expect(api.permission.reviewerProviderHasKey).toHaveBeenCalledTimes(5);
  });

  it("renders the reviewer provider select trigger", async () => {
    installApi();
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.queryByTestId("reviewer-provider-select")).toBeInTheDocument(),
    );
  });

  it("shows Foundry/GCP key storage footnote", async () => {
    installApi();
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.queryByText(/Azure AI Foundry/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Azure AI Foundry/)).toBeInTheDocument();
    expect(screen.getByText(/Google AI Studio/)).toBeInTheDocument();
  });

  it("calls reviewerProviderHasKey again after a successful reviewerDispatch (key map refresh)", async () => {
    const api = installApi({ openai: true });
    await act(async () => {
      render(<PermissionsTab />);
    });
    // Wait for initial key map load (5 calls from fetchAll)
    await waitFor(() =>
      expect(api.permission.reviewerProviderHasKey).toHaveBeenCalledTimes(5),
    );
    const countAfterMount = api.permission.reviewerProviderHasKey.mock.calls.length;

    // Simulate the LLM provider mode radio being selected (triggers applyReviewerCommand)
    await act(async () => {
      fireEvent.click(screen.getByTestId("reviewer-mode-llm"));
    });

    // After a successful dispatch, refreshProviderKeyMap is called (5 more calls)
    await waitFor(() =>
      expect(api.permission.reviewerProviderHasKey.mock.calls.length).toBeGreaterThan(
        countAfterMount,
      ),
    );
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
      expect(api.permission.reviewerProviderHasKey).toHaveBeenCalledTimes(5),
    );
    const countAfterMount = api.permission.reviewerProviderHasKey.mock.calls.length;

    // Trigger a failing dispatch
    await act(async () => {
      fireEvent.click(screen.getByTestId("reviewer-mode-llm"));
    });

    // On dispatch failure, refreshProviderKeyMap is NOT called
    // Small delay to confirm no extra calls happen
    await new Promise((r) => setTimeout(r, 50));
    expect(api.permission.reviewerProviderHasKey.mock.calls.length).toBe(countAfterMount);
  });
});
