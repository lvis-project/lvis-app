import { resolveBundledUvBinaryPath } from "../main/uv-runtime.js";

export interface StdioSpawnCommand {
  command: string;
  args: string[];
}

export function resolveStdioSpawnCommand(command: string, args: string[] = []): StdioSpawnCommand {
  if (!isBareUvxCommand(command)) {
    return { command, args };
  }
  return {
    command: resolveBundledUvBinaryPath(),
    args: ["tool", "run", ...args],
  };
}

function isBareUvxCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed === "uvx" || trimmed === "uvx.exe";
}
