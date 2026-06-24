import { describe, expect, it, vi } from "vitest";

import { applyPermissionModeCommand } from "../permission-mode-apply.js";
import type { PermissionModeCommand } from "../permission-slash.js";

function makeDeps() {
  let mode: PermissionModeCommand["mode"] = "default";
  const permissionManager = {
    getMode: vi.fn(() => mode),
    setMode: vi.fn((next: PermissionModeCommand["mode"]) => {
      mode = next;
    }),
    setModePersist: vi.fn(async (next: PermissionModeCommand["mode"]) => {
      mode = next;
    }),
  };
  const approvalGate = {
    requestAndWait: vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "allow-once" as const,
    })),
  };
  const auditLogger = {
    isPermissionAuditChainReady: vi.fn(() => true),
    appendPermissionAuditEntry: vi.fn(async () => undefined),
  };
  return { permissionManager, approvalGate, auditLogger };
}

const durableAuto: PermissionModeCommand = {
  kind: "mode",
  mode: "auto",
  durable: true,
};

describe("applyPermissionModeCommand", () => {
  it("uses the approval gate for durable mode changes without a trusted built-in confirmation", async () => {
    const deps = makeDeps();

    const result = await applyPermissionModeCommand(durableAuto, deps as never);

    expect(result).toMatchObject({ ok: true, mode: "auto", durable: true });
    expect(deps.approvalGate.requestAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "/permission mode",
        trustOrigin: "user-keyboard",
      }),
    );
    expect(deps.permissionManager.setModePersist).toHaveBeenCalledWith("auto");
  });

  it("does not request approval for durable mode changes backed by explicit built-in user action", async () => {
    const deps = makeDeps();

    const result = await applyPermissionModeCommand(durableAuto, {
      ...deps,
      approvalBypass: {
        source: "settings-ui",
        trustOrigin: "user-keyboard",
        explicitUserAction: true,
      },
    } as never);

    expect(result).toMatchObject({ ok: true, mode: "auto", durable: true });
    expect(deps.approvalGate.requestAndWait).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "mode_change",
        trustOrigin: "user-keyboard",
        fromMode: "default",
        toMode: "auto",
        durable: true,
        confirmationSource: "settings-ui",
      }),
    );
    expect(deps.permissionManager.setModePersist).toHaveBeenCalledWith("auto");
  });
});
