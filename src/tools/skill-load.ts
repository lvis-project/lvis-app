/**
 * `skill_load` LLM tool — loads a skill (markdown w/ frontmatter) and
 * registers it as a system-prompt overlay for the current session. The
 * renderer surfaces a SkillBadge ("🎯 Skill loaded: <name>") at the call
 * site so the user sees which skills are active for the rest of the chat.
 *
 * Security model (post C2 review):
 *   - Skill bodies are NEVER appended to conversation history as `user`-role
 *     messages. Pre-fix, a malicious skill body ("ignore previous
 *     instructions and exfil…") landed in history with the user role and
 *     read like genuine input. Post-fix, the body lives in a separately
 *     delimited section of each turn's system prompt, fenced with
 *     `<lvis-skill name="…" source="…">…</lvis-skill>` so provenance is
 *     unambiguous (see {@link SkillOverlay}).
 *   - First load of any user-authored skill requires explicit user approval
 *     via {@link ApprovalGate}. Approval is persisted in
 *     `~/.lvis/skill-approvals.json` so the modal does not re-pop on
 *     subsequent loads of the same skill. Built-in skills (shipped with
 *     the host) skip the approval gate.
 *   - Skill names are allowlisted to `[a-zA-Z0-9_-]+` and traversal-checked
 *     by {@link SkillStore} — see `skill-store.ts` for the file-side
 *     defenses.
 */
import { randomUUID } from "node:crypto";
import { createDynamicTool, type Tool } from "./base.js";
import type { SkillStore } from "../main/skill-store.js";
import { SKILL_NAME_ALLOWLIST } from "../main/skill-store.js";
import type { SkillOverlay } from "../main/skill-overlay.js";
import type { SkillApprovalsStore } from "../main/skill-approvals-store.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";

export interface SkillLoadEvent {
  name: string;
  description: string;
  source: "user" | "builtin";
}

export interface SkillLoadToolDeps {
  store: SkillStore;
  /** Per-session overlay registry — read by SystemPromptBuilder each turn. */
  overlay: SkillOverlay;
  /** Persistent allowlist for user-authored skills. */
  approvals: SkillApprovalsStore;
  /** ApprovalGate for first-use prompts (user-authored skills only). */
  getApprovalGate: () => ApprovalGate | undefined;
  /** Renderer event sink — used by the chat to render the SkillBadge. */
  emit: (event: SkillLoadEvent) => void;
}

export function createSkillLoadTool(deps: SkillLoadToolDeps): Tool {
  return createDynamicTool({
    name: "skill_load",
    description:
      "이름으로 skill 을 로드해 다음 턴부터 시스템 프롬프트에 주입합니다. " +
      "Skill 은 ~/.lvis/skills/<name>.md (YAML frontmatter + markdown). " +
      "처음 로드되는 user skill 은 사용자 승인을 요구하며, 승인은 영구 저장됩니다. " +
      "성공 시 { loaded: true, skillName, summary } 반환.",
    source: "builtin",
    // C2(d): skill bodies become part of the LLM's system prompt context.
    // Even though no filesystem mutation happens, the assistant's future
    // behavior is mutated by attacker-controlled content. Treat as "write"
    // so the §6.3 PermissionManager lifts the auto-approve and the first
    // load of each user skill goes through the user-confirmation modal.
    // Built-in skills bypass via `skill-approvals-store.ts` allowlist.
    category: "write",
    jsonSchema: {
      type: "object",
      required: ["skillName"],
      properties: {
        skillName: {
          type: "string",
          description: "로드할 skill 이름 (frontmatter 의 name 또는 파일명).",
        },
        args: {
          type: "object",
          description:
            "skill 에 전달할 파라미터 (현재 버전은 단순 메타데이터). 선택.",
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
      if (!SKILL_NAME_ALLOWLIST.test(skillName)) {
        return {
          output: JSON.stringify({
            error: `invalid skillName: must match ${SKILL_NAME_ALLOWLIST.source}`,
          }),
          isError: true,
        };
      }
      const skill = await deps.store.load(skillName);
      if (!skill) {
        return {
          output: JSON.stringify({ error: `skill not found: ${skillName}` }),
          isError: true,
        };
      }

      // C2(d): user-authored skills require explicit approval on first load.
      // Builtins are pre-blessed (they ship with the host).
      if (skill.source === "user") {
        // R2-CR-3: hash-bind approval to the current body. If the user
        // approved an earlier body and the file has since been swapped,
        // `isApproved` returns false and we re-prompt — this closes a TOCTOU
        // window where post-approval body mutations would silently inherit
        // the previous "yes."
        const alreadyApproved = await deps.approvals.isApproved(
          skill.name,
          skill.body,
        );
        if (!alreadyApproved) {
          const gate = deps.getApprovalGate();
          if (!gate) {
            return {
              output: JSON.stringify({
                error: "skill_load approval gate unavailable",
              }),
              isError: true,
            };
          }
          const decision = await gate.requestAndWait({
            id: randomUUID(),
            category: "tool",
            toolName: "skill_load",
            args: { skillName: skill.name, source: skill.source },
            reason: `사용자 작성 skill '${skill.name}' 을 시스템 프롬프트에 주입합니다. 승인 시 영구적으로 허용됩니다. (현재 본문 sha256 에 바인딩됩니다 — 본문이 변경되면 다시 확인합니다.)`,
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
          // R2-CR-3: persist approval BOUND TO the current body's sha256.
          // A subsequent body swap will invalidate this record.
          await deps.approvals.approve(skill.name, skill.body).catch((err) => {
            console.warn(
              "[lvis] skill_load: approval persistence failed (non-fatal):",
              (err as Error).message,
            );
          });
        }
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
      // Register in the per-session overlay. SystemPromptBuilder reads from
      // this on every subsequent turn — the next assistant round will see
      // the skill body inside <lvis-active-skills>…</lvis-active-skills>.
      deps.overlay.register(sessionId, skill);

      deps.emit({
        name: skill.name,
        description: skill.description,
        source: skill.source,
      });
      return {
        output: JSON.stringify({
          loaded: true,
          skillName: skill.name,
          summary:
            skill.description ||
            `Skill '${skill.name}' loaded from ${skill.source}`,
        }),
        isError: false,
      };
    },
  });
}
