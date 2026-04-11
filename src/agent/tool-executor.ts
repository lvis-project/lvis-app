/**
 * Tool Executor — §4.5.6 도구 실행 파이프라인 (8단계)
 *
 * claw-code 패턴 적용:
 * 1. lookup → 2. PreHook → 3. Permission → 4. HookOverride
 * → 5. Execute → 6. PostHook → 7. FeedbackMerge → 8. Result
 */
import type { ToolRegistry } from "../core/tool-registry.js";
import { HookRunner } from "./hook-runner.js";

export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ToolExecutorCallbacks {
  onToolStart?: (name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string, isError: boolean) => void;
}

export class ToolExecutor {
  private readonly toolRegistry: ToolRegistry;
  private readonly hookRunner: HookRunner;

  constructor(toolRegistry: ToolRegistry, hookRunner?: HookRunner) {
    this.toolRegistry = toolRegistry;
    this.hookRunner = hookRunner ?? new HookRunner();
  }

  getHookRunner(): HookRunner {
    return this.hookRunner;
  }

  /** 복수 tool_use 병렬 실행 — §4.5.6 StreamingToolExecutor */
  async executeAll(
    toolUses: ToolUseBlock[],
    callbacks?: ToolExecutorCallbacks,
  ): Promise<ToolResult[]> {
    return Promise.all(toolUses.map((tu) => this.executeOne(tu, callbacks)));
  }

  /** 단일 도구 — 8단계 파이프라인 */
  private async executeOne(
    toolUse: ToolUseBlock,
    callbacks?: ToolExecutorCallbacks,
  ): Promise<ToolResult> {
    // Step 1: Lookup
    const tool = this.toolRegistry.findByName(toolUse.name);
    if (!tool) {
      return { tool_use_id: toolUse.id, content: `도구를 찾을 수 없습니다: ${toolUse.name}`, is_error: true };
    }

    // Step 2: PreToolUse Hook
    const preResult = await this.hookRunner.runPreHooks({
      toolName: toolUse.name,
      toolInput: toolUse.input,
    });

    // Step 3-4: Permission + Hook Override (deny 처리)
    if (preResult.action === "deny") {
      const msg = `[차단] ${preResult.reason ?? "훅에 의해 차단됨"}`;
      callbacks?.onToolStart?.(toolUse.name, toolUse.input);
      callbacks?.onToolEnd?.(toolUse.name, msg, true);
      return { tool_use_id: toolUse.id, content: msg, is_error: true };
    }

    // 입력이 수정되었으면 적용
    const finalInput = preResult.action === "modify" && preResult.updatedInput
      ? preResult.updatedInput
      : toolUse.input;

    callbacks?.onToolStart?.(toolUse.name, finalInput);

    // Step 5: Execute
    let content: string;
    let isError = false;

    try {
      const result = await tool.execute(finalInput);
      content = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      content = err instanceof Error ? err.message : "알 수 없는 도구 실행 오류";
      isError = true;
    }

    // Step 6: PostToolUse Hook (or PostToolUseFailure)
    const postFeedback = await this.hookRunner.runPostHooks({
      toolName: toolUse.name,
      toolInput: finalInput,
      toolOutput: content,
      isError,
    });

    // Step 7: Feedback Merge
    if (postFeedback) {
      content = `${content}\n\n[Hook Feedback]\n${postFeedback}`;
    }
    if (preResult.feedback) {
      content = `${content}\n\n[Pre-Hook Note]\n${preResult.feedback}`;
    }

    // Step 8: Result
    callbacks?.onToolEnd?.(toolUse.name, content, isError);
    return { tool_use_id: toolUse.id, content, ...(isError && { is_error: true }) };
  }
}
