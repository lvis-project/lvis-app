import { spawnSync } from "node:child_process";

const TRUSTED_WINDOWS_BATCH_COMMANDS = new Set(["npm.cmd", "npx.cmd"]);
const UNSAFE_WINDOWS_BATCH_ARGUMENT = /[&|<>^%!()"\0\r\n]/;

function isTrustedWindowsBatchCommand(command) {
  return TRUSTED_WINDOWS_BATCH_COMMANDS.has(command.toLowerCase());
}

export function normalizeSpawnInvocation(
  command,
  args,
  { platform = process.platform, comSpec = process.env.ComSpec } = {}
) {
  if (platform !== "win32" || !isTrustedWindowsBatchCommand(command)) {
    return { command, args };
  }

  if (
    args.some(
      (arg) => typeof arg !== "string" || UNSAFE_WINDOWS_BATCH_ARGUMENT.test(arg)
    )
  ) {
    throw new Error(
      "[unsafe-windows-command-argument] refusing cmd.exe metacharacters in npm/npx arguments"
    );
  }

  return {
    command: comSpec || "cmd.exe",
    args: ["/d", "/s", "/c", command, ...args],
  };
}

export function spawnSyncPortable(command, args, options) {
  const invocation = normalizeSpawnInvocation(command, args);
  return spawnSync(invocation.command, invocation.args, options);
}
