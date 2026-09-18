import { afterEach, describe, expect, it, vi } from "vitest";
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
  buildHostShellExecutionRoute,
  buildHostShellExecutionRouteProjection,
  buildExecutionPlan,
  consumeExecutionGrantForBuiltinToolInvocation,
  consumeExecutionGrantForShellInvocation,
  executionRouteForHostShellPlan,
  getExecutionPlanAuditProjection,
  isIssuedExecutionCapability,
  isIssuedExecutionGrant,
  isIssuedExecutionPlan,
  issueEffectEnvelope,
  issueBrokeredToolExecutionGrant,
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
import {
  findPowerShellAstPathViolation,
  validatePowerShellAst,
  validatePowerShellAstStructure,
} from "../../tools/shell-tools.js";
import type {
  OperatorContainerCapability,
  OperatorContainerRevalidationLease,
} from "../operator-container-attestation.js";
import type { BrokeredWorkloadCapability } from "../../workload/runtime.js";

const operatorCapabilities = vi.hoisted(() => ({
  issued: new WeakSet<object>(),
  current: null as object | null,
  leases: new WeakMap<object, object>(),
  consumedLeases: new WeakSet<object>(),
}));

const workloadCapabilities = vi.hoisted(() => ({
  issued: new WeakSet<object>(),
  active: null as object | null,
}));

vi.mock("../operator-container-attestation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../operator-container-attestation.js")>();
  return {
    ...actual,
    isIssuedOperatorContainerCapability: (value: unknown) =>
      typeof value === "object" && value !== null && operatorCapabilities.issued.has(value),
    isCurrentPublishedOperatorContainerCapability: (value: unknown) =>
      value === operatorCapabilities.current &&
      typeof value === "object" && value !== null && operatorCapabilities.issued.has(value),
    consumeOperatorContainerRevalidationLease: (capability: object, lease: object) => {
      if (operatorCapabilities.current !== capability ||
          operatorCapabilities.leases.get(lease) !== capability ||
          operatorCapabilities.consumedLeases.has(lease)) return false;
      operatorCapabilities.consumedLeases.add(lease);
      return true;
    },
  };
});

vi.mock("../../workload/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../workload/runtime.js")>();
  return {
    ...actual,
    isIssuedActiveBrokeredWorkloadCapability: (value: unknown) =>
      value === workloadCapabilities.active &&
      typeof value === "object" && value !== null && workloadCapabilities.issued.has(value),
  };
});

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

function issuedDisposableCapability(
  generation = "operator-generation-1",
): OperatorContainerCapability {
  const value = Object.freeze({
    version: "operator-container-capability/v1" as const,
    id: "a".repeat(64),
    generation,
    expiresAt: 1_800_000_120,
    fingerprints: Object.freeze({
      attestation: "b".repeat(64),
      process: "c".repeat(64),
      key: "d".repeat(64),
    }),
  });
  operatorCapabilities.issued.add(value);
  operatorCapabilities.current = value;
  return value;
}

function revalidationLease(
  capability: OperatorContainerCapability,
): OperatorContainerRevalidationLease {
  const lease = Object.freeze({
    version: "operator-container-revalidation-lease/v1" as const,
    capabilityId: capability.id,
    capabilityGeneration: capability.generation,
  }) as OperatorContainerRevalidationLease;
  operatorCapabilities.leases.set(lease, capability);
  return lease;
}

