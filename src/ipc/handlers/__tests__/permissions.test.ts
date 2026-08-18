/**
 * permissions.ts (handlers) — negative-path regression guards for the trust
 * narrowing (3-agent cluster review of PR #1441, critic MAJOR-1).
 *
 * `resolvePermissionModeApprovalBypass`
 * (`src/permissions/permission-mode-apply.ts`) is the ONLY place a
 * transport-agnostic {@link SetPermissionModeBypass} is narrowed into the strict
 * {@link PermissionModeApprovalBypass} that lets `applyPermissionModeCommand`
 * skip the in-app approval surface. These tests pin down every rejected shape
 * as well as the two accepted surfaces, plus a behavior-level guard that a
 * rejected bypass never short-circuits the durable-mode approval flow in
 * {@link handleSetPermissionMode}.
 */
import { describe, expect, it, vi } from "vitest";

import {
  handleSetPermissionMode,
  type SetPermissionModeBypass,
} from "../permissions.js";
import {
  resolvePermissionModeApprovalBypass,
} from "../../../permissions/permission-mode-apply.js";
import type { IpcDeps } from "../../types.js";

describe("resolvePermissionModeApprovalBypass", () => {
  it("rejects a local-api-approval bypass with a non-external trustOrigin (user-keyboard)", () => {
    const bypass: SetPermissionModeBypass = {
      source: "local-api-approval",
      trustOrigin: "user-keyboard",
      explicitUserAction: true,
    };
    expect(resolvePermissionModeApprovalBypass(bypass)).toBeUndefined();
  });

  it("rejects a local-api-approval bypass with an unrecognized trustOrigin", () => {
    const bypass: SetPermissionModeBypass = {
      source: "local-api-approval",
      trustOrigin: "garbage-origin",
      explicitUserAction: true,
    };
    expect(resolvePermissionModeApprovalBypass(bypass)).toBeUndefined();
  });

  it("accepts a local-api-approval bypass with the local-api external origin", () => {
    const bypass: SetPermissionModeBypass = {
      source: "local-api-approval",
      trustOrigin: "local-api",
      explicitUserAction: true,
    };
    expect(resolvePermissionModeApprovalBypass(bypass)).toEqual({
      source: "local-api-approval",
      trustOrigin: "local-api",
      explicitUserAction: true,
    });
  });

  it("accepts a local-api-approval bypass with the cli external origin", () => {
    const bypass: SetPermissionModeBypass = {
      source: "local-api-approval",
      trustOrigin: "cli",
      explicitUserAction: true,
    };
    expect(resolvePermissionModeApprovalBypass(bypass)).toEqual({
      source: "local-api-approval",
      trustOrigin: "cli",
      explicitUserAction: true,
    });
  });

  it("accepts a settings-ui bypass with a user-keyboard trustOrigin", () => {
    const bypass: SetPermissionModeBypass = {
      source: "settings-ui",
      trustOrigin: "user-keyboard",
      explicitUserAction: true,
    };
    expect(resolvePermissionModeApprovalBypass(bypass)).toEqual({
      source: "settings-ui",
      trustOrigin: "user-keyboard",
      explicitUserAction: true,
    });
  });

  it("accepts a builtin-slash bypass with a user-keyboard trustOrigin", () => {
    const bypass: SetPermissionModeBypass = {
      source: "builtin-slash",
      trustOrigin: "user-keyboard",
      explicitUserAction: true,
    };
    expect(resolvePermissionModeApprovalBypass(bypass)).toEqual({
      source: "builtin-slash",
      trustOrigin: "user-keyboard",
      explicitUserAction: true,
    });
  });

  it("rejects any recognized source when explicitUserAction is false", () => {
    const sources: SetPermissionModeBypass["source"][] = [
      "settings-ui",
      "builtin-slash",
      "local-api-approval",
    ];
    for (const source of sources) {
      const bypass: SetPermissionModeBypass = {
        source,
        trustOrigin: source === "local-api-approval" ? "local-api" : "user-keyboard",
        explicitUserAction: false,
      };
      expect(resolvePermissionModeApprovalBypass(bypass)).toBeUndefined();
    }
  });

  it("rejects an unknown source even with explicitUserAction true and a user-keyboard trustOrigin", () => {
    const bypass: SetPermissionModeBypass = {
      source: "unknown-source",
      trustOrigin: "user-keyboard",
      explicitUserAction: true,
    };
    expect(resolvePermissionModeApprovalBypass(bypass)).toBeUndefined();
  });
});

