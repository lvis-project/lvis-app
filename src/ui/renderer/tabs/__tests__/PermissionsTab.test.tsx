// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  return lvis;
}

beforeEach(() => {
  delete (window as unknown as { lvis?: unknown }).lvis;
});

describe("PermissionsTab hook quarantine notice", () => {
  it("shows the four user-facing permission policy choices and their read behavior", async () => {
    installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });

    expect(screen.getByTestId("exec-mode-default")).toHaveTextContent("기본");
    expect(screen.getByText(/읽기 도구는 허용/)).toBeTruthy();
    expect(screen.getByTestId("exec-mode-strict")).toHaveTextContent("전체 물어보기");
    expect(screen.getByText(/읽기까지 포함해 모든 도구/)).toBeTruthy();
    expect(screen.getByTestId("exec-mode-auto")).toHaveTextContent("자동 검증");
    expect(screen.getByText(/헤드리스 작업은 백그라운드 리뷰어가 검증/)).toBeTruthy();
    expect(screen.getByTestId("exec-mode-allow")).toHaveTextContent("전체 허용");
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
    // `interactive low` dispatch so the new SOT (issue #690 P3) stays
    // coupled to the legacy `auto` UX.
    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("interactive low");
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

  it("hydrates reviewer settings and switches background review to LLM mode", async () => {
    const api = installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("show");
    expect(screen.getAllByText("명시 승인만").length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(screen.getByTestId("reviewer-mode-llm"));
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("mode llm");
    expect(screen.getByTestId("reviewer-provider-select")).toBeTruthy();
    expect(screen.getByTestId("reviewer-fallback-select")).toBeTruthy();
    expect(screen.getByTestId("reviewer-model-input")).toBeTruthy();
    expect(screen.getByTestId("reviewer-framework-panel")).toBeTruthy();
    expect(screen.getByText("permission-reviewer-framework/v1")).toBeTruthy();
  });

  it("exposes the LLM reviewer fallback policy instead of hiding fail-open behavior", async () => {
    const api = installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("reviewer-mode-llm"));
    });
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("reviewer-fallback-select"), {
        button: 0,
        ctrlKey: false,
        pointerId: 1,
        pointerType: "mouse",
      });
    });
    await waitFor(() => {
      expect(screen.getByText(/규칙 결과 사용/)).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByText(/규칙 결과 사용/));
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("fallback rule");
    expect(screen.getByTestId("reviewer-fallback-select").textContent).toContain("규칙 결과 사용");
  });

  it("persists reviewer model changes through reviewerDispatch", async () => {
    const api = installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("reviewer-mode-llm"));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("reviewer-model-input"), {
        target: { value: "gpt-5.5-mini" },
      });
      fireEvent.click(screen.getByText("적용"));
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("model gpt-5.5-mini");
    expect((screen.getByTestId("reviewer-model-input") as HTMLInputElement).value).toBe("gpt-5.5-mini");
  });

  it("toggles interactive auto-approve through reviewerDispatch (issue #690)", async () => {
    const api = installApi([[]]);
    api.permission.reviewerDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "show") {
        return {
          ok: true as const,
          verb: "show" as const,
          settings: {
            mode: "rule" as const,
            provider: "openai" as const,
            model: "gpt-4o-mini",
            fallbackOnError: "deny" as const,
            interactive: { autoApprove: "off" as const },
          },
        };
      }
      if (rawArgs === "interactive low") {
        return {
          ok: true as const,
          verb: "interactive" as const,
          settings: {
            mode: "rule" as const,
            provider: "openai" as const,
            model: "gpt-4o-mini",
            fallbackOnError: "deny" as const,
            interactive: { autoApprove: "low" as const },
          },
        };
      }
      throw new Error(`unexpected reviewerDispatch: ${rawArgs}`);
    });

    await act(async () => {
      render(<PermissionsTab />);
    });
    const off = screen.getByRole("radio", { name: "끔" });
    const low = screen.getByRole("radio", { name: "저위험 자동 허용" });
    // Initial state: "off" is selected.
    expect(off.getAttribute("aria-checked")).toBe("true");
    expect(low.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      fireEvent.click(low);
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("interactive low");
    expect(low.getAttribute("aria-checked")).toBe("true");
    expect(off.getAttribute("aria-checked")).toBe("false");
  });

  // TODO(shadcn-radio-migration): PR #708 swapped the hand-rolled radio buttons
  // for a shadcn RadioGroup, whose keyboard nav lives inside radix-ui and is
  // not triggered by raw fireEvent.keyDown. Re-enable after migrating this
  // test to userEvent.keyboard so the radix-ui internal listener fires.
  it.skip("supports arrow-key navigation for the low-risk auto-allow radio group", async () => {
    const api = installApi([[]]);
    api.permission.reviewerDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "show") {
        return {
          ok: true as const,
          verb: "show" as const,
          settings: {
            mode: "rule" as const,
            provider: "openai" as const,
            model: "gpt-4o-mini",
            fallbackOnError: "deny" as const,
            interactive: { autoApprove: "off" as const },
          },
        };
      }
      if (rawArgs === "interactive low") {
        return {
          ok: true as const,
          verb: "interactive" as const,
          settings: {
            mode: "rule" as const,
            provider: "openai" as const,
            model: "gpt-4o-mini",
            fallbackOnError: "deny" as const,
            interactive: { autoApprove: "low" as const },
          },
        };
      }
      throw new Error(`unexpected reviewerDispatch: ${rawArgs}`);
    });

    await act(async () => {
      render(<PermissionsTab />);
    });
    const off = screen.getByRole("radio", { name: "끔" });
    const low = screen.getByRole("radio", { name: "저위험 자동 허용" });
    expect(off.getAttribute("aria-checked")).toBe("true");
    expect(low.getAttribute("aria-checked")).toBe("false");
    off.focus();

    await act(async () => {
      fireEvent.keyDown(off, { key: "ArrowRight" });
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("interactive low");
    expect(low.getAttribute("aria-checked")).toBe("true");
  });

  it("uses the shadcn radio group for keyboard reviewer updates", async () => {
    const api = installApi([[]]);
    api.permission.reviewerDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "show") {
        return {
          ok: true as const,
          verb: "show" as const,
          settings: {
            mode: "rule" as const,
            provider: "openai" as const,
            model: "gpt-4o-mini",
            fallbackOnError: "deny" as const,
            interactive: { autoApprove: "off" as const },
          },
        };
      }
      if (rawArgs === "interactive low") {
        return {
          ok: true as const,
          verb: "interactive" as const,
          settings: {
            mode: "rule" as const,
            provider: "openai" as const,
            model: "gpt-4o-mini",
            fallbackOnError: "deny" as const,
            interactive: { autoApprove: "low" as const },
          },
        };
      }
      throw new Error(`unexpected reviewerDispatch: ${rawArgs}`);
    });

    await act(async () => {
      render(<PermissionsTab />);
    });
    const off = screen.getByRole("radio", { name: "끔" });
    const low = screen.getByRole("radio", { name: "저위험 자동 허용" });
    off.focus();

    await act(async () => {
      fireEvent.keyDown(off, { key: "ArrowRight" });
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("interactive low");
    expect(low.getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the prior reviewer mode when runtime rewire fails", async () => {
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
      fireEvent.click(screen.getByTestId("reviewer-mode-llm"));
    });

    expect(screen.getByText(/이전 설정으로 복원했습니다/)).toBeTruthy();
    expect(screen.getByText(/상세: missing provider/)).toBeTruthy();
    expect(screen.getByTestId("reviewer-mode-disabled").className).toContain("border-primary");
    expect(screen.getByTestId("reviewer-mode-llm").className).not.toContain("border-primary");
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

  it("renders the legacy auto-mode banner when mode=auto + interactive.autoApprove=off (round-5 test-engineer MAJOR)", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockResolvedValueOnce({ mode: "auto" });
    // Note: reviewerDispatch("show") default returns interactive.autoApprove="off".
    await act(async () => {
      render(<PermissionsTab />);
    });
    expect(screen.getByTestId("permissions-legacy-auto-mode-banner")).toBeTruthy();
  });

  it("renders the strict-low contradiction banner when mode=strict + interactive.autoApprove=low (round-5 test-engineer MAJOR)", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockResolvedValueOnce({ mode: "strict" });
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
            interactive: { autoApprove: "low" as const },
          },
        };
      }
      throw new Error(`unexpected reviewerDispatch: ${rawArgs}`);
    });
    await act(async () => {
      render(<PermissionsTab />);
    });
    expect(screen.getByTestId("permissions-strict-low-contradiction-banner")).toBeTruthy();
  });

  it("renders the allow-mode banner when mode=allow (round-5 architect MAJOR)", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockResolvedValueOnce({ mode: "allow" });
    await act(async () => {
      render(<PermissionsTab />);
    });
    expect(screen.getByTestId("permissions-allow-mode-banner")).toBeTruthy();
  });

  it("does NOT render legacy/contradiction banners under unrelated mode+interactive combos", async () => {
    installApi([[]]);
    // Default = mode "default" + reviewer interactive.autoApprove="off"
    // → no banner should render.
    await act(async () => {
      render(<PermissionsTab />);
    });
    expect(screen.queryByTestId("permissions-legacy-auto-mode-banner")).toBeNull();
    expect(screen.queryByTestId("permissions-strict-low-contradiction-banner")).toBeNull();
    expect(screen.queryByTestId("permissions-allow-mode-banner")).toBeNull();
  });
});
