import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("shell ASRT source contracts", () => {
  it("bash verifies an issued plan and consumes a generic one-shot fallback permit", () => {
    const bash = source("src/tools/bash.ts");

    expect(bash).toContain("const suppliedHostShellPlan = ctx.hostShellExecutionPlan");
    expect(bash).toContain("isIssuedHostShellExecutionPlan(suppliedHostShellPlan)");
    expect(bash).toContain("consumeHostShellExecutionPermit");
    expect(bash).toContain("requiresExplicitHostShellFallbackApproval(hostShellPlan)");
    expect(bash).toContain('hostShellPlan.mode === "blocked"');
    expect(bash).toContain('hostShellPlan.mode === "asrt"');
    expect(bash).toContain("shell: false");
    expect(bash).toContain("...getDefaultSensitiveReadDenyPaths()");
    expect(bash).toContain("denyWrite: getDefaultSensitiveWriteDenyPaths()");
  });

  it("powershell verifies an issued plan and consumes a generic one-shot fallback permit", () => {
    const powershell = source("src/tools/powershell.ts");

    expect(powershell).toContain("const suppliedHostShellPlan = ctx.hostShellExecutionPlan");
    expect(powershell).toContain("isIssuedHostShellExecutionPlan(suppliedHostShellPlan)");
    expect(powershell).toContain("consumeHostShellExecutionPermit");
    expect(powershell).toContain("requiresExplicitHostShellFallbackApproval(hostShellPlan)");
    expect(powershell).toContain('hostShellPlan.mode === "blocked"');
    expect(powershell).toContain('hostShellPlan.mode === "asrt"');
    expect(powershell).toContain("shell: false");
    expect(powershell).toContain("...getDefaultSensitiveReadDenyPaths()");
    expect(powershell).toContain("denyWrite: getDefaultSensitiveWriteDenyPaths()");
  });
});
