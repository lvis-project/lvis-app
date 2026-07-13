// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
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


function installApi(disabledBatches: HookTrustRow[][]) {
  const hookTrustList = vi.fn(async () => {
    const disabled = disabledBatches.shift() ?? [];
    return { ok: true as const, active: [], disabled, totalDisabled: disabled.length };
  });
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
      get: vi.fn(async () => ({
        requireExplicitApproval: true,
        managed: false,
        source: "defaults",
      })),
      set: vi.fn(async () => ({ ok: true })),
    },
  };
  (globalThis as unknown as { window: typeof window }).window.lvis = lvis as never;
  (globalThis as unknown as { window: typeof window }).window.lvisApi = {
    getSettings: vi.fn(async () => ({ features: { osToolSandbox: false } })),
    updateSettings: vi.fn(async () => ({})),
  } as never;
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
  it("shows the four user-facing permission policy choices and their read behavior", async () => {
    installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });

    expect(screen.getByTestId("exec-mode-default")).toHaveTextContent("쓰기 확인");
    expect(screen.getByText(/읽기 도구는 허용/)).toBeTruthy();
    expect(screen.getByTestId("exec-mode-strict")).toHaveTextContent("전체 확인");
    expect(screen.getByText(/읽기까지 포함해 모든 도구/)).toBeTruthy();
    expect(screen.getByTestId("exec-mode-auto")).toHaveTextContent("자동 검증");
    expect(screen.getByText(/대화형 저위험·중위험 판정/)).toBeTruthy();
    expect(screen.getByTestId("exec-mode-allow")).toHaveTextContent("모두 허용");
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

    expect(screen.getByTestId("exec-mode-default")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("exec-mode-auto"));
    });

    expect(api.permission.setMode).toHaveBeenCalledWith("auto");
    expect(api.permission.reviewerDispatch).not.toHaveBeenCalledWith("mode llm");
    expect(screen.getByText("사용자가 모드 변경을 거부했습니다.")).toBeTruthy();
    const defaultButton = screen.getByTestId("exec-mode-default");
    const autoButton = screen.getByTestId("exec-mode-auto");
    expect(defaultButton.className).toContain("border-primary");
    expect(autoButton.className).not.toContain("border-primary");
  });

  it("marks the returned mode active after durable mode confirmation succeeds", async () => {
    const api = installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("exec-mode-auto"));
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
    const autoButton = screen.getByTestId("exec-mode-auto");
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
      fireEvent.click(screen.getByTestId("exec-mode-allow"));
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("mode disabled");
    expect(api.permission.setMode).toHaveBeenCalledWith("allow");
    expect(api.permission.setMode.mock.invocationCallOrder[0]).toBeLessThan(
      api.permission.reviewerDispatch.mock.invocationCallOrder.at(-1)!,
    );
    expect(screen.getByTestId("exec-mode-allow").className).toContain("border-primary");
  });

  it("hydrates the active mode from durable settings on mount", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockResolvedValueOnce({ mode: "auto" });

    await act(async () => {
      render(<PermissionsTab />);
    });

    const autoButton = screen.getByTestId("exec-mode-auto");
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
    expect(screen.queryByTestId("reviewer-prompt-panel")).toBeNull();
    expect(screen.queryByTestId("permissions-legacy-auto-mode-banner")).toBeNull();
    expect(screen.queryByTestId("reviewer-llm-degraded-banner")).toBeNull();
  });

  it("keeps hidden reviewer auto-wiring and shows only the prompt collapse inside 자동 검증", async () => {
    const api = installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("exec-mode-auto"));
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("mode llm");
    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("interactive medium");
    expect(screen.queryByTestId("reviewer-active-llm-source")).toBeNull();
    expect(screen.queryByTestId("reviewer-provider-select")).toBeNull();
    expect(screen.queryByTestId("reviewer-fallback-select")).toBeNull();
    expect(screen.queryByTestId("reviewer-model-input")).toBeNull();
    expect(screen.queryByTestId("reviewer-framework-panel")).toBeNull();
    expect(screen.getByTestId("reviewer-prompt-panel")).toBeTruthy();
    expect(screen.getByTestId("exec-mode-auto")).toContainElement(screen.getByTestId("reviewer-prompt-panel"));
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

    expect(screen.queryByTestId("reviewer-prompt-panel")).toBeNull();
    const onModeChanged = api.permission.onModeChanged.mock.calls[0]?.[0] as ((mode: string) => void) | undefined;
    expect(onModeChanged).toBeTruthy();

    await act(async () => {
      onModeChanged?.("auto");
    });

    expect(screen.getByTestId("reviewer-prompt-panel")).toBeTruthy();
    expect(screen.getByTestId("exec-mode-auto")).toContainElement(screen.getByTestId("reviewer-prompt-panel"));
  });

  it("does not expose the reviewer fallback policy in Settings", async () => {
    const api = installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("exec-mode-auto"));
    });

    expect(screen.queryByTestId("reviewer-fallback-select")).toBeNull();
    expect(screen.getByTestId("reviewer-prompt-panel")).toBeTruthy();
    expect(screen.getByTestId("exec-mode-auto")).toContainElement(screen.getByTestId("reviewer-prompt-panel"));
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
      fireEvent.click(screen.getByTestId("exec-mode-auto"));
    });

    expect(screen.queryByTestId("reviewer-provider-select")).toBeNull();
    expect(screen.queryByTestId("reviewer-model-input")).toBeNull();
    expect(screen.queryByTestId("reviewer-active-llm-source")).toBeNull();
    expect(screen.getByTestId("reviewer-prompt-panel")).toBeTruthy();
    expect(screen.getByTestId("exec-mode-auto")).toContainElement(screen.getByTestId("reviewer-prompt-panel"));
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
    expect(screen.getByTestId("reviewer-prompt-panel")).toBeTruthy();
    expect(screen.getByTestId("exec-mode-auto")).toContainElement(screen.getByTestId("reviewer-prompt-panel"));
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
      fireEvent.click(screen.getByTestId("exec-mode-auto"));
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
    expect(screen.getByTestId("reviewer-prompt-panel")).toBeTruthy();
    expect(screen.getByTestId("exec-mode-auto")).toContainElement(screen.getByTestId("reviewer-prompt-panel"));
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
    const updateSettings = vi.fn(async () => ({}));
    (globalThis as unknown as { window: typeof window }).window.lvisApi = {
      // osToolSandbox=true so the component loads into the Windows consent state
      getSettings: vi.fn(async () => ({ features: { osToolSandbox: true } })),
      updateSettings,
    } as never;
    return { lvis, updateSettings };
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
