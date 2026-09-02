import { spawnSync } from "node:child_process";

const TRUSTED_WINDOWS_BATCH_COMMANDS = new Set(["npm.cmd", "npx.cmd"]);
const UNSAFE_WINDOWS_BATCH_ARGUMENT = /[&|<>^%!()"\0\r\n]/;

function isTrustedWindowsBatchCommand(command) {
  return TRUSTED_WINDOWS_BATCH_COMMANDS.has(command.toLowerCase());
}

function normalizeSpawnInvocation(
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

/**
 * Run a command with inherited stdio, echo it under `label`, and throw on a
 * spawn failure or a non-zero exit. The build, release, screenshot and
 * pre-push scripts each carried a private copy of this loop; the copies
 * agreed on everything but the log prefix, and one of them exited the
 * process instead of throwing, which skipped its caller's cleanup.
 */
export function runCommand(command, args, { cwd, label, env = process.env, ...options } = {}) {
  console.log(`[${label}] $ ${command} ${args.join(" ")}`);
  const result = spawnSyncPortable(command, args, {
    cwd,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    ...options,
  });
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status} in ${cwd}`);
  }
}
