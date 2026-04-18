import type { RolePreset } from "../../../data/role-presets.js";
import { buildPresetPrefix } from "../../../data/role-presets.js";

/**
 * Compose outgoing message with role-preset prefix, attached-doc notice,
 * and optional language lock. Pure function — extracted from App.tsx so it
 * can be unit-tested and reused by use-cost-estimate's draft serialization.
 */
export function composeOutgoing(params: {
  raw: string;
  activePreset: RolePreset | null;
  attachedDocs: Array<{ id: string; name: string }>;
  langLock: "off" | "ko" | "en";
}): string {
  const { raw, activePreset, attachedDocs, langLock } = params;
  const parts: string[] = [];
  const presetPrefix = buildPresetPrefix(activePreset);
  if (presetPrefix) parts.push(presetPrefix.trimEnd());
  if (attachedDocs.length > 0) {
    const lines = attachedDocs.map((d) => `- ${d.name} (id: ${d.id})`).join("\n");
    parts.push(`[Attached documents — use knowledge_search / document_structure to read them]\n${lines}`);
  }
  if (langLock === "ko") parts.push("Respond in Korean only.");
  else if (langLock === "en") parts.push("Respond in English only.");
  parts.push(raw);
  return parts.join("\n\n");
}
