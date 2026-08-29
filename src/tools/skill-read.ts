/**
 * `skill_read` — fetch ONE bundled resource of an already-loaded skill.
 *
 * Agent Skills stage-3: a skill may ship `references/`, `assets/` … beside its
 * SKILL.md. `skill_load` surfaces those files as an inert manifest inside the
 * `<lvis-skill>` overlay; this tool returns one file's bytes on demand, so a
 * large skill stays a small prompt footprint.
 *
 * Security model (bundled files are UNTRUSTED plugin/user content):
 *   - ACCESS: only skills already present in the CURRENT TURN's overlay are
 *     readable. Overlay membership means the skill passed `skill_load`'s
 *     body-hash approval gate, so approval is reused rather than re-invented —
 *     and the overlay is cleared at the user-turn boundary, so access expires.
 *   - CONTAINMENT: plugin resources resolve against frozen, sha256-verified
 *     in-memory bytes (zero filesystem access); user resources are realpath-
 *     contained inside the skill's own directory. Flat `<name>.md` skills are
 *     refused outright — their parent is the shared skills root, so treating it
 *     as a bundle root would let one approved skill read its siblings.
 *   - GENERATION: a plugin read re-acquires the generation lease and refuses
 *     when the live generation no longer matches the approved one.
 *   - DATA ONLY: content is returned as a `tool_result` (the same channel as
 *     any file read) and is NEVER executed, and never enters the trusted
 *     system-prompt overlay.
 */
import { t } from "../i18n/index.js";
import { createDynamicTool, type Tool } from "./base.js";
import type { SkillStore } from "../main/skill-store.js";
import { SKILL_SELECTOR_ALLOWLIST } from "../main/skill-store.js";
import type { SkillOverlay } from "../main/skill-overlay.js";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
const log = createLogger("lvis");

export interface SkillReadToolDeps {
  store: SkillStore;
  /** Current-turn overlay — the ACCESS CONTROL surface (loaded ⇒ approved). */
  overlay: SkillOverlay;
  /** Generation lease for plugin-owned skills; absent ⇒ plugin reads refuse. */
  acquirePluginGeneration?: (
    owner: { pluginId: string; localId: string },
  ) => Promise<{
    generation: import("../plugins/plugin-generation-coordinator.js").ActivePluginGeneration;
    release(): void;
  }>;
}

function errorResult(message: string): { output: string; isError: true } {
  return { output: JSON.stringify({ error: message }), isError: true };
}

export function createSkillReadTool(deps: SkillReadToolDeps): Tool {
  return createDynamicTool({
    name: "skill_read",
    description: t("be_skillRead.toolDescription"),
    source: "builtin",
    // Pure read: no filesystem mutation and — unlike `skill_load` — no mutation
    // of the model's trusted system prompt either. The content lands in a
    // tool_result, so it needs no approval prompt of its own; the gate is that
    // the owning skill was already approved and loaded.
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["skillName", "resourcePath"],
      properties: {
        skillName: {
          type: "string",
          description: t("be_skillRead.skillNameDescription"),
        },
        resourcePath: {
          type: "string",
          description: t("be_skillRead.resourcePathDescription"),
        },
      },
    },
    execute: async (rawInput, ctx) => {
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const skillName = typeof a.skillName === "string" ? a.skillName.trim() : "";
      const resourcePath = typeof a.resourcePath === "string" ? a.resourcePath.trim() : "";
      if (!skillName || !resourcePath) {
        return errorResult("skillName and resourcePath are required");
      }
      if (!SKILL_SELECTOR_ALLOWLIST.test(skillName)) {
        return errorResult(`invalid skillName: must match ${SKILL_SELECTOR_ALLOWLIST.source}`);
      }
      const sessionId =
        typeof ctx.metadata?.sessionId === "string" && ctx.metadata.sessionId
          ? (ctx.metadata.sessionId as string)
          : "";
      if (!sessionId) {
        return errorResult("skill_read: missing sessionId in tool execution context");
      }

      // ACCESS CONTROL: the skill must be loaded for THIS session's current
      // turn (⇒ it passed skill_load's approval gate). Nothing else grants read.
      const entry = deps.overlay.list(sessionId).find((candidate) => candidate.name === skillName);
      if (!entry) {
        return errorResult(`skill not loaded: call skill_load({ skillName: "${skillName}" }) first`);
      }
      // The manifest captured at load time is the AUTHORIZED set, so the
      // discovery caps are real access bounds rather than display limits.
      // (The rendered overlay list is byte-capped separately, so what the model
      // is SHOWN can be a subset of this set — never a superset.)
      if (!entry.resources.some((resource) => resource.path === resourcePath)) {
        return errorResult(`resource not listed for ${skillName}: ${resourcePath}`);
      }

      const selectorMatch = /^plugin:([^:]+):([^:]+)$/.exec(skillName);
      try {
        if (selectorMatch) {
          if (!deps.acquirePluginGeneration) {
            return errorResult("skill_read: plugin generation access unavailable");
          }
          const lease = await deps.acquirePluginGeneration({
            pluginId: selectorMatch[1],
            localId: selectorMatch[2],
          });
          try {
            // Refuse a cross-generation read: the approval that admitted this
            // skill was bound to the generation recorded in the overlay.
            const owner = entry.pluginOwner;
            // Fail CLOSED: a plugin-shaped selector without a recorded owner has
            // no approved generation to compare against, so it is not readable.
            if (
              !owner ||
              lease.generation.generationId !== owner.generationId ||
              lease.generation.pluginVersion !== owner.pluginVersion
            ) {
              return errorResult("skill generation changed since load; call skill_load again");
            }
            const resource = deps.store.readPluginResource(
              lease.generation,
              skillName,
              resourcePath,
            );
            if (!resource) return errorResult(`resource not found: ${resourcePath}`);
            return {
              output: JSON.stringify({ skillName, ...resource }),
              isError: false,
            };
          } finally {
            lease.release();
          }
        }

        // Read against the identity captured at approval time — NOT a fresh
        // name lookup: re-resolving `skillName` from disk would let a mid-turn
        // file swap (or a newly-created ambiguous sibling) redirect a read the
        // user authorized against a different file, and would re-run the bundle
        // scan on every call.
        const resource = await deps.store.readUserResource(
          { filePath: entry.filePath, pluginOwner: entry.pluginOwner },
          resourcePath,
        );
        return {
          output: JSON.stringify({ skillName, ...resource }),
          isError: false,
        };
      } catch (err) {
        const message = errorMessage(err);
        log.warn(`skill_read rejected ${skillName}/${resourcePath}: %s`, message);
        return errorResult(message);
      }
    },
  });
}
