import { describe, expect, it, vi } from "vitest";
import { A2ATaskState } from "../../shared/a2a.js";
import { createRemoteA2AActionController } from "../remote-a2a-action-controller.js";

const digest = "a".repeat(64);
const config = {
  routeControlBaseUrl: "https://hub.example.test/",
  receiverPublicOrigin: "https://receiver.lvis.ai/",
  outboundCallerGenerationId: "generation-1",
  receiverCallerGenerationId: "receiver-1",
  extensionSpecDigestSha256: digest,
  targets: [{ targetAgentId: 1, label: "Agent one", interfaceUrl: "https://agent.example.test/a2a", agentCardDigestSha256: digest, trustKeyId: 2, credentialBindingId: 3, routePolicyVersion: 4, routePolicyDigestSha256: digest, intendedCredentialRevisionId: 11, replayCredentialRevisionIds: [12, 13] }],
  receiverMaxKeysPerGeneration: 100,
};
const lineage = { targetAgentId: 1, interfaceUrl: "https://agent.example.test/a2a", agentCardDigestSha256: digest, trustKeyId: 2, credentialBindingId: 3, callerGenerationId: "generation-1", routePolicyVersion: 4, routePolicyDigestSha256: digest, extensionSpecDigestSha256: digest };

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    gates: { outboundRouting: true, receiverProfile: false },
    execute: vi.fn(async () => ({ ok: true, result: { message: {} }, record: {} })),
    getTaskProjection: vi.fn(async () => ({ handle: "handle", targetAgentId: 1, targetLabel: "Agent one", state: A2ATaskState.WORKING, updatedAt: "2026-07-16T00:00:00.000Z", terminal: false })),
    getTaskRoute: vi.fn(async () => ({ handle: "task_handle_123456", operationId: "initial-op", targetAgentId: 1, targetLabel: "Agent one", lineage, credentialRevisionId: 11, remoteTaskId: "remote-task", remoteContextId: "remote-context", messageId: "initial-message", state: A2ATaskState.INPUT_REQUIRED })),
    getOperationRecoveryRoute: vi.fn(async () => null),
    hasTaskAction: vi.fn(async () => false),
    taskActionDisposition: vi.fn(async () => ({ kind: "none" })),
    ready: vi.fn(async () => undefined),
    wrapReceiver: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

function ids() {
  let index = 0;
  return () => `host_minted_id_${String(++index).padStart(3, "0")}`;
}

