import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { A2AJsonRpcMethod } from "../../shared/a2a-wire.js";
import { A2A_EXACT_SEND_REPLAY_URI, type A2ARemotePreparedAttempt, type A2ARemoteResolvedFields } from "../a2a-remote-contracts.js";
import { A2ARemoteDurableStore, INTENDED_CREDENTIAL_REVISION_CONFLICT, createA2APayloadAad } from "../a2a-remote-store.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const digest = "a".repeat(64);
const lineage = { targetAgentId: 1, interfaceUrl: "https://agent.example.test/a2a", agentCardDigestSha256: digest, trustKeyId: 2, credentialBindingId: 3, callerGenerationId: "generation-1", routePolicyVersion: 4, routePolicyDigestSha256: digest, extensionSpecDigestSha256: digest };
const encryption = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() };

function prepared(overrides: Partial<A2ARemotePreparedAttempt> = {}): A2ARemotePreparedAttempt {
  return {
    operationId: "operation-1",
    attemptId: "initial-attempt",
    ownerToken: "initial-owner",
    ownerDigestSha256: sha("owner"),
    projectRootDigestSha256: sha("/project"),
    profileDigestSha256: sha("profile"),
    originDigestSha256: sha("user"),
    operation: "initial-send",
    method: A2AJsonRpcMethod.SEND_MESSAGE,
    lineage,
    depth: 0,
    semanticRequestHash: "b".repeat(64),
    messageId: "message-1",
    taskHandle: "task_handle_123456",
    targetLabel: "Agent one",
    approvalDecisionId: "approval-1",
    approvalDecidedAt: "2026-07-16T00:00:00.000Z",
    createdAt: "2026-07-16T00:00:00.000Z",
    attemptDeadline: "2026-07-16T00:10:00.000Z",
    intendedCredentialRevisionId: 11,
    ...overrides,
  };
}

function resolved(record: A2ARemotePreparedAttempt, revision = record.intendedCredentialRevisionId): A2ARemoteResolvedFields {
  return {
    snapshotId: `snapshot-${revision}`,
    credentialRevisionId: revision,
    resolvedAt: "2026-07-16T00:00:00.000Z",
    snapshotIssuedAt: "2026-07-16T00:00:00.000Z",
    snapshotExpiresAt: "2099-01-01T00:00:00.000Z",
    operation: record.operation,
    method: record.method,
    extensionUri: A2A_EXACT_SEND_REPLAY_URI,
    lineage: record.lineage,
    semanticRequestHash: record.semanticRequestHash,
    ownerDigestSha256: record.ownerDigestSha256!,
    projectRootDigestSha256: record.projectRootDigestSha256!,
    profileDigestSha256: record.profileDigestSha256!,
    originDigestSha256: record.originDigestSha256!,
    ...(record.approvalDecisionId ? { approvalDecisionId: record.approvalDecisionId } : {}),
    ...(record.approvalDecidedAt ? { approvalDecidedAt: record.approvalDecidedAt } : {}),
    ...(record.taskHandle ? { taskHandle: record.taskHandle } : {}),
    ...(record.payloadRecordId ? { payloadRecordId: record.payloadRecordId } : {}),
    ...(record.payloadCiphertextSha256 ? { payloadCiphertextSha256: record.payloadCiphertextSha256 } : {}),
    ...(record.payloadBodySha256 ? { payloadBodySha256: record.payloadBodySha256 } : {}),
    ...(record.payloadSize ? { payloadSize: record.payloadSize } : {}),
  };
}

function fixture(options: { maxAttempts?: number; now?: () => Date; writeJson?: (name: string, value: unknown) => Promise<void> } = {}) {
  let disk: any;
  const namespace = {
    readJson: async <T>(_name: string, fallback: T) => structuredClone((disk ?? fallback) as T),
    writeJson: options.writeJson ?? (async (_name: string, value: unknown) => { disk = structuredClone(value); }),
  };
  const store = new A2ARemoteDurableStore({ namespace, encryption, random: (size) => Buffer.alloc(size, 3), now: options.now ?? (() => new Date("2026-07-16T00:01:00.000Z")), maxAttempts: options.maxAttempts });
  return { store, namespace, disk: () => disk, setDisk: (value: unknown) => { disk = structuredClone(value); } };
}

