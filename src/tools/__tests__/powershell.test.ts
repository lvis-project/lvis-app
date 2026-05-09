import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../registry.js";
import {
  PowerShellTool,
  PowerShellToolInputSchema,
  validatePowerShellCommand,
} from "../powershell.js";
import type { ToolExecutionContext } from "../base.js";

const ctx = (cwd: string = process.cwd()): ToolExecutionContext => ({
  cwd,
  metadata: {},
});

describe("PowerShellTool — policy surface", () => {
  it("registers as a native shell-category tool", () => {
    const registry = new ToolRegistry();
    registry.register(new PowerShellTool());

    const found = registry.findByName("powershell");
    expect(found).toBeDefined();
    expect(found?.source).toBe("builtin");
    expect(found?.category).toBe("shell");
    expect(found?.isReadOnly({ command: "Get-ChildItem" })).toBe(false);
  });

  it("defaults timeoutSeconds to 600", () => {
    const parsed = PowerShellToolInputSchema.parse({ command: "Get-ChildItem" });
    expect(parsed.timeoutSeconds).toBe(600);
  });

  it("blocks expression execution and encoded command forms before spawn", () => {
    expect(validatePowerShellCommand("Invoke-Expression $x")).toContain("Invoke-Expression");
    expect(validatePowerShellCommand("iex $x")).toContain("Invoke-Expression");
    expect(validatePowerShellCommand("powershell -EncodedCommand AAAA")).toContain("encoded commands");
  });

  it("blocks interactive prompts before spawn", () => {
    expect(validatePowerShellCommand("Read-Host 'secret'")).toContain("interactive prompts");
    expect(validatePowerShellCommand("Pause")).toContain("interactive prompts");
  });

  it("blocks recursive forced deletion regardless of flag order", () => {
    expect(validatePowerShellCommand("Remove-Item ./x -Recurse -Force")).toContain(
      "recursive forced deletion",
    );
    expect(validatePowerShellCommand("Remove-Item ./x -Force -Recurse")).toContain(
      "recursive forced deletion",
    );
  });

  it("rejects cwd outside the sandbox before spawn", async () => {
    const result = await new PowerShellTool().execute(
      { command: "Get-ChildItem", cwd: "/etc", timeoutSeconds: 5 },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Sandbox:");
  });
});
