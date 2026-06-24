// @vitest-environment jsdom
/**
 * Reviewer prompt panel visibility — Settings no longer exposes reviewer
 * controls or degraded banners. Auto mode keeps only the read-only prompt view.
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
      // The reviewer config (and its degrade banner) only renders under the
      // auto-verification mode now that the permission UI has a single axis.
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
  (globalThis as unknown as { window: { lvisApi?: unknown } }).window.lvisApi = {
    onSettingsUpdated: vi.fn(() => () => undefined),
    getSettings: vi.fn(async () => ({ features: { osToolSandbox: false } })),
    updateSettings: vi.fn(async () => ({})),
  };
  return lvis;
}

describe("PermissionsTab — reviewer prompt-only Settings UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { lvis?: unknown }).lvis;
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { lvis?: unknown }).lvis;
  });

  it("shows the prompt panel, not a degraded reviewer banner, when mode=llm and reviewerDegradedToRule=true", async () => {
    installApi({ mode: "llm", degraded: true });
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("reviewer-prompt-panel")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("exec-mode-auto")).toContainElement(screen.getByTestId("reviewer-prompt-panel"));
    expect(screen.queryByTestId("reviewer-llm-degraded-banner")).toBeNull();
  });

  it("shows the prompt panel when reviewerDegradedToRule=false (llm wired normally)", async () => {
    installApi({ mode: "llm", degraded: false });
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("reviewer-prompt-panel")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("exec-mode-auto")).toContainElement(screen.getByTestId("reviewer-prompt-panel"));
    expect(screen.queryByTestId("reviewer-llm-degraded-banner")).toBeNull();
    expect(screen.queryByTestId("reviewer-framework-panel")).toBeNull();
  });

  it("shows the prompt panel when persisted mode is rule", async () => {
    installApi({ mode: "rule", degraded: false });
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("reviewer-prompt-panel")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("exec-mode-auto")).toContainElement(screen.getByTestId("reviewer-prompt-panel"));
    expect(screen.queryByTestId("reviewer-llm-degraded-banner")).toBeNull();
    expect(screen.queryByTestId("reviewer-framework-panel")).toBeNull();
  });
});