async function prepareAmbiguousInitial(store: A2ARemoteDurableStore) {
  const body = Buffer.from('{"jsonrpc":"2.0","id":1}');
  const base = prepared();
  const aad = createA2APayloadAad({ ownerId: "owner", operationId: base.operationId, messageId: base.messageId!, bodySha256: sha(body.toString()), lineage });
  const stored = await store.prepare(base, { body, aad });
  if (!stored.ok) throw new Error("fixture prepare failed");
  await store.resolveCas(base.attemptId, resolved(stored.record.prepared));
  await store.transition(base.attemptId, ["resolved"], "in-flight");
  await store.transition(base.attemptId, ["in-flight"], "outcome-unknown", { outcomeCode: "transport-ambiguous" });
  return stored.record.prepared;
}

describe("remote durable recovery lifecycle", () => {
  it("bounds deterministic revision losers without evicting a live winner", async () => {
    const f = fixture({ maxAttempts: 2 });
    const winner = prepared({ operation: "get", method: A2AJsonRpcMethod.GET_TASK, messageId: undefined, approvalDecisionId: undefined, approvalDecidedAt: undefined, attemptId: "winner", ownerToken: "winner-owner" });
    await f.store.prepare(winner);
    await f.store.recordNotSent(prepared({ ...winner, attemptId: "loser-1", ownerToken: "loser-owner-1", intendedCredentialRevisionId: 12 }), INTENDED_CREDENTIAL_REVISION_CONFLICT);
    await f.store.recordNotSent(prepared({ ...winner, attemptId: "loser-2", ownerToken: "loser-owner-2", intendedCredentialRevisionId: 13 }), INTENDED_CREDENTIAL_REVISION_CONFLICT);
    expect(f.disk().attempts).toHaveLength(2);
    expect(f.disk().attempts.some((item: any) => item.prepared.attemptId === "winner")).toBe(true);
    expect(f.disk().attempts.some((item: any) => item.prepared.attemptId === "loser-1")).toBe(false);

    const blocked = fixture({ maxAttempts: 1 });
    await blocked.store.prepare(winner);
    await expect(blocked.store.recordNotSent(prepared({ ...winner, attemptId: "loser", ownerToken: "loser-owner", intendedCredentialRevisionId: 12 }), INTENDED_CREDENTIAL_REVISION_CONFLICT)).rejects.toThrow("a2a-remote-attempt-capacity-exhausted");
  });

  it("keeps a staged orphan in memory after bind and rollback writes both fail, then retries cleanup", async () => {
    let writes = 0;
    let disk: unknown;
    let now = new Date("2026-07-16T00:00:00.000Z");
    const writeJson = vi.fn(async (_name: string, value: unknown) => {
      writes += 1;
      if (writes === 1 || writes >= 4) { disk = structuredClone(value); return; }
      throw new Error(`write-${writes}-failed`);
    });
    const namespace = { readJson: async <T>(_name: string, fallback: T) => structuredClone((disk ?? fallback) as T), writeJson };
    const store = new A2ARemoteDurableStore({ namespace, encryption, random: (size) => Buffer.alloc(size, 4), now: () => now, orphanTtlMs: 1_000 });
    const body = Buffer.from("payload");
    const base = prepared();
    const aad = createA2APayloadAad({ ownerId: "owner", operationId: base.operationId, messageId: base.messageId!, bodySha256: sha(body.toString()), lineage });
    await expect(store.prepare(base, { body, aad })).rejects.toThrow("write-2-failed");
    expect((disk as any).payloads[0].state).toBe("staged");
    now = new Date("2026-07-16T00:00:01.001Z");
    await expect(store.cleanup()).resolves.toEqual({ orphaned: 1, expired: 0 });
    expect((disk as any).payloads).toHaveLength(0);
  });

  it("terminalizes the whole replay chain on TTL and removes recovery eligibility", async () => {
    let now = new Date("2026-07-16T00:01:00.000Z");
    const f = fixture({ now: () => now });
    const source = await prepareAmbiguousInitial(f.store);
    const replay = prepared({ attemptId: "replay-attempt", ownerToken: "replay-owner", operation: "replay", intendedCredentialRevisionId: 12, predecessorCredentialRevisionId: 11 });
    await f.store.prepare(replay);
    await f.store.resolveCas(replay.attemptId, resolved(replay, 12));
    await f.store.transition(replay.attemptId, ["resolved"], "in-flight");
    await f.store.transition(replay.attemptId, ["in-flight"], "outcome-unknown", { outcomeCode: "transport-ambiguous" });
    now = new Date(source.payloadExpiresAt!);
    await expect(f.store.cleanup()).resolves.toMatchObject({ expired: 1 });
    expect(f.disk().payloads).toHaveLength(0);
    expect(f.disk().attempts.filter((item: any) => item.prepared.operationId === "operation-1").every((item: any) => item.stage === "RETENTION_EXPIRED")).toBe(true);
    await expect(f.store.getOperationRecoveryRoute("task_handle_123456", "owner")).resolves.toBeNull();
  });

  it("refuses arbitrary-operation terminal deletion when replay source bindings differ", async () => {
    const f = fixture();
    await prepareAmbiguousInitial(f.store);
    const replay = prepared({ attemptId: "replay-attempt", ownerToken: "replay-owner", operation: "replay", intendedCredentialRevisionId: 12, predecessorCredentialRevisionId: 11, profileDigestSha256: sha("other-profile") });
    await f.store.prepare(replay);
    await f.store.resolveCas(replay.attemptId, resolved(replay, 12));
    await f.store.transition(replay.attemptId, ["resolved"], "in-flight");
    await expect(f.store.transition(replay.attemptId, ["in-flight"], "settled", { outcomeCode: "success", deletePayload: true })).rejects.toThrow("a2a-remote-replay-source-binding-invalid");
    expect(f.disk().payloads).toHaveLength(1);
    await expect(f.store.getAttempt(replay.attemptId)).resolves.toMatchObject({ stage: "in-flight" });
  });

  it.each(["prepared", "resolved"] as const)(
    "aborts restart-left %s attempts before socket and atomically removes their payload",
    async (restartStage) => {
      const f = fixture();
      const body = Buffer.from('{"jsonrpc":"2.0","id":1}');
      const base = prepared();
      const aad = createA2APayloadAad({
        ownerId: "owner",
        operationId: base.operationId,
        messageId: base.messageId!,
        bodySha256: sha(body.toString()),
        lineage,
      });
      const stored = await f.store.prepare(base, { body, aad });
      if (!stored.ok) throw new Error("fixture prepare failed");
      if (restartStage === "resolved") {
        await f.store.resolveCas(base.attemptId, resolved(stored.record.prepared));
      }

      const restarted = new A2ARemoteDurableStore({
        namespace: f.namespace,
        encryption,
        random: (size) => Buffer.alloc(size, 4),
        now: () => new Date("2026-07-16T00:01:00.000Z"),
      });
      await expect(restarted.getAttempt(base.attemptId)).resolves.toMatchObject({
        stage: "NOT_SENT",
        outcomeCode: "restart-before-socket-aborted",
      });
      expect(f.disk().payloads).toHaveLength(0);
      expect(f.disk().attempts[0].prepared).not.toHaveProperty("payloadRecordId");
    },
  );

  it("turns a restart-left in-flight send into one recoverable ambiguity without deleting bytes", async () => {
    const f = fixture();
    const body = Buffer.from('{"jsonrpc":"2.0","id":1}');
    const base = prepared();
    const aad = createA2APayloadAad({
      ownerId: "owner",
      operationId: base.operationId,
      messageId: base.messageId!,
      bodySha256: sha(body.toString()),
      lineage,
    });
    const stored = await f.store.prepare(base, { body, aad });
    if (!stored.ok) throw new Error("fixture prepare failed");
    await f.store.resolveCas(base.attemptId, resolved(stored.record.prepared));
    await f.store.transition(base.attemptId, ["resolved"], "in-flight");
    const restarted = new A2ARemoteDurableStore({
      namespace: f.namespace,
      encryption,
      random: (size) => Buffer.alloc(size, 4),
      now: () => new Date("2026-07-16T00:01:00.000Z"),
    });
    await expect(restarted.getAttempt(base.attemptId)).resolves.toMatchObject({
      stage: "outcome-unknown",
      outcomeCode: "restart-in-flight-ambiguous",
    });
    expect(f.disk().payloads).toHaveLength(1);
    await expect(restarted.getOperationRecoveryRoute("task_handle_123456", "owner")).resolves.toMatchObject({
      operationId: "operation-1",
      credentialRevisionId: 11,
    });
  });

  it.each([
    ["continue", "TASK_STATE_WORKING"],
    ["cancel", "TASK_STATE_CANCELED"],
  ] as const)("reconciles an ambiguous %s only from an authoritative GetTask projection", async (operation, state) => {
    const f = fixture();
    const initial = prepared({ operationId: "initial-task-op" });
    await f.store.prepare(initial);
    await f.store.resolveCas(initial.attemptId, resolved(initial));
    await f.store.transition(initial.attemptId, ["resolved"], "in-flight");
    await f.store.transition(initial.attemptId, ["in-flight"], "settled", {
      outcomeCode: "success",
      taskProjection: {
        handle: "task_handle_123456",
        ownerId: "owner",
        targetAgentId: 1,
        targetLabel: "Agent one",
        lineage,
        credentialRevisionId: 11,
        task: {
          id: "remote-task",
          contextId: "remote-context",
          status: { state: "TASK_STATE_INPUT_REQUIRED" },
          history: [],
        } as never,
      },
    });

    const mutation = prepared({
      operationId: `${operation}-op`,
      attemptId: `${operation}-attempt`,
      ownerToken: `${operation}-owner`,
      operation,
      method: operation === "cancel" ? A2AJsonRpcMethod.CANCEL_TASK : A2AJsonRpcMethod.SEND_MESSAGE,
      messageId: operation === "continue" ? "continue-message" : undefined,
    });
    await f.store.prepare(mutation);
    await f.store.resolveCas(mutation.attemptId, resolved(mutation));
    await f.store.transition(mutation.attemptId, ["resolved"], "in-flight");
    await f.store.transition(mutation.attemptId, ["in-flight"], "outcome-unknown", {
      outcomeCode: "transport-ambiguous",
    });
    await expect(f.store.taskActionDisposition("task_handle_123456", operation, "owner")).resolves.toMatchObject({
      kind: "blocked",
    });

    const get = prepared({
      operationId: `get-after-${operation}`,
      attemptId: `get-after-${operation}-attempt`,
      ownerToken: `get-after-${operation}-owner`,
      operation: "get",
      method: A2AJsonRpcMethod.GET_TASK,
      messageId: undefined,
      approvalDecisionId: undefined,
      approvalDecidedAt: undefined,
    });
    await f.store.prepare(get);
    await f.store.resolveCas(get.attemptId, resolved(get));
    await f.store.transition(get.attemptId, ["resolved"], "in-flight");
    await f.store.transition(get.attemptId, ["in-flight"], "settled", {
      outcomeCode: "success",
      taskProjection: {
        handle: "task_handle_123456",
        ownerId: "owner",
        targetAgentId: 1,
        targetLabel: "Agent one",
        lineage,
        credentialRevisionId: 11,
        task: {
          id: "remote-task",
          contextId: "remote-context",
          status: { state },
          history: [],
        } as never,
      },
    });

    await expect(f.store.getAttempt(mutation.attemptId)).resolves.toMatchObject({
      stage: "settled",
      outcomeCode: "success",
    });
    await expect(f.store.taskActionDisposition("task_handle_123456", operation, "owner")).resolves.toMatchObject({
      kind: "success",
      projection: { state },
    });
  });
});
