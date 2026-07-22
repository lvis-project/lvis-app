import { createDynamicTool, type Tool } from "./base.js";
import type { ToolExecutionContext } from "./types.js";
import {
  backgroundShellManager,
  type BackgroundShellManager,
  type BackgroundShellReadResult,
} from "./background-shell-manager.js";

function sessionIdOf(ctx: ToolExecutionContext | undefined): string {
  const raw = ctx?.metadata?.["sessionId"];
  return typeof raw === "string" && raw !== "" ? raw : "unknown";
}

function shellIdOf(rawInput: unknown): string {
  const args = (rawInput ?? {}) as Record<string, unknown>;
  return typeof args.shellId === "string" ? args.shellId.trim() : "";
}

function present(result: BackgroundShellReadResult): { output: string; isError: boolean } {
  return {
    output: JSON.stringify({
      shellId: result.shellId,
      command: result.command,
      status: result.status,
      exitCode: result.exitCode,
      output: result.output,
      truncated: result.truncated,
    }),
    isError: false,
  };
}

const NOT_FOUND =
  "no background shell with that id is running in this session (it may have already been reaped, or belongs to another session)";

/**
 * `bash_output` — read newly-accumulated output (and current status/exit code)
 * from a background shell started by `bash` with `run_in_background: true`.
 * Returns only the output produced since the previous call. Read-only.
 */
export function createBashOutputTool(
  manager: BackgroundShellManager = backgroundShellManager,
): Tool {
  return createDynamicTool({
    name: "bash_output",
    description:
      "Read output produced since your last check from a background shell started by `bash` " +
      "with run_in_background: true. Returns the new output plus the shell's status " +
      "(running | exited | killed | failed) and exit code. Poll this to follow a long-running command.",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["shellId"],
      properties: {
        shellId: { type: "string", description: "The shell id returned by the background bash call." },
      },
    },
    execute: async (rawInput, ctx) => {
      const shellId = shellIdOf(rawInput);
      if (shellId === "") {
        return { output: "bash_output: `shellId` is required.", isError: true };
      }
      const result = manager.read(sessionIdOf(ctx), shellId);
      if (!result) {
        return { output: `bash_output: ${NOT_FOUND}.`, isError: true };
      }
      return present(result);
    },
  });
}

/**
 * `bash_kill` — terminate a background shell started by `bash` with
 * `run_in_background: true`. Sends SIGTERM and returns the shell's final
 * status plus any remaining unread output.
 */
export function createBashKillTool(
  manager: BackgroundShellManager = backgroundShellManager,
): Tool {
  return createDynamicTool({
    name: "bash_kill",
    description:
      "Terminate a background shell started by `bash` with run_in_background: true, by its shell id. " +
      "Returns the shell's final status and any remaining unread output.",
    source: "builtin",
    category: "shell",
    isReadOnly: () => false,
    jsonSchema: {
      type: "object",
      required: ["shellId"],
      properties: {
        shellId: { type: "string", description: "The shell id returned by the background bash call." },
      },
    },
    execute: async (rawInput, ctx) => {
      const shellId = shellIdOf(rawInput);
      if (shellId === "") {
        return { output: "bash_kill: `shellId` is required.", isError: true };
      }
      const result = manager.kill(sessionIdOf(ctx), shellId);
      if (!result) {
        return { output: `bash_kill: ${NOT_FOUND}.`, isError: true };
      }
      return present(result);
    },
  });
}
