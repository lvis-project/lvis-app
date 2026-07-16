import { describe, expect, it, vi } from "vitest";
import { A2AJsonRpcMethod } from "../../shared/a2a-wire.js";
import { A2ARemoteClient } from "../a2a-remote-client.js";
import { A2A_EXACT_SEND_REPLAY_URI, A2A_SPECIFICATION_URI, a2aRemoteLineageDigestSha256, type A2ARouteSnapshot } from "../a2a-remote-contracts.js";
import { A2ARemoteDurableStore } from "../a2a-remote-store.js";

const digest = "a".repeat(64);
const lineage = { targetAgentId: 1, interfaceUrl: "https://agent.example.test/a2a", agentCardDigestSha256: digest, trustKeyId: 2, credentialBindingId: 3, callerGenerationId: "generation-1", routePolicyVersion: 4, routePolicyDigestSha256: digest, extensionSpecDigestSha256: digest };
const now = () => new Date("2026-07-16T00:00:00.000Z");
function snapshot(): A2ARouteSnapshot { return { ...lineage, snapshotId: "snapshot-11", credentialRevisionId: 11, credentialVersion: 1, credentialProvider: "vault", credentialExternalVersion: "v11", advertisedInterfaceId: 6, interfaceHealthObservationId: 7, healthObservedAt: now().toISOString(), healthExpiresAt: "2099-01-01T00:00:00.000Z", wireConformanceArtifactId: "artifact-1", wireConformanceArtifactDigestSha256: digest, servedSpecObservationId: 8, wireConformanceEvidenceId: 9, agentHubHeadSha: "1".repeat(40), lvisAppHeadSha: "2".repeat(40), remoteServerHeadSha: "3".repeat(40), a2aTckTag: "v1.0.0", a2aTckCommitSha: "4".repeat(40), agentHubLockDigestSha256: digest, lvisAppLockDigestSha256: digest, remoteServerLockDigestSha256: digest, a2aTckLockDigestSha256: digest, a2aSpecificationUri: A2A_SPECIFICATION_URI, issuedAt: now().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z", extensionUri: A2A_EXACT_SEND_REPLAY_URI, authenticationScheme: "Bearer", protocolBinding: "JSONRPC", protocolVersion: "1.0" }; }

function setup(result: unknown) {
  let disk: any;
  const writes: any[] = [];
  const store = new A2ARemoteDurableStore({
    namespace: {
      readJson: async <T>(_name: string, fallback: T) => structuredClone((disk ?? fallback) as T),
      writeJson: async (_name: string, value: unknown) => { disk = structuredClone(value); writes.push(structuredClone(value)); },
    },
    encryption: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
    random: (size) => Buffer.alloc(size, 5),
    now,
  });
  const client = new A2ARemoteClient({
    enabled: true,
    authorizer: { authorize: () => true },
    approver: { approve: async ({ intendedCredentialRevisionId, lineage: approvedLineage, semanticDigestSha256 }) => ({ decisionId: "approval-real", decidedAt: now().toISOString(), intendedCredentialRevisionId, lineageDigestSha256: a2aRemoteLineageDigestSha256(approvedLineage), semanticDigestSha256 }) },
    store,
    secretResolver: { prepare: async () => ({ take: () => "secret", zeroize: () => undefined }) },
    controlPlane: { resolve: async () => snapshot() },
    transport: { invoke: vi.fn(async () => ({ status: 200, headers: { "a2a-extensions": A2A_EXACT_SEND_REPLAY_URI }, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result })) })) },
    now,
  });
  const execute = () => client.execute({
    operationId: "operation-1",
    attemptId: "attempt-1",
    operation: "initial-send",
    taskHandle: "opaque_task_handle_1",
    targetLabel: "Agent one",
    authorization: { ownerId: "owner", projectRoot: "/project", profileId: "profile", origin: "user", depth: 0, targetAgentId: 1, interfaceUrl: lineage.interfaceUrl },
    lineage,
    intendedCredentialRevisionId: 11,
    request: { id: 1, method: A2AJsonRpcMethod.SEND_MESSAGE, params: { message: { messageId: "message-1", role: "ROLE_USER", parts: [{ text: "work" }] } } },
    messageId: "message-1",
  });
  return { execute, store, writes, disk: () => disk };
}

function task(state: string, withMessage = true) {
  return {
    task: {
      id: "remote-task",
      contextId: "remote-context",
      status: {
        state,
        timestamp: now().toISOString(),
        ...(withMessage ? { message: { messageId: "status-message", taskId: "remote-task", contextId: "remote-context", role: "ROLE_AGENT", parts: [{ text: "remote says sk-abcdefghijklmnopqrstuvwxyz123456" }] } } : {}),
      },
      history: [],
    },
  };
}

describe("encrypted remote Task registry", () => {
  it("atomically settles and stores only an encrypted full Task behind an opaque handle", async () => {
    const value = setup(task("TASK_STATE_WORKING"));
    await expect(value.execute()).resolves.toMatchObject({ ok: true });
    const disk = value.disk();
    expect(disk.attempts[0]).toMatchObject({ stage: "settled", outcomeCode: "success" });
    expect(disk.tasks).toHaveLength(1);
    expect(disk.tasks[0]).toMatchObject({ handle: "opaque_task_handle_1", taskState: "TASK_STATE_WORKING", ciphertext: expect.any(String) });
    expect(JSON.stringify(disk)).not.toContain("remote-task");
    expect(JSON.stringify(disk)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    const atomicWrite = value.writes.find((entry) => entry.attempts?.[0]?.stage === "settled");
    expect(atomicWrite.tasks).toHaveLength(1);
    await expect(value.store.getTaskProjection("opaque_task_handle_1", "owner")).resolves.toMatchObject({ state: "TASK_STATE_WORKING", terminal: false });
    await expect(value.store.getTaskRoute("opaque_task_handle_1", "owner")).resolves.toMatchObject({ remoteTaskId: "remote-task", remoteContextId: "remote-context", credentialRevisionId: 11 });
  });

  it("keeps AUTH_REQUIRED as an explanatory out-of-band state and rejects message-less variants", async () => {
    const accepted = setup(task("TASK_STATE_AUTH_REQUIRED"));
    await expect(accepted.execute()).resolves.toMatchObject({ ok: false, outcome: "authentication-required-out-of-band", record: { stage: "settled", outcomeCode: "authentication-required-out-of-band" } });
    await expect(accepted.store.getTaskProjection("opaque_task_handle_1", "owner")).resolves.toMatchObject({ state: "TASK_STATE_AUTH_REQUIRED" });

    const rejected = setup(task("TASK_STATE_AUTH_REQUIRED", false));
    await expect(rejected.execute()).resolves.toMatchObject({ ok: false, outcome: "unknown-manual-reconciliation-required", record: { stage: "outcome-unknown", outcomeCode: "post-socket-validation-ambiguous" } });
    await expect(rejected.store.getTaskProjection("opaque_task_handle_1", "owner")).resolves.toBeNull();
  });
});
