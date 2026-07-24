




import { parseImportedTriggerEnvelope } from "../shared/overlay-trigger-source.js";
import { parseAppMessageEnvelope } from "../shared/mcp-app-message-source.js";

// ─── Types ──────────────────────────────────────────

export type InputClassification =
  | { type: "command"; command: string; args: string }
  | { type: "skill"; keyword: string; skillId: string; pluginId?: string; input: string }
  | { type: "general"; input: string };

export interface SkillKeyword {
  /** Case-insensitive substring that can activate plugin scope and tool preload. */
  keyword: string;
  /**
   * Exact model-visible Tool name to preload when this keyword matches.
   *
   * @deprecated Owner: `lvis-app` plugin runtime. Remove after every supported
   * plugin has migrated to bundled `manifest.skills` and no active manifest
   * declares `keywords`.
   */
  skillId: string;



  pluginId?: string;
}

type RegisteredSkillKeyword = SkillKeyword & { generationToken?: object };

interface PluginKeywordSlot {
  current?: readonly RegisteredSkillKeyword[];
}

export interface PreparedPluginKeywordGeneration {
  publish(): void;
}

// ─── Engine ─────────────────────────────────────────

export class KeywordEngine {
  private skillKeywords: RegisteredSkillKeyword[] = [];
  private readonly pluginKeywordSlots = new Map<string, PluginKeywordSlot>();

  private *keywords(): Iterable<RegisteredSkillKeyword> {
    yield* this.skillKeywords;
    for (const slot of this.pluginKeywordSlots.values()) {
      if (slot.current) yield* slot.current;
    }
  }


  registerKeywords(keywords: SkillKeyword[]): void {
    this.skillKeywords.push(...keywords);
  }

  /** Atomically replace one plugin generation's routing entries. */
  publishPluginGeneration(pluginId: string, generationToken: object, keywords: SkillKeyword[]): void {
    this.preparePluginGeneration(pluginId, generationToken, keywords).publish();
  }

  /**
   * Allocate and validate the complete keyword projection before the bundle
   * commit. Publication itself is one preallocated slot assignment, so another
   * plugin publishing concurrently cannot be overwritten by a stale snapshot.
   */
  preparePluginGeneration(
    pluginId: string,
    generationToken: object,
    keywords: SkillKeyword[],
  ): PreparedPluginKeywordGeneration {
    let slot = this.pluginKeywordSlots.get(pluginId);
    if (!slot) {
      slot = {};
      this.pluginKeywordSlots.set(pluginId, slot);
    }
    const prepared = Object.freeze(
      keywords.map((keyword) => Object.freeze({ ...keyword, pluginId, generationToken })),
    );
    let published = false;
    return Object.freeze({
      publish: () => {
        if (published) return;
        slot.current = prepared;
        published = true;
      },
    });
  }

  /** Remove only entries still owned by this exact generation. */
  removePluginGeneration(pluginId: string, generationToken: object): void {
    const slot = this.pluginKeywordSlots.get(pluginId);
    if (slot?.current?.some((keyword) => keyword.generationToken === generationToken)) {
      slot.current = undefined;
    }
  }


  clearKeywords(): void {
    this.skillKeywords = [];
    for (const slot of this.pluginKeywordSlots.values()) slot.current = undefined;
  }


  unregisterByPlugin(pluginId: string): void {
    this.skillKeywords = this.skillKeywords.filter((sk) => sk.pluginId !== pluginId);
    const slot = this.pluginKeywordSlots.get(pluginId);
    if (slot) slot.current = undefined;
  }

  /** Whether this plugin currently contributes any keyword routing entries. */
  hasPluginKeywords(pluginId: string): boolean {
    for (const keyword of this.keywords()) {
      if (keyword.pluginId === pluginId) return true;
    }
    return false;
  }




  matchAllPluginIds(input: string): Set<string> {
    const lowerInput = input.trim().toLowerCase();
    const result = new Set<string>();
    for (const sk of this.keywords()) {
      if (sk.pluginId && lowerInput.includes(sk.keyword.toLowerCase())) {
        result.add(sk.pluginId);
      }
    }
    return result;
  }




  /**
   * Return the exact Tool names selected by matching keyword entries.
   *
   * The caller supplies the current model-visible, plugin-scoped membership
   * predicate, so a stale or dynamically registered `skillId` cannot widen the
   * turn scope. This method selects tool schemas for the model; it never invokes
   * a Tool.
   */
  matchToolNames(input: string, isToolName: (name: string) => boolean): Set<string> {
    const lowerInput = input.trim().toLowerCase();
    const result = new Set<string>();
    for (const sk of this.keywords()) {
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
    for (const sk of this.keywords()) {
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
