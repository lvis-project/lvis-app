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
import { escapeHtml } from "../shared/escape-html.js";

export interface SkillOverlayEntry {
  name: string;
  body: string;
  pluginOwner?: LoadedSkill["pluginOwner"];
  /**
   * Bundled resources declared by the loaded skill (stage-3). Rendered as an
   * inert manifest so the model knows what it may fetch with `skill_read`;
   * contents never live here. This list is also the AUTHORIZED set: `skill_read`
   * serves only what was listed at load time.
   */
  resources: LoadedSkill["resources"];
  /**
   * Canonical SKILL.md path resolved when the skill was approved and loaded.
   * `skill_read` resolves user-skill resources against THIS identity instead of
   * re-resolving the name from disk, so a mid-turn file swap cannot redirect a
   * read that the user authorized against a different file.
   */
  filePath: string;
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
      resources: skill.resources,
      filePath: skill.filePath,
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
   * only the `name` attribute went through `escapeHtml`. A malicious body
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
      lines.push(`<lvis-skill name="${escapeHtml(e.name)}">`);
      lines.push(neutralizeSkillFence(e.body));
      if (e.resources.length > 0) {
        // Inert manifest: names only, so the model knows what it can fetch with
        // `skill_read`. Fence integrity rests on the DISCOVERY-side validator
        // (`isSafeResourcePath` rejects control chars, `<`, `>`, `\`, `:`), which is
        // the single chokepoint — paths are deliberately NOT re-escaped here,
        // because escaping would rewrite legitimate names into ones the authorized
        // set does not contain.
        //
        // Bounded separately from the body: the manifest shares the fence with an
        // 8 KB-capped body, and an attacker-chosen filename list must not become a
        // bigger injection budget than the body it accompanies.
        const manifest: string[] = [];
        let manifestChars = 0;
        let omitted = 0;
        for (const resource of e.resources) {
          // NOT escapeHtml: this is fence body text, not an attribute, and
          // escaping would rewrite a legitimate `Q&A.md` into `Q&amp;A.md` —
          // which `skill_read` then refuses as "not listed", leaving the model
          // with a name it can never fetch. `<`/`>`/control chars are already
          // rejected at discovery (`isSafeResourcePath`), so listed == fetchable.
          const line = `- ${resource.path} (${resource.bytes} bytes)`;
          if (manifestChars + line.length > MAX_MANIFEST_CHARS) {
            omitted += 1;
            continue;
          }
          manifestChars += line.length;
          manifest.push(line);
        }
        if (manifest.length > 0) {
          lines.push("");
          lines.push("bundled resources (fetch with skill_read):");
          lines.push(...manifest);
          if (omitted > 0) lines.push(`- …and ${omitted} more (not listed)`);
        }
      }
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

/**
 * LOW (skill fence neutralization): neutralize literal `<lvis-skill …>` and
 * `</lvis-skill>` patterns inside the body so an attacker-controlled skill
 * cannot break out of its envelope. We insert a zero-width space (U+200B)
 * after the opening `<` so the rendered text remains visually identical (and
 * semantically intact for an LLM reading the prompt) while no longer matching
 * a parser looking for the fence tags. Whitespace tolerance is applied so
 * `< /lvis-skill >` and similar variants are also caught.
 */
/** Total characters the bundled-resource manifest may add inside one fence. */
const MAX_MANIFEST_CHARS = 2048;

const SKILL_FENCE_PATTERN = /<(\s*\/?\s*lvis-skill[^>]*)>/gi;
const ZWSP = "​";
function neutralizeSkillFence(body: string): string {
  return body.replace(SKILL_FENCE_PATTERN, `<${ZWSP}$1>`);
}
