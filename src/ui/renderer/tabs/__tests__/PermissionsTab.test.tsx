// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { MOCK_REVIEWER_PARENT_ADJUDICATION, installMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

vi.mock("../../../../components/ui/scroll-area.js", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

import { PermissionsTab } from "../PermissionsTab.js";
import { makeHookTrustRow as hook } from "./test-helpers.js";
import type { HookTrustRow } from "../../types.js";
import { isPolicyUserEditable, type PolicySource } from "../../../../shared/policy-editability.js";
import { t } from "../../../../i18n/runtime.js";
import { TEST_IDS, execModeTestId } from "../../../../shared/test-ids.js";

/**
 * Mirrors the `PERMISSIONS.policyGet` handler: the host attaches `editable`
 * from the real predicate. Built here the same way so a renderer that goes back
 * to reading `managed` directly fails these tests.
 */
function policyGetPayload(loaded: {
  requireExplicitApproval: boolean;
  managed: boolean;
  source: PolicySource;
  adminPath?: string;
}) {
  return { version: 1 as const, updatedAt: "2026-01-01T00:00:00.000Z", ...loaded, editable: isPolicyUserEditable(loaded) };
}


function installApi(
  disabledBatches: HookTrustRow[][],
  envForcedSettings: readonly string[] = [],
) {
  const hookTrustList = vi.fn(async () => {
    const disabled = disabledBatches.shift() ?? [];
    return { ok: true as const, active: [], disabled, totalDisabled: disabled.length };
  });
  const lvis = {
    permission: {
      getMode: vi.fn(async () => ({ mode: "default" })),
      setMode: vi.fn(async (mode: string) => ({ ok: true, mode })),
      onModeChanged: vi.fn(() => () => undefined),
      onConfigChanged: vi.fn(() => () => undefined),
      listRules: vi.fn(async () => []),
      addRule: vi.fn(async () => ({ ok: true, rule: { pattern: "x", action: "allow" } })),
      removeRule: vi.fn(async () => ({ ok: true })),
      deferredList: vi.fn(async () => ({ ok: true, pending: [], total: 0 })),
      deferredResolve: vi.fn(async () => ({ ok: true })),
      onDeferredPending: vi.fn(() => () => undefined),
      hookTrustList,
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
              parentAdjudication: MOCK_REVIEWER_PARENT_ADJUDICATION,
              interactive: { autoApprove: "off" as const },
            },
          };
        }
        if (rawArgs === "mode llm") {
          return {
            ok: true as const,
            verb: "mode" as const,
            settings: {
              mode: "llm" as const,
              provider: "openai" as const,
              model: "gpt-4o-mini",
              fallbackOnError: "deny" as const,
              parentAdjudication: MOCK_REVIEWER_PARENT_ADJUDICATION,
              interactive: { autoApprove: "off" as const },
            },
          };
        }
        if (rawArgs === "mode disabled") {
          return {
            ok: true as const,
            verb: "mode" as const,
            settings: {
              mode: "disabled" as const,
              provider: "openai" as const,
              model: "gpt-4o-mini",
              fallbackOnError: "deny" as const,
              parentAdjudication: MOCK_REVIEWER_PARENT_ADJUDICATION,
              interactive: { autoApprove: "off" as const },
            },
          };
        }
        if (rawArgs === "fallback rule") {
          return {
            ok: true as const,
            verb: "fallback" as const,
            settings: {
              mode: "llm" as const,
              provider: "openai" as const,
              model: "gpt-4o-mini",
              fallbackOnError: "rule" as const,
              parentAdjudication: MOCK_REVIEWER_PARENT_ADJUDICATION,
              interactive: { autoApprove: "off" as const },
            },
          };
        }
        if (rawArgs === "interactive low" || rawArgs === "interactive medium") {
          return {
            ok: true as const,
            verb: "interactive" as const,
            settings: {
              mode: "llm" as const,
              provider: "openai" as const,
              model: "gpt-4o-mini",
              fallbackOnError: "deny" as const,
              parentAdjudication: MOCK_REVIEWER_PARENT_ADJUDICATION,
              interactive: { autoApprove: rawArgs === "interactive medium" ? "medium" as const : "low" as const },
            },
          };
        }
        if (rawArgs === "interactive off") {
          return {
            ok: true as const,
            verb: "interactive" as const,
            settings: {
              mode: "disabled" as const,
              provider: "openai" as const,
              model: "gpt-4o-mini",
              fallbackOnError: "deny" as const,
              parentAdjudication: MOCK_REVIEWER_PARENT_ADJUDICATION,
              interactive: { autoApprove: "off" as const },
            },
          };
        }
        if (rawArgs === "model gpt-5.5-mini") {
          return {
            ok: true as const,
            verb: "model" as const,
            settings: {
              mode: "llm" as const,
              provider: "openai" as const,
              model: "gpt-5.5-mini",
              fallbackOnError: "deny" as const,
              parentAdjudication: MOCK_REVIEWER_PARENT_ADJUDICATION,
              interactive: { autoApprove: "off" as const },
            },
          };
        }
        throw new Error(`unexpected reviewerDispatch: ${rawArgs}`);
      }),
      /** C3 — key-driven dynamic activation: return true for openai by default. */
      reviewerProviderHasKey: vi.fn(async (provider: string) => provider === "openai"),
      sandboxCapability: vi.fn(async () => ({
        platform: "linux" as NodeJS.Platform,
        enabled: false,
        available: true,
        kind: "full" as const,
        reason: "ASRT (bwrap) confines filesystem, process, and network egress when enabled",
        potentialReason: "ASRT (bwrap) confines filesystem, process, and network egress when enabled",
        runtime: {
          available: false,
          kind: "none" as const,
          reason: "no OS sandbox configured for the host process",
        },
        confines: { filesystem: true, process: true, network: true },
      })),
    },
    policy: {
      get: vi.fn(async () => policyGetPayload({
        requireExplicitApproval: true,
        managed: false,
        source: "defaults",
      })),
      set: vi.fn(async () => ({ ok: true })),
    },
    userApproval: {
      list: vi.fn(async () => []),
      record: vi.fn(async () => ({ ok: true })),
      revokeByKey: vi.fn(async () => ({ ok: true })),
    },
  };
  (globalThis as unknown as { window: typeof window }).window.lvis = lvis as never;
  installMockLvisApi({
    settings: { features: { osToolSandbox: false } },
    envForcedSettings,
  });
  return lvis;
}

