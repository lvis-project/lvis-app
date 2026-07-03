import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import type { SubAgentSpawn } from "../../components/SubAgentCard.js";
import {
  deriveSubAgentSpawnsFromEntries,
  derivedSpawnId,
  mergeSubAgentSpawns,
} from "../derive-subagent-spawns.js";

function group(tools: Extract<ChatEntry, { kind: "tool_group" }>["tools"]): ChatEntry {
  return {
    kind: "tool_group",
    groupId: "g1",
    groupIds: ["g1"],
    status: "done",
    tools,
  };
}

describe("deriveSubAgentSpawnsFromEntries", () => {
  it("reconstructs a done spawn from a persisted agent_spawn tool call", () => {
    const entries: ChatEntry[] = [
      group([
        {
          toolUseId: "tu-1",
          name: "agent_spawn",
          displayOrder: 0,
          status: "done",
          category: "meta",
          input: { title: "Research task", instructions: "do the thing" },
          result: JSON.stringify({
            summary: "Found 3 relevant files",
            toolCallCount: 5,
            turnCount: 2,
          }),
        },
      ]),
    ];

    const spawns = deriveSubAgentSpawnsFromEntries(entries);
    expect(spawns).toHaveLength(1);
    const spawn = spawns[0];
    expect(spawn.spawnId).toBe(derivedSpawnId("tu-1"));
    expect(spawn.toolUseId).toBe("tu-1");
    expect(spawn.title).toBe("Research task");
    expect(spawn.status).toBe("done");
    expect(spawn.summary).toBe("Found 3 relevant files");
    expect(spawn.toolCallCount).toBe(5);
    // Final output collapsed into a single synthetic turn.
    expect(spawn.turns).toHaveLength(1);
    expect(spawn.turns[0]).toEqual({
      turn: 1,
      text: "Found 3 relevant files",
      toolCallCount: 5,
    });
  });

  it("falls back to agentName when title is absent", () => {
    const entries: ChatEntry[] = [
      group([
        {
          toolUseId: "tu-2",
          name: "agent_spawn",
          displayOrder: 0,
          status: "done",
          input: { agentName: "explore", instructions: "search" },
          result: JSON.stringify({ summary: "ok", toolCallCount: 1 }),
        },
      ]),
    ];
    expect(deriveSubAgentSpawnsFromEntries(entries)[0].title).toBe("explore");
  });

  it("marks a spawn as error when the tool status is error", () => {
    const entries: ChatEntry[] = [
      group([
        {
          toolUseId: "tu-3",
          name: "agent_spawn",
          displayOrder: 0,
          status: "error",
          input: { title: "Broken run" },
          result: JSON.stringify({ error: "agent profile not found: nope" }),
        },
      ]),
    ];
    const spawn = deriveSubAgentSpawnsFromEntries(entries)[0];
    expect(spawn.status).toBe("error");
    expect(spawn.errorMessage).toBe("agent profile not found: nope");
    expect(spawn.turns).toHaveLength(0);
  });

  it("downgrades a nominally-done tool to error when the result carries { error }", () => {
    const entries: ChatEntry[] = [
      group([
        {
          toolUseId: "tu-4",
          name: "agent_spawn",
          displayOrder: 0,
          status: "done",
          input: { title: "Late failure" },
          result: JSON.stringify({ error: "runner not configured" }),
        },
      ]),
    ];
    const spawn = deriveSubAgentSpawnsFromEntries(entries)[0];
    expect(spawn.status).toBe("error");
    expect(spawn.errorMessage).toBe("runner not configured");
  });

  it("ignores non-agent_spawn tools and non-tool_group entries", () => {
    const entries: ChatEntry[] = [
      { kind: "user", text: "hi" },
      group([
        {
          toolUseId: "read-1",
          name: "read_file",
          displayOrder: 0,
          status: "done",
          input: { path: "/tmp/x" },
          result: "content",
        },
      ]),
    ];
    expect(deriveSubAgentSpawnsFromEntries(entries)).toHaveLength(0);
  });

  it("derives multiple spawns across tool groups in display order", () => {
    const entries: ChatEntry[] = [
      group([
        {
          toolUseId: "tu-b",
          name: "agent_spawn",
          displayOrder: 1,
          status: "done",
          input: { title: "Second" },
          result: JSON.stringify({ summary: "b" }),
        },
        {
          toolUseId: "tu-a",
          name: "agent_spawn",
          displayOrder: 0,
          status: "done",
          input: { title: "First" },
          result: JSON.stringify({ summary: "a" }),
        },
      ]),
    ];
    const spawns = deriveSubAgentSpawnsFromEntries(entries);
    expect(spawns.map((s) => s.title)).toEqual(["First", "Second"]);
  });

  it("handles a non-JSON result string as the sub-agent output", () => {
    const entries: ChatEntry[] = [
      group([
        {
          toolUseId: "tu-5",
          name: "agent_spawn",
          displayOrder: 0,
          status: "done",
          input: { title: "Raw output" },
          result: "plain text summary",
        },
      ]),
    ];
    const spawn = deriveSubAgentSpawnsFromEntries(entries)[0];
    expect(spawn.summary).toBe("plain text summary");
    expect(spawn.turns[0].text).toBe("plain text summary");
  });
});

