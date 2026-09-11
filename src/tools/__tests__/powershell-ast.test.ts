import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizePowerShellAstSummary, type PowerShellArgument, type PowerShellAstSummary } from "../powershell-ast.js";
import { findPowerShellAstPathViolation, validatePowerShellAst } from "../shell-tools.js";

const literal = (value: string, text = value): PowerShellArgument => ({ kind: "literal", value, text });
const command = (name: string, args: PowerShellArgument[] = []): PowerShellAstSummary => ({
  errors: [], unsupported: [], redirections: [], commands: [{ name, text: name, arguments: [literal(name), ...args] }],
});
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
function check(summary: PowerShellAstSummary) {
  const root = mkdtempSync(join(tmpdir(), "lvis-ps-facts-")); roots.push(root);
  return findPowerShellAstPathViolation(summary, root, root, [], true);
}

describe("native PowerShell AST facts", () => {
  it("uses native literal values instead of re-expanding dollar or percent source", () => {
    const summary = command("Set-Content", [literal("$HOME/file.txt", "'$HOME/file.txt'"), literal("%CD%")]);
    expect(check(normalizePowerShellAstSummary(summary))).toBeNull();
  });

  it("checks actual dynamic arguments without guessing their expanded path", () => {
    expect(check(command("Set-Content", [{ kind: "dynamic", text: '"$HOME/file.txt"' }, literal("data")]))?.reason).toContain("dynamic path argument");
  });

  it("checks redirect values independently of a data-only command", () => {
    expect(check({ ...command("Write-Output", [literal("../outside")]), redirections: [literal("../outside/result")] })?.kind).toBe("sandbox-boundary");
    expect(check(command("Write-Output", [literal("../outside")]))).toBeNull();
  });

  it("preserves named literal-path semantics and attached flag values", () => {
    expect(check(command("Get-Content", [{ kind: "parameter", name: "LiteralPath", text: "-LiteralPath", argument: { kind: "literal", text: "'[x].txt'", value: "[x].txt" } }]))).toBeNull();
    const summary = command("Remove-Item", [literal("./safe"),
      { kind: "parameter", name: "Recurse", text: "-Recurse:$false", argument: { kind: "literal", text: "$false", value: "false" } },
      { kind: "parameter", name: "Force", text: "-Force" },
    ]);
    expect(validatePowerShellAst(summary)).toBeNull();
  });

  it("does not treat an additional New-Item path as content data", () => {
    expect(check(command("New-Item", [literal("./safe"), literal("../outside/result")]))?.kind).toBe("sandbox-boundary");
  });

  it.each([
    {}, { errors: [], commands: [] },
    { ...command("Get-Content"), commands: [{ name: "Get-Content", text: "Get-Content", arguments: [{ kind: "literal", text: "x" }] }] },
    { ...command("Get-Content"), redirections: [null] },
    { ...command("Get-Content"), commands: [{ name: "Get-Content", text: "Get-Content", arguments: [{ kind: "parameter", text: "-Path", name: "Path", argument: { kind: "parameter", text: "-x", name: "x" } }] }] },
  ])("rejects malformed native summary %j", (raw) => {
    expect(() => normalizePowerShellAstSummary(raw)).toThrow("PowerShell AST");
  });
});
