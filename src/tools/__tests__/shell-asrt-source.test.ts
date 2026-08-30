import { describe, expect, it } from "vitest";
import { readRepoFile } from "../../__tests__/test-helpers.js";

// Both shell dialects live in shell-tools.ts; assert each dialect's own
// section carries the full plan-sealing + permit-consumption preamble, so a
// regression in one dialect cannot hide behind the other's copy.
const shellTools = readRepoFile("src/tools/shell-tools.ts");
const powershellSectionStart = shellTools.indexOf(" * Native PowerShell tool.");
const bashSection = shellTools.slice(0, powershellSectionStart);
const powershellSection = shellTools.slice(powershellSectionStart);

function expectShellDialectContracts(section: string): void {
  expect(section).toContain("const suppliedHostShellPlan = ctx.hostShellExecutionPlan");
  expect(section).toContain("isIssuedHostShellExecutionPlan(suppliedHostShellPlan)");
  expect(section).toContain("consumeHostShellExecutionPermit");
  expect(section).toContain("requiresExplicitHostShellFallbackApproval(hostShellPlan)");
  expect(section).toContain('hostShellPlan.mode === "blocked"');
  expect(section).toContain('hostShellPlan.mode === "asrt"');
  expect(section).toContain("shell: false");
  expect(section).toContain("...getDefaultSensitiveReadDenyPaths()");
  expect(section).toContain("denyWrite: getDefaultSensitiveWriteDenyPaths()");
}

describe("shell ASRT source contracts", () => {
  it("the bash sections verify an issued plan and consume a generic one-shot fallback permit", () => {
    expect(powershellSectionStart).toBeGreaterThan(0);
    expectShellDialectContracts(bashSection);
  });

  it("the powershell sections verify an issued plan and consume a generic one-shot fallback permit", () => {
    expectShellDialectContracts(powershellSection);
  });
});