beforeEach(() => {
  delete (window as unknown as { lvis?: unknown }).lvis;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { lvis?: unknown }).lvis;
});

describe("PermissionsTab hook quarantine notice", () => {
  it("saves a permanent deny for the exact pending tool and canonical input", async () => {
    const api = installApi([[]]);
    const onExactDenySaved = vi.fn();
    const onDiscardExactDeny = vi.fn();

    await act(async () => {
      render(
        <PermissionsTab
          exactDenyDraft={{
            requestId: "approval-exact-1",
            toolName: "plugin:meeting_list_preps",
            args: { z: 2, a: 1 },
            source: "plugin",
            trustOrigin: "plugin-emitted",
            approvalCacheKey: "meeting:list-preps",
            verdictAtApproval: "medium",
          }}
          onExactDenySaved={onExactDenySaved}
          onDiscardExactDeny={onDiscardExactDeny}
        />,
      );
    });

    expect(screen.getByTestId("exact-deny-draft")).toHaveTextContent("plugin:meeting_list_preps");
    expect(screen.getByTestId("exact-deny-draft")).toHaveTextContent("이후의 정확한 일치 요청을 거절");
    await waitFor(() => expect(screen.getByTestId("exact-deny-focus-target")).toHaveFocus());

    await act(async () => {
      fireEvent.click(screen.getByTestId("save-exact-deny"));
    });

    expect(api.userApproval.record).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "approval-exact-1",
      toolName: "plugin:meeting_list_preps",
      args: '{"a":1,"z":2}',
      source: "plugin",
      decision: "deny",
      scope: "persistent",
      trustOrigin: "plugin-emitted",
      approvalCacheKey: "meeting:list-preps",
    }));
    expect(onExactDenySaved).toHaveBeenCalledWith("approval-exact-1");
    expect(onDiscardExactDeny).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId(TEST_IDS.settingsPageTitle)).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("plugin:meeting_list_preps");
  });

  it("keeps an exact-deny draft focused and cancellable when unrelated Settings loading fails", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockRejectedValueOnce(new Error("settings unavailable"));
    const onDiscardExactDeny = vi.fn();

    render(
      <PermissionsTab
        exactDenyDraft={{
          requestId: "approval-exact-load-failure",
          toolName: "bash",
          args: { command: "Remove-Item C:\\tmp\\artifact" },
          source: "builtin",
          verdictAtApproval: "high",
        }}
        onDiscardExactDeny={onDiscardExactDeny}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("permissions-load-error"))
      .toHaveTextContent("settings unavailable"));
    expect(screen.getByTestId("exact-deny-draft")).toHaveTextContent("bash");
    await waitFor(() => expect(screen.getByTestId("exact-deny-focus-target")).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.cancelButton") }));
    expect(onDiscardExactDeny).toHaveBeenCalledTimes(1);
  });

  it("refocuses the editor when the same pending request re-enters from the dock", async () => {
    installApi([[]]);
    const draft = {
      requestId: "approval-exact-reenter",
      toolName: "read_file",
      args: { path: "C:\\workspace\\notes.md" },
      source: "builtin" as const,
      verdictAtApproval: "low" as const,
    };
    const { rerender } = render(<PermissionsTab exactDenyDraft={draft} />);
    await waitFor(() => expect(screen.getByTestId("exact-deny-focus-target")).toHaveFocus());

    screen.getByTestId(TEST_IDS.settingsPageTitle).focus();
    expect(screen.getByTestId(TEST_IDS.settingsPageTitle)).toHaveFocus();
    rerender(<PermissionsTab exactDenyDraft={{ ...draft }} />);

    await waitFor(() => expect(screen.getByTestId("exact-deny-focus-target")).toHaveFocus());
  });

  it("returns focus to the live dock Settings link after exact-deny cancellation", async () => {
    installApi([[]]);

    function FocusHarness() {
      const [draft, setDraft] = useState<{
        requestId: string;
        toolName: string;
        args: unknown;
        source: "builtin";
        verdictAtApproval: "low";
      } | null>({
        requestId: "approval-exact-cancel-focus",
        toolName: "read_file",
        args: { path: "C:\\workspace\\notes.md" },
        source: "builtin" as const,
        verdictAtApproval: "low" as const,
      });
      return (
        <>
          <button type="button" data-testid={TEST_IDS.openPermanentDenySettings}>
            Return to exact deny
          </button>
          <PermissionsTab
            exactDenyDraft={draft}
            onDiscardExactDeny={() => setDraft(null)}
          />
        </>
      );
    }

    render(<FocusHarness />);
    await waitFor(() => expect(screen.getByTestId("exact-deny-focus-target")).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.cancelButton") }));

    await waitFor(() => expect(screen.getByTestId(TEST_IDS.openPermanentDenySettings)).toHaveFocus());
    expect(screen.queryByTestId("exact-deny-draft")).toBeNull();
  });

  it("shows the four user-facing permission policy choices and their read behavior", async () => {
    installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });

    expect(screen.getByTestId(execModeTestId("default"))).toHaveTextContent("쓰기 확인");
    expect(screen.getByText(/읽기 도구는 허용/)).toBeTruthy();
    expect(screen.getByTestId(execModeTestId("strict"))).toHaveTextContent("전체 확인");
    expect(screen.getByText(/읽기까지 포함해 모든 도구/)).toBeTruthy();
    expect(screen.getByTestId(execModeTestId("auto"))).toHaveTextContent("자동 검증");
    expect(screen.getByText(/대화형 저위험·중위험 판정/)).toBeTruthy();
    expect(screen.getByTestId(execModeTestId("allow"))).toHaveTextContent("모두 허용");
  });

  it("keeps the rendered mode unchanged when durable mode confirmation fails", async () => {
    const api = installApi([[]]);
    api.permission.setMode.mockResolvedValueOnce({
      ok: false,
      error: "approval-denied",
      message: "사용자가 모드 변경을 거부했습니다.",
    });

    await act(async () => {
      render(<PermissionsTab />);
    });

    expect(screen.getByTestId(execModeTestId("default"))).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("auto")));
    });

    expect(api.permission.setMode).toHaveBeenCalledWith("auto");
    expect(api.permission.reviewerDispatch).not.toHaveBeenCalledWith("mode llm");
    expect(screen.getByText("사용자가 모드 변경을 거부했습니다.")).toBeTruthy();
    const defaultButton = screen.getByTestId(execModeTestId("default"));
    const autoButton = screen.getByTestId(execModeTestId("auto"));
    expect(defaultButton.className).toContain("border-primary");
    expect(autoButton.className).not.toContain("border-primary");
  });

  it("marks the returned mode active after durable mode confirmation succeeds", async () => {
    const api = installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("auto")));
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("mode llm");
    expect(api.permission.setMode).toHaveBeenCalledWith("auto");
    // Round-2 test-engineer MAJOR — exec-mode-auto must ALSO fire the
    // `interactive medium` dispatch so the global LOW+MEDIUM threshold stays
    // coupled to the legacy `auto` UX.
    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("interactive medium");
    expect(api.permission.setMode.mock.invocationCallOrder[0]).toBeLessThan(
      api.permission.reviewerDispatch.mock.invocationCallOrder.at(-1)!,
    );
    const autoButton = screen.getByTestId(execModeTestId("auto"));
    expect(autoButton.className).toContain("border-primary");
  });

  it("maps full allow policy to allow mode and disables background reviewer", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockResolvedValueOnce({ mode: "auto" });
    api.permission.reviewerDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "show") {
        return {
          ok: true as const,
          verb: "show" as const,
          settings: {
            mode: "llm" as const,
            provider: "openai" as const,
            model: "gpt-4o-mini",
            fallbackOnError: "deny" as const,
            parentAdjudication: MOCK_REVIEWER_PARENT_ADJUDICATION,
            interactive: { autoApprove: "off" as const },
          },
        };
      }
      if (rawArgs === "mode disabled") {
        return {
          ok: true as const,
          verb: "mode" as const,
          settings: {
            mode: "disabled" as const,
            provider: "openai" as const,
            model: "gpt-4o-mini",
            fallbackOnError: "deny" as const,
            parentAdjudication: MOCK_REVIEWER_PARENT_ADJUDICATION,
            interactive: { autoApprove: "off" as const },
          },
        };
      }
      throw new Error(`unexpected reviewerDispatch: ${rawArgs}`);
    });

    await act(async () => {
      render(<PermissionsTab />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("allow")));
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("mode disabled");
    expect(api.permission.setMode).toHaveBeenCalledWith("allow");
    expect(api.permission.setMode.mock.invocationCallOrder[0]).toBeLessThan(
      api.permission.reviewerDispatch.mock.invocationCallOrder.at(-1)!,
    );
    expect(screen.getByTestId(execModeTestId("allow")).className).toContain("border-primary");
  });

  it("hydrates the active mode from durable settings on mount", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockResolvedValueOnce({ mode: "auto" });

    await act(async () => {
      render(<PermissionsTab />);
    });

    const autoButton = screen.getByTestId(execModeTestId("auto"));
    expect(autoButton.className).toContain("border-primary");
  });

  it("does not render the notice when no hooks are quarantined", async () => {
    installApi([[]]);
    let container: HTMLElement;
    await act(async () => {
      const rendered = render(<PermissionsTab />);
      container = rendered.container;
    });

    expect(container!.querySelector('[data-testid="hook-quarantine-notice"]')).toBeNull();
  });

  it("renders a non-modal notice with the hooks list slash path", async () => {
    installApi([[hook("pre-scan.sh")]]);
    await act(async () => {
      render(<PermissionsTab />);
    });

    expect(screen.getByTestId("hook-quarantine-notice")).toBeTruthy();
    expect(screen.getByText("검토 대기 1")).toBeTruthy();
    expect(screen.getByText("/permission hooks list")).toBeTruthy();
    expect(screen.getByText("pre-scan.sh")).toBeTruthy();
  });

  it("clears the notice after the quarantined list becomes empty", async () => {
    const api = installApi([[hook("pre-scan.sh")], []]);
    await act(async () => {
      render(<PermissionsTab />);
    });
    expect(screen.getByTestId("hook-quarantine-notice")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getAllByText("새로고침")[0]);
    });

    expect(api.permission.hookTrustList).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("hook-quarantine-notice")).toBeNull();
  });

  it("does not render the reviewer settings section", async () => {
    const api = installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("show");
    expect(screen.getAllByText("명시 액션 필수").length).toBeGreaterThan(0);

    expect(screen.queryByTestId("reviewer-active-llm-source")).toBeNull();
    expect(screen.queryByTestId("reviewer-fallback-select")).toBeNull();
    expect(screen.queryByTestId("reviewer-framework-panel")).toBeNull();
    expect(screen.queryByTestId("reviewer-cli-mapping-panel")).toBeNull();
    expect(screen.queryByTestId(TEST_IDS.reviewerPromptPanel)).toBeNull();
    expect(screen.queryByTestId("permissions-legacy-auto-mode-banner")).toBeNull();
    expect(screen.queryByTestId("reviewer-llm-degraded-banner")).toBeNull();
  });

  it("keeps hidden reviewer auto-wiring and shows only the prompt collapse inside 자동 검증", async () => {
    const api = installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("auto")));
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("mode llm");
    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("interactive medium");
    expect(screen.queryByTestId("reviewer-active-llm-source")).toBeNull();
    expect(screen.queryByTestId("reviewer-provider-select")).toBeNull();
    expect(screen.queryByTestId("reviewer-fallback-select")).toBeNull();
    expect(screen.queryByTestId("reviewer-model-input")).toBeNull();
    expect(screen.queryByTestId("reviewer-framework-panel")).toBeNull();
    expect(screen.getByTestId(TEST_IDS.reviewerPromptPanel)).toBeTruthy();
    expect(screen.getByTestId(execModeTestId("auto"))).toContainElement(screen.getByTestId(TEST_IDS.reviewerPromptPanel));
    expect(screen.queryByText("검증 프롬프트")).toBeNull();
    expect(screen.getByTestId("reviewer-system-prompt")).toHaveTextContent("UNTRUSTED_INPUT");
    expect(screen.queryByTestId("reviewer-mode-llm")).toBeNull();
    expect(screen.queryByTestId("reviewer-mode-disabled")).toBeNull();
  });

  it("refreshes an already-open Settings tab when another window changes permission mode", async () => {
    const api = installApi([[]]);
    api.permission.getMode
      .mockResolvedValueOnce({ mode: "default" })
      .mockResolvedValue({ mode: "auto" });

    await act(async () => {
      render(<PermissionsTab />);
    });

    expect(screen.queryByTestId(TEST_IDS.reviewerPromptPanel)).toBeNull();
    const onModeChanged = api.permission.onModeChanged.mock.calls[0]?.[0] as ((mode: string) => void) | undefined;
    expect(onModeChanged).toBeTruthy();

    await act(async () => {
      onModeChanged?.("auto");
    });

    expect(screen.getByTestId(TEST_IDS.reviewerPromptPanel)).toBeTruthy();
    expect(screen.getByTestId(execModeTestId("auto"))).toContainElement(screen.getByTestId(TEST_IDS.reviewerPromptPanel));
  });

  it("does not expose the reviewer fallback policy in Settings", async () => {
    const api = installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("auto")));
    });

    expect(screen.queryByTestId("reviewer-fallback-select")).toBeNull();
    expect(screen.getByTestId(TEST_IDS.reviewerPromptPanel)).toBeTruthy();
    expect(screen.getByTestId(execModeTestId("auto"))).toContainElement(screen.getByTestId(TEST_IDS.reviewerPromptPanel));
    expect(api.permission.reviewerDispatch).not.toHaveBeenCalledWith(
      expect.stringMatching(/^fallback\b/),
    );
  });

  it("does not expose legacy reviewer provider/model controls", async () => {
    const api = installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("auto")));
    });

    expect(screen.queryByTestId("reviewer-provider-select")).toBeNull();
    expect(screen.queryByTestId("reviewer-model-input")).toBeNull();
    expect(screen.queryByTestId("reviewer-active-llm-source")).toBeNull();
    expect(screen.getByTestId(TEST_IDS.reviewerPromptPanel)).toBeTruthy();
    expect(screen.getByTestId(execModeTestId("auto"))).toContainElement(screen.getByTestId(TEST_IDS.reviewerPromptPanel));
    expect(api.permission.reviewerDispatch).not.toHaveBeenCalledWith(
      expect.stringMatching(/^(provider|model)\b/),
    );
  });

  it("renders the off/low/medium threshold control when the stored mode is auto", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockResolvedValueOnce({ mode: "auto" });
    api.permission.reviewerDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "show") {
        return {
          ok: true as const,
          verb: "show" as const,
          settings: {
            mode: "llm" as const,
            provider: "openai" as const,
            model: "gpt-4o-mini",
            fallbackOnError: "deny" as const,
            parentAdjudication: MOCK_REVIEWER_PARENT_ADJUDICATION,
            interactive: { autoApprove: "off" as const },
          },
        };
      }
      throw new Error(`unexpected reviewerDispatch: ${rawArgs}`);
    });

    await act(async () => {
      render(<PermissionsTab />);
    });
    expect(screen.getByTestId("interactive-auto-approve-select")).toBeTruthy();
    expect(screen.queryByTestId("permissions-legacy-auto-mode-banner")).toBeNull();
    expect(screen.getByTestId(TEST_IDS.reviewerPromptPanel)).toBeTruthy();
    expect(screen.getByTestId(execModeTestId("auto"))).toContainElement(screen.getByTestId(TEST_IDS.reviewerPromptPanel));
  });

  it("surfaces the reviewer rewire failure when entering the auto-verification mode", async () => {
    const api = installApi([[]]);
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
            parentAdjudication: MOCK_REVIEWER_PARENT_ADJUDICATION,
            interactive: { autoApprove: "off" as const },
          },
        };
      }
      if (rawArgs === "mode llm") {
        return { ok: false as const, error: "reviewer-rewire-failed: missing provider" };
      }
      throw new Error(`unexpected reviewerDispatch: ${rawArgs}`);
    });

    await act(async () => {
      render(<PermissionsTab />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("auto")));
    });

    // The exec mode switch succeeds, but the auto-wired `mode llm` reviewer
    // dispatch fails → surface the rewire-failure banner.
    expect(api.permission.setMode).toHaveBeenCalledWith("auto");
    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("mode llm");
    expect(screen.getByText(/이전 설정으로 복원했습니다/)).toBeTruthy();
    expect(screen.getByText(/상세: missing provider/)).toBeTruthy();
  });

  it("adds and removes additional directories through the slash-backed IPC", async () => {
    const api = installApi([[]]);
    api.permission.dirDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "list") {
        return {
          ok: true as const,
          verb: "list" as const,
          defaults: [],
          userAdditions: [],
          effective: [],
        };
      }
      if (rawArgs === "allow /tmp/lvis-extra") {
        return {
          ok: true as const,
          verb: "allow" as const,
          persisted: ["/tmp/lvis-extra"],
          sessionOnly: false,
          warnings: [],
        };
      }
      return {
        ok: true as const,
        verb: "deny" as const,
        persisted: [],
      };
    });

    await act(async () => {
      render(<PermissionsTab />);
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("경로 (예: ~/Documents/project)"), {
        target: { value: "/tmp/lvis-extra" },
      });
      fireEvent.click(screen.getAllByText("추가").at(-1)!);
    });

    expect(api.permission.dirDispatch).toHaveBeenCalledWith("allow /tmp/lvis-extra");
    expect(screen.getByText("/tmp/lvis-extra")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getAllByText("✕").at(-1)!);
    });

    expect(api.permission.dirDispatch).toHaveBeenCalledWith("deny /tmp/lvis-extra");
  });

  it("keeps the settings pane scroll position after removing an additional directory", async () => {
    const api = installApi([[]]);
    api.permission.dirDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "list") {
        return {
          ok: true as const,
          verb: "list" as const,
          defaults: [],
          userAdditions: ["/tmp/a", "/tmp/b", "/tmp/c"],
          effective: ["/tmp/a", "/tmp/b", "/tmp/c"],
        };
      }
      if (rawArgs === "deny /tmp/b") {
        return {
          ok: true as const,
          verb: "deny" as const,
          persisted: ["/tmp/a", "/tmp/c"],
        };
      }
      throw new Error(`unexpected dirDispatch: ${rawArgs}`);
    });
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });

    await act(async () => {
      render(
        <div className="lvis-settings-scroll">
          <PermissionsTab />
        </div>,
      );
    });

    const scroller = document.querySelector<HTMLElement>(".lvis-settings-scroll")!;
    scroller.scrollTop = 720;
    const row = screen.getByText("/tmp/b").closest("tr")!;
    const removeButton = row.querySelector("button")!;

    await act(async () => {
      fireEvent.click(removeButton);
    });

    expect(api.permission.dirDispatch).toHaveBeenCalledWith("deny /tmp/b");
    expect(screen.queryByText("/tmp/b")).toBeNull();
    expect(scroller.scrollTop).toBe(720);

    requestAnimationFrameSpy.mockRestore();
  });

  it("requires an explicit warning acknowledgement before saving risky directories", async () => {
    const api = installApi([[]]);
    api.permission.dirDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "list") {
        return {
          ok: true as const,
          verb: "list" as const,
          defaults: [],
          userAdditions: [],
          effective: [],
        };
      }
      if (rawArgs === "allow /tmp/project/.git") {
        return {
          ok: false as const,
          error: "directory has adjacency warnings; explicit acknowledgement required",
          warnings: ["path contains .git"],
          requiresAcknowledgement: true,
        };
      }
      if (rawArgs === "allow --ack-warnings /tmp/project/.git") {
        return {
          ok: true as const,
          verb: "allow" as const,
          persisted: ["/tmp/project/.git"],
          sessionOnly: false,
          warnings: ["path contains .git"],
        };
      }
      throw new Error(`unexpected dirDispatch: ${rawArgs}`);
    });

    await act(async () => {
      render(<PermissionsTab />);
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("경로 (예: ~/Documents/project)"), {
        target: { value: "/tmp/project/.git" },
      });
      fireEvent.click(screen.getAllByText("추가").at(-1)!);
    });

    expect(screen.getByTestId("directory-warning-confirmation")).toBeTruthy();
    expect(screen.queryByText("/tmp/project/.git")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText("경고 확인 후 추가"));
    });

    expect(api.permission.dirDispatch).toHaveBeenCalledWith("allow --ack-warnings /tmp/project/.git");
    expect(screen.getByText("/tmp/project/.git")).toBeTruthy();
  });

  it("renders only the prompt panel when mode=auto + interactive.autoApprove=off", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockResolvedValueOnce({ mode: "auto" });
    // Note: reviewerDispatch("show") default returns interactive.autoApprove="off".
    await act(async () => {
      render(<PermissionsTab />);
    });
    expect(screen.getByTestId(TEST_IDS.reviewerPromptPanel)).toBeTruthy();
    expect(screen.getByTestId(execModeTestId("auto"))).toContainElement(screen.getByTestId(TEST_IDS.reviewerPromptPanel));
    expect(screen.queryByTestId("permissions-legacy-auto-mode-banner")).toBeNull();
    expect(screen.queryByTestId("reviewer-active-llm-source")).toBeNull();
    expect(screen.queryByTestId("reviewer-framework-panel")).toBeNull();
  });

  it("hides the reviewer section (and its banners) entirely under strict mode", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockResolvedValueOnce({ mode: "strict" });
    await act(async () => {
      render(<PermissionsTab />);
    });
    // Single-axis: the reviewer config only exists under 자동 검증, so strict
    // shows no reviewer section and none of its banners.
    expect(screen.queryByTestId("reviewer-framework-panel")).toBeNull();
    expect(screen.queryByTestId("permissions-legacy-auto-mode-banner")).toBeNull();
  });

  it("hides the reviewer section entirely under allow mode", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockResolvedValueOnce({ mode: "allow" });
    await act(async () => {
      render(<PermissionsTab />);
    });
    expect(screen.queryByTestId("reviewer-framework-panel")).toBeNull();
    expect(screen.queryByTestId("permissions-legacy-auto-mode-banner")).toBeNull();
  });

  it("does NOT render the auto-mode auto-approve-off banner under non-auto modes", async () => {
    installApi([[]]);
    // Default = mode "default" → reviewer section (and its banner) hidden.
    await act(async () => {
      render(<PermissionsTab />);
    });
    expect(screen.queryByTestId("permissions-legacy-auto-mode-banner")).toBeNull();
  });
});

