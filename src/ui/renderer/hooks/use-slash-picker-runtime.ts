/**
 * useSlashPickerRuntime — lazily fetches the live MCP-server tools and the
 * registered assistant skills that back the SlashPicker's `mcp` / `skills`
 * categories.
 *
 * Both sources are REAL host IPCs that already exist:
 *   - MCP tools: `window.lvis.mcp.servers()` → each connected server's
 *     `registeredTools` (namespaced names), flattened.
 *   - Skills: `window.lvis.listSkills()` → `{ skills: AssistantSkillSummary[] }`.
 *
 * No fake/stub fallback: when the host API is absent (e.g. detached preview
 * windows) the lists stay empty, which the panel surfaces honestly as a
 * zero-count category rather than synthesizing rows.
 *
 * Fetching is gated on `enabled` so the picker pays the IPC cost only while
 * open, and re-runs whenever it re-opens so a newly-connected MCP server or a
 * freshly-installed skill shows up without a restart.
 */
import { useEffect, useState } from "react";
import type {
  McpPromptEntry,
  McpToolEntry,
  SkillEntry,
} from "../components/slash-picker-data.js";

export interface SlashPickerRuntime {
  mcpTools: McpToolEntry[];
  /** Server-declared prompts — a USER-controlled primitive, never model-callable. */
  mcpPrompts: McpPromptEntry[];
  skills: SkillEntry[];
}

/**
 * One read of both live sources. The hook below subscribes with it; the native
 * command menu calls it directly at click time, because a menu is built and
 * popped in a single call and has nowhere to show a pending state — what it
 * draws must be what is connected at the moment it opens.
 */
export async function loadSlashPickerRuntime(): Promise<SlashPickerRuntime> {
  const [servers, skillResult] = await Promise.all([
    (async () => (await window.lvis?.mcp?.servers?.()) ?? [])(),
    (async () => await window.lvisApi?.listSkills?.())(),
  ]);
  const mcpTools: McpToolEntry[] = [];
  const mcpPrompts: McpPromptEntry[] = [];
  for (const s of servers) {
    if (s.status !== "connected") continue;
    for (const name of s.registeredTools) mcpTools.push({ name, serverId: s.id });
    for (const prompt of s.prompts ?? []) {
      mcpPrompts.push({
        name: prompt.name,
        serverId: s.id,
        ...(prompt.title ? { title: prompt.title } : {}),
        ...(prompt.description ? { description: prompt.description } : {}),
        arguments: (prompt.arguments ?? []).map((argument) => ({
          name: argument.name,
          ...(argument.description ? { description: argument.description } : {}),
          required: argument.required === true,
        })),
      });
    }
  }
  return {
    mcpTools,
    mcpPrompts,
    skills: (skillResult?.skills ?? []).map((skill) => ({
      name: skill.name,
      description: skill.description,
    })),
  };
}

const EMPTY_RUNTIME: SlashPickerRuntime = { mcpTools: [], mcpPrompts: [], skills: [] };

export function useSlashPickerRuntime(enabled: boolean): SlashPickerRuntime {
  const [runtime, setRuntime] = useState<SlashPickerRuntime>(EMPTY_RUNTIME);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadSlashPickerRuntime().then((next) => {
      if (!cancelled) setRuntime(next);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return runtime;
}
