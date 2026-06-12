// @vitest-environment jsdom
/**
 * Reviewer LLM-degraded-to-rule banner — surfaces the runtime degrade state
 * (persisted mode="llm" but boot wiring fell back to the rule classifier
 * because no LLM provider/key is configured).
 */
import "../../../../../test/renderer/setup.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../components/ui/scroll-area.js", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

import { PermissionsTab } from "../PermissionsTab.js";

function installApi(opts: { mode: "llm" | "rule"; degraded: boolean }) {
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
        disabled: [],
        totalDisabled: 0,
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
              mode: opts.mode,
              provider: "openai" as const,
              model: "gpt-4o-mini",
              fallbackOnError: "deny" as const,
              interactive: { autoApprove: "low" as const },
            },
            reviewerDegradedToRule: opts.degraded,
          };
        }
        throw new Error(`unexpected reviewerDispatch: ${rawArgs}`);
      }),
      reviewerProviderHasKey: vi.fn(async (provider: string) => provider === "openai"),
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
  (globalThis as unknown as { window: { lvisApi?: unknown } }).window.lvisApi = {
    onSettingsUpdated: vi.fn(() => () => undefined),
  };
  return lvis;
}

describe("PermissionsTab — LLM reviewer degraded-to-rule banner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { lvis?: unknown }).lvis;
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { lvis?: unknown }).lvis;
  });

  it("shows the degrade banner when mode=llm and reviewerDegradedToRule=true", async () => {
    installApi({ mode: "llm", degraded: true });
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("reviewer-llm-degraded-banner")).toBeInTheDocument(),
    );
  });

  it("hides the banner when reviewerDegradedToRule=false (llm wired normally)", async () => {
    installApi({ mode: "llm", degraded: false });
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("reviewer-mode-llm")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("reviewer-llm-degraded-banner")).toBeNull();
  });

  it("hides the banner when persisted mode is rule (no degrade applicable)", async () => {
    installApi({ mode: "rule", degraded: false });
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("reviewer-mode-rule")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("reviewer-llm-degraded-banner")).toBeNull();
  });
});