describe("handleSetPermissionMode — rejected bypass does not short-circuit approval", () => {
  function makeDeps() {
    let mode = "default";
    const permissionManager = {
      getMode: vi.fn(() => mode),
      setMode: vi.fn((next: string) => {
        mode = next;
      }),
      setModePersist: vi.fn(async (next: string) => {
        mode = next;
      }),
    };
    const approvalGate = {
      requestAndWait: vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "deny-once" as const,
      })),
    };
    const auditLogger = {
      isPermissionAuditChainReady: vi.fn(() => true),
      appendPermissionAuditEntry: vi.fn(async () => undefined),
    };
    const deps = {
      conversationLoop: { permissionManager },
      approvalGate,
      auditLogger,
      getMainWindow: vi.fn(() => null),
      getAppWindows: vi.fn(() => []),
    } as unknown as IpcDeps;
    return { deps, permissionManager, approvalGate, auditLogger };
  }

  it("a rejected local-api-approval shape (user-keyboard trustOrigin) falls through to the ApprovalGate ask, which denies the durable mode change", async () => {
    const { deps, permissionManager, approvalGate } = makeDeps();

    const result = await handleSetPermissionMode(deps, "auto", {
      source: "local-api-approval",
      trustOrigin: "user-keyboard",
      explicitUserAction: true,
    });

    // The bypass was rejected by resolvePermissionModeApprovalBypass, so
    // applyPermissionModeCommand had to go through the normal ApprovalGate
    // ask — which this test stubs to deny. The mutation must NOT apply.
    expect(approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
    expect(permissionManager.setModePersist).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: "durable-mode-denied" });
  });

  // ── Durability follows the CHANNEL ──
  it("the in-app settings surface still gets a DURABLE change (unchanged local-UI trust context)", async () => {
    const { deps, permissionManager, approvalGate } = makeDeps();

    const result = await handleSetPermissionMode(deps, "auto", {
      source: "settings-ui",
      trustOrigin: "user-keyboard",
      explicitUserAction: true,
    });

    expect(result).toEqual({ ok: true, mode: "auto" });
    expect(permissionManager.setModePersist).toHaveBeenCalledWith("auto");
    expect(permissionManager.setMode).not.toHaveBeenCalled();
    // The built-in confirmation still stands in for the prompt.
    expect(approvalGate.requestAndWait).not.toHaveBeenCalled();
  });

  it("the in-app settings surface may still select `allow`", async () => {
    const { deps, permissionManager } = makeDeps();

    const result = await handleSetPermissionMode(deps, "allow", {
      source: "settings-ui",
      trustOrigin: "user-keyboard",
      explicitUserAction: true,
    });

    expect(result).toEqual({ ok: true, mode: "allow" });
    expect(permissionManager.setModePersist).toHaveBeenCalledWith("allow");
  });

  it("the external channel gets a SESSION-scoped change — nothing is persisted", async () => {
    const { deps, permissionManager, approvalGate } = makeDeps();

    const result = await handleSetPermissionMode(deps, "auto", {
      source: "local-api-approval",
      trustOrigin: "local-api",
      explicitUserAction: true,
    });

    expect(result).toEqual({ ok: true, mode: "auto" });
    expect(permissionManager.setMode).toHaveBeenCalledWith("auto");
    expect(permissionManager.setModePersist).not.toHaveBeenCalled();
    // Still no second prompt: the ApprovalGate dock already asked.
    expect(approvalGate.requestAndWait).not.toHaveBeenCalled();
  });

  it("the external channel cannot select `allow`", async () => {
    const { deps, permissionManager } = makeDeps();

    const result = await handleSetPermissionMode(deps, "allow", {
      source: "local-api-approval",
      trustOrigin: "cli",
      explicitUserAction: true,
    });

    expect(result).toMatchObject({ ok: false, error: "external-mode-forbidden" });
    expect(permissionManager.setMode).not.toHaveBeenCalled();
    expect(permissionManager.setModePersist).not.toHaveBeenCalled();
  });

  // A shape that fails narrowing is NOT "external" — downgrading it to a
  // session change would drop the ApprovalGate ask that currently guards it.
  it("a bypass that fails narrowing still takes the durable path (and its prompt)", async () => {
    const { deps, approvalGate } = makeDeps();

    await handleSetPermissionMode(deps, "auto", {
      source: "unknown-source",
      trustOrigin: "local-api",
      explicitUserAction: true,
    });

    expect(approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
  });
});
