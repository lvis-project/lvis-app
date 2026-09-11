/** Native PowerShell AST facts. Raw source is diagnostic text, never expansion authority. */
export type PowerShellValueArgument =
  | { kind: "literal"; text: string; value: string }
  | { kind: "dynamic"; text: string };
export type PowerShellArgument = PowerShellValueArgument
  | { kind: "parameter"; text: string; name: string; argument?: PowerShellValueArgument };
export interface PowerShellAstSummary {
  errors: string[];
  commands: Array<{ name: string | null; text: string; arguments: PowerShellArgument[] }>;
  redirections: PowerShellArgument[];
  unsupported: string[];
}

export function normalizePowerShellAstSummary(raw: unknown): PowerShellAstSummary {
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid PowerShell AST record");
    return value as Record<string, unknown>;
  };
  const strings = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Invalid PowerShell AST string collection");
    return value as string[];
  };
  const valueArgument = (value: unknown): PowerShellValueArgument => {
    const item = record(value);
    if (typeof item.text !== "string") throw new Error("Invalid PowerShell AST argument source");
    if (item.kind === "literal" && typeof item.value === "string") return { kind: "literal", text: item.text, value: item.value };
    if (item.kind === "dynamic") return { kind: "dynamic", text: item.text };
    throw new Error("Invalid PowerShell AST value argument");
  };
  const argument = (value: unknown): PowerShellArgument => {
    const item = record(value);
    if (item.kind === "parameter" && typeof item.name === "string" && typeof item.text === "string") return {
      kind: "parameter", text: item.text, name: item.name,
      ...(item.argument == null ? {} : { argument: valueArgument(item.argument) }),
    };
    return valueArgument(value);
  };
  const input = record(raw);
  if (!Array.isArray(input.commands) || !Array.isArray(input.redirections)) throw new Error("Missing PowerShell AST collections");
  return {
    errors: strings(input.errors), unsupported: strings(input.unsupported),
    redirections: input.redirections.map(argument),
    commands: input.commands.map((value) => {
      const item = record(value);
      if ((item.name !== null && typeof item.name !== "string") || typeof item.text !== "string" || !Array.isArray(item.arguments)) throw new Error("Invalid PowerShell AST command");
      return { name: item.name, text: item.text, arguments: item.arguments.map(argument) };
    }),
  };
}

export const POWER_SHELL_AST_PARSER = `
$ErrorActionPreference = 'Stop'
$cmd = [Console]::In.ReadToEnd()
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($cmd, [ref]$tokens, [ref]$errors)
function Describe-Argument($node) {
  if ($node -is [System.Management.Automation.Language.CommandParameterAst]) {
    $value = $null
    if ($null -ne $node.Argument) { $value = Describe-Argument $node.Argument }
    return [ordered]@{ kind = 'parameter'; text = $node.Extent.Text; name = $node.ParameterName; argument = $value }
  }
  if ($node -is [System.Management.Automation.Language.StringConstantExpressionAst] -or
      ($node -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and $node.NestedExpressions.Count -eq 0) -or
      $node -is [System.Management.Automation.Language.ConstantExpressionAst]) {
    return [ordered]@{ kind = 'literal'; text = $node.Extent.Text; value = [string]$node.Value }
  }
  if ($node -is [System.Management.Automation.Language.VariableExpressionAst] -and
      $node.VariablePath.UserPath -in @('true', 'false')) {
    return [ordered]@{ kind = 'literal'; text = $node.Extent.Text; value = $node.VariablePath.UserPath }
  }
  return [ordered]@{ kind = 'dynamic'; text = $node.Extent.Text }
}
$commands = @(
  $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) |
    ForEach-Object {
      [ordered]@{
        name = $_.GetCommandName()
        text = $_.Extent.Text
        arguments = @($_.CommandElements | ForEach-Object { Describe-Argument $_ })
      }
    }
)
$redirections = @(
  $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FileRedirectionAst] }, $true) |
    ForEach-Object { Describe-Argument $_.Location }
)
$unsupported = @(
  $ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -or
    $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst]
  }, $true) | ForEach-Object { $_.GetType().Name }
)
[ordered]@{
  errors = @($errors | ForEach-Object { $_.Message })
  commands = $commands
  redirections = $redirections
  unsupported = $unsupported
} | ConvertTo-Json -Depth 16 -Compress
`;
