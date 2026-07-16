import { describe, expect, it, vi } from "vitest";
import { A2AJsonRpcMethod } from "../../shared/a2a-wire.js";
import { A2ARemoteClient, type A2ARemoteExecuteInput } from "../a2a-remote-client.js";
import {
  A2A_EXACT_SEND_REPLAY_URI,
  A2A_SPECIFICATION_URI,
  a2aRemoteLineageDigestSha256,
  type A2ARouteSnapshot,
} from "../a2a-remote-contracts.js";
import { A2ARemoteDurableStore } from "../a2a-remote-store.js";

const digest = "a".repeat(64);
const now = () => new Date("2026-07-16T00:00:00.000Z");
const lineage = { targetAgentId: 1, interfaceUrl: "https://agent.example.test/a2a", agentCardDigestSha256: digest, trustKeyId: 2, credentialBindingId: 3, callerGenerationId: "generation-1", routePolicyVersion: 4, routePolicyDigestSha256: digest, extensionSpecDigestSha256: digest };
const authorization = { ownerId: "owner", projectRoot: "/project", profileId: "profile", origin: "user", depth: 0, targetAgentId: 1, interfaceUrl: lineage.interfaceUrl, taskId: "remote-task", contextId: "remote-context" };

function snapshot(revision: number): A2ARouteSnapshot {
  return { ...lineage, snapshotId: `snapshot-${revision}`, credentialRevisionId: revision, credentialVersion: 1, credentialProvider: "vault", credentialExternalVersion: `v${revision}`, advertisedInterfaceId: 6, interfaceHealthObservationId: 7, healthObservedAt: now().toISOString(), healthExpiresAt: "2099-01-01T00:00:00.000Z", wireConformanceArtifactId: "artifact-1", wireConformanceArtifactDigestSha256: digest, servedSpecObservationId: 8, wireConformanceEvidenceId: 9, agentHubHeadSha: "1".repeat(40), lvisAppHeadSha: "2".repeat(40), remoteServerHeadSha: "3".repeat(40), a2aTckTag: "v1.0.0", a2aTckCommitSha: "4".repeat(40), agentHubLockDigestSha256: digest, lvisAppLockDigestSha256: digest, remoteServerLockDigestSha256: digest, a2aTckLockDigestSha256: digest, a2aSpecificationUri: A2A_SPECIFICATION_URI, issuedAt: now().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z", extensionUri: A2A_EXACT_SEND_REPLAY_URI, authenticationScheme: "Bearer", protocolBinding: "JSONRPC", protocolVersion: "1.0" };
}

function task(historyLength: number, state = "TASK_STATE_WORKING") {
  return {
    id: "remote-task",
    contextId: "remote-context",
    status: { state },
    history: Array.from({ length: historyLength }, (_, index) => ({
      messageId: `history-${index}`,
      taskId: "remote-task",
      contextId: "remote-context",
      role: "ROLE_AGENT",
      parts: [{ text: `entry-${index}` }],
    })),
  };
}

function fixture(responseResult: unknown, headers: Record<string, string> = {}) {
  let disk: unknown;
  const prepareSecret = vi.fn(async () => ({ take: () => "secret", zeroize: () => undefined }));
  const resolve = vi.fn(async ({ intendedCredentialRevisionId }) => snapshot(intendedCredentialRevisionId));
  const invoke = vi.fn(async ({ body }: { body: Uint8Array }) => {
    const id = (JSON.parse(Buffer.from(body).toString()) as { id: unknown }).id;
    return { status: 200, headers, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: responseResult })) };
  });
  const namespace = {
    readJson: async <T>(_name: string, fallback: T) => structuredClone((disk ?? fallback) as T),
    writeJson: async (_name: string, value: unknown) => { disk = structuredClone(value); },
  };
  const store = new A2ARemoteDurableStore({ namespace, encryption: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() }, random: (size) => Buffer.alloc(size, 7), now });
  const client = new A2ARemoteClient({
    enabled: true,
    authorizer: { authorize: () => true },
    approver: { approve: async ({ intendedCredentialRevisionId, lineage: approvedLineage, semanticDigestSha256 }) => ({ decisionId: "approval", decidedAt: now().toISOString(), intendedCredentialRevisionId, lineageDigestSha256: a2aRemoteLineageDigestSha256(approvedLineage), semanticDigestSha256 }) },
    store,
    secretResolver: { prepare: prepareSecret },
    controlPlane: { resolve },
    transport: { invoke },
    now,
  });
  return { client, store, disk: () => disk, prepareSecret, resolve, invoke };
}

function getInput(historyLength: number): A2ARemoteExecuteInput {
  return { operationId: `get-${historyLength}`, attemptId: `attempt-${historyLength}`, operation: "get", taskHandle: "task_handle_123456", targetLabel: "Agent one", authorization, lineage, intendedCredentialRevisionId: 11, request: { id: 1, method: A2AJsonRpcMethod.GET_TASK, params: { id: "remote-task", historyLength } } };
}

describe("remote Task historyLength response binding", () => {
  it.each([
    [0, 0],
    [2, 2],
  ])("accepts history bounded by the exact GetTask request (%i/%i)", async (requested, returned) => {
    const f = fixture(task(returned));
    await expect(f.client.execute(getInput(requested))).resolves.toMatchObject({ ok: true });
    await expect(f.store.getTaskProjection("task_handle_123456", "owner")).resolves.toMatchObject({ state: "TASK_STATE_WORKING" });
  });

  it("treats over-returned GetTask history as post-socket ambiguous and stores no Task", async () => {
    const f = fixture(task(2));
    await expect(f.client.execute(getInput(1))).resolves.toMatchObject({
      ok: false,
      outcome: "unknown-manual-reconciliation-required",
      record: { stage: "outcome-unknown", outcomeCode: "post-socket-validation-ambiguous" },
    });
    await expect(f.store.getTaskProjection("task_handle_123456", "owner")).resolves.toBeNull();
  });

  it("rejects negative historyLength before secret, Hub, or socket work", async () => {
    const f = fixture(task(0));
    await expect(f.client.execute(getInput(-1))).rejects.toThrow("a2a-remote-history-length-invalid");
    expect(f.prepareSecret).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.disk()).toBeUndefined();
  });

  it.each(["initial-send", "cancel"] as const)("retains the protocol max history policy for %s results", async (operation) => {
    const resultTask = task(1, operation === "cancel" ? "TASK_STATE_CANCELED" : "TASK_STATE_WORKING");
    const f = fixture(
      operation === "initial-send" ? { task: resultTask } : resultTask,
      operation === "initial-send" ? { "a2a-extensions": A2A_EXACT_SEND_REPLAY_URI } : {},
    );
    const input: A2ARemoteExecuteInput = operation === "initial-send"
      ? { operationId: "send-op", attemptId: "send-attempt", operation, taskHandle: "task_handle_123456", targetLabel: "Agent one", authorization: { ...authorization, taskId: undefined, contextId: undefined }, lineage, intendedCredentialRevisionId: 11, request: { id: 3, method: A2AJsonRpcMethod.SEND_MESSAGE, params: { message: { messageId: "message-1", role: "ROLE_USER", parts: [{ text: "hello" }] } } }, messageId: "message-1" }
      : { operationId: "cancel-op", attemptId: "cancel-attempt", operation, taskHandle: "task_handle_123456", targetLabel: "Agent one", authorization, lineage, intendedCredentialRevisionId: 11, request: { id: 4, method: A2AJsonRpcMethod.CANCEL_TASK, params: { id: "remote-task" } } };
    await expect(f.client.execute(input)).resolves.toMatchObject({ ok: true });
  });
});
