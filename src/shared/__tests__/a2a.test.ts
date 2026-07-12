import { describe, expect, it } from "vitest";
import {
  A2A_INTERRUPTED_TASK_STATE_VALUES,
  A2A_PROJECTED_TASK_STATE_VALUES,
  A2A_ROLE_VALUES,
  A2A_SUB_AGENT_RUN_STATE_MAP,
  A2A_TASK_STATE_PROTO_ORDER,
  A2A_TASK_STATE_TRANSITION_RANK,
  A2A_TASK_STATE_VALUES,
  A2A_TERMINAL_TASK_STATE_VALUES,
  A2ARole,
  A2ATaskState,
  canTransitionA2ATaskState,
  isA2AInterruptedTaskState,
  isA2AProjectedTaskState,
  isA2ATaskState,
  isA2ATerminalTaskState,
  projectSubAgentResultState,
  projectSubAgentRunState,
  type A2AArtifact,
  type A2AMessage,
  type A2APart,
  type A2ATask,
  type A2ATaskStatus,
  type A2ATaskStatusUpdateEvent,
} from "../a2a.js";

describe("A2A v1.0 vendored core model", () => {
  it("pins canonical ProtoJSON TaskState values in proto numeric order", () => {
    expect(A2A_TASK_STATE_VALUES).toEqual([
      "TASK_STATE_UNSPECIFIED",
      "TASK_STATE_SUBMITTED",
      "TASK_STATE_WORKING",
      "TASK_STATE_COMPLETED",
      "TASK_STATE_FAILED",
      "TASK_STATE_CANCELED",
      "TASK_STATE_INPUT_REQUIRED",
      "TASK_STATE_REJECTED",
      "TASK_STATE_AUTH_REQUIRED",
    ]);
    for (const [index, state] of A2A_TASK_STATE_VALUES.entries()) {
      expect(A2A_TASK_STATE_PROTO_ORDER[state]).toBe(index);
      expect(isA2ATaskState(state)).toBe(true);
    }
    expect(isA2ATaskState("working")).toBe(false);
    expect(isA2ATaskState(2)).toBe(false);
  });

  it("pins canonical ProtoJSON Role values", () => {
    expect(A2A_ROLE_VALUES).toEqual([
      "ROLE_UNSPECIFIED",
      "ROLE_USER",
      "ROLE_AGENT",
    ]);
  });

  it("uses v1 camelCase fields and member-presence Part variants", () => {
    const parts: [A2APart, ...A2APart[]] = [
      { text: "partial result" },
      { raw: "AQID", filename: "bytes.bin", mediaType: "application/octet-stream" },
      { url: "https://example.test/report", mediaType: "text/html" },
      { data: { reason: "budget", nested: [true, null] } },
    ];
    const message: A2AMessage = {
      messageId: "message-1",
      contextId: "parent-1",
      taskId: "child-1",
      role: A2ARole.AGENT,
      parts,
      referenceTaskIds: ["earlier-task"],
    };
    const artifact: A2AArtifact = {
      artifactId: "artifact-1",
      parts: [{ text: "done" }],
    };
    const status: A2ATaskStatus = {
      state: A2ATaskState.WORKING,
      message,
      timestamp: "2026-07-11T00:00:00Z",
    };
    const task: A2ATask = {
      id: "child-1",
      contextId: "parent-1",
      status,
      artifacts: [artifact],
      history: [message],
    };
    const event: A2ATaskStatusUpdateEvent = {
      taskId: task.id,
      contextId: task.contextId!,
      status,
    };

    expect(Object.keys(task)).toContain("contextId");
    expect(Object.keys(message)).toContain("messageId");
    expect(Object.keys(message)).toContain("referenceTaskIds");
    expect(Object.keys(parts[1])).toContain("mediaType");
    expect(event).not.toHaveProperty("final");
    expect(event).not.toHaveProperty("kind");
  });
});

