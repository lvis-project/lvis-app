import { describe, expect, it } from "vitest";
import {
  HOST_SHELL_EXECUTION_PLAN_VERSION,
  buildHostShellExecutionPlan,
  getHostShellExecutionPlanAuditProjection,
  getHostShellExecutionPlanCacheIdentity,
  isIssuedHostShellExecutionPlanAuditProjection,
  requiresExplicitHostShellFallbackApproval,
} from "../host-shell-execution-plan.js";

const FULL_ASRT = {
  kind: "asrt" as const,
  confidence: "verified" as const,
  platform: "darwin" as const,
  reason: "full ASRT",
  confines: { filesystem: true, process: true, network: true },
};

const WINDOWS_PARTIAL_ASRT = {
  kind: "asrt" as const,
  confidence: "verified" as const,
  platform: "win32" as const,
  reason: "srt-win partial",
  confines: { filesystem: true, process: false, network: true },
};

const NONE = {
  kind: "none" as const,
  confidence: "verified" as const,
  platform: "win32" as const,
  reason: "inactive",
  confines: { filesystem: false, process: false, network: false },
};

describe("host shell execution plan", () => {
  it("uses Windows Plan B for requested partial ASRT without calling it a sandbox", () => {
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: WINDOWS_PARTIAL_ASRT,
    });

    expect(plan).toMatchObject({
      version: HOST_SHELL_EXECUTION_PLAN_VERSION,
      requestedSandbox: true,
      mode: "plain",
      fallbackReason: "windows-partial-shell-acl-unsafe",
      requiresExplicitUserApproval: true,
      capability: {
        kind: "none",
        confines: { filesystem: false, process: false, network: false },
      },
    });
    expect(plan.identity).toContain("windows-partial-shell-acl-unsafe");
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.capability)).toBe(true);
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "keeps requested-on but unavailable %s distinct from explicit sandbox-off",
    (platform) => {
      const requested = buildHostShellExecutionPlan({
        platform,
        requestedSandbox: true,
        activeCapability: { ...NONE, platform },
      });
      const off = buildHostShellExecutionPlan({
        platform,
        requestedSandbox: false,
        activeCapability: { ...NONE, platform },
      });

      expect(requested).toMatchObject({
        requestedSandbox: true,
        mode: "plain",
        fallbackReason: "requested-sandbox-unavailable",
        requiresExplicitUserApproval: true,
        capability: {
          kind: "none",
          confines: { filesystem: false, process: false, network: false },
        },
      });
      expect(requiresExplicitHostShellFallbackApproval(requested)).toBe(true);
      expect(off).toMatchObject({
        requestedSandbox: false,
        mode: "plain",
        fallbackReason: "none",
        requiresExplicitUserApproval: false,
      });
      expect(requiresExplicitHostShellFallbackApproval(off)).toBe(false);
    },
  );
  it.each(["darwin", "linux", "win32"] as const)(
    "keeps full %s ASRT on the wrapped route",
    (platform) => {
      const plan = buildHostShellExecutionPlan({
        platform,
        requestedSandbox: true,
        activeCapability: { ...FULL_ASRT, platform },
      });

      expect(plan.mode).toBe("asrt");
      expect(plan.fallbackReason).toBe("none");
      expect(plan.requiresExplicitUserApproval).toBe(false);
      expect(plan.capability).toMatchObject({
        kind: "asrt",
        confines: { filesystem: true, process: true, network: true },
      });
    },
  );

  it("keeps a hypothetical non-Windows partial substrate fail-closed rather than applying Plan B", () => {
    const plan = buildHostShellExecutionPlan({
      platform: "linux",
      requestedSandbox: true,
      activeCapability: {
        ...WINDOWS_PARTIAL_ASRT,
        platform: "linux",
      },
    });

    expect(plan.mode).toBe("blocked");
    expect(plan.fallbackReason).toBe("active-sandbox-not-shell-contained");
    expect(plan.requiresExplicitUserApproval).toBe(false);
    expect(plan.capability).toMatchObject({
      kind: "none",
      confines: { filesystem: false, process: false, network: false },
    });
  });
  it("partitions cache identity by the entire safe plan projection", () => {

    const requested = buildHostShellExecutionPlan({
      platform: "darwin",
      requestedSandbox: true,
      activeCapability: { ...NONE, platform: "darwin" },
    });
    const explicitOff = buildHostShellExecutionPlan({
      platform: "darwin",
      requestedSandbox: false,
      activeCapability: { ...NONE, platform: "darwin" },
    });

    // The sealed requested-unavailable plan gets a distinct route identity, and
    // its cache identity must remain distinct from explicit sandbox-off.
    expect(requested.identity).not.toBe(explicitOff.identity);
    const requestedProjection = getHostShellExecutionPlanAuditProjection(requested);
    const offProjection = getHostShellExecutionPlanAuditProjection(explicitOff);
    expect(getHostShellExecutionPlanCacheIdentity(requestedProjection))
      .not.toBe(getHostShellExecutionPlanCacheIdentity(offProjection));
    expect(getHostShellExecutionPlanCacheIdentity(requestedProjection))
      .toBe(getHostShellExecutionPlanCacheIdentity(requestedProjection));
  });
  it.each(["darwin", "linux", "win32"] as const)(
    "fails closed for future partial substrates on %s",
    (platform) => {
      for (const kind of ["partial", "fs-only"] as const) {
        const plan = buildHostShellExecutionPlan({
          platform,
          requestedSandbox: true,
          activeCapability: {
            kind,
            confidence: "policy-best-effort",
            platform,
            reason: "future partial substrate",
            confines: {
              filesystem: kind === "fs-only",
              process: false,
              network: false,
            },
          },
        });

        expect(plan).toMatchObject({
          requestedSandbox: true,
          mode: "blocked",
          fallbackReason: "active-sandbox-not-shell-contained",
          requiresExplicitUserApproval: false,
          capability: {
            kind: "none",
            confines: { filesystem: false, process: false, network: false },
          },
        });
      }
    },
  );
  it("returns one immutable allowlist-only audit projection per execution plan", () => {
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: {
        ...WINDOWS_PARTIAL_ASRT,
        reason: "internal capability detail that must not be audited",
      },
    });

    const projection = getHostShellExecutionPlanAuditProjection(plan);
    expect(getHostShellExecutionPlanAuditProjection(plan)).toBe(projection);
    expect(projection).toMatchObject({
      version: HOST_SHELL_EXECUTION_PLAN_VERSION,
      identity: plan.identity,
      platform: "win32",
      requestedSandbox: true,
      mode: "plain",
      fallbackReason: "windows-partial-shell-acl-unsafe",
      requiresExplicitUserApproval: true,
      capability: {
        kind: "none",
        confidence: "verified",
        platform: "win32",
        confines: { filesystem: false, process: false, network: false },
      },
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.capability)).toBe(true);
    expect(Object.isFrozen(projection.capability.confines)).toBe(true);
    expect(isIssuedHostShellExecutionPlanAuditProjection(projection)).toBe(true);
    expect(isIssuedHostShellExecutionPlanAuditProjection({ ...projection })).toBe(false);

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("internal capability detail that must not be audited");
    for (const forbidden of [
      "command",
      "requestedCwd",
      "executionCwd",
      "resolvedCwd",
      "allowedDirectories",
      "permit",
      "binding",
      "nonce",
      "hmac",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
