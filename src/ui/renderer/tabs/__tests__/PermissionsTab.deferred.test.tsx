// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("mounts the deferred queue panel inside the permissions tab", async () => {
    installLvisApi();

    render(<PermissionsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("deferred-queue-panel")).toBeTruthy();
    });
    expect(screen.getByText("write_file")).toBeTruthy();
    expect(screen.getByText(/outside allowed directory/)).toBeTruthy();
  });

  it("resolves the visible deferred entry through the tab-mounted panel", async () => {
    const permission = installLvisApi();

    render(<PermissionsTab />);

    await waitFor(() => {
      expect(screen.getByText("write_file")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("승인"));

    await waitFor(() => {
      expect(permission.deferredResolve).toHaveBeenCalledWith("dq-1", "approved");
    });
    expect(permission.deferredList.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