describe("PermissionsTab — explicit-approval policy editability", () => {
  const CHECKBOX_LABEL = t("permissionsTab.approvalDialogCheckboxAriaLabel");

  it("enables the checkbox when no admin policy is deployed", async () => {
    installApi([[]]);
    await act(async () => {
      render(<PermissionsTab />);
    });
    expect(screen.getByLabelText(CHECKBOX_LABEL)).not.toBeDisabled();
    expect(screen.queryByTitle("IT 관리자 설정")).toBeNull();
  });

  // The case the `managed` flag alone gets wrong: an admin-dir policy that
  // pins requireExplicitApproval without claiming `managed`. loadPolicy returns
  // managed:false + source:"admin", savePolicy still refuses every write.
  it("locks the checkbox for an admin-dir policy that does not set managed:true", async () => {
    const api = installApi([[]]);
    api.policy.get.mockResolvedValueOnce(policyGetPayload({
      requireExplicitApproval: true,
      managed: false,
      source: "admin",
      adminPath: "/etc/lvis/policy.json",
    }));
    await act(async () => {
      render(<PermissionsTab />);
    });
    expect(screen.getByLabelText(CHECKBOX_LABEL)).toBeDisabled();
    expect(screen.getByTitle("IT 관리자 설정")).toBeTruthy();
    expect(screen.getByText(/\/etc\/lvis\/policy.json/)).toBeTruthy();
  });

  it("locks the checkbox for a merged admin+user policy with managed:false", async () => {
    const api = installApi([[]]);
    api.policy.get.mockResolvedValueOnce(policyGetPayload({
      requireExplicitApproval: false,
      managed: false,
      source: "merged",
      adminPath: "/etc/lvis/policy.json",
    }));
    await act(async () => {
      render(<PermissionsTab />);
    });
    expect(screen.getByLabelText(CHECKBOX_LABEL)).toBeDisabled();
  });

  it("locks the checkbox for a user policy with managed:true", async () => {
    const api = installApi([[]]);
    api.policy.get.mockResolvedValueOnce(policyGetPayload({
      requireExplicitApproval: true,
      managed: true,
      source: "user",
    }));
    await act(async () => {
      render(<PermissionsTab />);
    });
    expect(screen.getByLabelText(CHECKBOX_LABEL)).toBeDisabled();
  });
});

