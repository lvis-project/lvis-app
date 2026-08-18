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
} as never;

/** What the EXTERNAL channel is now allowed to send: session-scoped, non-`allow`. */
const sessionAuto: PermissionModeCommand = {
  kind: "mode",
  mode: "auto",
  durable: false,
} as never;

const EXTERNAL_BYPASS = {
  source: "local-api-approval",
  trustOrigin: "local-api",
  explicitUserAction: true,
} as const;

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

  // ── 3-agent cluster review of PR #1441 — critic minor 1 + audit forensics ──
  it("does not request approval for a SESSION-scoped mode change backed by a local-api-approval bypass, and pins the confirmationSource forensic marker", async () => {
    const deps = makeDeps();

    const result = await applyPermissionModeCommand(sessionAuto, {
      ...deps,
      approvalBypass: EXTERNAL_BYPASS,
    } as never);

    expect(result).toMatchObject({ ok: true, mode: "auto", durable: false });
    expect(deps.approvalGate.requestAndWait).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "mode_change",
        trustOrigin: "user-keyboard",
        fromMode: "default",
        toMode: "auto",
        durable: false,
        confirmationSource: "local-api-approval",
      }),
    );
    // Session-scoped: in-memory only, never written to permissions.json.
    expect(deps.permissionManager.setMode).toHaveBeenCalledWith("auto");
    expect(deps.permissionManager.setModePersist).not.toHaveBeenCalled();
  });

  // ── External-channel ceiling ──
  // One ApprovalGate click is consent to ONE change, not to a standing grant.
  it("refuses a DURABLE mode change on the external channel — nothing is persisted and nothing is audited as applied", async () => {
    const deps = makeDeps();

    const result = await applyPermissionModeCommand(durableAuto, {
      ...deps,
      approvalBypass: EXTERNAL_BYPASS,
    } as never);

    expect(result).toMatchObject({ ok: false, error: "external-durable-forbidden" });
    expect(deps.permissionManager.setModePersist).not.toHaveBeenCalled();
    expect(deps.permissionManager.setMode).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });

  it("refuses the `allow` mode on the external channel even session-scoped", async () => {
    const deps = makeDeps();

    const result = await applyPermissionModeCommand(
      { kind: "mode", mode: "allow", durable: false } as never,
      { ...deps, approvalBypass: EXTERNAL_BYPASS } as never,
    );

    expect(result).toMatchObject({ ok: false, error: "external-mode-forbidden" });
    expect(deps.permissionManager.setMode).not.toHaveBeenCalled();
    expect(deps.permissionManager.setModePersist).not.toHaveBeenCalled();
  });

  it("keeps `allow` reachable for the in-app settings surface (local UI is a different trust context)", async () => {
    const deps = makeDeps();

    const result = await applyPermissionModeCommand(
      { kind: "mode", mode: "allow", durable: true } as never,
      {
        ...deps,
        approvalBypass: {
          source: "settings-ui",
          trustOrigin: "user-keyboard",
          explicitUserAction: true,
        },
      } as never,
    );

    expect(result).toMatchObject({ ok: true, mode: "allow", durable: true });
    expect(deps.permissionManager.setModePersist).toHaveBeenCalledWith("allow");
  });

  // The bypass union pins trustOrigin: ExternalOrigin for the local-api-approval
  // variant, but callers hand-build these literals (src/engine/turn/commands.ts)
  // so a bad cast at a JS call site can smuggle a non-external origin in. The
  // apply path must re-check at runtime, not trust the type.
  it("still asks the approval gate when a local-api-approval bypass carries a non-external trustOrigin", async () => {
    const deps = makeDeps();
    deps.approvalGate.requestAndWait.mockResolvedValueOnce({
      requestId: "r", choice: "deny" as never,
    } as never);

    const result = await applyPermissionModeCommand(durableAuto, {
      ...deps,
      approvalBypass: {
        source: "local-api-approval",
        trustOrigin: "user-keyboard",
        explicitUserAction: true,
      },
    } as never);

    expect(deps.approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, error: "durable-mode-denied" });
    expect(deps.permissionManager.setModePersist).not.toHaveBeenCalled();
  });

  it("does not attribute a rejected bypass in the permission audit chain", async () => {
    const deps = makeDeps();

    const result = await applyPermissionModeCommand(durableAuto, {
      ...deps,
      approvalBypass: {
        source: "local-api-approval",
        trustOrigin: "garbage-origin",
        explicitUserAction: true,
      },
    } as never);

    expect(result).toMatchObject({ ok: true });
    expect(deps.approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "mode_change", confirmationSource: undefined }),
    );
  });
});
