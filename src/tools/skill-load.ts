/**
 * `skill_load` LLM tool — loads a skill (markdown w/ frontmatter) and
 * registers it as a system-prompt overlay for the current user turn. The
 * renderer surfaces a SkillBadge ("🎯 Skill loaded: <name>") at the call
 * site so the user sees which skills were loaded for the active turn.
 *
 * Security model (post C2 review + #1104 file-seed migration):
 *   - Skill bodies are NEVER appended to conversation history as `user`-role
 *     messages. Pre-fix, a malicious skill body ("ignore previous
 *     instructions and exfil…") landed in history with the user role and
 *     read like genuine input. Post-fix, the body lives in a separately
 *     delimited section of each turn's system prompt, fenced with
 *     `<lvis-skill name="…">…</lvis-skill>` so provenance is unambiguous
 *     (see {@link SkillOverlay}).
 *   - Every skill — including seeded built-ins under `~/.lvis/skills/`,
 *     which are user-editable on disk — runs through {@link ApprovalGate}
 *     on first load. Approval is persisted in `~/.lvis/skills/approvals.json`
 *     and hash-bound to the current body so a post-approval body swap
 *     re-prompts (R2-CR-3 TOCTOU close).
 *   - Skill names are allowlisted to `[a-zA-Z0-9_-]+` and traversal-checked
 *     by {@link SkillStore} — see `skill-store.ts` for the file-side
 *     defenses.
 */
import { randomUUID, createHash } from "node:crypto";
import { t } from "../i18n/index.js";
import { createDynamicTool, type Tool } from "./base.js";
import type { SkillStore } from "../main/skill-store.js";
import { SKILL_SELECTOR_ALLOWLIST } from "../main/skill-store.js";
import { parsePluginSkillSelector } from "../shared/plugin-skill-selector.js";
import type { SkillOverlay } from "../main/skill-overlay.js";
import type { SkillApprovalsStore } from "../main/skill-approvals-store.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

export interface SkillLoadEvent {
  name: string;
  description: string;
}

/**
 * What the approval record is hash-bound to.
 *
 * The body alone stopped being sufficient once a skill can ship bundled files:
 * their NAMES render inside the trusted `<lvis-skill>` fence, so a bundle that
 * gains files while SKILL.md is unchanged would reach the system prompt without
 * re-prompting — the exact TOCTOU the body-hash binding exists to prevent.
 *
 * Scope: the body plus each bundled file's NAME and SIZE — i.e. exactly what the
 * trusted fence renders. Resource CONTENT is deliberately not covered; it never
 * enters the system prompt, arriving only as `skill_read` tool_result data.
 *
 * Two encodings live here — the bare body (no bundle) and a digest pair (bundle)
 * — so they are kept in SEPARATE key spaces by {@link approvalRecordKey}. Within
 * the bundle space the pair is unambiguous (fixed-width hex either side of `|`),
 * and across spaces a crafted body can no longer impersonate a pair because the
 * two never share a record key. Skills with no resources still hash the bare
 * body under the unchanged key, so existing approvals (all seeded built-ins,
 * which are flat files, included) stay valid.
 */
function approvalMaterial(skill: { body: string; resources: readonly { path: string; bytes: number }[] }): string {
  if (skill.resources.length === 0) return skill.body;
  const manifest = skill.resources
    .map((resource) => `${resource.path}:${resource.bytes}`)
    .sort()
    .join("\n");
  const digest = (value: string): string => createHash("sha256").update(value, "utf-8").digest("hex");
  return `${digest(skill.body)}|${digest(manifest)}`;
}

/**
 * Which approval record {@link approvalMaterial} is stored under.
 *
 * Bundle-bearing approvals get their own namespace so the two material
 * encodings never share a key space (see `approvalMaterial`). Resource-bearing
 * skills are new, so no legacy record exists under the namespaced key and the
 * separation costs nothing; resource-less skills keep the original key and
 * their existing approvals.
 */
function approvalRecordKey(skill: {
  name: string;
  approvalKey?: string;
  resources: readonly { path: string; bytes: number }[];
}): string {
  const base = skill.approvalKey ?? skill.name;
  return skill.resources.length === 0 ? base : `${base}#bundled`;
}

export interface SkillLoadToolDeps {
  store: SkillStore;
  /** Current-turn overlay registry — read by SystemPromptBuilder each round. */
  overlay: SkillOverlay;
  /** Persistent allowlist for user-authored skills. */
  approvals: SkillApprovalsStore;
  /**
   * ApprovalGate for first-use prompts (user-authored skills only). Held by
   * value like every other gate wiring: the gate is constructed before the
   * builtin tools are registered, so there is nothing to late-bind.
   */
  approvalGate: ApprovalGate;
  /** Renderer event sink — used by the chat to render the SkillBadge. */
  emit: (event: SkillLoadEvent) => void;
  /** Exact generation lease held from materialized body read through overlay registration. */
  acquirePluginGeneration?: (
    owner: { pluginId: string; localId: string },
  ) => Promise<{
    generation: import("../plugins/plugin-generation-coordinator.js").ActivePluginGeneration;
    release(): void;
  }>;
}