describe("PermissionsTab — OS sandbox toggle and capability rendering", () => {
  function settingsApi() {
    return window.lvisApi as unknown as {
      getSettings: ReturnType<typeof vi.fn>;
      updateSettings: ReturnType<typeof vi.fn>;
    };
  }

  it("rolls back optimistic enable when settings IPC returns an error", async () => {
    const api = installApi([[]]);
    settingsApi().updateSettings.mockResolvedValueOnce({
      ok: false as const,
      error: "persist-failed",
      message: "저장 실패",
    });

    await act(async () => {
      render(<PermissionsTab />);
    });

    const toggle = screen.getByTestId("os-sandbox-toggle");
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(settingsApi().updateSettings).toHaveBeenCalledWith({
      features: { osToolSandbox: true },
    });
    expect(api.permission.sandboxCapability).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("저장 실패")).toBeTruthy();
  });

  it("renders platform potential, runtime reason, and restart note as separate branches", async () => {
    const api = installApi([[]]);
    api.permission.sandboxCapability.mockResolvedValueOnce({
      platform: "linux" as NodeJS.Platform,
      enabled: true,
      available: true,
      kind: "full" as const,
      reason: "legacy summary",
      potentialReason: "platform can confine filesystem, process, and network",
      runtime: {
        available: true,
        kind: "full" as const,
        reason: "ASRT runtime registered at startup",
      },
      confines: { filesystem: true, process: true, network: true },
    });
    settingsApi().getSettings.mockResolvedValueOnce({ features: { osToolSandbox: true } });

    await act(async () => {
      render(<PermissionsTab />);
    });

    expect(screen.getByTestId("os-sandbox-potential-reason")).toHaveTextContent(
      "platform can confine filesystem, process, and network",
    );
    expect(screen.getByTestId("os-sandbox-runtime-reason")).toHaveTextContent(
      "ASRT runtime registered at startup",
    );
    expect(screen.getByText(/변경 사항은 앱을 재시작한 후 적용됩니다/)).toBeTruthy();
  });

  it("says the environment is deciding the sandbox when the variable is set", async () => {
    // `LVIS_SANDBOX_ENABLED=1` is OR-ed with the setting at boot, so without
    // this line the toggle reads "off" while the sandbox is on, and turning it
    // off again does nothing — a control that lies about the running app.
    installApi([[]], ["features.osToolSandbox"]);

    await act(async () => {
      render(<PermissionsTab />);
    });

    await waitFor(() => {
      expect(screen.getByTestId("os-sandbox-forced")).toHaveTextContent("LVIS_SANDBOX_ENABLED");
    });
    // The control stays usable: the stored value still decides the next run
    // launched without the variable.
    expect(screen.getByTestId("os-sandbox-toggle")).not.toBeDisabled();
  });

  it("stays silent about the environment when no variable is forcing it", async () => {
    installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });

    expect(screen.queryByTestId("os-sandbox-forced")).toBeNull();
  });

  it("renders the unavailable branch and disables the toggle for unsupported platforms", async () => {
    const api = installApi([[]]);
    api.permission.sandboxCapability.mockResolvedValueOnce({
      platform: "freebsd" as NodeJS.Platform,
      enabled: false,
      available: false,
      kind: "none" as const,
      reason: "OS sandbox is fail-closed on this platform; tools run unconfined",
      potentialReason: "OS sandbox is fail-closed on this platform; tools run unconfined",
      runtime: {
        available: false,
        kind: "none" as const,
        reason: "no OS sandbox configured for the host process",
      },
      confines: { filesystem: false, process: false, network: false },
    });

    await act(async () => {
      render(<PermissionsTab />);
    });

    expect(screen.getByTestId("os-sandbox-unavailable")).toHaveTextContent("freebsd");
    expect(screen.getByTestId("os-sandbox-toggle")).toBeDisabled();
    expect(screen.queryByTestId("os-sandbox-potential-reason")).toBeNull();
    expect(screen.queryByTestId("os-sandbox-runtime-reason")).toBeNull();
  });
});

