import { describe, expect, it, vi } from "vitest";
import { createAgentListTool } from "../agent-list.js";
import { A2ATaskState } from "../../shared/a2a.js";

/**
 * agent_list must answer the question the model actually asks it: "which
 * agents exist?" — including THIS conversation's suspended sub-agents. The
 * observed failure this pins: told to continue the agents, the model called
 * agent_list, got only profile definitions, and spawned fresh agents,
 * discarding the suspended children's context.
 */
const PARENT = "9ebd3fcc-3317-4e83-9914-f6b32d3672ac";

function makeTool(persisted: Array<Record<string, unknown>>) {
  return createAgentListTool({
    store: { list: vi.fn(async () => [
      { name: "researcher", description: "d", sourceTools: [], triggers: [], model: "mid", mode: "research" },
    ]) } as never,
    getRunner: () => ({
      listPersistedSpawnsForOrigin: vi.fn((origin: string) =>
        origin === PARENT ? persisted : []),
    }) as never,
  });
}

const ctx = { cwd: "/", metadata: { sessionId: PARENT } } as never;

describe("agent_list existing sub-agents", () => {
  it("lists this conversation's sub-agents with resumeId and resumability", async () => {
    const tool = makeTool([
      {
        spawnId: "s1",
        childSessionId: "sub-aaaa-1111",
        title: "RALPLAN Ledger 검증",
        modifiedAt: new Date(),
        taskState: A2ATaskState.INPUT_REQUIRED,
      },
      {
        spawnId: "s2",
        childSessionId: "sub-aaaa-2222",
        title: "RALPLAN Architect 검토",
        modifiedAt: new Date(),
        taskState: A2ATaskState.COMPLETED,
      },
    ]);
    const result = await tool.execute({}, ctx);
    const payload = JSON.parse(result.output);

    expect(payload.agents).toHaveLength(1);
    expect(payload.existingSubAgents).toEqual([
      expect.objectContaining({
        title: "RALPLAN Ledger 검증",
        resumeId: "sub-aaaa-1111",
        resumable: true,
      }),
      expect.objectContaining({
        title: "RALPLAN Architect 검토",
        resumeId: "sub-aaaa-2222",
        resumable: false,
      }),
    ]);
    expect(payload.existingSubAgentsGuidance).toContain("resumeId");
  });

  it("advertises only what the runner's resume gate accepts — INPUT_REQUIRED", async () => {
    // The runner's resumeWithPolicy rejects everything but INPUT_REQUIRED, so
    // advertising SUBMITTED/WORKING/unrecorded as resumable sends the model
    // into a guided retry loop against a permanent rejection. They stay
    // listed (the model benefits from knowing they existed) but non-resumable.
    const tool = makeTool([
      { spawnId: "s3", childSessionId: "sub-aaaa-3333", title: "t", modifiedAt: new Date() },
      { spawnId: "s4", childSessionId: "sub-aaaa-4444", title: "t", modifiedAt: new Date(), taskState: A2ATaskState.WORKING },
      { spawnId: "s5", childSessionId: "sub-aaaa-5555", title: "t", modifiedAt: new Date(), taskState: A2ATaskState.SUBMITTED },
    ]);
    const payload = JSON.parse((await tool.execute({}, ctx)).output);
    expect(payload.existingSubAgents.map((e: { taskState: string; resumable: boolean }) => [e.taskState, e.resumable]))
      .toEqual([["unrecorded", false], [A2ATaskState.WORKING, false], [A2ATaskState.SUBMITTED, false]]);
  });

  it("omits the section entirely when the conversation has no sub-agents", async () => {
    const payload = JSON.parse((await makeTool([]).execute({}, ctx)).output);
    expect(payload.existingSubAgents).toBeUndefined();
    expect(payload.existingSubAgentsGuidance).toBeUndefined();
  });

  it("stays profile-only when no runner is wired", async () => {
    const tool = createAgentListTool({
      store: { list: vi.fn(async () => []) } as never,
    });
    const payload = JSON.parse((await tool.execute({}, ctx)).output);
    expect(payload.agents).toEqual([]);
    expect(payload.existingSubAgents).toBeUndefined();
  });
});
