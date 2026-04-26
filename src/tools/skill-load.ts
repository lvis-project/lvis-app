/**
 * `skill_load` LLM tool — loads a skill (markdown w/ frontmatter) into the
 * current conversation as a system-role message. Renderer surfaces a
 * SkillBadge ("🎯 Skill loaded: <name>") at the call site so the user sees
 * which skills are active for the rest of the turn.
 */
import { createDynamicTool, type Tool } from "./base.js";
import type { SkillStore } from "../main/skill-store.js";

export interface SkillLoadEvent {
  name: string;
  description: string;
  source: "user" | "builtin";
}

export interface SkillLoadToolDeps {
  store: SkillStore;
  /** Renderer event sink — used by the chat to render the SkillBadge. */
  emit: (event: SkillLoadEvent) => void;
  /**
   * Conversation injector — appends the skill body as an assistant-visible
   * overlay (user-role with [Skill] prefix, since the GenericMessage type
   * has no `system` role at runtime — system prompt is built each turn by
   * SystemPromptBuilder) so subsequent rounds carry the skill guidance.
   */
  injectSystemMessage: (sessionId: string, content: string) => void;
}

export function createSkillLoadTool(deps: SkillLoadToolDeps): Tool {
  return createDynamicTool({
    name: "skill_load",
    description:
      "이름으로 skill 을 로드해 현재 대화의 system 메시지로 주입합니다. " +
      "Skill 은 ~/.lvis/skills/<name>.md (YAML frontmatter + markdown). " +
      "성공 시 { loaded: true, skillName, summary } 반환.",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["skillName"],
      properties: {
        skillName: {
          type: "string",
          description: "로드할 skill 이름 (frontmatter 의 name 또는 파일명).",
        },
        args: {
          type: "object",
          description:
            "skill 에 전달할 파라미터 (현재 버전은 단순 메타데이터). 선택.",
        },
      },
    },
    execute: async (rawInput, ctx) => {
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const skillName = typeof a.skillName === "string" ? a.skillName.trim() : "";
      if (!skillName) {
        return {
          output: JSON.stringify({ error: "skillName is required" }),
          isError: true,
        };
      }
      const skill = await deps.store.load(skillName);
      if (!skill) {
        return {
          output: JSON.stringify({ error: `skill not found: ${skillName}` }),
          isError: true,
        };
      }
      const sessionId =
        typeof ctx.metadata?.sessionId === "string"
          ? (ctx.metadata.sessionId as string)
          : "unknown";
      // Inject the skill body as a system-role overlay. The chat history is
      // mutated in-place so the next assistant round sees the new guidance.
      const overlay = `[Skill: ${skill.name}]\n${skill.body}`;
      try {
        deps.injectSystemMessage(sessionId, overlay);
      } catch (err) {
        // Non-fatal: still fire the badge so the user sees the load attempt.
        console.warn(
          "[lvis] skill_load injectSystemMessage failed:",
          (err as Error).message,
        );
      }
      deps.emit({
        name: skill.name,
        description: skill.description,
        source: skill.source,
      });
      return {
        output: JSON.stringify({
          loaded: true,
          skillName: skill.name,
          summary:
            skill.description ||
            `Skill '${skill.name}' loaded from ${skill.source}`,
        }),
        isError: false,
      };
    },
  });
}
