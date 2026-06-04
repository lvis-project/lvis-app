/**
 * Scripted-turn registry tests — guard the per-scenario JSON contract
 * so a script drift (missing fakeResultKo, mismatched id, etc.) fails
 * loudly at unit-test time rather than rendering broken demo entries.
 */
import { describe, it, expect } from "vitest";
import { getScriptByScenarioId } from "../scripts-registry.js";
import type { ScriptedTurn } from "../types.js";
import meetingSummary from "../scripts/meeting-summary-demo.json" with { type: "json" };
import docSearch from "../scripts/doc-search-demo.json" with { type: "json" };
import workAssistant from "../scripts/work-assistant-demo.json" with { type: "json" };
import multiAgent from "../scripts/multi-agent-demo.json" with { type: "json" };

// Catalog assertions guard the per-scenario JSON contract directly from the
// fixtures (the production module no longer carries an inert DEMO_SCRIPTS export).
const DEMO_SCRIPTS: readonly ScriptedTurn[] = [
  meetingSummary as ScriptedTurn,
  docSearch as ScriptedTurn,
  workAssistant as ScriptedTurn,
  multiAgent as ScriptedTurn,
];

describe("DEMO_SCRIPTS catalog", () => {
  it("includes the 4 canonical scenario scripts", () => {
    const ids = DEMO_SCRIPTS.map((s) => s.id);
    expect(ids).toEqual([
      "meeting-summary-demo",
      "doc-search-demo",
      "work-assistant-demo",
      "multi-agent-demo",
    ]);
  });

  it("every script has a populated user message + assistant response", () => {
    for (const script of DEMO_SCRIPTS) {
      expect(script.userMessage.length).toBeGreaterThan(0);
      expect(script.assistantResponse.length).toBeGreaterThan(0);
      expect(script.titleKo.length).toBeGreaterThan(0);
    }
  });

  it("every tool call has a fake result string (no script drift)", () => {
    for (const script of DEMO_SCRIPTS) {
      for (const call of script.toolCalls) {
        expect(typeof call.fakeResultKo).toBe("string");
        expect(call.fakeResultKo.length).toBeGreaterThan(0);
        expect(typeof call.toolName).toBe("string");
        expect(call.toolName.length).toBeGreaterThan(0);
        expect(typeof call.labelKo).toBe("string");
        expect(call.labelKo.length).toBeGreaterThan(0);
      }
    }
  });

  it("doc-search-demo references the Option A user message", () => {
    const docs = DEMO_SCRIPTS.find((s) => s.id === "doc-search-demo");
    expect(docs?.userMessage).toContain("PRD");
  });

  it("work-assistant-demo orchestrates both calendar and email mocks", () => {
    const work = DEMO_SCRIPTS.find((s) => s.id === "work-assistant-demo");
    expect(work).toBeTruthy();
    const toolNames = work?.toolCalls.map((c) => c.toolName) ?? [];
    expect(toolNames).toContain("calendar_today_events");
    expect(toolNames).toContain("email_pending");
  });

  it("multi-agent-demo dispatches both market-analyst and competitor-tracker", () => {
    const multi = DEMO_SCRIPTS.find((s) => s.id === "multi-agent-demo");
    expect(multi).toBeTruthy();
    const labels = multi?.toolCalls.map((c) => c.labelKo).join(" ") ?? "";
    expect(labels).toMatch(/market-analyst/);
    expect(labels).toMatch(/competitor-tracker/);
  });
});

describe("getScriptByScenarioId", () => {
  it("maps ScenarioShowcase ids to the correct script", () => {
    expect(getScriptByScenarioId("meeting")?.id).toBe("meeting-summary-demo");
    expect(getScriptByScenarioId("docs")?.id).toBe("doc-search-demo");
    expect(getScriptByScenarioId("work")?.id).toBe("work-assistant-demo");
    expect(getScriptByScenarioId("multi-agent")?.id).toBe("multi-agent-demo");
  });

  it("returns null for null / unknown scenario ids", () => {
    expect(getScriptByScenarioId(null)).toBeNull();
    expect(getScriptByScenarioId(undefined)).toBeNull();
    expect(getScriptByScenarioId("nope")).toBeNull();
  });
});
