/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/hooks/executor.py
 * Copyright (c) 2026 HKU Data Intelligence Lab
 */
import { spawn } from "node:child_process";
import type { ExternalHookResult } from "./types.js";
import { aggregateExternal, type AggregatedExternalHookResult } from "./types.js";
import type {
  CommandHookDefinition,
  HooksConfig,
  HookDefinition,
  HttpHookDefinition,
} from "./schemas.js";

export class ExternalHookExecutor {
  constructor(
    private readonly config: HooksConfig,
    private readonly cwd: string,
  ) {}

  async run(
    event: "preToolUse" | "postToolUse",
    toolName: string,
    payload: Record<string, unknown>,
  ): Promise<AggregatedExternalHookResult> {
    const hooks = event === "preToolUse" ? this.config.preToolUse : this.config.postToolUse;
    const results: ExternalHookResult[] = [];
    for (const hook of hooks) {
      if (!matches(hook, toolName)) continue;
      if (hook.type === "command") {
        results.push(await this.runCommandHook(hook, event, toolName, payload));
      } else {
        results.push(await this.runHttpHook(hook, event, toolName, payload));
      }
    }
    return aggregateExternal(results);
  }

  private async runCommandHook(
    hook: CommandHookDefinition,
    event: string,
    toolName: string,
    payload: Record<string, unknown>,
  ): Promise<ExternalHookResult> {
    const payloadJson = JSON.stringify(payload);
    const commandWithArgs = hook.command.replace("$ARGUMENTS", shellEscape(payloadJson));
    return new Promise((resolve) => {
      const child = spawn("sh", ["-c", commandWithArgs], {
        cwd: this.cwd,
        env: {
          ...process.env,
          LVIS_HOOK_EVENT: event,
          LVIS_HOOK_PAYLOAD: payloadJson,
          LVIS_HOOK_TOOL_NAME: toolName,
        },
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
      child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, hook.timeoutSeconds * 1000);
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        const output = Buffer.concat([...stdoutChunks, ...stderrChunks])
          .toString("utf-8")
          .trim();
        const success = code === 0;
        resolve({
          hookType: "command",
          success,
          output,
          blocked: hook.blockOnFailure && !success,
          reason: success ? undefined : output || `command hook exit ${code}`,
          metadata: { returncode: code },
        });
      });
      child.on("error", (err: Error) => {
        clearTimeout(timer);
        resolve({
          hookType: "command",
          success: false,
          blocked: hook.blockOnFailure,
          reason: err.message,
        });
      });
    });
  }

  private async runHttpHook(
    hook: HttpHookDefinition,
    event: string,
    toolName: string,
    payload: Record<string, unknown>,
  ): Promise<ExternalHookResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), hook.timeoutSeconds * 1000);
    try {
      const response = await fetch(hook.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...hook.headers },
        body: JSON.stringify({ event, toolName, payload }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const output = await response.text().catch(() => "");
      const success = response.ok;
      return {
        hookType: "http",
        success,
        output,
        blocked: hook.blockOnFailure && !success,
        reason: success ? undefined : output || `http hook status ${response.status}`,
        metadata: { statusCode: response.status },
      };
    } catch (err) {
      clearTimeout(timer);
      return {
        hookType: "http",
        success: false,
        blocked: hook.blockOnFailure,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function matches(hook: HookDefinition, toolName: string): boolean {
  if (!hook.matcher) return true;
  return minimatchLike(toolName, hook.matcher);
}

function minimatchLike(subject: string, pattern: string): boolean {
  // Simple glob: * = any chars, ** = any chars incl /, exact otherwise
  const regex = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  return regex.test(subject);
}

function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
