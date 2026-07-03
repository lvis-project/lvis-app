import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import type { SubAgentSpawn } from "../../components/SubAgentCard.js";
import {
  deriveSubAgentSpawnsFromEntries,
  derivedSpawnId,
  mergeSubAgentSpawns,
} from "../derive-subagent-spawns.js";

type ToolGroupTools = Extract<ChatEntry, { kind: "tool_group" }>["tools"];

// Wrap a tool list as a done tool_group entry. Inlined via `entriesOf` so the
// tool_group shape is built once here rather than duplicating the fixture across
// each case (and avoids a shared-helper-body collision with other test files).
function entriesOf(tools: ToolGroupTools, prefix = ""): ChatEntry[] {
  return [
    {
      kind: "tool_group",
      groupId: `${prefix}g`,
      groupIds: [`${prefix}g`],
      status: "done",
      tools,
    },
  ];
}

describe("deriveSubAgentSpawnsFromEntries", () => {
  it("reconstructs a done spawn from a persisted agent_spawn tool call", () => {
    const spawns = deriveSubAgentSpawnsFromEntries(
      entriesOf([
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
    );
    expect(spawns).toHaveLength(1);
    const spawn = spawns[0];
    expect(spawn.spawnId).toBe(derivedSpawnId("tu-1"));
    expect(spawn.toolUseId).toBe("tu-1");
    expect(spawn.title).toBe("Research task");
    expect(spawn.status).toBe("done");
    expect(spawn.summary).toBe("Found 3 relevant files");
    expect(spawn.toolCallCount).toBe(5);
    // Legacy result (no embedded `entries`) → single synthetic assistant entry.
    expect(spawn.entries).toHaveLength(1);
    expect(spawn.entries[0]).toEqual({
      kind: "assistant",
      text: "Found 3 relevant files",
      streaming: false,
    });
  });

  it("uses the embedded child transcript (entries) when present (PR3 persistence)", () => {
    const childEntries: ChatEntry[] = [
      {
        kind: "tool_group",
        groupId: "cg",
        groupIds: ["cg"],
        status: "done",
        tools: [
          {
            toolUseId: "child-read-1",
            name: "read_file",
            displayOrder: 0,
            status: "done",
            input: { path: "/tmp/a" },
            result: "child content",
          },
        ],
      },
      { kind: "assistant", text: "child final", streaming: false },
    ];
    const spawn = deriveSubAgentSpawnsFromEntries(
      entriesOf([
        {
          toolUseId: "tu-embed",
          name: "agent_spawn",
          displayOrder: 0,
          status: "done",
          input: { title: "Embedded" },
          result: JSON.stringify({
            summary: "child final",
            toolCallCount: 1,
            entries: childEntries,
          }),
        },
      ]),
    )[0];
    // Real embedded transcript is used verbatim — NOT the synthetic fallback.
    expect(spawn.entries).toHaveLength(2);
    expect(spawn.entries[0].kind).toBe("tool_group");
    expect(spawn.entries[1]).toEqual({ kind: "assistant", text: "child final", streaming: false });
  });

  it("falls back to agentName when title is absent", () => {
    const spawns = deriveSubAgentSpawnsFromEntries(
      entriesOf([
        {
          toolUseId: "tu-2",
          name: "agent_spawn",
          displayOrder: 0,
          status: "done",
          input: { agentName: "explore", instructions: "search" },
          result: JSON.stringify({ summary: "ok", toolCallCount: 1 }),
        },
      ]),
    );
    expect(spawns[0].title).toBe("explore");
  });

  it("marks a spawn as error when the tool status is error", () => {
    const spawn = deriveSubAgentSpawnsFromEntries(
      entriesOf([
        {
          toolUseId: "tu-3",
          name: "agent_spawn",
          displayOrder: 0,
          status: "error",
          input: { title: "Broken run" },
          result: JSON.stringify({ error: "agent profile not found: nope" }),
        },
      ]),
    )[0];
    expect(spawn.status).toBe("error");
    expect(spawn.errorMessage).toBe("agent profile not found: nope");
    expect(spawn.entries).toHaveLength(0);
  });

  it("downgrades a nominally-done tool to error when the result carries { error }", () => {
    const spawn = deriveSubAgentSpawnsFromEntries(
      entriesOf([
        {
          toolUseId: "tu-4",
          name: "agent_spawn",
          displayOrder: 0,
          status: "done",
          input: { title: "Late failure" },
          result: JSON.stringify({ error: "runner not configured" }),
        },
      ]),
    )[0];
    expect(spawn.status).toBe("error");
    expect(spawn.errorMessage).toBe("runner not configured");
  });

  it("ignores non-agent_spawn tools and non-tool_group entries", () => {
    const entries: ChatEntry[] = [
      { kind: "user", text: "hi" },
      ...entriesOf([
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
    const spawns = deriveSubAgentSpawnsFromEntries(
      entriesOf([
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
    );
    expect(spawns.map((s) => s.title)).toEqual(["First", "Second"]);
  });

  it("extracts childSessionId from an original spawn's incomplete result resumeId", () => {
    const spawn = deriveSubAgentSpawnsFromEntries(
      entriesOf([
        {
          toolUseId: "tu-orig",
          name: "agent_spawn",
          displayOrder: 0,
          status: "done",
          input: { title: "Long task" },
          result: JSON.stringify({
            summary: "partial progress",
            toolCallCount: 3,
            incomplete: true,
            resumeId: "child-session-42",
          }),
        },
      ]),
    )[0];
    // The result's own resumeId (= this spawn's childSessionId) is the JOIN KEY.
    expect(spawn.childSessionId).toBe("child-session-42");
  });

  it("extracts childSessionId from a resume call's input resumeId", () => {
    const spawn = deriveSubAgentSpawnsFromEntries(
      entriesOf([
        {
          toolUseId: "tu-resume",
          name: "agent_spawn",
          displayOrder: 0,
          status: "done",
          input: { instructions: "continue", resumeId: "child-session-42" },
          result: JSON.stringify({ summary: "resumed and finished", toolCallCount: 2 }),
        },
      ]),
    )[0];
    // A resume's input.resumeId is the ORIGINAL's childSessionId — same JOIN KEY.
    expect(spawn.childSessionId).toBe("child-session-42");
  });

  it("leaves childSessionId undefined on a clean-complete original (solo group)", () => {
    const spawn = deriveSubAgentSpawnsFromEntries(
      entriesOf([
        {
          toolUseId: "tu-clean",
          name: "agent_spawn",
          displayOrder: 0,
          status: "done",
          input: { title: "One-shot" },
          result: JSON.stringify({ summary: "done", toolCallCount: 1 }),
        },
      ]),
    )[0];
    expect(spawn.childSessionId).toBeUndefined();
  });

  it("handles a non-JSON result string as the sub-agent output", () => {
    const spawn = deriveSubAgentSpawnsFromEntries(
      entriesOf([
        {
          toolUseId: "tu-5",
          name: "agent_spawn",
          displayOrder: 0,
          status: "done",
          input: { title: "Raw output" },
          result: "plain text summary",
        },
      ]),
    )[0];
    expect(spawn.summary).toBe("plain text summary");
    expect(spawn.entries[0]).toEqual({
      kind: "assistant",
      text: "plain text summary",
      streaming: false,
    });
  });
});

describe("mergeSubAgentSpawns", () => {
  const live: SubAgentSpawn = {
    spawnId: "live-uuid-1",
    title: "Live run",
    status: "done",
    entries: [
      { kind: "assistant", text: "step 1", streaming: false },
      { kind: "assistant", text: "step 2", streaming: false },
    ],
    summary: "live summary",
    toolCallCount: 4,
    toolUseId: "tu-1",
  };
  const derivedSameRun: SubAgentSpawn = {
    spawnId: derivedSpawnId("tu-1"),
    title: "Live run",
    status: "done",
    entries: [{ kind: "assistant", text: "live summary", streaming: false }],
    summary: "live summary",
    toolCallCount: 4,
    toolUseId: "tu-1",
  };
  const derivedPastRun: SubAgentSpawn = {
    spawnId: derivedSpawnId("tu-9"),
    title: "Past run",
    status: "done",
    entries: [{ kind: "assistant", text: "past summary", streaming: false }],
    summary: "past summary",
    toolCallCount: 2,
    toolUseId: "tu-9",
  };

  it("keeps the live spawn and drops the derived duplicate for the same run (dedupe by toolUseId)", () => {
    const merged = mergeSubAgentSpawns([live], [derivedSameRun, derivedPastRun]);
    expect(merged).toHaveLength(2);
    // Live richness preserved (2 entries, not the collapsed single derived entry).
    const liveResult = merged.find((s) => s.toolUseId === "tu-1");
    expect(liveResult?.spawnId).toBe("live-uuid-1");
    expect(liveResult?.entries).toHaveLength(2);
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
