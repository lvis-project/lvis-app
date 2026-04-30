import type { RolePreset } from "../../../data/role-presets.js";
import { buildPresetPrefix } from "../../../data/role-presets.js";

/**
 * Compose outgoing message with role-preset prefix and attached-doc notice.
 * Pure function — extracted from App.tsx so it can be unit-tested and reused
 * by use-cost-estimate's draft serialization.
 *
 * CTRL simplification: language lock removed. Modern LLMs detect language
 * from user input automatically; an explicit "Respond in Korean/English"
 * directive is unnecessary and brittle.
 */
export function composeOutgoing(params: {
  raw: string;
  activePreset: RolePreset | null;
  attachedDocs: Array<{ id: string; name: string }>;
}): string {
  const { raw, activePreset, attachedDocs } = params;
  const parts: string[] = [];
  const presetPrefix = buildPresetPrefix(activePreset);
  if (presetPrefix) parts.push(presetPrefix.trimEnd());
  if (attachedDocs.length > 0) {
    const lines = attachedDocs.map((d) => `- ${d.name} (id: ${d.id})`).join("\n");
    parts.push(`[Attached documents — use knowledge_search / document_structure to read them]\n${lines}`);
  }
  parts.push(raw);
  return parts.join("\n\n");
}