describe("PermissionsTab — handleWindowsInstall error-shape robustness", () => {
  /**
   * When sandboxWindowsInstall returns an error shape (ok: false), the handler
   * must keep the user's opt-in setting enabled and keep the consent panel
   * visible so the install can be retried. The UI surfaces the error separately
   * from the persisted desire to enable ASRT.
   */
  function installApiWithWindows(overrides: {
    sandboxWindowsInstall?: ReturnType<typeof vi.fn>;
    sandboxWindowsStatus?: ReturnType<typeof vi.fn>;
  } = {}) {
    const windowsStatus = {
      applicable: true,
      userState: "absent" as const,
      wfpState: "absent" as const,
      ready: false,
      instructions: "Run srt-win install…",
    };
    const lvis = {
      permission: {
        getMode: vi.fn(async () => ({ mode: "default" })),
        setMode: vi.fn(async (mode: string) => ({ ok: true, mode })),
        onModeChanged: vi.fn(() => () => undefined),
        listRules: vi.fn(async () => []),
        addRule: vi.fn(async () => ({ ok: true, rule: { pattern: "x", action: "allow" } })),
        removeRule: vi.fn(async () => ({ ok: true })),
        deferredList: vi.fn(async () => ({ ok: true, pending: [], total: 0 })),
        deferredResolve: vi.fn(async () => ({ ok: true })),
        onDeferredPending: vi.fn(() => () => undefined),
        hookTrustList: vi.fn(async () => ({ ok: true, active: [], disabled: [], totalDisabled: 0 })),
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
            mode: "disabled" as const,
            provider: "openai" as const,
            model: "gpt-4o-mini",
            fallbackOnError: "deny" as const,
            parentAdjudication: MOCK_REVIEWER_PARENT_ADJUDICATION,
            interactive: { autoApprove: "off" as const },
          },
        })),
        reviewerProviderHasKey: vi.fn(async () => false),
        sandboxCapability: vi.fn(async () => ({
          platform: "win32" as NodeJS.Platform,
          enabled: true,
          available: true,
          kind: "partial" as const,
          reason: "ASRT (srt-win) confines filesystem access and network egress; process isolation is unavailable on Windows; needs a one-time admin install",
          potentialReason: "ASRT (srt-win) confines filesystem access and network egress; process isolation is unavailable on Windows; needs a one-time admin install",
          runtime: {
            available: false,
            kind: "none" as const,
            reason: "no OS sandbox configured for the host process",
          },
          confines: { filesystem: true, process: false, network: true },
        })),
        sandboxWindowsStatus: overrides.sandboxWindowsStatus ?? vi.fn(async () => windowsStatus),
        sandboxWindowsInstall: overrides.sandboxWindowsInstall ?? vi.fn(async () => ({ cancelled: true })),
      },
      policy: {
        get: vi.fn(async () => ({
          requireExplicitApproval: true,
          managed: false,
          source: "defaults",
        })),
        set: vi.fn(async () => ({ ok: true })),
      },
    };
    (globalThis as unknown as { window: typeof window }).window.lvis = lvis as never;
    // osToolSandbox=true so the component loads into the Windows consent state
    const api = installMockLvisApi({ settings: { features: { osToolSandbox: true } } });
    return { lvis, updateSettings: api.updateSettings! };
  }

  it("keeps opt-in enabled and shows error banner on ok:false error shape", async () => {
    const { updateSettings } = installApiWithWindows({
      sandboxWindowsInstall: vi.fn(async () => ({
        ok: false as const,
        error: "install-failed",
        message: "srt-win returned non-zero",
      })),
    });

    await act(async () => {
      render(<PermissionsTab />);
    });

    // The consent panel must be visible (sandboxEnabled=true, applicable, not ready).
    const installBtn = screen.getByTestId("os-sandbox-windows-consent");
    expect(installBtn).toBeTruthy();

    // Click "Re-provision" (i18n key osSandboxWindowsInstallButton → "재설정") — triggers the error-shape branch.
    await act(async () => {
      fireEvent.click(screen.getByText("재설정"));
    });

    // osToolSandbox must not be reverted to false; the user opted in and the
    // consent panel remains the place to retry/follow instructions.
    expect(updateSettings).not.toHaveBeenCalledWith({ features: { osToolSandbox: false } });

    // An error banner must appear (the i18n key osSandboxWindowsInstallError
    // wraps the detail: "Windows 샌드박스 설치 오류: {message}").
    expect(screen.getByText(/srt-win returned non-zero/)).toBeTruthy();

    // The consent panel must remain visible (toggle stays enabled).
    expect(screen.getByTestId("os-sandbox-windows-consent")).toBeTruthy();
  });

  it("keeps opt-in enabled when UAC is cancelled so the user can retry", async () => {
    const { updateSettings } = installApiWithWindows({
      sandboxWindowsInstall: vi.fn(async () => ({ cancelled: true })),
    });

    await act(async () => {
      render(<PermissionsTab />);
    });

    await act(async () => {
      fireEvent.click(screen.getByText("재설정"));
    });

    expect(updateSettings).not.toHaveBeenCalledWith({ features: { osToolSandbox: false } });
    expect(screen.getByTestId("os-sandbox-windows-install-cancelled")).toBeTruthy();
    expect(screen.getByTestId("os-sandbox-windows-consent")).toBeTruthy();
  });
});

