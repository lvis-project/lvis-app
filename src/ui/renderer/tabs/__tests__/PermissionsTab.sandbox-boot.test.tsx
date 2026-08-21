// @vitest-environment jsdom
/**
 * The sandbox notice that tells the user a setting they turned on did not take.
 *
 * The runtime reason cannot carry this: a degraded gate publishes no capability,
 * so the renderer sees the same "no OS sandbox configured" it sees when the
 * sandbox was never enabled. These cases pin the distinction at the surface —
 * degraded says so, off and active stay quiet, and a host that never ran the
 * gate is not reported as either.
 */
import "../../../../../test/renderer/setup.js";
import { MOCK_REVIEWER_PARENT_ADJUDICATION } from "../../../../../test/renderer/mock-lvis-api.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../components/ui/scroll-area.js", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

import { PermissionsTab } from "../PermissionsTab.js";

function installApi(boot: unknown, sandboxOn = true) {
  const lvis = {
    permission: {
      getMode: vi.fn(async () => ({ mode: "default" })),
      setMode: vi.fn(async (mode: string) => ({ ok: true, mode })),
      onModeChanged: vi.fn(() => () => undefined),
      listRules: vi.fn(async () => []),
      deferredList: vi.fn(async () => ({ ok: true as const, pending: [], total: 0 })),
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
      reviewerDispatch: vi.fn(async () => ({
        ok: true as const,
        verb: "show" as const,
        settings: {
          mode: "rule" as const,
          provider: "openai" as const,
          model: "gpt-4o-mini",
          fallbackOnError: "deny" as const,
          parentAdjudication: MOCK_REVIEWER_PARENT_ADJUDICATION,
          interactive: { autoApprove: "low" as const },
        },
        reviewerDegradedToRule: false,
      })),
      reviewerProviderHasKey: vi.fn(async () => true),
      // win32 so the platform half is realistic; the notice must not depend on it.
      sandboxCapability: vi.fn(async () => ({
        platform: "win32" as NodeJS.Platform,
        enabled: sandboxOn,
        available: true,
        kind: "partial" as const,
        reason: "",
        runtime: {
          available: false,
          kind: "none" as const,
          reason: "no OS sandbox configured for the host process",
        },
        boot,
        confines: { filesystem: true, process: false, network: true },
      })),
      sandboxWindowsStatus: vi.fn(async () => ({
        applicable: false,
        userState: null,
        wfpState: null,
        ready: false,
        instructions: "",
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
    getSettings: vi.fn(async () => ({ features: { osToolSandbox: sandboxOn } })),
    updateSettings: vi.fn(async () => ({})),
  };
  return lvis;
}

async function renderTab(): Promise<void> {
  await act(async () => {
    render(<PermissionsTab />);
  });
  await waitFor(() => expect(screen.getByTestId("os-sandbox-toggle")).toBeInTheDocument());
}

describe("PermissionsTab — boot sandbox outcome notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { lvis?: unknown }).lvis;
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { lvis?: unknown }).lvis;
  });

  it("says the sandbox did not start, and shows the dependency error that names the fix", async () => {
    installApi({
      action: "degrade",
      reason: "degrade-windows-not-installed",
      onSignal: "default-settings",
      dependencyErrors: ["Sandbox user is not provisioned (user=true, cred=false)."],
    });
    await renderTab();

    expect(screen.getByTestId("os-sandbox-boot-degraded")).toBeInTheDocument();
    expect(screen.getByTestId("os-sandbox-boot-degraded-detail")).toHaveTextContent(
      "cred=false",
    );
  });

  it("reports an abort the same way — the user is equally unprotected either way", async () => {
    installApi({
      action: "abort",
      reason: "abort-explicit-cannot-activate",
      onSignal: "explicit-env",
      dependencyErrors: ["missing bwrap"],
    });
    await renderTab();

    expect(screen.getByTestId("os-sandbox-boot-degraded")).toBeInTheDocument();
  });

  it("stays quiet when the gate activated", async () => {
    installApi({
      action: "activate",
      reason: "deps-present",
      onSignal: "default-settings",
      dependencyErrors: [],
    });
    await renderTab();

    expect(screen.queryByTestId("os-sandbox-boot-degraded")).toBeNull();
  });

  it("stays quiet when the user simply has the sandbox off", async () => {
    installApi(
      { action: "skip", reason: "gate-off", onSignal: "off", dependencyErrors: [] },
      false,
    );
    await renderTab();

    expect(screen.queryByTestId("os-sandbox-boot-degraded")).toBeNull();
  });

  it("stays quiet when the gate never ran, rather than guessing it was off", async () => {
    installApi(null);
    await renderTab();

    expect(screen.queryByTestId("os-sandbox-boot-degraded")).toBeNull();
  });

  it("renders without the field at all, for a host older than this snapshot", async () => {
    installApi(undefined);
    await renderTab();

    expect(screen.queryByTestId("os-sandbox-boot-degraded")).toBeNull();
  });
});
