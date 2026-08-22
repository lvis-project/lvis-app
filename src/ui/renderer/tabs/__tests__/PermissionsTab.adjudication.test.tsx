// @vitest-environment jsdom
/**
 * Sub-agent parent-adjudication controls in the Permissions tab.
 *
 * The master switch is a feature flag written through `updateSettings`; the
 * six ceilings under it are permission settings written through the reviewer
 * slash dispatcher. The two paths are asserted separately, and the numeric
 * fields are asserted to carry the STORE's bounds — a form that offered a
 * range the store would refuse is the failure this file exists to catch.
 */
import "../../../../../test/renderer/setup.js";
import { MOCK_REVIEWER_PARENT_ADJUDICATION, installMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../components/ui/scroll-area.js", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

import { PermissionsTab } from "../PermissionsTab.js";

function reviewerSettings(
  parentAdjudication: Record<string, unknown> = { ...MOCK_REVIEWER_PARENT_ADJUDICATION },
) {
  return {
    mode: "llm" as const,
    provider: "openai" as const,
    model: "gpt-4o-mini",
    fallbackOnError: "deny" as const,
    interactive: { autoApprove: "low" as const },
    parentAdjudication,
  };
}

function installApi(opts: { featureEnabled?: boolean } = {}) {
  const lvis = {
    permission: {
      getMode: vi.fn(async () => ({ mode: "auto" })),
      setMode: vi.fn(async (mode: string) => ({ ok: true, mode })),
      onModeChanged: vi.fn(() => () => undefined),
      onConfigChanged: vi.fn(() => () => undefined),
      listRules: vi.fn(async () => []),
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
          return { ok: true as const, verb: "show" as const, settings: reviewerSettings() };
        }
        return { ok: true as const, verb: "adjudication" as const, settings: reviewerSettings() };
      }),
      reviewerProviderHasKey: vi.fn(async () => true),
      sandboxCapability: vi.fn(async () => ({
        platform: "darwin" as NodeJS.Platform,
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
        editable: true,
        source: "defaults",
        adminPath: undefined,
      })),
      set: vi.fn(async () => ({ ok: true })),
    },
    userApproval: {
      list: vi.fn(async () => []),
      revokeByKey: vi.fn(async () => ({ ok: true })),
      record: vi.fn(async () => ({ ok: true })),
    },
  };
  (globalThis as unknown as { window: typeof window }).window.lvis = lvis as never;
  const lvisApi = installMockLvisApi({
    settings: {
      features: {
        osToolSandbox: false,
        subAgentParentAdjudication: opts.featureEnabled ?? true,
      },
    },
  });
  return { lvis, lvisApi };
}

async function renderTab() {
  await act(async () => {
    render(<PermissionsTab />);
  });
}

