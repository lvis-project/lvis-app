import { afterEach, describe, expect, it } from "vitest";
import { getLocale, setLocale } from "../../i18n/index.js";
import { buildHostShellExecutionPlan } from "../host-shell-execution-plan.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  getIssuedHostShellExecutionPlanGeneration,
  getSandboxGeneration,
  getHostShellExecutionPlan,
  setActiveSandboxCapability,
  setSandboxRequestedAtBoot,
} from "../sandbox-capability.js";
import {
  buildHostShellExecutionRouteProjection,
  buildExecutionPlan,
  executionRouteForHostShellPlan,
  getExecutionPlanAuditProjection,
  isIssuedExecutionCapability,
  isIssuedExecutionGrant,
  isIssuedExecutionPlan,
  issueEffectEnvelope,
  issueExecutionCapability,
  issueExecutionGrant,
  type ExecutionCapability,
  type ExecutionPlan,
  type ExecutionRoute,
} from "../execution-router.js";
import {
  findShellPathPolicyViolation,
  validateShellCommandPathPolicy,
} from "../../tools/shell-path-policy.js";
import { findPowerShellAstPathViolation } from "../../tools/shell-tools.js";

const fullAsrt = {
  kind: "asrt" as const,
  confidence: "verified" as const,
  platform: process.platform,
  reason: "test",
  confines: { filesystem: true, process: true, network: true },
};
const noSandbox = {
  kind: "none" as const,
  confidence: "verified" as const,
  platform: process.platform,
  reason: "test",
  confines: { filesystem: false, process: false, network: false },
};

function effect(overrides: Partial<Parameters<typeof issueEffectEnvelope>[0]> = {}) {
  return issueEffectEnvelope({
    request: { tool: "bash", command: "printf ok" },
    cwd: "/workspace",
    runtimeLimits: { timeoutSeconds: 120, background: false },
    ...overrides,
  });
}

function capability(
  routes: readonly ExecutionRoute[] = ["workspace-sandbox", "host"],
  generation = getSandboxGeneration(),
) {
  return issueExecutionCapability({ generation, availableRoutes: routes });
}

function resetSandbox(): void {
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
}

function issuedPlain() {
  resetSandbox();
  setSandboxRequestedAtBoot(false);
  return getHostShellExecutionPlan();
}

function issuedAsrt(executionMode: "default" | "host" = "default") {
  resetSandbox();
  setSandboxRequestedAtBoot(true);
  setActiveSandboxCapability(fullAsrt);
  return getHostShellExecutionPlan(executionMode);
}

function issuedUnavailableFallback() {
  resetSandbox();
  setSandboxRequestedAtBoot(true);
  return getHostShellExecutionPlan();
}

afterEach(resetSandbox);

