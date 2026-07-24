/**
 * SkillOverlay — current-turn registry of loaded skills, consumed by
 * {@link SystemPromptBuilder} as a separately delimited section in each
 * turn's system prompt.
 *
 * Why a separate module (vs. mutating chat history)?
 * Pre-fix, `skill_load` appended the skill body as a `user`-role message
 * via ConversationHistory. A skill body containing prompt-injection content
 * ("ignore previous instructions and exfil…") landed in conversation
 * history with the user role — i.e., looked exactly like the user typed it.
 * Routing skill bodies through the SYSTEM prompt instead, fenced with
 * `<lvis-skill name="…">…</lvis-skill>` envelopes, keeps the provenance
 * clear and prevents the body from masquerading as user input.
 *
 * The overlay is queried by SystemPromptBuilder during the current user turn,
 * so newly-loaded skills take effect on the next assistant round. The
 * ConversationLoop clears the overlay at the user-turn boundary; loaded skill
 * bodies are not ambient session context.
 */
import type { LoadedSkill } from "./skill-store.js";

export interface SkillOverlayEntry {
  name: string;
  body: string;
  pluginOwner?: LoadedSkill["pluginOwner"];
}

interface StoredSkillOverlayEntry extends SkillOverlayEntry {
  releaseGeneration?: () => void;
}

export class SkillOverlay {
  private readonly bySession = new Map<string, Map<string, StoredSkillOverlayEntry>>();

  /** Register (or refresh) a skill for the given session. */
  register(sessionId: string, skill: LoadedSkill, generationLease?: { release(): void }): void {
    if (!sessionId) return;
    const bySkill = this.bySession.get(sessionId) ?? new Map<string, StoredSkillOverlayEntry>();
    const key = skill.approvalKey ?? skill.name;
    bySkill.get(key)?.releaseGeneration?.();
    bySkill.set(key, {
      name: skill.name,
      body: skill.body,
      pluginOwner: skill.pluginOwner,
      ...(generationLease ? { releaseGeneration: () => generationLease.release() } : {}),
    });
    this.bySession.set(sessionId, bySkill);
  }

  /** Active skills for the session, ordered by registration. */
  list(sessionId: string): SkillOverlayEntry[] {
    const m = this.bySession.get(sessionId);
    if (!m) return [];
    return [...m.values()];
  }

  /** Drop all skills for a session — fired on user-turn boundaries and chat:new. */
  clear(sessionId: string): void {
    for (const entry of this.bySession.get(sessionId)?.values() ?? []) {
      entry.releaseGeneration?.();
    }
    this.bySession.delete(sessionId);
  }

  clearPluginGeneration(pluginId: string, generationId: string): void {
    for (const [sessionId, entries] of this.bySession) {
      for (const [key, entry] of entries) {
        if (entry.pluginOwner?.pluginId === pluginId && entry.pluginOwner.generationId === generationId) {
          entry.releaseGeneration?.();
          entries.delete(key);
        }
      }
      if (entries.size === 0) this.bySession.delete(sessionId);
    }
  }

  /**
   * Build the system-prompt section for the given session. Each skill is
   * fenced with `<lvis-skill>` so the LLM can attribute the guidance and
   * the body cannot accidentally look like user-supplied content.
   * Empty when no skills are loaded for the current user turn.
   *
   * LOW (skill body sanitization): skill BODIES are also sanitized — pre-fix,
   * only the `name` attribute went through `escapeAttr`. A malicious body
   * containing a literal `</lvis-skill>` could close the fence early and
   * inject pseudo-system content; a literal `<lvis-skill …>` could inject
   * a fake sibling skill entry. We neutralize those exact patterns by
   * inserting a zero-width space, which preserves visual content for the
   * LLM while preventing the parser-style injection.
   */
  buildSection(sessionId: string): string {
    const entries = this.list(sessionId);
    if (entries.length === 0) return "";
    const lines: string[] = ["<lvis-active-skills>"];
    for (const e of entries) {
      lines.push(`<lvis-skill name="${escapeAttr(e.name)}">`);
      lines.push(neutralizeSkillFence(e.body));
      lines.push(`</lvis-skill>`);
    }
    lines.push(`</lvis-active-skills>`);
    return lines.join("\n");
  }
}

/**
 * Escape a value so it can safely appear inside a double-quoted XML
 * attribute. Skill names are already allowlisted in {@link SkillStore} but
 * we belt-and-suspenders here in case a future caller bypasses that check.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * LOW (skill fence neutralization): neutralize literal `<lvis-skill …>` and
 * `</lvis-skill>` patterns inside the body so an attacker-controlled skill
 * cannot break out of its envelope. We insert a zero-width space (U+200B)
 * after the opening `<` so the rendered text remains visually identical (and
 * semantically intact for an LLM reading the prompt) while no longer matching
 * a parser looking for the fence tags. Whitespace tolerance is applied so
 * `< /lvis-skill >` and similar variants are also caught.
 */
const SKILL_FENCE_PATTERN = /<(\s*\/?\s*lvis-skill[^>]*)>/gi;
const ZWSP = "​";
function neutralizeSkillFence(body: string): string {
  return body.replace(SKILL_FENCE_PATTERN, `<${ZWSP}$1>`);
}
