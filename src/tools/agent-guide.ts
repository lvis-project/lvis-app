/**
 * `agent_guide` — the parent's mid-run channel to a sub-agent it started.
 *
 * WHY A SECOND TOOL RATHER THAN A BRANCH IN `agent_send`. `agent_send` is
 * defined from inside a child: its `to` means "my parent or a sibling", its
 * `waitForReply` suspends the CHILD's turn as a question, and its sender is
 * resolved from a childSessionId that a root session does not have. A parent
 * branch would make the address space, the reply flag, and the sender
 * resolution all conditional on caller depth — and the root-visible schema
 * would then advertise `to: "parent"` and `waitForReply`, neither of which a
 * root session can use. That exact shape (a visible tool the caller can never
 * successfully call) was removed from `agent_send` once already; re-creating it
 * inside the same schema would be re-introducing it. Two tools instead means
 * each schema states exactly its caller's authority, and the child-side
 * contract is untouched — `agent_send` still refuses every non-child caller.
 */
import { createDynamicTool, type Tool } from "./base.js";
import type { SubAgentRunner } from "../engine/subagent-runner.js";
import { PARENT_DIRECTIVE_MAX_CHARS } from "../engine/parent-directive.js";
import { t } from "../i18n/index.js";

interface AgentGuideToolDeps {
  getRunner: () => SubAgentRunner | undefined;
}

function resultError(reason: string, extra?: Record<string, string>): {
  output: string;
  isError: true;
} {
  return {
    output: JSON.stringify({ error: reason, ...(extra ?? {}) }),
    isError: true,
  };
}

export function createAgentGuideTool(deps: AgentGuideToolDeps): Tool {
  return createDynamicTool({
    name: "agent_guide",
    description: "Send a directive to a sub-agent YOU started — change its direction or tell it to stop. A running sub-agent receives it at its next round boundary; a suspended one receives it when you resume it with agent_spawn(resumeId).",
    source: "builtin",
    category: "meta",
    // Same argument as `agent_send`: this moves a message and nothing else. It
    // writes no file and opens no socket, and whatever the child then does
    // re-enters PermissionManager at the child's own tool calls, which is where
    // effects are gated. Ownership is host-checked in the runner, so the model
    // cannot widen who it reaches by arguing with the schema.
    decisionOverride: "always-allow-with-audit",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["childSessionId", "message"],
      properties: {
        childSessionId: {
          type: "string",
          description: "childSessionId of a sub-agent this conversation started (see agent_status or agent_list). Agent names are not addresses.",
        },
        message: {
          type: "string",
          maxLength: PARENT_DIRECTIVE_MAX_CHARS,
          description: "The directive, in your own words. It reaches the sub-agent labelled as coming from you.",
        },
      },
    },
    execute: async (rawInput, ctx) => {
      // Defense in depth beside the sub-agent registry blocklist: a child has no
      // children, so depth >= 1 has nothing this tool could legitimately address.
      const depth = typeof ctx.metadata?.spawnDepth === "number"
        ? ctx.metadata.spawnDepth
        : 0;
      if (depth >= 1) {
        return resultError("agent_guide cannot be invoked from a sub-agent");
      }
      const runner = deps.getRunner();
      if (!runner) return resultError("agent_guide runner not configured");
      const originSessionId = typeof ctx.metadata?.sessionId === "string"
        ? ctx.metadata.sessionId
        : "";
      if (!originSessionId) return resultError("agent_guide requires a session id");

      const input = (rawInput ?? {}) as Record<string, unknown>;
      if (!Object.keys(input).every((key) => ["childSessionId", "message"].includes(key))) {
        return resultError("invalid-message");
      }
      const childSessionId = typeof input.childSessionId === "string"
        ? input.childSessionId.trim()
        : "";
      const message = typeof input.message === "string" ? input.message : "";
      if (!childSessionId) return resultError("unknown-recipient");
      if (message.trim().length === 0) return resultError("invalid-message");

      const delivered = await runner.queueParentMessageToChild(
        originSessionId,
        childSessionId,
        message,
      );
      if (!delivered.ok) {
        // The one refusal a parent would otherwise retry forever: name what is
        // actually true about the child instead of letting "it did not work"
        // read as "try again".
        return resultError(
          delivered.reason,
          delivered.reason === "child-not-resumable"
            ? { guidance: t("be_parentDirective.notResumableGuidance") }
            : undefined,
        );
      }
      return {
        output: JSON.stringify({
          childSessionId: delivered.childSessionId,
          messageId: delivered.messageId,
          disposition: delivered.disposition,
          ...(delivered.disposition === "mailbox"
            ? { guidance: t("be_parentDirective.queuedForResumeGuidance") }
            : {}),
        }),
        isError: false,
      };
    },
  });
}
