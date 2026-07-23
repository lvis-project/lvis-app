




import { parseImportedTriggerEnvelope } from "../shared/overlay-trigger-source.js";
import { parseAppMessageEnvelope } from "../shared/mcp-app-message-source.js";

// ─── Types ──────────────────────────────────────────

export type InputClassification =
  | { type: "command"; command: string; args: string }
  | { type: "skill"; keyword: string; skillId: string; pluginId?: string; input: string }
  | { type: "general"; input: string };

export interface SkillKeyword {

  keyword: string;

  skillId: string;



  pluginId?: string;
}

type RegisteredSkillKeyword = SkillKeyword & { generationToken?: object };

// ─── Engine ─────────────────────────────────────────

export class KeywordEngine {
  private skillKeywords: RegisteredSkillKeyword[] = [];


  registerKeywords(keywords: SkillKeyword[]): void {
    this.skillKeywords.push(...keywords);
  }

  /** Atomically replace one plugin generation's routing entries. */
  publishPluginGeneration(pluginId: string, generationToken: object, keywords: SkillKeyword[]): void {
    const next = keywords.map((keyword) => ({ ...keyword, pluginId, generationToken }));
    this.skillKeywords = [
      ...this.skillKeywords.filter((keyword) => keyword.pluginId !== pluginId),
      ...next,
    ];
  }

  /** Remove only entries still owned by this exact generation. */
  removePluginGeneration(pluginId: string, generationToken: object): void {
    this.skillKeywords = this.skillKeywords.filter(
      (keyword) => keyword.pluginId !== pluginId || keyword.generationToken !== generationToken,
    );
  }


  clearKeywords(): void {
    this.skillKeywords = [];
  }


  unregisterByPlugin(pluginId: string): void {
    this.skillKeywords = this.skillKeywords.filter((sk) => sk.pluginId !== pluginId);
  }

  /** Whether this plugin currently contributes any keyword routing entries. */
  hasPluginKeywords(pluginId: string): boolean {
    return this.skillKeywords.some((sk) => sk.pluginId === pluginId);
  }




  matchAllPluginIds(input: string): Set<string> {
    const lowerInput = input.trim().toLowerCase();
    const result = new Set<string>();
    for (const sk of this.skillKeywords) {
      if (sk.pluginId && lowerInput.includes(sk.keyword.toLowerCase())) {
        result.add(sk.pluginId);
      }
    }
    return result;
  }




  matchToolNames(input: string, isToolName: (name: string) => boolean): Set<string> {
    const lowerInput = input.trim().toLowerCase();
    const result = new Set<string>();
    for (const sk of this.skillKeywords) {
      if (lowerInput.includes(sk.keyword.toLowerCase()) && isToolName(sk.skillId)) {
        result.add(sk.skillId);
      }
    }
    return result;
  }


  classify(input: string): InputClassification {
    const trimmed = input.trim();

    // 0. Staged-input envelope (plugin overlay trigger / MCP-app `ui/message`) —
    // bypass skill-keyword matching. Shares its pattern with ipc-bridge.ts's
    // originSource detection, the host gate, and the trigger executor's wrap (see
    // shared/overlay-trigger-source.ts + shared/mcp-app-message-source.ts) so all
    // gates agree on what counts as a valid envelope. Non-user-authored text must
    // not steer host routing.
    if (
      parseImportedTriggerEnvelope(trimmed) !== null ||
      parseAppMessageEnvelope(trimmed) !== null
    ) {
      return { type: "general", input: trimmed };
    }


    const cmdMatch = trimmed.match(/^\/(\S+)\s*(.*)?$/s);
    if (cmdMatch) {
      return {
        type: "command",
        command: cmdMatch[1],
        args: cmdMatch[2]?.trim() ?? "",
      };
    }


    const lowerInput = trimmed.toLowerCase();
    for (const sk of this.skillKeywords) {
      if (lowerInput.includes(sk.keyword.toLowerCase())) {
        return {
          type: "skill",
          keyword: sk.keyword,
          skillId: sk.skillId,
          pluginId: sk.pluginId,
          input: trimmed,
        };
      }
    }


    return { type: "general", input: trimmed };
  }
}