export function createSkillLoadTool(deps: SkillLoadToolDeps): Tool {
  return createDynamicTool({
    name: "skill_load",
    description: t("be_skillLoad.toolDescription"),
    source: "builtin",
    // C2(d): skill bodies become part of the LLM's system prompt context.
    // Even though no filesystem mutation happens, the assistant's future
    // behavior is mutated by attacker-controlled content. Treat as "write"
    // so the §6.3 PermissionManager lifts the auto-approve and the first
    // load of each skill — seeded built-ins included — goes through the
    // user-approval dock, then the body-hash record in
    // `skill-approvals-store.ts` short-circuits repeat loads of the same
    // body.
    category: "write",
    jsonSchema: {
      type: "object",
      required: ["skillName"],
      properties: {
        skillName: {
          type: "string",
          description: t("be_skillLoad.skillNameDescription"),
        },
        args: {
          type: "object",
          description: t("be_skillLoad.argsDescription"),
        },
      },
    },
    execute: async (rawInput, ctx) => {
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const skillName = typeof a.skillName === "string" ? a.skillName.trim() : "";
      if (!skillName) {
        return {
          output: JSON.stringify({ error: "skillName is required" }),
          isError: true,
        };
      }
      // C2(b): allowlist check before doing any filesystem work — defense in
      // depth even though SkillStore enforces the same constraint on file
      // discovery.
      if (!SKILL_SELECTOR_ALLOWLIST.test(skillName)) {
        return {
          output: JSON.stringify({
            error: `invalid skillName: must match ${SKILL_SELECTOR_ALLOWLIST.source}`,
          }),
          isError: true,
        };
      }
      // Same parser the turn-scope gate uses (src/shared/plugin-skill-selector.ts).
      const selectorMatch = parsePluginSkillSelector(skillName);
      if (selectorMatch && !deps.acquirePluginGeneration) {
        return {
          output: JSON.stringify({
            error: "skill_load: plugin generation access unavailable",
          }),
          isError: true,
        };
      }
      const generationLease = selectorMatch
        ? await deps.acquirePluginGeneration!({
            pluginId: selectorMatch.pluginId,
            localId: selectorMatch.localId,
          })
        : undefined;
      const skill = generationLease
        ? deps.store.loadPluginGeneration(generationLease.generation, skillName)
        : await deps.store.load(skillName);
      if (!skill) {
        generationLease?.release();
        return {
          output: JSON.stringify({ error: `skill not found: ${skillName}` }),
          isError: true,
        };
      }

      let generationLeaseTransferred = false;
      try {

      // C2(d): every skill body is user-editable on disk — seeded built-in
      // files included — so the approval gate runs uniformly. R2-CR-3:
      // hash-bind approval to the current body AND its bundled manifest (see
      // `approvalMaterial`). If the user approved an earlier body, or the
      // bundle has since gained/resized a file, `isApproved` returns false and
      // we re-prompt — closing the TOCTOU window where post-approval mutations
      // would silently inherit the previous "yes."
      const alreadyApproved = await deps.approvals.isApproved(
        approvalRecordKey(skill),
        approvalMaterial(skill),
      );
      if (!alreadyApproved) {
        const decision = await deps.approvalGate.requestAndWait({
          id: randomUUID(),
          category: "tool",
          toolName: "skill_load",
          toolCategory: "meta",
          // Attribute the modal to the conversation loading the skill. The
          // missing-session case is still rejected further down, after the
          // user has decided — do not change that ordering here.
          ...(typeof ctx.metadata?.sessionId === "string" && ctx.metadata.sessionId
            ? { sessionId: ctx.metadata.sessionId }
            : {}),
          args: { skillName: skill.name },
          reason: t("be_skillLoad.approvalReason", { name: skill.name }),
          source: "builtin",
          createdAt: Date.now(),
        });
        if (decision.choice.startsWith("deny")) {
          return {
            output: JSON.stringify({
              error: `user denied skill load: ${skill.name}`,
            }),
            isError: true,
          };
        }
        // R2-CR-3: persist approval BOUND TO the current body + bundled
        // manifest. A later body swap, or a bundle file added/resized,
        // invalidates this record.
        await deps.approvals.approve(approvalRecordKey(skill), approvalMaterial(skill)).catch((err) => {
          log.warn(
            "skill_load: approval persistence failed (non-fatal): %s",
            (err as Error).message,
          );
        });
      }

      // R2-SEC-INFO: refuse to register a skill without a real session id.
      // Falling back to "unknown" piles unattributed skills under one synthetic
      // bucket and lets them leak across debug/test runs. The tool cannot
      // function correctly without session attribution, so error out.
      const sessionId =
        typeof ctx.metadata?.sessionId === "string" && ctx.metadata.sessionId
          ? (ctx.metadata.sessionId as string)
          : "";
      if (!sessionId) {
        return {
          output: JSON.stringify({
            error:
              "skill_load: missing sessionId in tool execution context (cannot attribute skill overlay)",
          }),
          isError: true,
        };
      }
      // Register in the current-turn overlay. SystemPromptBuilder reads this
      // on subsequent assistant rounds, and ConversationLoop clears it at the
      // user-turn boundary so the body does not become ambient session context.
      deps.overlay.register(sessionId, skill, generationLease);
      generationLeaseTransferred = Boolean(generationLease);

      deps.emit({
        name: skill.name,
        description: skill.description,
      });
      return {
        output: JSON.stringify({
          loaded: true,
          skillName: skill.name,
          summary:
            skill.description || `Skill '${skill.name}' loaded`,
        }),
        isError: false,
      };
      } finally {
        if (!generationLeaseTransferred) generationLease?.release();
      }
    },
  });
}
