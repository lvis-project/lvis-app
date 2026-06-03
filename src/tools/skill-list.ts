import { createDynamicTool, type Tool } from "./base.js";
import type { SkillStore } from "../main/skill-store.js";
import { t } from "../i18n/index.js";

export function createSkillListTool(store: SkillStore): Tool {
  return createDynamicTool({
    name: "skill_list",
    description: t("be_skillList.toolDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => {
      const skills = store.listCatalogSync();
      return { output: JSON.stringify({ skills }), isError: false };
    },
  });
}
