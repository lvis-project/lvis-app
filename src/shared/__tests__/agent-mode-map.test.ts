import { describe, expect, it } from "vitest";
import {
  AGENT_MODES,
  AGENT_MODE_MAP,
  isAgentMode,
  resolveAgentMode,
} from "../agent-mode-map.js";

// The seeded builtin skill names (resources/skills/*.md). autoSkills must
// only reference these — a typo would surface a recommendation the user
// can never satisfy.
const SEEDED_BUILTIN_SKILLS = new Set([
  "report-writing",
  "meeting-minutes",
  "email-polish",
  "decision-record",
  "data-summary",
]);

describe("agent-mode-map", () => {
  describe("AGENT_MODE_MAP coverage", () => {
    it("declares a config for every mode", () => {
      for (const mode of AGENT_MODES) {
        expect(AGENT_MODE_MAP[mode], `mode "${mode}" missing`).toBeDefined();
      }
    });

    it("every autoSkills entry references a seeded builtin skill", () => {
      for (const mode of AGENT_MODES) {
        for (const skill of AGENT_MODE_MAP[mode].autoSkills) {
          expect(
            SEEDED_BUILTIN_SKILLS.has(skill),
            `mode "${mode}" autoSkill "${skill}" is not a seeded builtin`,
          ).toBe(true);
        }
      }
    });

    it("default mode is inert — no posture, no auto skills", () => {
      expect(AGENT_MODE_MAP.default.reasoningHint).toBe("");
      expect(AGENT_MODE_MAP.default.autoSkills).toEqual([]);
    });

    it("non-default modes carry a working-posture hint", () => {
      for (const mode of AGENT_MODES) {
        if (mode === "default") continue;
        expect(
          AGENT_MODE_MAP[mode].reasoningHint.length,
          `mode "${mode}" must have a reasoningHint`,
        ).toBeGreaterThan(0);
      }
    });
  });

  describe("isAgentMode", () => {
    it("accepts every declared mode", () => {
      for (const mode of AGENT_MODES) {
        expect(isAgentMode(mode)).toBe(true);
      }
    });

    it("rejects unknown / non-string values", () => {
      expect(isAgentMode("executor")).toBe(false); // agent name, not a mode
      expect(isAgentMode("planning")).toBe(false);
      expect(isAgentMode("")).toBe(false);
      expect(isAgentMode(undefined)).toBe(false);
      expect(isAgentMode(null)).toBe(false);
      expect(isAgentMode(7)).toBe(false);
    });
  });

  describe("resolveAgentMode", () => {
    it("resolves a known mode to its config (matched=true)", () => {
      const r = resolveAgentMode("plan");
      expect(r.config).toBe(AGENT_MODE_MAP.plan);
      expect(r.matched).toBe(true);
      expect(r.requested).toBe("plan");
    });

    it("treats absent mode as the default config without flagging unknown", () => {
      for (const input of [undefined, null, "", "   "]) {
        const r = resolveAgentMode(input);
        expect(r.config).toBe(AGENT_MODE_MAP.default);
        expect(r.matched).toBe(true); // absence is expected, not an error
        expect(r.requested).toBeNull();
      }
    });

    it("falls back to default for an unknown mode and flags it (matched=false)", () => {
      const r = resolveAgentMode("supervise");
      expect(r.config).toBe(AGENT_MODE_MAP.default);
      expect(r.matched).toBe(false); // caller logs "unknown mode"
      expect(r.requested).toBe("supervise");
    });

    it("trims whitespace before matching", () => {
      const r = resolveAgentMode("  research  ");
      expect(r.config).toBe(AGENT_MODE_MAP.research);
      expect(r.matched).toBe(true);
      expect(r.requested).toBe("research");
    });
  });
});
