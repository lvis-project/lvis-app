import type { A2AAgentCausalContext } from "../engine/a2a-agent-message-envelope.js";
import type { McpUiPayload } from "../mcp/types.js";
import type { HostShellExecutionPlanAuditProjection } from "../permissions/host-shell-execution-plan.js";
import type { PermissionReviewEvent } from "../shared/permission-review-status.js";
import type { RationaleExecutorControlOutcome } from "./pipeline/rationale-pr1-contract.js";
import type { RationaleHostRuntime } from "./pipeline/rationale-orchestrator.js";
import type { RationaleResumeHostRuntime } from "./pipeline/rationale-resume-runner.js";
import type { ToolResultChunkReader } from "./tool-result-chunk.js";
import type {
  ToolCategory,
  ToolResultImage,
  ToolSource,
  ToolTrustOrigin,
} from "./types.js";

/** Stable renderer/audit metadata for one tool invocation. */
export interface ToolCallMeta {
  groupId: string;
  toolUseId: string;
  displayOrder: number;
  source?: ToolSource;
  category?: ToolCategory;
  pluginId?: string;
  workerId?: string;
  mcpServerId?: string;
  /** Renderer-safe shell projection; never the raw capability or permit. */
  executionPlan?: HostShellExecutionPlanAuditProjection;
}

export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  /** MCP Apps spec §3.2 UI payload. */
  uiPayload?: McpUiPayload;
  /** Host-internal raw tool result for non-LLM plugin invocation surfaces. */
  rawResult?: unknown;
  /** Optional image for the model to see. */
  image?: ToolResultImage;
  /** Host-issued renderer-safe shell substrate projection. */
  executionPlan?: HostShellExecutionPlanAuditProjection;
  /** Wall-clock pipeline duration, including every terminal path. */
  durationMs: number;
}

export interface ToolExecutorCallbacks {
  onToolStart?: (name: string, input: Record<string, unknown>, meta: ToolCallMeta) => void;
  onPermissionReview?: (event: PermissionReviewEvent) => void;
  onToolEnd?: (
    name: string,
    result: string,
    isError: boolean,
    meta: ToolCallMeta,
    uiPayload: McpUiPayload | undefined,
    durationMs: number,
  ) => void;
}

export interface ToolPermissionContext {
  headless?: boolean;
  allowedPluginIds?: ReadonlySet<string>;
  /** Derived only after hooks finalize the invocation arguments. */
  approvalCacheKey?: string;
  /** Snapshot of user-configured Layer 1 roots. */
  additionalDirectories?: readonly string[];
  /** Fresh accessor used to observe earlier grants in an ordered batch. */
  getAdditionalDirectories?: () => readonly string[];
  /** Audited trust origin for this invocation. */
  trustOrigin: ToolTrustOrigin;
  /** Direct plugin panel/renderer user activation marker. */
  pluginPanelUserAction?: boolean;
  /** Recent user-authored intent for reviewer context only. */
  userIntent?: string;
  onTurnDirectoryGrant?: (approvedDirectory: string) => void;
  onSessionDirectoryGrant?: (approvedDirectory: string) => void;
}

/** Bundled options shared by batch and single-invocation execution. */
export interface ExecuteOptions {
  callbacks?: ToolExecutorCallbacks;
  sessionId?: string;
  overlayTriggerOrigin?: string | null;
  spawnDepth?: number;
  supportsA2AParentDelivery?: boolean;
  approvalReasonPrefix?: string;
  a2aCausalContext?: A2AAgentCausalContext;
  abortSignal?: AbortSignal;
  toolResultChunkReader?: ToolResultChunkReader;
  permissionContext?: ToolPermissionContext;
  executionCwd?: string;
}

export interface ConversationExecuteOptions extends ExecuteOptions {
  executionCwd: string;
}

export type InterceptedMetaToolHandler = (
  toolUse: ToolUseBlock,
) => Promise<ToolResult | null>;

export interface ConversationBatchExecuteOptions extends ConversationExecuteOptions {
  rationaleRuntime?: RationaleHostRuntime;
  interceptedMetaToolHandler?: InterceptedMetaToolHandler;
}

export interface RationaleResumeExecuteOptions extends ConversationExecuteOptions {
  rationaleResumeRuntime?: RationaleResumeHostRuntime;
}

export type ConversationBatchExecutionOutcome =
  | {
      outcome: "completed";
      results: ToolResult[];
    }
  | {
      outcome: "rationale-required";
      completedResults: ToolResult[];
      control: RationaleExecutorControlOutcome;
    };

export const RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT =
  "Rationale-authorized action ran, but its terminal audit could not be committed. " +
  "The execution outcome is unknown; the action will not be retried automatically.";