function issuedBrokeredWorkloadCapability(
  generation = "broker-generation-1",
): BrokeredWorkloadCapability {
  const value = Object.freeze({
    version: "brokered-workload-capability/v1" as const,
    workload: Object.freeze({
      id: "e".repeat(64),
      generation,
      boundaryFingerprint: "f".repeat(64),
      imageDigest: `sha256:${"1".repeat(64)}`,
      cwd: "/workspace",
      home: "/home/agent",
      platform: "linux" as const,
    }),
    expiresAt: "2999-01-01T00:00:00.000Z",
    allowedOperations: Object.freeze(["file.read" as const]),
  }) as BrokeredWorkloadCapability;
  workloadCapabilities.issued.add(value);
  workloadCapabilities.active = value;
  return value;
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

afterEach(() => {
  operatorCapabilities.current = null;
  workloadCapabilities.active = null;
  resetSandbox();
});

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
      "disposableCapability",
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

  it("orders workspace confinement before a verified disposable guest and that guest before host", () => {
    const disposableCapability = issuedDisposableCapability();
    const asrt = buildHostShellExecutionRoute({
      legacyPlan: issuedAsrt(),
      toolName: "bash",
      command: "printf ok",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
      disposableCapability,
    });
    expect(asrt.plan).toMatchObject({ decision: "selected", route: "workspace-sandbox" });

    const plain = buildHostShellExecutionRoute({
      legacyPlan: issuedPlain(),
      toolName: "bash",
      command: "printf ok",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
      disposableCapability,
    });
    expect(plain.plan).toMatchObject({
      decision: "selected",
      route: "disposable-container",
      disposableCapability: {
        kind: "operator-container",
        id: disposableCapability.id,
        generation: disposableCapability.generation,
        expiresAt: disposableCapability.expiresAt,
      },
    });
  });

  it.each([
    ["ASRT", () => issuedAsrt()],
    ["host", () => issuedPlain()],
  ])("selects the workload broker exclusively over the %s route", (_name, legacyPlan) => {
    const brokeredWorkloadCapability = issuedBrokeredWorkloadCapability();
    const route = buildHostShellExecutionRoute({
      legacyPlan: legacyPlan(),
      toolName: "bash",
      command: "printf ok",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
      brokeredWorkloadCapability,
    });

    expect(route.plan).toMatchObject({
      decision: "selected",
      route: "disposable-container",
      disposableCapability: {
        kind: "workload-broker",
        id: brokeredWorkloadCapability.workload.id,
        generation: brokeredWorkloadCapability.workload.generation,
        cwd: brokeredWorkloadCapability.workload.cwd,
        home: brokeredWorkloadCapability.workload.home,
        platform: "linux",
      },
    });
  });

  it("rejects PowerShell at routing when the active broker implements only canonical bash", () => {
    const brokeredWorkloadCapability = issuedBrokeredWorkloadCapability();
    expect(() => buildHostShellExecutionRoute({
      legacyPlan: issuedPlain(),
      toolName: "powershell",
      command: "Write-Output ok",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
      brokeredWorkloadCapability,
    })).toThrow("supports only the canonical bash tool");
  });

  it("binds broker projections and builtin effect digests to the exact guest identity", () => {
    const first = issuedBrokeredWorkloadCapability("broker-generation-exact");
    const legacyPlan = issuedPlain();
    const route = buildHostShellExecutionRoute({
      legacyPlan,
      toolName: "bash",
      command: "printf ok",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
      brokeredWorkloadCapability: first,
    });
    expect(route.plan.disposableCapability).toMatchObject({
      kind: "workload-broker",
      cwd: "/workspace",
      home: "/home/agent",
      platform: "linux",
    });

    const exactInput = {
      toolName: "read_file",
      normalizedInput: { path: "notes.txt" },
      cwd: "/workspace",
    };
    const firstGrant = issueBrokeredToolExecutionGrant({ toolUseId: "tool-use-test", capability: first, ...exactInput });
    const changedHome = Object.freeze({
      ...first,
      workload: Object.freeze({ ...first.workload, home: "/home/other" }),
    }) as BrokeredWorkloadCapability;
    workloadCapabilities.issued.add(changedHome);
    workloadCapabilities.active = changedHome;
    const changedHomeGrant = issueBrokeredToolExecutionGrant({
      toolUseId: "tool-use-test",
      capability: changedHome,
      ...exactInput,
    });

    expect(changedHomeGrant.effectDigest).not.toBe(firstGrant.effectDigest);
    expect(changedHomeGrant.identity).not.toBe(firstGrant.identity);
  });

  it("relaxes sensitive paths only for workload-broker shell authority", () => {
    const brokeredWorkloadCapability = issuedBrokeredWorkloadCapability();
    const brokerLegacyPlan = issuedPlain();
    const brokerGrant = issueExecutionGrant(buildHostShellExecutionRoute({
      legacyPlan: brokerLegacyPlan,
      toolName: "bash",
      command: "cat /etc/hosts",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
      brokeredWorkloadCapability,
    }).plan, { toolUseId: "tool-use-test", toolName: "bash" });
    const brokerAuthority = consumeExecutionGrantForShellInvocation({
      grant: brokerGrant,
      legacyPlan: brokerLegacyPlan,
      toolName: "bash",
      command: "cat /etc/hosts",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
    });

    const operatorCapability = issuedDisposableCapability();
    const operatorLegacyPlan = issuedPlain();
    const operatorGrant = issueExecutionGrant(buildHostShellExecutionRoute({
      legacyPlan: operatorLegacyPlan,
      toolName: "bash",
      command: "find . -type f",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
      disposableCapability: operatorCapability,
      disposableRevalidationLease: revalidationLease(operatorCapability),
    }).plan, { toolUseId: "tool-use-test", toolName: "bash" });
    const operatorAuthority = consumeExecutionGrantForShellInvocation({
      grant: operatorGrant,
      legacyPlan: operatorLegacyPlan,
      toolName: "bash",
      command: "find . -type f",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
    });

    expect(brokerAuthority?.pathPolicyRelaxations).toContain("sensitive-path");
    expect(operatorAuthority?.pathPolicyRelaxations).not.toContain("sensitive-path");
  });

  it("returns the exact branded workload capability when consuming a broker shell grant", () => {
    const brokeredWorkloadCapability = issuedBrokeredWorkloadCapability();
    const legacyPlan = issuedPlain();
    const grant = issueExecutionGrant(buildHostShellExecutionRoute({
      legacyPlan,
      toolName: "bash",
      command: "printf ok",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
      brokeredWorkloadCapability,
    }).plan, { toolUseId: "tool-use-test", toolName: "bash" });

    const authority = consumeExecutionGrantForShellInvocation({
      grant,
      legacyPlan,
      toolName: "bash",
      command: "printf ok",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
    });

    expect(authority).toMatchObject({
      route: "disposable-container",
      disposableAuthority: "workload-broker",
    });
    expect(authority?.brokeredWorkloadCapability).toBe(brokeredWorkloadCapability);
  });

  it.each([
    ["tool", { toolName: "write_file", normalizedInput: { path: "notes.txt" }, cwd: "/workspace" }],
    ["input", { toolName: "read_file", normalizedInput: { path: "other.txt" }, cwd: "/workspace" }],
    ["cwd", { toolName: "read_file", normalizedInput: { path: "notes.txt" }, cwd: "/other" }],
  ] as const)("rejects a builtin broker grant with mismatched %s", (_field, invocation) => {
    const capability = issuedBrokeredWorkloadCapability();
    const grant = issueBrokeredToolExecutionGrant({
      toolUseId: "tool-use-test",
      capability,
      toolName: "read_file",
      normalizedInput: { path: "notes.txt" },
      cwd: "/workspace",
    });

    expect(consumeExecutionGrantForBuiltinToolInvocation({ grant, ...invocation })).toBeNull();
  });

  it("consumes an exact builtin broker grant only once", () => {
    const capability = issuedBrokeredWorkloadCapability();
    const exact = {
      toolName: "read_file",
      normalizedInput: { path: "notes.txt" },
      cwd: "/workspace",
    };
    const grant = issueBrokeredToolExecutionGrant({ toolUseId: "tool-use-test", capability, ...exact });

    expect(consumeExecutionGrantForBuiltinToolInvocation({ grant, ...exact }))
      .toMatchObject({
        route: "disposable-container",
        disposableAuthority: "workload-broker",
      });
    expect(consumeExecutionGrantForBuiltinToolInvocation({ grant, ...exact })).toBeNull();
  });

  it("rejects a builtin broker grant after its authority becomes stale", () => {
    const capability = issuedBrokeredWorkloadCapability();
    const exact = {
      toolName: "read_file",
      normalizedInput: { path: "notes.txt" },
      cwd: "/workspace",
    };
    const grant = issueBrokeredToolExecutionGrant({ toolUseId: "tool-use-test", capability, ...exact });
    workloadCapabilities.active = null;

    expect(consumeExecutionGrantForBuiltinToolInvocation({ grant, ...exact })).toBeNull();
  });

  it("keeps explicit-host and analysis-uncertain work inside the strongest reachable guest", () => {
    const disposableCapability = issuedDisposableCapability();
    for (const legacyPlan of [issuedAsrt("host"), issuedPlain()]) {
      const route = buildHostShellExecutionRoute({
        legacyPlan,
        toolName: "bash",
        command: "find . -type f",
        cwd: "/workspace",
        timeoutSeconds: 120,
        background: false,
        unresolvedRequirementKind: "recursive-traversal",
        disposableCapability,
      });
      expect(route.plan).toMatchObject({
        decision: "selected",
        route: "disposable-container",
      });
    }
  });

  it("rejects an unissued disposable capability instead of advertising its route", () => {
    const forged = Object.freeze({
      ...issuedDisposableCapability(),
      generation: "forged-generation",
    }) as OperatorContainerCapability;
    expect(() => buildHostShellExecutionRoute({
      legacyPlan: issuedPlain(),
      toolName: "bash",
      command: "printf ok",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
      disposableCapability: forged,
    })).toThrow("not current host authority");
  });

  it("consumes a disposable grant once and binds it to the exact live shell action", () => {
    const disposableCapability = issuedDisposableCapability();
    const legacyPlan = issuedPlain();
    const makeGrant = () => issueExecutionGrant(buildHostShellExecutionRoute({
      legacyPlan,
      toolName: "bash",
      command: "find . -type f",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
      unresolvedRequirementKind: "recursive-traversal",
      disposableCapability,
      disposableRevalidationLease: revalidationLease(disposableCapability),
    }).plan, { toolUseId: "tool-use-test", toolName: "bash" });
    const exact = {
      legacyPlan,
      toolName: "bash" as const,
      command: "find . -type f",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
    };

    const grant = makeGrant();
    expect(consumeExecutionGrantForShellInvocation({ grant, ...exact }))
      .toEqual({
        route: "disposable-container",
        disposableAuthority: "operator-container",
        pathPolicyRelaxations: [
          "dynamic-path",
          "recursive-traversal",
          "sandbox-boundary",
        ],
      });
    expect(consumeExecutionGrantForShellInvocation({ grant, ...exact })).toBeNull();
    expect(consumeExecutionGrantForShellInvocation({
      grant: makeGrant(),
      ...exact,
      command: "printf changed",
    })).toBeNull();

    const forged = Object.freeze({ ...makeGrant() });
    expect(consumeExecutionGrantForShellInvocation({
      grant: forged,
      ...exact,
    })).toBeNull();

    const replacedCapabilityGrant = makeGrant();
    operatorCapabilities.current = null;
    expect(consumeExecutionGrantForShellInvocation({
      grant: replacedCapabilityGrant,
      ...exact,
    })).toBeNull();

    operatorCapabilities.current = disposableCapability;
    const stale = makeGrant();
    setSandboxRequestedAtBoot(true);
    setSandboxRequestedAtBoot(false);
    expect(consumeExecutionGrantForShellInvocation({ grant: stale, ...exact })).toBeNull();
  });

  it("consumes an operator revalidation lease once and rejects replay or forgery", () => {
    const disposableCapability = issuedDisposableCapability();
    const routeInput = {
      legacyPlan: issuedPlain(),
      toolName: "bash" as const,
      command: "printf ok",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
      disposableCapability,
    };
    const lease = revalidationLease(disposableCapability);
    const route = buildHostShellExecutionRoute({
      ...routeInput,
      disposableRevalidationLease: lease,
    });
    expect(issueExecutionGrant(route.plan, {
      toolUseId: "lease-first-use",
      toolName: "bash",
    })).toMatchObject({ disposableAuthority: "operator-container" });
    expect(() => issueExecutionGrant(route.plan, {
      toolUseId: "lease-replay",
      toolName: "bash",
    })).toThrow("no fresh revalidation lease");

    const forgedLease = Object.freeze({
      version: "operator-container-revalidation-lease/v1",
      capabilityId: disposableCapability.id,
      capabilityGeneration: disposableCapability.generation,
    }) as OperatorContainerRevalidationLease;
    const forgedRoute = buildHostShellExecutionRoute({
      ...routeInput,
      legacyPlan: issuedPlain(),
      disposableRevalidationLease: forgedLease,
    });
    expect(() => issueExecutionGrant(forgedRoute.plan, {
      toolUseId: "lease-forged",
      toolName: "bash",
    })).toThrow("no fresh revalidation lease");
  });

  it("refuses to mint a disposable grant after the published capability changes", () => {
    const disposableCapability = issuedDisposableCapability();
    const route = buildHostShellExecutionRoute({
      legacyPlan: issuedPlain(),
      toolName: "bash",
      command: "printf ok",
      cwd: "/workspace",
      timeoutSeconds: 120,
      background: false,
      disposableCapability,
    });
    operatorCapabilities.current = null;
    expect(() => issueExecutionGrant(route.plan, { toolUseId: "tool-use-test", toolName: "bash" })).toThrow("capability is stale");
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
    expect(() => issueExecutionGrant(forgedPlan, { toolUseId: "tool-use-test", toolName: "bash" })).toThrow("plan was not issued");
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

    const grant = issueExecutionGrant(first, { toolUseId: "tool-use-test", toolName: "bash" });
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
    expect(() => issueExecutionGrant(first, { toolUseId: "tool-use-test", toolName: "bash" })).toThrow("generation is stale");
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
    expect(() => issueExecutionGrant(issuedPlan, { toolUseId: "tool-use-test", toolName: "bash" })).toThrow("generation is stale");
  });

  it("does not issue a grant for approval, analysis, or blocked decisions", () => {
    const fallback = issuedUnavailableFallback();
    const approvalPlan = buildExecutionPlan({
      legacyPlan: fallback,
      effect: effect(),
      capability: capability(["host"], getSandboxGeneration()),
    });
    expect(approvalPlan.decision).toBe("approval-required");
    expect(() => issueExecutionGrant(approvalPlan, { toolUseId: "tool-use-test", toolName: "bash" })).toThrow("requires another decision");
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

  it("separates disposable PowerShell path uncertainty from structural rejection", () => {
    const dynamicPath = {
      errors: [],
      unsupported: [],
      redirections: [],
      commands: [{
        name: "Set-Content",
        text: "Set-Content $HOME/out.txt data",
        arguments: [
          { kind: "literal" as const, text: "Set-Content", value: "Set-Content" },
          { kind: "dynamic" as const, text: "$HOME/out.txt" },
          { kind: "literal" as const, text: "data", value: "data" },
        ],
      }],
    };
    expect(validatePowerShellAst(dynamicPath)).toBe(
      "dynamic path argument is not allowed: $HOME/out.txt",
    );
    expect(validatePowerShellAstStructure(dynamicPath)).toBeNull();

    const structural = {
      errors: [],
      unsupported: [],
      redirections: [],
      commands: [{
        name: "Invoke-Expression",
        text: "Invoke-Expression $code",
        arguments: [
          { kind: "literal" as const, text: "Invoke-Expression", value: "Invoke-Expression" },
          { kind: "dynamic" as const, text: "$code" },
        ],
      }],
    };
    expect(validatePowerShellAstStructure(structural)).toContain("Invoke-Expression");
  });
});
