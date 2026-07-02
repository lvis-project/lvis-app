/**
 * permissions.ts (handlers) — negative-path regression guards for the trust
 * narrowing (3-agent cluster review of PR #1441, critic MAJOR-1).
 *
 * `resolveApprovalBypass` is the ONLY place a transport-agnostic
 * {@link SetPermissionModeBypass} is narrowed into the strict
 * {@link PermissionModeApprovalBypass} that lets `applyPermissionModeCommand`
 * skip the in-app approval modal. These tests pin down every rejected shape
 * as well as the two accepted surfaces, plus a behavior-level guard that a
 * rejected bypass never short-circuits the durable-mode approval flow in
 * {@link handleSetPermissionMode}.
 */
import { describe, expect, it, vi } from "vitest";

import {
  handleSetPermissionMode,
  resolveApprovalBypass,
  type SetPermissionModeBypass,
} from "../permissions.js";
import type { IpcDeps } from "../../types.js";

describe("resolveApprovalBypass", () => {
  it("rejects a local-api-approval bypass with a non-external trustOrigin (user-keyboard)", () => {
    const bypass: SetPermissionModeBypass = {
      source: "local-api-approval",
      trustOrigin: "user-keyboard",
      explicitUserAction: true,
    };
    expect(resolveApprovalBypass(bypass)).toBeUndefined();
  });

  it("rejects a local-api-approval bypass with an unrecognized trustOrigin", () => {
    const bypass: SetPermissionModeBypass = {
      source: "local-api-approval",
      trustOrigin: "garbage-origin",
      explicitUserAction: true,
    };
    expect(resolveApprovalBypass(bypass)).toBeUndefined();
  });

  it("accepts a local-api-approval bypass with the local-api external origin", () => {
    const bypass: SetPermissionModeBypass = {
      source: "local-api-approval",
      trustOrigin: "local-api",
      explicitUserAction: true,
    };
    expect(resolveApprovalBypass(bypass)).toEqual({
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
    expect(resolveApprovalBypass(bypass)).toEqual({
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
    expect(resolveApprovalBypass(bypass)).toEqual({
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
    expect(resolveApprovalBypass(bypass)).toEqual({
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
      expect(resolveApprovalBypass(bypass)).toBeUndefined();
    }
  });

  it("rejects an unknown source even with explicitUserAction true and a user-keyboard trustOrigin", () => {
    const bypass: SetPermissionModeBypass = {
      source: "unknown-source",
      trustOrigin: "user-keyboard",
      explicitUserAction: true,
    };
    expect(resolveApprovalBypass(bypass)).toBeUndefined();
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

    // The bypass was rejected by resolveApprovalBypass, so
    // applyPermissionModeCommand had to go through the normal ApprovalGate
    // ask — which this test stubs to deny. The mutation must NOT apply.
    expect(approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
    expect(permissionManager.setModePersist).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: "durable-mode-denied" });
  });
});