/**
 * A refresh must not blank the panel.
 *
 * Every rule/directory mutation broadcasts a permission-config-changed hint,
 * and this tab answers it by re-running `fetchAll`. While `loading` was true
 * for THAT fetch too, the whole panel collapsed to a single "loading" line —
 * the scroll container went from thousands of pixels to one viewport, the
 * browser clamped scrollTop to the new maximum, and the position was gone by
 * the time the content came back. Measured on the real app: removing a rule
 * near the bottom took the scroll container from 1562 to 8.
 */
describe("PermissionsTab background refresh", () => {
  it("keeps the loaded panel on screen while a config-change refresh runs", async () => {
    const api = installApi([[], []]);
    const onConfigChanged = api.permission.onConfigChanged as unknown as ReturnType<typeof vi.fn>;

    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() => expect(screen.queryByTestId("permissions-loading")).toBeNull());

    // The hint the host broadcasts after addRule/removeRule.
    const notify = onConfigChanged.mock.calls[0]?.[0] as (() => void) | undefined;
    expect(notify).toBeTypeOf("function");

    let resolveRules: ((rows: never[]) => void) | undefined;
    (api.permission.listRules as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => { resolveRules = resolve as (rows: never[]) => void; }),
    );

    await act(async () => {
      notify!();
    });

    // Mid-refresh: the panel the user was reading is still there.
    expect(screen.queryByTestId("permissions-loading")).toBeNull();
    expect(screen.getByTestId("permissions-rule-pattern-input")).toBeTruthy();

    await act(async () => {
      resolveRules?.([]);
    });
    expect(screen.queryByTestId("permissions-loading")).toBeNull();
  });

  it("still shows the loading surface on the FIRST load, where there is nothing to keep", async () => {
    const api = installApi([[]]);
    let resolveRules: ((rows: never[]) => void) | undefined;
    (api.permission.listRules as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => { resolveRules = resolve as (rows: never[]) => void; }),
    );

    await act(async () => {
      render(<PermissionsTab />);
    });
    expect(screen.getByTestId("permissions-loading")).toBeTruthy();

    await act(async () => {
      resolveRules?.([]);
    });
    await waitFor(() => expect(screen.queryByTestId("permissions-loading")).toBeNull());
  });
});

