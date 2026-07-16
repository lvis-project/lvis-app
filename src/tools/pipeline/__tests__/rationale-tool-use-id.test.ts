import { describe, expect, it } from "vitest";
import {
  createHostInvocationStartLease,
  validateHostInvocationStartLease,
  validateInvocationAuditRecord,
  type InvocationAuditRecord,
} from "../rationale-ticket-lifecycle.js";
import { RATIONALE_CONTROL_CONTRACT_VERSION } from "../rationale-control.js";

const authorized: InvocationAuditRecord = {
  contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
  ticketId: "11111111-1111-4111-8111-111111111111",
  actionDigest: "a".repeat(64),
  invocationDigest: "b".repeat(64),
  toolUseId: "valid-tool-use",
  authorizationReceiptId: "22222222-2222-4222-8222-222222222222",
  invocationStartLeaseId: null,
  version: 0,
  state: "authorized",
  automaticRetry: "forbidden",
};

describe("rationale lifecycle tool-use IDs", () => {
  it.each([
    ["empty", ""],
    ["oversized", "😀".repeat(65)],
    ["NUL", "raw-secret\u0000id"],
    ["C1", "raw-secret\u0085id"],
  ])("rejects %s audit IDs with a safe error", (_label, toolUseId) => {
    let message = "";
    try {
      validateInvocationAuditRecord({ ...authorized, toolUseId });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("invocation audit tool use ID is invalid");
    expect(message).not.toContain("raw-secret");
  });

  it("applies the same validation to invocation leases", () => {
    const lease = createHostInvocationStartLease({ authorized, now: 100 });
    let message = "";
    try {
      validateHostInvocationStartLease(
        { ...lease, toolUseId: "raw-secret\nlease" },
        authorized,
        100,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("invocation lease tool use ID is invalid");
    expect(message).not.toContain("raw-secret");
  });
});
