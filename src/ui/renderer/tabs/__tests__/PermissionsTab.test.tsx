// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

    expect(screen.getByText("기본 (Default)")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("자동 (Auto)").closest("button")!);
    });

    expect(api.permission.setMode).toHaveBeenCalledWith("auto");
    expect(screen.getByText("사용자가 모드 변경을 거부했습니다.")).toBeTruthy();
    const defaultButton = screen.getByText("기본 (Default)").closest("button")!;
    const autoButton = screen.getByText("자동 (Auto)").closest("button")!;
    expect(defaultButton.className).toContain("border-primary");
    expect(autoButton.className).not.toContain("border-primary");
  });

  it("marks the returned mode active after durable mode confirmation succeeds", async () => {
    const api = installApi([[]]);

    await act(async () => {
      render(<PermissionsTab />);
    });

    await act(async () => {
      fireEvent.click(screen.getByText("자동 (Auto)").closest("button")!);
    });

    expect(api.permission.setMode).toHaveBeenCalledWith("auto");
    const autoButton = screen.getByText("자동 (Auto)").closest("button")!;
    expect(autoButton.className).toContain("border-primary");
  });

  it("hydrates the active mode from durable settings on mount", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockResolvedValueOnce({ mode: "auto" });

    await act(async () => {
      render(<PermissionsTab />);
    });

    const autoButton = screen.getByText("자동 (Auto)").closest("button")!;
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
});
