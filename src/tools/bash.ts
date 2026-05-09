/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/tools/bash_tool.py
 * Copyright (c) 2026 HKU Data Intelligence Lab
 *
 * SafeBashExecutor (Tier A1) — non-interactive shell execution with
 * preflight detection for interactive scaffolds, timeout handling with
 * partial-output drain, graceful terminate→kill ladder, and output cap.
 *
 * AF3: the `cwd` sandbox check in `execute()` is a **heuristic hint**,
 * not a sandbox boundary. A user-supplied `input.cwd` that points outside
 * the session cwd is rejected before spawn, but the real enforcement of
 * which commands may run lives in {@link ../main/bash-ast-validator.ts}.
 * Do not rely on this function to stop shell escapes — only BashAstValidator
 * (Step 2.5 of the tool executor pipeline) prevents dangerous syntax.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { resolveShell } from "../lib/shell-resolver.js";
import type { Readable } from "node:stream";
import { resolve as pathResolve } from "node:path";
import { z } from "zod";

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

import {
  ZodTool,
  type ToolCategory,
  type ToolExecutionContext,
  type ToolResult,
} from "./base.js";
import { validateSandboxPath } from "../sandbox/path-validator.js";
import { buildSafeChildEnv } from "./safe-env.js";

export const BashToolInputSchema = z.object({
  command: z.string().min(1).describe("Shell command to execute"),
  cwd: z.string().optional().describe("Working directory override"),
  timeoutSeconds: z.number().int().min(1).max(600).default(600),
});

const OUTPUT_CAP = 12_000;
const TRUNCATION_MARKER = "\n...[truncated]...";

const INTERACTIVE_SCAFFOLDS = [
  "create-next-app",
  "npm create ",
  "pnpm create ",
  "yarn create ",
  "bun create ",
  "pnpm dlx ",
  "npm init ",
  "pnpm init ",
  "yarn init ",
  "bunx create-",
  "npx create-",
];

const NON_INTERACTIVE_MARKERS = [
  "--yes",
  " -y",
  "--skip-install",
  "--defaults",
  "--non-interactive",
  "--ci",
];

export class BashTool extends ZodTool<typeof BashToolInputSchema> {
  readonly name = "bash";
  readonly description = "Run a shell command in the local repository.";
  readonly inputSchema = BashToolInputSchema;
  override readonly category: ToolCategory = "shell";

  override isReadOnly(_input: unknown): boolean {
    return false;
  }

  protected async executeTyped(
    input: z.infer<typeof BashToolInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    // Preflight: interactive scaffolds would hang on stdin.
    const preflightError = preflightInteractiveCommand(input.command);
    if (preflightError !== null) {
      return {
        output: preflightError,
        isError: true,
        metadata: { interactiveRequired: true },
      };
    }

    // Sandbox path check on cwd (if overridden).
    const resolvedCwd = input.cwd ? pathResolve(input.cwd) : ctx.cwd;
    if (input.cwd) {
      const check = validateSandboxPath(resolvedCwd, ctx.cwd);
      if (!check.allowed) {
        return { output: `Sandbox: ${check.reason}`, isError: true };
      }
    }

    return await spawnWithTimeout(input.command, resolvedCwd, input.timeoutSeconds); // Uses shared shell resolver
  }
}

function preflightInteractiveCommand(command: string): string | null {
  const lowered = command.toLowerCase();
  const hasScaffold = INTERACTIVE_SCAFFOLDS.some((marker) => lowered.includes(marker));
  const hasNonInteractive = NON_INTERACTIVE_MARKERS.some((marker) =>
    lowered.includes(marker),
  );
  if (hasScaffold && !hasNonInteractive) {
    return (
      "This command appears to require interactive input before it can continue. " +
      "The bash tool is non-interactive, so it cannot answer installer/scaffold prompts live. " +
      "Prefer non-interactive flags (for example --yes, -y, --skip-install, --defaults, --non-interactive), " +
      "or run the scaffolding step once in an external terminal before asking the agent to continue."
    );
  }
  return null;
}

interface SpawnResult {
  output: string;
  isError: boolean;
  metadata: Record<string, unknown>;
}

async function spawnWithTimeout(
  command: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const shell = resolveShell();
    const child: PipedChild = spawn(shell.cmd, shell.shellArgs(command), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // H2: strip secrets (LVIS_*, *_API_KEY, GITHUB_TOKEN, AWS_*, etc.)
      // from the child's environment. Only generic shell/locale vars.
      env: buildSafeChildEnv(),
    });

    const chunks: Buffer[] = [];
    const collect = (c: Buffer): void => {
      chunks.push(c);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcess(child);
    }, timeoutSeconds * 1000);

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = Buffer.concat(chunks).toString("utf-8");
      const formatted = formatOutput(combined);
      if (timedOut) {
        resolve({
          output: formatTimeoutOutput(formatted, command, timeoutSeconds),
          isError: true,
          metadata: { returncode: code, timedOut: true },
        });
      } else {
        resolve({
          output: formatted,
          isError: code !== 0,
          metadata: { returncode: code },
        });
      }
    };

    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        output: `spawn failed: ${err.message}`,
        isError: true,
        metadata: {},
      });
    });
  });
}

function terminateProcess(child: PipedChild): void {
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGKILL");
    }
  }, 2000);
}

function formatOutput(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text.length === 0) return "(no output)";
  if (text.length > OUTPUT_CAP) return text.slice(0, OUTPUT_CAP) + TRUNCATION_MARKER;
  return text;
}

function formatTimeoutOutput(
  partial: string,
  command: string,
  timeoutSeconds: number,
): string {
  const parts = [`Command timed out after ${timeoutSeconds} seconds.`];
  if (partial !== "(no output)") {
    parts.push("", "Partial output:", partial);
  }
  const hint = interactiveHint(command, partial);
  if (hint !== null) {
    parts.push("", hint);
  }
  return parts.join("\n");
}

function interactiveHint(command: string, output: string): string | null {
  const lowered = command.toLowerCase();
  const outputLower = output.toLowerCase();
  const looksInteractive = INTERACTIVE_SCAFFOLDS.some((m) => lowered.includes(m));
  const looksPrompt = [
    "would you like",
    "ok to proceed",
    "select an option",
    "press enter",
  ].some((m) => outputLower.includes(m));
  if (looksInteractive || looksPrompt) {
    return (
      "This command appears to require interactive input. " +
      "The bash tool is non-interactive, so prefer non-interactive flags " +
      "(for example --yes, -y, --skip-install, or similar) or run the " +
      "scaffolding step once in an external terminal before continuing."
    );
  }
  return null;
}
