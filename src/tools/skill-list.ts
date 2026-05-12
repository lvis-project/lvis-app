import { createDynamicTool, type Tool } from "./base.js";
import type { SkillStore } from "../main/skill-store.js";

export function createSkillListTool(store: SkillStore): Tool {
  return createDynamicTool({
    name: "skill_list",
    description:
      "현재 사용할 수 있는 LVIS skills 목록을 반환합니다. skill_load 전에 어떤 skill 이 있는지 확인할 때 사용하세요.",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => {
      const skills = (await store.list()).map((skill) => ({
        name: skill.name,
        description: skill.description,
        triggers: skill.triggers,
        source: skill.source,
      }));
      return { output: JSON.stringify({ skills }), isError: false };
    },
  });
}