describe("mergeSubAgentSpawns", () => {
  const live: SubAgentSpawn = {
    spawnId: "live-uuid-1",
    title: "Live run",
    status: "done",
    turns: [
      { turn: 1, text: "step 1", toolCallCount: 1 },
      { turn: 2, text: "step 2", toolCallCount: 2 },
    ],
    summary: "live summary",
    toolCallCount: 4,
    toolUseId: "tu-1",
  };
  const derivedSameRun: SubAgentSpawn = {
    spawnId: derivedSpawnId("tu-1"),
    title: "Live run",
    status: "done",
    turns: [{ turn: 1, text: "live summary", toolCallCount: 4 }],
    summary: "live summary",
    toolCallCount: 4,
    toolUseId: "tu-1",
  };
  const derivedPastRun: SubAgentSpawn = {
    spawnId: derivedSpawnId("tu-9"),
    title: "Past run",
    status: "done",
    turns: [{ turn: 1, text: "past summary", toolCallCount: 2 }],
    summary: "past summary",
    toolCallCount: 2,
    toolUseId: "tu-9",
  };

  it("keeps the live spawn and drops the derived duplicate for the same run (dedupe by toolUseId)", () => {
    const merged = mergeSubAgentSpawns([live], [derivedSameRun, derivedPastRun]);
    expect(merged).toHaveLength(2);
    // Live richness preserved (2 turns, not the collapsed single derived turn).
    const liveResult = merged.find((s) => s.toolUseId === "tu-1");
    expect(liveResult?.spawnId).toBe("live-uuid-1");
    expect(liveResult?.turns).toHaveLength(2);
    // Past run derived from loaded entries is included.
    expect(merged.find((s) => s.toolUseId === "tu-9")?.title).toBe("Past run");
  });

  it("returns only derived spawns for a loaded session with no live stream", () => {
    const merged = mergeSubAgentSpawns([], [derivedPastRun]);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe("Past run");
  });

  it("returns only live spawns for a fresh session with no derived entries yet", () => {
    const merged = mergeSubAgentSpawns([live], []);
    expect(merged).toEqual([live]);
  });

  it("dedupes when a live and derived entry share the same spawnId", () => {
    const derivedSameId: SubAgentSpawn = { ...derivedPastRun, spawnId: "live-uuid-1", toolUseId: "tu-x" };
    const merged = mergeSubAgentSpawns([live], [derivedSameId]);
    expect(merged).toHaveLength(1);
    expect(merged[0].spawnId).toBe("live-uuid-1");
    expect(merged[0].title).toBe("Live run");
  });
});
