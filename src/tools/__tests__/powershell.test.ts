import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../registry.js";
import {
  PowerShellTool,
  PowerShellToolInputSchema,
  validatePowerShellCommand,
  validatePowerShellAst,
  type PowerShellAstSummary,
} from "../powershell.js";
import type { ToolExecutionContext } from "../base.js";

const ctx = (cwd: string = process.cwd()): ToolExecutionContext => ({
  cwd,
  allowedDirectories: [],
  metadata: {},
});

function ast(commands: Array<Partial<PowerShellAstSummary["commands"][number]>>, errors: string[] = []): PowerShellAstSummary {
  return {
    errors,
    commands: commands.map((command) => ({
      name: command.name ?? null,
      text: command.text ?? command.name ?? "",
      elements: command.elements ?? (command.name ? [command.name] : []),
    })),
  };
}

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

  it("blocks expression execution and encoded command forms from the AST summary", () => {
    expect(validatePowerShellAst(ast([{ name: "Invoke-Expression" }]))).toContain("Invoke-Expression");
    expect(validatePowerShellAst(ast([{ name: "iex" }]))).toContain("Invoke-Expression");
    expect(validatePowerShellAst(ast([{ name: "powershell", elements: ["powershell", "-EncodedCommand", "AAAA"] }]))).toContain("encoded commands");
  });

  it("blocks interactive prompts from the AST summary", () => {
    expect(validatePowerShellAst(ast([{ name: "Read-Host" }]))).toContain("interactive prompts");
    expect(validatePowerShellAst(ast([{ name: "Pause" }]))).toContain("interactive prompts");
  });

  it("blocks recursive forced deletion regardless of flag order", () => {
    expect(validatePowerShellAst(ast([{ name: "Remove-Item", elements: ["Remove-Item", "./x", "-Recurse", "-Force"] }]))).toContain(
      "recursive forced deletion",
    );
    expect(validatePowerShellAst(ast([{ name: "Remove-Item", elements: ["Remove-Item", "./x", "-Force", "-Recurse"] }]))).toContain(
      "recursive forced deletion",
    );
  });

  it("fails closed when the parser reports syntax errors or dynamic dispatch", () => {
    expect(validatePowerShellAst(ast([], ["Unexpected token"]))).toContain("parse error");
    expect(validatePowerShellAst(ast([{ name: null, text: "& ($x)" }]))).toContain("dynamic command");
  });

  it("uses the AST parser result before spawn", async () => {
    const parser = async (): Promise<PowerShellAstSummary> => ast([{ name: "Start-Process" }]);
    await expect(validatePowerShellCommand("Start-Process calc", parser)).resolves.toContain(
      "process detachment",
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