describe("PermissionsTab — revoking a stored approval", () => {
  it("revokes a persistent decision at once, with nothing to confirm", async () => {
    // Removing a stored decision destroys nothing and grants nothing: the next
    // matching call follows the current policy and may ask again. A browser
    // confirm here blocked the renderer thread to ask about an action that was
    // already reversible by re-answering the prompt.
    const confirm = vi.spyOn(window, "confirm");
    try {
      const api = installApi([[]]);
      (api.userApproval.list as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => [
        {
          key: "bash:rm",
          decision: "allow" as const,
          approvedAt: "2026-01-01T00:00:00.000Z",
          scope: "persistent" as const,
          verdictAtApproval: "medium" as const,
          nlJustification: null,
          revokedAt: null,
          toolName: "bash",
        },
      ]);

      await act(async () => {
        render(<PermissionsTab />);
      });
      await waitFor(() => expect(screen.getByTestId("permissions-approvals-table")).toBeTruthy());

      await act(async () => {
        fireEvent.click(screen.getByText(t("permissionsTab.revokeButton")));
      });

      expect(confirm).not.toHaveBeenCalled();
      expect(api.userApproval.revokeByKey).toHaveBeenCalledWith("bash:rm");
    } finally {
      confirm.mockRestore();
    }
  });
});
