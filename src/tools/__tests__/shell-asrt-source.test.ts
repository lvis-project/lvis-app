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

describe("background shell lifetime contract", () => {
  // A background child is registered with the managed-child registry, and app
  // shutdown force-kills everything in it. That is deliberate. What was not
  // stated anywhere the MODEL can read is that the process therefore does not
  // outlive the session -- so a benchmark trial started a gRPC server with
  // run_in_background and reported it as "still running for the client to
  // connect to" after the turn had already killed it. These assertions tie the
  // two surfaces the model reads to the mechanism that makes the claim true.
  it("registers the background child with the managed-child registry", () => {
    expect(bashSection).toMatch(/trackManagedChildProcess\(child,\s*\{\s*label:\s*"tool:bash:background",\s*killProcessGroup,?\s*\}\)/);
    expect(bashSection).toContain('spawnWindowsJobProcess(shell.cmd, [...argv], { cwd, env })');
    expect(bashSection).toContain("detached: true");
    expect(bashSection).toContain('killProcessGroup: process.platform !== "win32"');
  });

  it("states the lifetime in the parameter the model chooses from", () => {
    expect(bashSection).toContain("The shell is bound to this session and is ");
    expect(bashSection).toContain("terminated when the session ends");
  });

  it("states the lifetime again in the result the model reads back", () => {
    expect(bashSection).toContain("This shell is managed by the session and is stopped when the session ends.");
    expect(bashSection).toContain("Descendants that leave the owned process group may survive its cleanup.");
  });
});
