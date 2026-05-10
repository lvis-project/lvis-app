// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PermissionsTab } from "../PermissionsTab.js";

function installLvisApi() {
  (window as unknown as { lvis: unknown }).lvis = {
    permission: {
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
      deferredResolve: vi.fn(),
      onDeferredPending: vi.fn(() => () => {}),
    },
    policy: {
      get: vi.fn(async () => ({
        requireExplicitApproval: true,
        managed: false,
        source: "user",
      })),
      set: vi.fn(),
    },
  };
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
});
