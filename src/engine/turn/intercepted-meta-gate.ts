import { randomUUID } from "node:crypto";
import type { LoopContext } from "./loop-context.js";
import type { ToolUseBlock } from "../../tools/executor.js";
import type { ToolTrustOrigin } from "../../tools/types.js";
import { REQUEST_PLUGIN_TOOL } from "./plugin-expansion.js";
import { TOOL_SEARCH_TOOL } from "./tool-search.js";

interface InterceptedMetaGateResult {
  approved: ToolUseBlock[];
  denied: Array<{
    toolUseId: string;
    toolName: string;
    content: string;
  }>;
}
function isApprovalChoiceAllowed(choice: string): boolean {
  return choice === "allow-once" || choice === "allow-session" || choice === "allow-always";
}

export async function gateCrossAgentInterceptedMetaTools(
  self: LoopContext,
  toolUses: ToolUseBlock[],
  approvalReasonPrefix: string | undefined,
  trustOrigin: ToolTrustOrigin,
  sessionId: string,
): Promise<InterceptedMetaGateResult> {
  if (!approvalReasonPrefix) return { approved: toolUses, denied: [] };

  const approved: ToolUseBlock[] = [];
  const denied: InterceptedMetaGateResult["denied"] = [];
  for (const toolUse of toolUses) {
    if (toolUse.name !== REQUEST_PLUGIN_TOOL && toolUse.name !== TOOL_SEARCH_TOOL) {
      approved.push(toolUse);
      continue;
    }

    const gate = self.deps.approvalGate;
    let allowed = false;
    if (!gate) {
      self.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId,
        type: "error",
        input: `cross-agent-meta-approval-unavailable:${toolUse.name}`,
      });
    } else {
      try {
        const decision = await gate.requestAndWait({
          id: randomUUID(),
          category: "tool",
          kind: "tool",
          toolName: toolUse.name,
          toolCategory: "meta",
          args: toolUse.input,
          reason: `${approvalReasonPrefix} cross-agent message requested ${toolUse.name}`,
          source: "builtin",
          createdAt: Date.now(),
          isReadOnly: false,
          mode: "ask_all",
          trustOrigin,
        });
        allowed = isApprovalChoiceAllowed(decision.choice);
      } catch {
        self.auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId,
          type: "error",
          input: `cross-agent-meta-approval-failed:${toolUse.name}`,
        });
      }
    }

    if (allowed) {
      approved.push(toolUse);
    } else {
      denied.push({
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content: `cross-agent-approval-denied: ${toolUse.name}`,
      });
    }
  }

  return { approved, denied };
}
