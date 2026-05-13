// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PermissionsTab } from "../PermissionsTab.js";

function installLvisApi() {
  const permission = {
    getMode: vi.fn(async () => ({ mode: "default" })),
    setMode: vi.fn(),
    listRules: vi.fn(async () => []),
    addRule: vi.fn(),
    removeRule: vi.fn(),
    hookTrustList: vi.fn(async () => ({ ok: true, active: [], disabled: [], totalDisabled: 0 })),
    dirDispatch: vi.fn(async () => ({
      ok: true,
      verb: "list",
      defaults: [],
      userAdditions: [],
      effective: [],
    })),
    deferredList: vi.fn(async () => ({
      ok: true,
      total: 1,
      pending: [
        {
          id: "dq-1",
          ts: "2026-05-10T09:00:00.000Z",
          toolName: "write_file",
          source: "builtin",
          category: "write",
          inputSummary: '{"path":"<redacted>"}',
          verdict: { level: "high", reason: "outside allowed directory" },
          status: "pending",
        },
      ],
    })),
    deferredResolve: vi.fn(async () => ({ ok: true })),
    onDeferredPending: vi.fn(() => () => {}),
    reviewerDispatch: vi.fn(async () => ({
      ok: true,
      verb: "show",
      settings: {
        mode: "disabled",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      },
    })),
  };
  (window as unknown as { lvis: unknown }).lvis = {
    permission,
    policy: {
      get: vi.fn(async () => ({
        requireExplicitApproval: true,
        managed: false,
        source: "user",
      })),
      set: vi.fn(),
    },
  };
  return permission;
}

beforeEach(() => {
  delete (window as unknown as { lvis?: unknown }).lvis;
});

describe("PermissionsTab deferred queue surface", () => {
  it("does not mount the deferred queue approval surface inside settings", async () => {
    installLvisApi();

    render(<PermissionsTab />);

    await waitFor(() => {
      expect(screen.getByText("현재 권한 정책")).toBeTruthy();
    });
    expect(screen.queryByTestId("deferred-queue-panel")).toBeNull();
  });

  it("leaves deferred approval actions to the chat queue modal", async () => {
    const permission = installLvisApi();

    render(<PermissionsTab />);

    await waitFor(() => {
      expect(screen.getByText("현재 권한 정책")).toBeTruthy();
    });

    expect(screen.queryByText("write_file")).toBeNull();
    expect(permission.deferredResolve).not.toHaveBeenCalled();
  });
});
