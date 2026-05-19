import { resolveBundledUvBinaryPath } from "../main/uv-runtime.js";

export interface StdioSpawnCommand {
  command: string;
  args: string[];
}

export function resolveStdioSpawnCommand(command: string, args: string[] = []): StdioSpawnCommand {
  const uvxInlineArgs = parseUvxCommand(command);
  if (!uvxInlineArgs) {
    return { command, args };
  }
  return {
    command: resolveBundledUvBinaryPath(),
    args: ["tool", "run", ...uvxInlineArgs, ...args],
  };
}

function parseUvxCommand(command: string): string[] | null {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const executable = parts[0];
  if (executable !== "uvx" && executable !== "uvx.exe") return null;
  return parts.slice(1);
}
