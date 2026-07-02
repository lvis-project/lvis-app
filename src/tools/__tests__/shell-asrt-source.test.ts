import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("shell ASRT source contracts", () => {
  it("bash refuses partial ASRT shells and restates read/write deny floors", () => {
    const bash = source("src/tools/bash.ts");

    expect(bash).toContain("isActiveSandboxShellContained");
    expect(bash).toContain("!isActiveSandboxShellContained()");
    expect(bash).toContain("...getDefaultSensitiveReadDenyPaths()");
    expect(bash).toContain("denyWrite: getDefaultSensitiveWriteDenyPaths()");
  });

  it("powershell refuses partial ASRT shells and restates read/write deny floors", () => {
    const powershell = source("src/tools/powershell.ts");

    expect(powershell).toContain("isActiveSandboxShellContained");
    expect(powershell).toContain("!isActiveSandboxShellContained()");
    expect(powershell).toContain("...getDefaultSensitiveReadDenyPaths()");
    expect(powershell).toContain("denyWrite: getDefaultSensitiveWriteDenyPaths()");
  });
});