describe("A2A state machine helpers", () => {
  it("ports a2a-tck STREAM-ORDER-001 lifecycle ranks", () => {
    expect(A2A_TASK_STATE_TRANSITION_RANK).toEqual({
      TASK_STATE_UNSPECIFIED: -1,
      TASK_STATE_SUBMITTED: 0,
      TASK_STATE_WORKING: 1,
      TASK_STATE_INPUT_REQUIRED: 1,
      TASK_STATE_AUTH_REQUIRED: 1,
      TASK_STATE_COMPLETED: 2,
      TASK_STATE_FAILED: 2,
      TASK_STATE_CANCELED: 2,
      TASK_STATE_REJECTED: 2,
    });

    expect(canTransitionA2ATaskState(
      A2ATaskState.SUBMITTED,
      A2ATaskState.WORKING,
    )).toBe(true);
    expect(canTransitionA2ATaskState(
      A2ATaskState.WORKING,
      A2ATaskState.INPUT_REQUIRED,
    )).toBe(true);
    expect(canTransitionA2ATaskState(
      A2ATaskState.INPUT_REQUIRED,
      A2ATaskState.WORKING,
    )).toBe(true);
    expect(canTransitionA2ATaskState(
      A2ATaskState.SUBMITTED,
      A2ATaskState.COMPLETED,
    )).toBe(true);
    expect(canTransitionA2ATaskState(
      A2ATaskState.INPUT_REQUIRED,
      A2ATaskState.CANCELED,
    )).toBe(true);
  });

  it("rejects rank regressions and terminal-task restarts", () => {
    expect(canTransitionA2ATaskState(
      A2ATaskState.WORKING,
      A2ATaskState.SUBMITTED,
    )).toBe(false);
    expect(canTransitionA2ATaskState(
      A2ATaskState.COMPLETED,
      A2ATaskState.WORKING,
    )).toBe(false);
    expect(canTransitionA2ATaskState(
      A2ATaskState.COMPLETED,
      A2ATaskState.FAILED,
    )).toBe(false);
    expect(canTransitionA2ATaskState(
      A2ATaskState.COMPLETED,
      A2ATaskState.COMPLETED,
    )).toBe(true);
    expect(canTransitionA2ATaskState(
      A2ATaskState.UNSPECIFIED,
      A2ATaskState.UNSPECIFIED,
    )).toBe(false);
  });

  it("classifies terminal and interrupted states exactly", () => {
    expect(A2A_TERMINAL_TASK_STATE_VALUES).toEqual([
      A2ATaskState.COMPLETED,
      A2ATaskState.FAILED,
      A2ATaskState.CANCELED,
      A2ATaskState.REJECTED,
    ]);
    expect(A2A_INTERRUPTED_TASK_STATE_VALUES).toEqual([
      A2ATaskState.INPUT_REQUIRED,
      A2ATaskState.AUTH_REQUIRED,
    ]);
    for (const state of A2A_TASK_STATE_VALUES) {
      expect(isA2ATerminalTaskState(state)).toBe(
        A2A_TERMINAL_TASK_STATE_VALUES.includes(
          state as (typeof A2A_TERMINAL_TASK_STATE_VALUES)[number],
        ),
      );
      expect(isA2AInterruptedTaskState(state)).toBe(
        A2A_INTERRUPTED_TASK_STATE_VALUES.includes(
          state as (typeof A2A_INTERRUPTED_TASK_STATE_VALUES)[number],
        ),
      );
    }
  });
});

describe("sub-agent to A2A projection", () => {
  it("maps every run-handle state in the ph1 transition table", () => {
    expect(A2A_SUB_AGENT_RUN_STATE_MAP).toEqual({
      submitted: A2ATaskState.SUBMITTED,
      running: A2ATaskState.WORKING,
      waiting: A2ATaskState.INPUT_REQUIRED,
      done: A2ATaskState.COMPLETED,
      error: A2ATaskState.FAILED,
      interrupted: A2ATaskState.CANCELED,
      rejected: A2ATaskState.REJECTED,
    });
    for (const [state, expected] of Object.entries(A2A_SUB_AGENT_RUN_STATE_MAP)) {
      expect(projectSubAgentRunState(
        state as keyof typeof A2A_SUB_AGENT_RUN_STATE_MAP,
      )).toBe(expected);
    }
  });

  it.each([
    ["natural end", { ok: true, stopReason: "end_turn" }, A2ATaskState.COMPLETED],
    ["failed run", { ok: false }, A2ATaskState.FAILED],
    ["interrupt", { ok: true, stopReason: "interrupted" }, A2ATaskState.CANCELED],
    ["resume guard", { ok: false, resumeExhausted: true }, A2ATaskState.REJECTED],
    ["prompt rejection", { ok: true, stopReason: "blocked" }, A2ATaskState.REJECTED],
    [
      "budget wait",
      {
        ok: true,
        suspension: { reason: "budget", resumeId: "sub-budget" },
      },
      A2ATaskState.INPUT_REQUIRED,
    ],
    [
      "question wait",
      {
        ok: true,
        suspension: {
          reason: "question",
          prompt: "Which branch?",
          resumeId: "sub-question",
        },
      },
      A2ATaskState.INPUT_REQUIRED,
    ],
    ["legacy incomplete", { ok: true, incomplete: true }, A2ATaskState.INPUT_REQUIRED],
    ["legacy round cap", { ok: true, stopReason: "round-cap" }, A2ATaskState.INPUT_REQUIRED],
  ])("projects %s", (_label, result, expected) => {
    expect(projectSubAgentResultState(result)).toBe(expected);
  });

  it.each(["budget", "question"] as const)(
    "round-trips %s suspension metadata",
    (reason) => {
      const suspension = {
        reason,
        prompt: reason === "question" ? "Which branch?" : "Continue",
        resumeId: "sub-resume",
      };
      const roundTripped = JSON.parse(JSON.stringify(suspension)) as typeof suspension;
      expect(roundTripped).toEqual(suspension);
      expect(projectSubAgentResultState({
        ok: true,
        suspension: roundTripped,
      })).toBe(A2ATaskState.INPUT_REQUIRED);
    },
  );

  it("makes AUTH_REQUIRED valid protocol input but impossible host output", () => {
    expect(isA2ATaskState(A2ATaskState.AUTH_REQUIRED)).toBe(true);
    expect(isA2AProjectedTaskState(A2ATaskState.AUTH_REQUIRED)).toBe(false);
    expect(isA2AProjectedTaskState(A2ATaskState.UNSPECIFIED)).toBe(false);
    expect(A2A_PROJECTED_TASK_STATE_VALUES).not.toContain(A2ATaskState.AUTH_REQUIRED);
    expect(A2A_PROJECTED_TASK_STATE_VALUES).not.toContain(A2ATaskState.UNSPECIFIED);

    for (const state of Object.keys(A2A_SUB_AGENT_RUN_STATE_MAP)) {
      const projected = projectSubAgentRunState(
        state as keyof typeof A2A_SUB_AGENT_RUN_STATE_MAP,
      );
      expect(isA2AProjectedTaskState(projected)).toBe(true);
    }
  });
});
