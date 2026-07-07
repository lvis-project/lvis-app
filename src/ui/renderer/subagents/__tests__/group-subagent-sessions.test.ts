import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import type { SubAgentSpawn } from "../types.js";
import { groupSubAgentSessions } from "../group-subagent-sessions.js";

// Minimal assistant entry factory so each segment carries a distinguishable
// transcript body (inlined here to avoid a shared-helper collision with the
// derive test file).
function assistant(text: string): ChatEntry {
  return { kind: "assistant", text, streaming: false };
}

function spawn(overrides: Partial<SubAgentSpawn> & Pick<SubAgentSpawn, "spawnId">): SubAgentSpawn {
  return {
    title: "Agent",
    status: "done",
    entries: [],
    toolCallCount: 0,
    ...overrides,
  };
}

describe("groupSubAgentSessions", () => {
  it("concatenates an original + two resumes sharing a childSessionId into one unified spawn", () => {
    const grouped = groupSubAgentSessions([
      spawn({
        spawnId: "orig",
        title: "Research task",
        instructions: "original prompt",
        status: "done",
        childSessionId: "child-1",
        entries: [assistant("original work")],
        toolCallCount: 3,
      }),
      spawn({
        spawnId: "resume-1",
        title: "(sub-agent)", // resume titles are looser; original title wins
        status: "done",
        childSessionId: "child-1",
        entries: [assistant("resume 1 work")],
        toolCallCount: 2,
      }),
      spawn({
        spawnId: "resume-2",
        title: "(sub-agent)",
        status: "running",
        childSessionId: "child-1",
        entries: [assistant("resume 2 tail")],
        toolCallCount: 1,
      }),
    ]);

    expect(grouped).toHaveLength(1);
    const unified = grouped[0];
    // Identity from the FIRST segment.
    expect(unified.spawnId).toBe("orig");
    expect(unified.title).toBe("Research task");
    expect(unified.instructions).toBe("original prompt");
    expect(unified.childSessionId).toBe("child-1");
    // Transcript is the ordered flat concat of every segment.
    expect(unified.entries.map((e) => (e.kind === "assistant" ? e.text : ""))).toEqual([
      "original work",
      "resume 1 work",
      "resume 2 tail",
    ]);
    // Status/summary/error come from the LATEST segment; tool count is summed.
    expect(unified.status).toBe("running");
    expect(unified.toolCallCount).toBe(6);
  });

  it("takes status, summary, and errorMessage from the latest segment", () => {
    const grouped = groupSubAgentSessions([
      spawn({ spawnId: "a", childSessionId: "c", status: "done", summary: "first summary", toolCallCount: 1 }),
      spawn({
        spawnId: "b",
        childSessionId: "c",
        status: "error",
        summary: "second summary",
        errorMessage: "boom",
        toolCallCount: 4,
      }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].status).toBe("error");
    expect(grouped[0].summary).toBe("second summary");
    expect(grouped[0].errorMessage).toBe("boom");
    expect(grouped[0].toolCallCount).toBe(5);
  });

  it("keeps a spawn without childSessionId as its own solo group (today's behavior)", () => {
    const solo = spawn({ spawnId: "solo-1", title: "Solo", entries: [assistant("x")], toolCallCount: 2 });
    const grouped = groupSubAgentSessions([solo]);
    expect(grouped).toHaveLength(1);
    // Singleton groups are returned verbatim (reference identity preserved).
    expect(grouped[0]).toBe(solo);
  });

  it("does NOT merge two solo spawns that both lack a childSessionId", () => {
    const grouped = groupSubAgentSessions([
      spawn({ spawnId: "s1", title: "One" }),
      spawn({ spawnId: "s2", title: "Two" }),
    ]);
    expect(grouped.map((g) => g.title)).toEqual(["One", "Two"]);
  });

  it("preserves first-seen group order across interleaved sessions", () => {
    const grouped = groupSubAgentSessions([
      spawn({ spawnId: "a1", title: "A", childSessionId: "ca", entries: [assistant("a1")] }),
      spawn({ spawnId: "b1", title: "B", childSessionId: "cb", entries: [assistant("b1")] }),
      spawn({ spawnId: "a2", title: "(sub-agent)", childSessionId: "ca", entries: [assistant("a2")] }),
    ]);
    expect(grouped).toHaveLength(2);
    // Group order follows the first appearance of each childSessionId (A then B),
    // even though A's second segment appears after B.
    expect(grouped.map((g) => g.title)).toEqual(["A", "B"]);
    expect(grouped[0].entries.map((e) => (e.kind === "assistant" ? e.text : ""))).toEqual(["a1", "a2"]);
    expect(grouped[1].entries.map((e) => (e.kind === "assistant" ? e.text : ""))).toEqual(["b1"]);
  });

  it("returns an empty array for no spawns", () => {
    expect(groupSubAgentSessions([])).toEqual([]);
  });
});
