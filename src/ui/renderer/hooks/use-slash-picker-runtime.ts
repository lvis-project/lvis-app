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
import type { McpToolEntry, SkillEntry } from "../components/slash-picker-data.js";

export interface SlashPickerRuntime {
  mcpTools: McpToolEntry[];
  skills: SkillEntry[];
}

export function useSlashPickerRuntime(enabled: boolean): SlashPickerRuntime {
  const [mcpTools, setMcpTools] = useState<McpToolEntry[]>([]);
  const [skills, setSkills] = useState<SkillEntry[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    void (async () => {
      const servers = (await window.lvis?.mcp?.servers?.()) ?? [];
      if (cancelled) return;
      const tools: McpToolEntry[] = [];
      for (const s of servers) {
        if (s.status !== "connected") continue;
        for (const name of s.registeredTools) {
          tools.push({ name, serverId: s.id });
        }
      }
      setMcpTools(tools);
    })();

    void (async () => {
      const result = await window.lvisApi?.listSkills?.();
      if (cancelled) return;
      const list = result?.skills ?? [];
      setSkills(list.map((s) => ({ name: s.name, description: s.description })));
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { mcpTools, skills };
}
