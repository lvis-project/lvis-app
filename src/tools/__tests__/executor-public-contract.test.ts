import { describe, expect, expectTypeOf, it } from "vitest";
import * as executorModule from "../executor.js";
import type {
  ConversationBatchExecuteOptions,
  ConversationBatchExecutionOutcome,
  ConversationExecuteOptions,
  ExecuteOptions,
  InterceptedMetaToolHandler,
  RationaleResumeExecuteOptions,
  ToolCallMeta,
  ToolExecutorCallbacks,
  ToolPermissionContext,
  ToolResult,
  ToolUseBlock,
} from "../executor.js";

type PublicExecutorContracts = [
  ConversationBatchExecuteOptions,
  ConversationBatchExecutionOutcome,
  ConversationExecuteOptions,
  ExecuteOptions,
  InterceptedMetaToolHandler,
  RationaleResumeExecuteOptions,
  ToolCallMeta,
  ToolExecutorCallbacks,
  ToolPermissionContext,
  ToolResult,
  ToolUseBlock,
];

describe("ToolExecutor public barrel", () => {
  it("preserves the runtime exports while public contract types remain importable", () => {
    expect(Object.keys(executorModule).sort()).toEqual([
      "RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT",
      "ToolExecutor",
    ]);
    expect(executorModule.ToolExecutor).toBeTypeOf("function");
    expect(executorModule.RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT).toContain(
      "terminal audit",
    );
    expectTypeOf<PublicExecutorContracts>().toBeArray();
  });
});
