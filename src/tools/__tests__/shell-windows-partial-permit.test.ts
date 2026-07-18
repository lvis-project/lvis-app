import { afterEach, describe, expect, it } from "vitest";
import { BashTool } from "../bash.js";
import { PowerShellTool } from "../powershell.js";
import type { ToolExecutionContext } from "../types.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  getHostShellExecutionPlan,
  setActiveSandboxCapability,
  setSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { buildHostShellExecutionPlan } from "../../permissions/host-shell-execution-plan.js";
import { setProcessPlatform } from "../../testing/process-platform.js";

const ORIGINAL_PLATFORM = process.platform;

function partialWindowsAsrt(): void {
  setProcessPlatform("win32");
  setSandboxRequestedAtBoot(true);
  setActiveSandboxCapability({
    kind: "asrt",
    confidence: "verified",
    platform: "win32",
    reason: "srt-win partial",
    confines: { filesystem: true, process: false, network: true },
  });
}

function requestedSandboxUnavailable(platform: "darwin" | "linux" | "win32"): void {
  setProcessPlatform(platform);
  __resetActiveSandboxCapabilityForTest();
  setSandboxRequestedAtBoot(true);
}
function context(plan: ToolExecutionContext["hostShellExecutionPlan"]): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    extraAllowedDirectories: [],
    hostShellExecutionPlan: plan,
    metadata: { toolUseId: "direct-call" },
  };
}

const SHELLS = [
  {
    name: "bash",
    create: () => new BashTool(),
    input: { command: "echo permit", timeoutSeconds: 5 },
  },
  {
    name: "powershell",
    create: () => new PowerShellTool(),
    input: { command: "Write-Output permit", timeoutSeconds: 5 },
  },
] as const;

describe("builtin shell — Windows partial Plan-B permit", () => {
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    setProcessPlatform(ORIGINAL_PLATFORM);
  });

  it.each(SHELLS)("rejects a direct call even with a getter-issued plan ($name)", async ({ create, input }) => {
    partialWindowsAsrt();

    const result = await create().execute(input, context(getHostShellExecutionPlan()));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("one-shot host approval permit");
  });

  it.each(SHELLS)("rejects a forged structural plan ($name)", async ({ create, input }) => {
    partialWindowsAsrt();
    const forgedPlan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: false,
      activeCapability: {
        kind: "none",
        confidence: "verified",
        platform: "win32",
        reason: "forged off",
        confines: { filesystem: false, process: false, network: false },
      },
    });

    const result = await create().execute(input, context(forgedPlan));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("was not issued by the host");
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "rejects permit-less direct Bash/PowerShell calls for requested-unavailable %s",
    async (platform) => {
      requestedSandboxUnavailable(platform);
      const plan = getHostShellExecutionPlan();
      expect(plan).toMatchObject({
        platform,
        requestedSandbox: true,
        mode: "plain",
        fallbackReason: "requested-sandbox-unavailable",
        requiresExplicitUserApproval: true,
      });

      for (const shell of SHELLS) {
        const result = await shell.create().execute(shell.input, context(plan));
        expect(result.isError).toBe(true);
        expect(result.output).toContain("one-shot host approval permit");
      }
    },
  );});