describe("PermissionsTab — parent adjudication controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { lvis?: unknown }).lvis;
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { lvis?: unknown }).lvis;
  });

  it("renders the persisted block, the three-tier chain note, and the privacy note", async () => {
    installApi();
    await renderTab();

    expect(screen.getByTestId("parent-adjudication-toggle")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("parent-adjudication-chain-note").textContent).toContain("자동 레인");
    // The one field that widens what leaves the machine says so in the UI.
    expect(
      screen.getByTestId("parent-adjudication-context-turns-privacy-note").textContent,
    ).toContain("DLP");
    // Milliseconds are stored, seconds are typed.
    expect(screen.getByTestId("parent-adjudication-timeout-input")).toHaveValue(30);
    expect(screen.getByTestId("parent-adjudication-max-per-child-run-input")).toHaveValue(200);
    expect(screen.getByTestId("parent-adjudication-context-turns-input")).toHaveValue(0);
    expect(screen.getByTestId("parent-adjudication-max-verdict-select")).toBeTruthy();
    expect(screen.getByTestId("parent-adjudication-model-select")).toBeTruthy();
    expect(screen.getByTestId("parent-adjudication-background-escalation-select")).toBeTruthy();
  });

  it("types the numeric fields against the store's bounds", async () => {
    installApi();
    await renderTab();

    const timeout = screen.getByTestId("parent-adjudication-timeout-input");
    expect(timeout).toHaveAttribute("min", "1");
    expect(timeout).toHaveAttribute("max", "120");
    const perRun = screen.getByTestId("parent-adjudication-max-per-child-run-input");
    expect(perRun).toHaveAttribute("min", "1");
    expect(perRun).toHaveAttribute("max", "1000");
    const turns = screen.getByTestId("parent-adjudication-context-turns-input");
    expect(turns).toHaveAttribute("min", "0");
    expect(turns).toHaveAttribute("max", "5");
  });

  it("writes the master switch through the settings feature flag", async () => {
    const { lvisApi } = installApi();
    await renderTab();

    await act(async () => {
      fireEvent.click(screen.getByTestId("parent-adjudication-toggle"));
    });

    expect(lvisApi.updateSettings).toHaveBeenCalledWith({
      features: { subAgentParentAdjudication: false },
    });
    expect(screen.getByTestId("parent-adjudication-toggle")).toHaveAttribute("aria-checked", "false");
  });

  it("keeps the switch off and banners the failure when the settings write fails", async () => {
    const { lvisApi } = installApi();
    lvisApi.updateSettings.mockResolvedValueOnce({
      ok: false as const,
      error: "persist-failed",
      message: "저장 실패",
    } as never);
    await renderTab();

    await act(async () => {
      fireEvent.click(screen.getByTestId("parent-adjudication-toggle"));
    });

    expect(screen.getByTestId("parent-adjudication-toggle")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("저장 실패")).toBeTruthy();
  });

  it("converts the timeout from seconds to the stored milliseconds on commit", async () => {
    const { lvis } = installApi();
    await renderTab();

    const timeout = screen.getByTestId("parent-adjudication-timeout-input");
    await act(async () => {
      fireEvent.blur(timeout, { target: { value: "45" } });
    });

    expect(lvis.permission.reviewerDispatch).toHaveBeenCalledWith("adjudication timeoutMs 45000");
  });

  it("dispatches the remaining numeric ceilings verbatim", async () => {
    const { lvis } = installApi();
    await renderTab();

    await act(async () => {
      fireEvent.blur(screen.getByTestId("parent-adjudication-max-per-child-run-input"), {
        target: { value: "50" },
      });
    });
    await act(async () => {
      fireEvent.blur(screen.getByTestId("parent-adjudication-context-turns-input"), {
        target: { value: "2" },
      });
    });

    expect(lvis.permission.reviewerDispatch).toHaveBeenCalledWith(
      "adjudication maxPerChildRun 50",
    );
    expect(lvis.permission.reviewerDispatch).toHaveBeenCalledWith(
      "adjudication includeParentContextTurns 2",
    );
  });

  it("does not dispatch when the committed value is the persisted one", async () => {
    const { lvis } = installApi();
    await renderTab();

    await act(async () => {
      fireEvent.blur(screen.getByTestId("parent-adjudication-timeout-input"), {
        target: { value: "30" },
      });
    });

    expect(lvis.permission.reviewerDispatch).toHaveBeenCalledTimes(1); // the initial "show"
  });

  it("disables the ceilings while the master switch is off", async () => {
    installApi({ featureEnabled: false });
    await renderTab();

    expect(screen.getByTestId("parent-adjudication-toggle")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("parent-adjudication-timeout-input")).toBeDisabled();
    expect(screen.getByTestId("parent-adjudication-max-per-child-run-input")).toBeDisabled();
    expect(screen.getByTestId("parent-adjudication-context-turns-input")).toBeDisabled();
    expect(screen.getByTestId("parent-adjudication-max-verdict-select")).toBeDisabled();
    expect(screen.getByTestId("parent-adjudication-model-select")).toBeDisabled();
    expect(screen.getByTestId("parent-adjudication-background-escalation-select")).toBeDisabled();
  });

  it("surfaces a dispatcher rejection instead of showing the refused value", async () => {
    const { lvis } = installApi();
    lvis.permission.reviewerDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "show") {
        return { ok: true as const, verb: "show" as const, settings: reviewerSettings() };
      }
      return { ok: false as const, error: "invalid timeoutMs '900' — expected 1..120" } as never;
    });
    await renderTab();

    await act(async () => {
      fireEvent.blur(screen.getByTestId("parent-adjudication-timeout-input"), {
        target: { value: "900" },
      });
    });

    // The field keeps rendering the persisted value, not the refused one.
    expect(screen.getByTestId("parent-adjudication-timeout-input")).toHaveValue(30);
  });
});
