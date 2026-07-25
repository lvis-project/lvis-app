/**
 * Render an MCP `prompts/get` result into ONE block of turn text.
 *
 * Trust: the messages are SERVER-authored. The user chose to run the prompt, but
 * not its content, so the rendered text is untrusted data — it enters the turn
 * under a dedicated provenance origin and never as user-typed input.
 *
 * Only `text` blocks are rendered. `image` / `audio` / `resource` blocks are
 * replaced with an explicit placeholder rather than dropped silently: a server
 * must not be able to make the host quietly omit part of what it returned, and
 * unrendered bytes must not reach the model as if they were text.
 *
 * Pure — no filesystem, no IPC, no logging. The BOUNDS it enforces live in
 * `shared/mcp-prompt-bounds.ts`, because main and the renderer must agree on them.
 */

import {
  MCP_PROMPT_MAX_BLOCKS,
  MCP_PROMPT_MAX_CHARS,
} from "../shared/mcp-prompt-bounds.js";

export interface McpPromptBlock {
  role: string;
  type: string;
  text?: string;
}

export interface RenderedMcpPrompt {
  text: string;
  /** True when the block list or character budget clipped the render. */
  truncated: boolean;
  /** Count of non-text blocks that became placeholders. */
  omittedBlocks: number;
}

function safeRole(role: string): string {
  // Roles are annotations inside the rendered text, so keep them inert: a
  // server-supplied role must not smuggle markup or line breaks.
  //
  // These annotations are NOT a trust signal. A text block may itself contain a
  // line reading `[system] …`, and nothing here can tell the two apart. What
  // carries provenance is the envelope around the whole render plus the
  // model-facing guidance for this origin — never a `[role]` prefix.
  const cleaned = role.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return cleaned.length > 0 ? cleaned : "unknown";
}

export function renderMcpPrompt(
  blocks: readonly McpPromptBlock[],
  description?: string,
): RenderedMcpPrompt {
  const lines: string[] = [];
  let truncated = false;
  let omittedBlocks = 0;

  if (typeof description === "string" && description.trim().length > 0) {
    lines.push(`prompt: ${description.trim()}`);
    lines.push("");
  }

  const considered = blocks.slice(0, MCP_PROMPT_MAX_BLOCKS);
  if (considered.length < blocks.length) truncated = true;

  for (const block of considered) {
    const role = safeRole(block.role);
    if (block.type === "text" && typeof block.text === "string") {
      const body = block.text.trim();
      if (body.length === 0) continue;
      lines.push(`[${role}] ${body}`);
      continue;
    }
    omittedBlocks += 1;
    lines.push(`[${role}] (omitted ${safeRole(block.type)} content — not rendered as text)`);
  }

  let text = lines.join("\n").trim();
  if (text.length > MCP_PROMPT_MAX_CHARS) {
    text = `${text.slice(0, MCP_PROMPT_MAX_CHARS)}…`;
    truncated = true;
  }
  return { text, truncated, omittedBlocks };
}