describe("production remote A2A action controller", () => {
  it("host-mints authority and DLP-masks renderer intent before initial SendMessage", async () => {
    const value = runtime();
    const controller = createRemoteA2AActionController({ runtime: value as never, config, projectRoot: "/project", makeId: ids(), now: () => new Date("2026-07-16T00:00:00.000Z") });
    const status = await controller.send({ targetAgentId: 1, intent: "Use sk-abcdefghijklmnopqrstuvwxyz123456 safely" });
    expect(status).toMatchObject({ state: "sent", taskAvailable: true, taskHandle: expect.stringMatching(/^host_minted_id_/) });
    const input = value.execute.mock.calls[0]![0] as any;
    expect(input.authorization.ownerId).toMatch(/^local-project:[a-f0-9]{64}$/);
    expect(input.authorization.ownerId).not.toBe("local-user");
    expect(input.lineage).toEqual(lineage);
    expect(input.intendedCredentialRevisionId).toBe(11);
    expect(input.taskHandle).toMatch(/^host_minted_id_/);
    expect(JSON.stringify(input.request)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("runs prompt-free GetTask with historyLength 0 and the fresh configured same-route revision", async () => {
    const value = runtime();
    const controller = createRemoteA2AActionController({ runtime: value as never, config, projectRoot: "/project", makeId: ids() });
    await controller.get({ taskHandle: "task_handle_123456" });
    const input = value.execute.mock.calls[0]![0] as any;
    expect(input).toMatchObject({ operation: "get", intendedCredentialRevisionId: 13, predecessorCredentialRevisionId: 11 });
    expect(input.request.params).toEqual({ id: "remote-task", historyLength: 0 });
  });

  it("permits Resume only from confirmed INPUT_REQUIRED and never from AUTH_REQUIRED", async () => {
    const value = runtime();
    const controller = createRemoteA2AActionController({ runtime: value as never, config, projectRoot: "/project", makeId: ids() });
    await expect(controller.resume({ taskHandle: "task_handle_123456", intent: "continue" })).resolves.toMatchObject({ state: "sent" });
    value.getTaskRoute.mockResolvedValueOnce({ ...(await value.getTaskRoute()), state: A2ATaskState.AUTH_REQUIRED } as never);
    await expect(controller.resume({ taskHandle: "task_handle_123456", intent: "password is secret" })).rejects.toThrow("a2a-remote-task-not-input-required");
    expect(value.execute).toHaveBeenCalledOnce();
  });

  it("blocks a second continuation mutation until prompt-free GetTask reconciles the prior fence", async () => {
    const value = runtime({ taskActionDisposition: vi.fn(async (_handle: string, operation: string) => operation === "continue" ? { kind: "blocked", outcome: "post-socket-validation-ambiguous" } : { kind: "none" }) });
    const controller = createRemoteA2AActionController({ runtime: value as never, config, projectRoot: "/project", makeId: ids() });
    await expect(controller.resume({ taskHandle: "task_handle_123456", intent: "continue again" })).resolves.toMatchObject({ state: "failed", outcome: "continue-reconciliation-required:post-socket-validation-ambiguous" });
    expect(value.execute).not.toHaveBeenCalled();
  });

  it("replays only an outcome-unknown operation handle without requiring a Task route", async () => {
    const value = runtime({
      getTaskRoute: vi.fn(async () => { throw new Error("must-not-read-task-route"); }),
      getOperationRecoveryRoute: vi.fn(async () => ({ handle: "recovery_handle_123", operationId: "initial-op", targetAgentId: 1, targetLabel: "Agent one", lineage, messageId: "initial-message", credentialRevisionId: 11 })),
    });
    const controller = createRemoteA2AActionController({ runtime: value as never, config, projectRoot: "/project", makeId: ids() });
    await expect(controller.replay({ taskHandle: "recovery_handle_123" })).resolves.toMatchObject({ state: "sent" });
    expect(value.getTaskRoute).not.toHaveBeenCalled();
    expect(value.execute).toHaveBeenCalledWith(expect.objectContaining({ operation: "replay", operationId: "initial-op", intendedCredentialRevisionId: 12, predecessorCredentialRevisionId: 11, messageId: "initial-message" }));
  });

  it("reuses an authorized active revision when no rotation successor exists and rejects stale revisions", async () => {
    const sameRevisionConfig = { ...config, targets: [{ ...config.targets[0]!, replayCredentialRevisionIds: [] }] };
    const same = runtime({ getOperationRecoveryRoute: vi.fn(async () => ({ handle: "recovery_handle_123", operationId: "initial-op", targetAgentId: 1, targetLabel: "Agent one", lineage, messageId: "initial-message", credentialRevisionId: 11 })) });
    const sameController = createRemoteA2AActionController({ runtime: same as never, config: sameRevisionConfig, projectRoot: "/project", makeId: ids() });
    await sameController.replay({ taskHandle: "recovery_handle_123" });
    expect(same.execute).toHaveBeenCalledWith(expect.objectContaining({ intendedCredentialRevisionId: 11, predecessorCredentialRevisionId: 11 }));

    const stale = runtime({ getOperationRecoveryRoute: vi.fn(async () => ({ handle: "recovery_handle_123", operationId: "initial-op", targetAgentId: 1, targetLabel: "Agent one", lineage, messageId: "initial-message", credentialRevisionId: 99 })) });
    const staleController = createRemoteA2AActionController({ runtime: stale as never, config, projectRoot: "/project", makeId: ids() });
    await expect(staleController.replay({ taskHandle: "recovery_handle_123" })).rejects.toThrow("a2a-remote-recovery-revision-not-authorized");
    expect(stale.execute).not.toHaveBeenCalled();
  });

  it("returns a successful stored Cancel projection locally and blocks ambiguous prior Cancel without a second socket", async () => {
    const canceledRoute = { ...(await runtime().getTaskRoute()), state: A2ATaskState.CANCELED };
    const success = runtime({ getTaskRoute: vi.fn(async () => canceledRoute), taskActionDisposition: vi.fn(async () => ({ kind: "success", projection: { handle: "task_handle_123456", targetAgentId: 1, targetLabel: "Agent one", state: A2ATaskState.CANCELED, updatedAt: "2026-07-16T00:00:00.000Z", terminal: true } })) });
    const successController = createRemoteA2AActionController({ runtime: success as never, config, projectRoot: "/project", makeId: ids() });
    await expect(successController.cancel({ taskHandle: "task_handle_123456" })).resolves.toMatchObject({ state: "sent", outcome: "cancel-already-settled", taskState: A2ATaskState.CANCELED });
    await expect(successController.cancel({ taskHandle: "task_handle_123456" })).resolves.toMatchObject({ state: "sent", outcome: "cancel-already-settled", taskState: A2ATaskState.CANCELED });
    expect(success.execute).not.toHaveBeenCalled();

    const blocked = runtime({ getTaskRoute: vi.fn(async () => canceledRoute), taskActionDisposition: vi.fn(async () => ({ kind: "blocked", outcome: "transport-ambiguous" })) });
    const blockedController = createRemoteA2AActionController({ runtime: blocked as never, config, projectRoot: "/project", makeId: ids() });
    await expect(blockedController.cancel({ taskHandle: "task_handle_123456" })).resolves.toMatchObject({ state: "failed", outcome: "cancel-reconciliation-required:transport-ambiguous" });
    expect(blocked.execute).not.toHaveBeenCalled();

    const completed = runtime({ getTaskRoute: vi.fn(async () => ({ ...canceledRoute, state: A2ATaskState.COMPLETED })) });
    const completedController = createRemoteA2AActionController({ runtime: completed as never, config, projectRoot: "/project", makeId: ids() });
    await expect(completedController.cancel({ taskHandle: "task_handle_123456" })).rejects.toThrow("a2a-remote-task-terminal");
    expect(completed.execute).not.toHaveBeenCalled();
  });

  it("does not expose runtime/provider/store error messages to renderer outcomes", async () => {
    const sendRuntime = runtime({ execute: vi.fn(async () => { throw new Error("private-gate-provider-detail"); }) });
    const sendController = createRemoteA2AActionController({ runtime: sendRuntime as never, config, projectRoot: "/project", makeId: ids() });
    const send = await sendController.send({ targetAgentId: 1, intent: "hello" });
    expect(send).toMatchObject({ state: "failed", outcome: "a2a-remote-send-failed" });
    expect(JSON.stringify(send)).not.toContain("private-gate-provider-detail");

    const taskRuntime = runtime({ execute: vi.fn(async () => { throw new Error("private-store-detail"); }) });
    const taskController = createRemoteA2AActionController({ runtime: taskRuntime as never, config, projectRoot: "/project", makeId: ids() });
    const taskStatus = await taskController.get({ taskHandle: "task_handle_123456" });
    expect(taskStatus).toMatchObject({ state: "failed", outcome: "a2a-remote-task-action-failed" });
    expect(JSON.stringify(taskStatus)).not.toContain("private-store-detail");

    const replayRuntime = runtime({
      execute: vi.fn(async () => { throw new Error("private-replay-provider-detail"); }),
      getOperationRecoveryRoute: vi.fn(async () => ({ handle: "recovery_handle_123", operationId: "initial-op", targetAgentId: 1, targetLabel: "Agent one", lineage, messageId: "initial-message", credentialRevisionId: 11 })),
    });
    const replayController = createRemoteA2AActionController({ runtime: replayRuntime as never, config, projectRoot: "/project", makeId: ids() });
    const replayStatus = await replayController.replay({ taskHandle: "recovery_handle_123" });
    expect(replayStatus).toMatchObject({ state: "failed", recoveryEligible: true, outcome: "a2a-remote-replay-failed" });
    expect(replayController.status()).toEqual(replayStatus);
    expect(JSON.stringify(replayStatus)).not.toContain("private-replay-provider-detail");
    await expect(replayController.replay({ taskHandle: "recovery_handle_123" })).resolves.toMatchObject({
      state: "failed",
      outcome: "a2a-remote-replay-failed",
    });
    expect(replayRuntime.execute).toHaveBeenCalledTimes(2);
  });
});
