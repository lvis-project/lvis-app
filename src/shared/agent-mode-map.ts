/**
 * Single source of truth for agent-profile **mode** → behavior config +
 * auto-skill mapping, consumed by `SubAgentRunner` when an agent profile
 * declares a `mode:` in its frontmatter.
 *
 * A mode answers "what kind of work does this sub-agent do, and which
 * skills naturally come with it?" The four staff-facing builtin agents
 * map one-to-one onto the four modes:
 *   - executor  → execute   (produce office artifacts)
 *   - planner   → plan      (analysis / multi-step planning)
 *   - researcher→ research   (external evidence gathering)
 *   - explorer  → explore   (local file/email lookup)
 *
 * Why a separate SOT (vs. baking it into agent-profile-store):
 *   - agent-profile-store parses files off disk; it must not carry
 *     opinions about what each mode *means*. This file is that opinion,
 *     and a plugin shipping new agent profiles can reference these mode
 *     names without the store growing mode-specific branches.
 *
 * Design-intent fallback (per LVIS root CLAUDE.md "No Fallback Code"):
 *   - `resolveAgentMode` returns the `default` config for an unknown or
 *     absent mode and the caller logs "unknown mode" so the audit trail
 *     captures the gap. `default` is the design-intent safety path — not
 *     a legacy alias — chosen so a profile with a typo'd mode still runs
 *     (with no auto-skills) instead of failing the spawn.
 *
 * Auto-skill SECURITY MODEL (the load-bearing decision for #1113):
 *   - LVIS gates EVERY skill behind a body-hash approval (see
 *     skill-load.ts + skill-approvals-store.ts). A mode that force-loaded
 *     skills into the system prompt would BYPASS that gate — a security
 *     regression. So `autoSkills` is a *recommendation list*, never a
 *     force-load. SubAgentRunner does NOT register anything into the child
 *     SkillOverlay from a mode: `buildModePreamble` only emits a
 *     `<lvis-agent-mode-skills>` text block naming the candidates and
 *     telling the LLM to call `skill_load` itself — which runs the normal
 *     body-hash approval modal. The gate is therefore fully preserved; a
 *     skill body is only ever injected after the user approves it through
 *     `skill_load`, exactly as for a manually requested skill. The
 *     ergonomic win is that the agent's mode surfaces the right skills so
 *     the user/LLM does not have to hunt for them.
 *
 * Cross-importer boundary:
 *   - Imported by `SubAgentRunner` (engine). Pure / browser-safe — no
 *     Electron / Node imports.
 */

import { t } from "../i18n/index.js";

/**
 * Behavior knobs a mode can tune. Intentionally small: LVIS removed
 * per-vendor `temperature` / `maxOutputTokens` sampling params (see
 * llm-vendor-defaults.ts CHANGELOG — modern frontier models ignore them),
 * so a mode does NOT carry a temperature. `reasoningHint` is injected into
 * the sub-agent's instructions so the LLM knows the working posture
 * expected of this mode; `maxToolRoundsHint` is a soft suggestion the
 * spawn caller may use to seed the host round budget when no explicit
 * `maxRounds` override is provided.
 */
export interface AgentModeConfig {
  /** One-line working-posture hint injected into the sub-agent prompt. */
  reasoningHint: string;
  /**
   * Candidate skill names (must match seeded builtin skills under
   * `~/.lvis/skills/`). Surfaced to the sub-agent as a recommendation only
   * (never auto-registered); the LLM calls `skill_load` to load one, which
   * runs the normal body-hash approval modal. See the SECURITY MODEL note.
   */
  autoSkills: readonly string[];
  /**
   * Soft default for the host round budget when no explicit maxRounds is
   * provided by the caller. undefined → fall back to SubAgentRunner's own
   * MAX_TURNS_DEFAULT.
   */
  maxToolRoundsHint?: number;
}

export const AGENT_MODES = [
  "execute",
  "plan",
  "research",
  "explore",
  "default",
] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** Runtime guard for `unknown` (e.g. profile frontmatter parsed off disk). */
export function isAgentMode(value: unknown): value is AgentMode {
  return (
    typeof value === "string" &&
    (AGENT_MODES as readonly string[]).includes(value)
  );
}

export const AGENT_MODE_MAP: Readonly<Record<AgentMode, AgentModeConfig>> =
  Object.freeze({
    execute: {
      reasoningHint:
        t("be_agentModeMap.executeReasoningHint"),
      autoSkills: ["email-polish", "meeting-minutes"],
      maxToolRoundsHint: 20,
    },
    plan: {
      reasoningHint:
        t("be_agentModeMap.planReasoningHint"),
      autoSkills: ["decision-record", "report-writing"],
      maxToolRoundsHint: 30,
    },
    research: {
      reasoningHint:
        t("be_agentModeMap.researchReasoningHint"),
      autoSkills: ["data-summary", "report-writing"],
      maxToolRoundsHint: 25,
    },
    explore: {
      reasoningHint:
        t("be_agentModeMap.exploreReasoningHint"),
      autoSkills: [],
      maxToolRoundsHint: 15,
    },
    default: {
      // Design-intent fallback: unknown / absent mode lands here (including an
      // anonymous `agent_spawn` with no `agentName`). No auto skills, no posture
      // injection — the profile body alone drives the sub-agent, exactly as it
      // did before mode support existed.
      //
      // Round budget: since `agent_spawn` no longer lets the LLM pick a
      // `maxTurns`, this hint is the host's budget for EVERY anonymous spawn.
      // 20 assistant rounds — standard multi-step work — sits between the
      // read-only explore posture (15) and the full 30 ceiling: high enough
      // that a normal multi-step sub-task finishes without a premature
      // round-cap, low enough that a runaway loop is still bounded. A caller
      // that knows it needs the full 30 uses a `plan`-mode profile (or passes
      // an explicit host `maxRounds`).
      reasoningHint: "",
      autoSkills: [],
      maxToolRoundsHint: 20,
    },
  });

/**
 * Resolve a profile's `mode:` frontmatter to its config. Unknown / absent
 * modes resolve to `default` (design-intent fallback). The boolean in the
 * return value lets the caller log an "unknown mode" audit line only when
 * a non-empty mode string failed to match.
 */
export function resolveAgentMode(mode: string | null | undefined): {
  config: AgentModeConfig;
  matched: boolean;
  requested: string | null;
} {
  const trimmed = mode?.trim() ?? "";
  if (!trimmed) {
    return { config: AGENT_MODE_MAP.default, matched: true, requested: null };
  }
  if (isAgentMode(trimmed)) {
    return { config: AGENT_MODE_MAP[trimmed], matched: true, requested: trimmed };
  }
  return { config: AGENT_MODE_MAP.default, matched: false, requested: trimmed };
}
