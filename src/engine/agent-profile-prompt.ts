export interface AgentProfilePromptSource {
  name: string;
  body: string;
}

const AGENT_PROFILE_FENCE_PATTERN = /<(\s*\/?\s*lvis-agent-(?:profile|task)[^>]*)>/gi;
const ZWSP = "\u200b";

/**
 * Render a loaded agent profile and its task as separate, fence-safe
 * prompt sections. Profile and task content cannot close or open either fence.
 */
export function renderAgentProfilePrompt(
  profile: AgentProfilePromptSource,
  taskInstructions: string,
): string {
  return [
    '<lvis-agent-profile name="' + escapeAttr(profile.name) + '">',
    neutralizeAgentProfileFence(profile.body),
    "</lvis-agent-profile>",
    "",
    "<lvis-agent-task>",
    neutralizeAgentProfileFence(taskInstructions),
    "</lvis-agent-task>",
  ].join("\n");
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function neutralizeAgentProfileFence(body: string): string {
  return body.replace(AGENT_PROFILE_FENCE_PATTERN, "<" + ZWSP + "$1>");
}