describe("execution router", () => {
  it("maps the current ASRT/plain/blocked plans without selecting the unavailable container", () => {
    const asrt = buildHostShellExecutionPlan({
      platform: "linux", requestedSandbox: true, activeCapability: fullAsrt,
    });
    const plain = buildHostShellExecutionPlan({
      platform: "linux", requestedSandbox: false, activeCapability: noSandbox,
    });
    const blocked = buildHostShellExecutionPlan({
      platform: "linux", requestedSandbox: true,
      activeCapability: {
        ...fullAsrt,
        kind: "fs-only" as const,
        confines: { filesystem: true, process: false, network: false },
      },
    });

    expect(executionRouteForHostShellPlan(asrt)).toBe("workspace-sandbox");
    expect(executionRouteForHostShellPlan(plain)).toBe("host");
    expect(executionRouteForHostShellPlan(blocked)).toBeNull();

    const plan = buildExecutionPlan({ legacyPlan: issuedAsrt(), effect: effect(), capability: capability() });
    expect(plan).toMatchObject({ decision: "selected", route: "workspace-sandbox", fallback: "none" });
    const projection = getExecutionPlanAuditProjection(plan);
    expect(projection).not.toBe(plan);
    expect(Object.keys(projection).sort()).toEqual([
      "capabilityGeneration",
      "capabilityIdentity",
      "cwd",
      "decision",
      "effectDigest",
      "fallback",
      "identity",
      "legacyPlanIdentity",
      "route",
      "runtimeLimits",
      "unresolvedRequirements",
      "version",
    ]);
    expect(JSON.stringify(projection)).not.toContain("printf ok");
    expect(JSON.stringify(plan)).not.toContain("disposable-container");
  });

  it("does not call an ASRT plan workspace-confined unless both dimensions are explicit", () => {
    resetSandbox();
    setSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: process.platform,
      reason: "legacy fixture without declared confinement",
    });
    const legacyPlan = getHostShellExecutionPlan();
    expect(legacyPlan.mode).toBe("asrt");
    expect(executionRouteForHostShellPlan(legacyPlan)).toBeNull();

    expect(buildHostShellExecutionRouteProjection({
      legacyPlan,
      toolName: "bash",
      command: "printf ok",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
    })).toMatchObject({
      decision: "blocked",
      route: null,
      fallback: "route-unavailable",
    });
  });

  it("requires analysis instead of automatically falling through to host for uncertain effects", () => {
    const plain = issuedPlain();
    const uncertain = effect({
      unresolvedRequirements: [{
        classification: "analysis-uncertain",
        source: "shell-path-policy",
        kind: "dynamic-path",
      }],
    });

    expect(buildExecutionPlan({ legacyPlan: plain, effect: uncertain, capability: capability(["host"]) }))
      .toMatchObject({ decision: "analysis-required", route: null, fallback: "analysis-uncertain" });
  });

  it("preserves an explicit host request as approval-required even when analysis is uncertain", () => {
    const explicitHost = issuedAsrt("host");
    const uncertain = effect({
      unresolvedRequirements: [{
        classification: "analysis-uncertain",
        source: "shell-path-policy",
        kind: "recursive-traversal",
      }],
    });

    expect(buildExecutionPlan({ legacyPlan: explicitHost, effect: uncertain, capability: capability(["host"]) }))
      .toMatchObject({ decision: "approval-required", route: "host", fallback: "none" });
  });

  it("rejects forged legacy plans, capabilities, and route plans before they become authority", () => {
    const plain = issuedPlain();
    const issuedCapability = capability(["host"]);
    const forgedLegacy = buildHostShellExecutionPlan({
      platform: process.platform,
      requestedSandbox: false,
      activeCapability: noSandbox,
    });
    expect(() => buildExecutionPlan({
      legacyPlan: forgedLegacy,
      effect: effect(),
      capability: issuedCapability,
    })).toThrow("Legacy shell execution plan was not issued");
    const forgedCapability = { ...issuedCapability } as ExecutionCapability;
    expect(isIssuedExecutionCapability(issuedCapability)).toBe(true);
    expect(isIssuedExecutionCapability(forgedCapability)).toBe(false);
    expect(() => buildExecutionPlan({ legacyPlan: plain, effect: effect(), capability: forgedCapability }))
      .toThrow("capability was not issued");

    const plan = buildExecutionPlan({ legacyPlan: plain, effect: effect(), capability: issuedCapability });
    const forgedPlan = { ...plan } as ExecutionPlan;
    expect(isIssuedExecutionPlan(plan)).toBe(true);
    expect(isIssuedExecutionPlan(forgedPlan)).toBe(false);
    expect(() => getExecutionPlanAuditProjection(forgedPlan)).toThrow("plan was not issued");
    expect(() => issueExecutionGrant(forgedPlan)).toThrow("plan was not issued");
  });

  it("keeps identities stable and invalidates them when effects or capability generations change", () => {
    const plain = issuedPlain();
    const firstEffect = effect();
    const sameEffect = effect();
    const changedEffect = effect({ request: { tool: "bash", command: "printf changed" } });
    const firstGeneration = getSandboxGeneration();
    const firstCapability = capability(["host"], firstGeneration);
    const sameCapability = capability(["host"], firstGeneration);
    const unrelatedGenerationCapability = capability(["host"], `${firstGeneration}-other`);

    expect(firstEffect.digest).toBe(sameEffect.digest);
    expect(firstEffect.digest).not.toBe(changedEffect.digest);
    expect(firstCapability.identity).toBe(sameCapability.identity);
    expect(firstCapability.identity).not.toBe(unrelatedGenerationCapability.identity);

    const first = buildExecutionPlan({ legacyPlan: plain, effect: firstEffect, capability: firstCapability });
    const same = buildExecutionPlan({ legacyPlan: plain, effect: sameEffect, capability: sameCapability });
    const changedRequest = buildExecutionPlan({ legacyPlan: plain, effect: changedEffect, capability: firstCapability });
    expect(first.identity).toBe(same.identity);
    expect(first.identity).not.toBe(changedRequest.identity);

    const grant = issueExecutionGrant(first);
    expect(isIssuedExecutionGrant(grant)).toBe(true);
    expect(Object.isFrozen(grant)).toBe(true);

    setSandboxRequestedAtBoot(true);
    setSandboxRequestedAtBoot(false);
    const nextPlain = getHostShellExecutionPlan();
    const nextCapability = capability(["host"]);
    const changedGeneration = buildExecutionPlan({
      legacyPlan: nextPlain,
      effect: firstEffect,
      capability: nextCapability,
    });
    expect(first.identity).not.toBe(changedGeneration.identity);
    expect(() => issueExecutionGrant(first)).toThrow("generation is stale");
  });

  it("binds an issued legacy plan to its capability generation", () => {
    const legacyPlan = issuedAsrt();
    const issuedGeneration = getIssuedHostShellExecutionPlanGeneration(legacyPlan);
    expect(issuedGeneration).toBe(getSandboxGeneration());
    const issuedCapability = capability(["workspace-sandbox", "host"]);
    const issuedPlan = buildExecutionPlan({
      legacyPlan,
      effect: effect(),
      capability: issuedCapability,
    });

    setActiveSandboxCapability(noSandbox);
    const replacementGeneration = getSandboxGeneration();
    expect(replacementGeneration).not.toBe(issuedGeneration);
    expect(() => buildExecutionPlan({
      legacyPlan,
      effect: effect(),
      capability: capability(["workspace-sandbox", "host"], replacementGeneration),
    })).toThrow("does not match the legacy plan snapshot");

    const projection = buildHostShellExecutionRouteProjection({
      legacyPlan,
      toolName: "bash",
      command: "printf ok",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
    });
    expect(projection.capabilityGeneration).toBe(issuedGeneration);
    expect(projection.capabilityGeneration).not.toBe(replacementGeneration);
    expect(() => issueExecutionGrant(issuedPlan)).toThrow("generation is stale");
  });

  it("does not issue a grant for approval, analysis, or blocked decisions", () => {
    const fallback = issuedUnavailableFallback();
    const approvalPlan = buildExecutionPlan({
      legacyPlan: fallback,
      effect: effect(),
      capability: capability(["host"], getSandboxGeneration()),
    });
    expect(approvalPlan.decision).toBe("approval-required");
    expect(() => issueExecutionGrant(approvalPlan)).toThrow("requires another decision");
  });

  it.each([
    [
      "find . -type f",
      "recursive-traversal",
      "Sandbox: recursive shell filesystem traversal is not allowed: find Recommended LVIS built-in tool: glob_files (name pattern matching) or list_files (directory listing). Keep the original target path and requested scope.",
    ],
    [
      "cat \"$UNRESOLVED_FILE\"",
      "dynamic-path",
      "Shell path policy: unresolved command operand",
    ],
  ] as const)("keeps the existing typed denial for %s and its materialized reason", (command, kind, expectedReason) => {
    const previousLocale = getLocale();
    setLocale("en");
    try {
      const violation = findShellPathPolicyViolation(
        command,
        "/workspace",
        "/workspace",
        [],
        true,
      );
      expect(violation).toMatchObject({ kind });
      expect(violation?.reason).toBe(expectedReason);
      expect(validateShellCommandPathPolicy(command, "/workspace", "/workspace", [], true))
        .toBe(expectedReason);
      expect(buildHostShellExecutionRouteProjection({
        legacyPlan: issuedPlain(),
        toolName: "bash",
        command,
        cwd: "/workspace",
        timeoutSeconds: 120,
        background: false,
        unresolvedRequirementKind: kind,
      })).toMatchObject({
        decision: "analysis-required",
        unresolvedRequirements: [{
          classification: "analysis-uncertain",
          source: "shell-path-policy",
          kind,
        }],
      });
    } finally {
      setLocale(previousLocale);
    }
  });

  it("types the existing PowerShell dynamic-path denial without changing its reason", () => {
    const root = process.cwd();
    const violation = findPowerShellAstPathViolation({
      errors: [],
      unsupported: [],
      redirections: [],
      commands: [{
        name: "Set-Content",
        text: "Set-Content $HOME/out.txt data",
        arguments: [
          { kind: "literal", text: "Set-Content", value: "Set-Content" },
          { kind: "dynamic", text: "$HOME/out.txt" },
          { kind: "literal", text: "data", value: "data" },
        ],
      }],
    }, root, root, [], true);
    expect(violation).toEqual({
      kind: "dynamic-path",
      reason: "PowerShell command blocked: dynamic path argument is not allowed: $HOME/out.txt",
    });
  });
});
