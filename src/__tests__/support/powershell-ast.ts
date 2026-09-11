import type { PowerShellValueArgument } from "../../tools/powershell-ast.js";

/** A native parser literal keeps its value separate from its source spelling. */
export function powerShellLiteral(value: string, text = value): PowerShellValueArgument {
  return { kind: "literal", value, text };
}
