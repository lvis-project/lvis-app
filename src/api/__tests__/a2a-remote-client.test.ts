import { describe, expect, it, vi } from "vitest";
import { A2AJsonRpcMethod } from "../../shared/a2a-wire.js";
import { A2ARemoteClient } from "../a2a-remote-client.js";
import { A2A_EXACT_SEND_REPLAY_URI, A2A_SPECIFICATION_URI, a2aRemoteLineageDigestSha256, type A2ARouteSnapshot } from "../a2a-remote-contracts.js";
import { A2ARemoteDurableStore } from "../a2a-remote-store.js";

const digest = "a".repeat(64);
const lineage = { targetAgentId: 1, interfaceUrl: "https://agent.example.test/a2a", agentCardDigestSha256: digest, trustKeyId: 2, credentialBindingId: 3, callerGenerationId: "generation-1", routePolicyVersion: 4, routePolicyDigestSha256: digest, extensionSpecDigestSha256: digest };
function snapshot(revision: number): A2ARouteSnapshot { return { ...lineage, snapshotId: `snapshot-${revision}`, credentialRevisionId: revision, credentialVersion: 1, credentialProvider: "vault", credentialExternalVersion: `v${revision}`, advertisedInterfaceId: 6, interfaceHealthObservationId: 7, healthObservedAt: "2026-07-16T00:00:00.000Z", healthExpiresAt: "2099-01-01T00:00:00.000Z", wireConformanceArtifactId: "artifact-1", wireConformanceArtifactDigestSha256: digest, servedSpecObservationId: 8, wireConformanceEvidenceId: 9, controlPlaneHeadSha: "1".repeat(40), lvisAppHeadSha: "2".repeat(40), remoteServerHeadSha: "3".repeat(40), a2aTckTag: "v1.0.0", a2aTckCommitSha: "4".repeat(40), controlPlaneLockDigestSha256: digest, lvisAppLockDigestSha256: digest, remoteServerLockDigestSha256: digest, a2aTckLockDigestSha256: digest, a2aSpecificationUri: A2A_SPECIFICATION_URI, issuedAt: "2026-07-16T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", extensionUri: A2A_EXACT_SEND_REPLAY_URI, authenticationScheme: "Bearer", protocolBinding: "JSONRPC", protocolVersion: "1.0" }; }

describe("A2A remote exact initial replay", () => {
  it.each([
    ["explicit deny", "deny"],
    ["thrown gate", "throw"],
    ["timeout-shaped rejection", "timeout"],
  ])("normalizes %s before journal, secret, Hub, or socket effects", async (_label, mode) => {
    let disk: unknown;
    const prepareSecret = vi.fn();
    const resolve = vi.fn();
    const invoke = vi.fn();
    const audit = vi.fn();
    const raw = `private-approval-${mode}-detail`;
    const store = new A2ARemoteDurableStore({
      namespace: {
        readJson: async <T>(_name: string, fallback: T) => structuredClone((disk ?? fallback) as T),
        writeJson: async (_name: string, value: unknown) => { disk = structuredClone(value); },
      },
      encryption: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
      random: (size) => Buffer.alloc(size, 6),
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    });
    const client = new A2ARemoteClient({
      enabled: true,
      authorizer: { authorize: () => true },
      approver: {
        approve: async () => {
          if (mode === "deny") return null;
          throw new Error(raw);
        },
      },
      store,
      secretResolver: { prepare: prepareSecret },
      controlPlane: { resolve },
      transport: { invoke },
      audit,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    });
    const result = await client.execute({
      operationId: `approval-${mode}`,
      attemptId: `attempt-${mode}`,
      operation: "initial-send",
      targetLabel: "Agent one",
      authorization: { ownerId: "owner", projectRoot: "/project", profileId: "profile", origin: "user", depth: 0, targetAgentId: 1, interfaceUrl: lineage.interfaceUrl },
      lineage,
      intendedCredentialRevisionId: 11,
      request: { id: 1, method: A2AJsonRpcMethod.SEND_MESSAGE, params: { message: { messageId: `message-${mode}`, role: "ROLE_USER", parts: [{ text: "hello" }] } } },
      messageId: `message-${mode}`,
    });
    expect(result).toEqual({ ok: false, outcome: "not-sent" });
    expect(JSON.stringify(result)).not.toContain(raw);
    expect(disk).toBeUndefined();
    expect(prepareSecret).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith({ type: "a2a-remote-operation", operation: "initial-send", outcome: "approval-denied", code: "foreground-approval-failed" });
  });

  it("reuses the encrypted original byte sequence and original JSON-RPC ID", async () => {
    let disk: unknown;
    const now = () => new Date("2026-07-16T00:01:00.000Z");
    const namespace = { readJson: async <T>(_n: string, fallback: T) => structuredClone((disk ?? fallback) as T), writeJson: async (_n: string, value: unknown) => { disk = structuredClone(value); } };
    const encryption = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v.toString() };
    const store = new A2ARemoteDurableStore({ namespace, encryption, random: (size) => Buffer.alloc(size, 9), now });
    const bodies: Buffer[] = [];
    const transport = { invoke: vi.fn(async ({ body }: { body: Uint8Array }) => { bodies.push(Buffer.from(body)); if (bodies.length < 3) throw new Error("socket-lost"); return { status: 200, headers: { "a2a-extensions": A2A_EXACT_SEND_REPLAY_URI }, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 41, result: { message: { messageId: "reply-1", role: "ROLE_AGENT", parts: [{ text: "ok" }] } } })) }; }) };
    const approve = vi.fn(async ({ intendedCredentialRevisionId, lineage: approvedLineage, semanticDigestSha256 }) => ({ decisionId: "approval", decidedAt: "2026-07-16T00:00:00.000Z", intendedCredentialRevisionId, lineageDigestSha256: a2aRemoteLineageDigestSha256(approvedLineage), semanticDigestSha256 }));
    const resolve = vi.fn(async ({ intendedCredentialRevisionId }) => snapshot(intendedCredentialRevisionId));
    const client = new A2ARemoteClient({ enabled: true, authorizer: { authorize: () => true }, approver: { approve }, store, secretResolver: { prepare: async () => ({ take: () => "data-plane-only", zeroize: () => undefined }) }, controlPlane: { resolve }, transport, now });
    const authorization = { ownerId: "owner", projectRoot: "/project", profileId: "profile", origin: "user", depth: 0, targetAgentId: 1, interfaceUrl: lineage.interfaceUrl };
    const initialInput = { operationId: "op", attemptId: "first", operation: "initial-send" as const, targetLabel: "Agent one", authorization, lineage, intendedCredentialRevisionId: 11, request: { id: 41, method: A2AJsonRpcMethod.SEND_MESSAGE, params: { message: { messageId: "message-1", role: "ROLE_USER", parts: [{ text: "original" }] } } }, messageId: "message-1" };
    const initialPromise = client.execute(initialInput);
    const joinedPromise = client.execute({ ...initialInput, attemptId: "joined" });
    expect(joinedPromise).toBe(initialPromise);
    const [initial, joined] = await Promise.all([initialPromise, joinedPromise]);
    expect(joined).toEqual(initial); expect(approve).toHaveBeenCalledOnce(); expect(resolve).toHaveBeenCalledOnce(); expect(transport.invoke).toHaveBeenCalledOnce();
    expect(initial).toMatchObject({ ok: false, outcome: "unknown-manual-reconciliation-required" });
    const forbiddenRestartSend = await client.execute({ ...initialInput, attemptId: "restart-new-initial" });
    expect(forbiddenRestartSend).toMatchObject({ ok: false, outcome: "conflict" });
    expect(transport.invoke).toHaveBeenCalledOnce(); expect(resolve).toHaveBeenCalledOnce();
    const replay = await client.execute({ operationId: "op", attemptId: "replay", operation: "replay", authorization, lineage, intendedCredentialRevisionId: 12, predecessorCredentialRevisionId: 11, request: { id: 999, method: A2AJsonRpcMethod.SEND_MESSAGE, params: { message: { messageId: "message-1", role: "ROLE_USER", parts: [{ text: "must-not-serialize" }] } } }, messageId: "message-1" });
    expect(replay).toMatchObject({ ok: false, outcome: "unknown-manual-reconciliation-required" });
    expect((disk as { payloads: unknown[] }).payloads).toHaveLength(1);
    const replayAgain = await client.execute({ operationId: "op", attemptId: "replay-again", operation: "replay", authorization, lineage, intendedCredentialRevisionId: 13, predecessorCredentialRevisionId: 12, request: { id: 1_000, method: A2AJsonRpcMethod.SEND_MESSAGE, params: { message: { messageId: "message-1", role: "ROLE_USER", parts: [{ text: "also-must-not-serialize" }] } } }, messageId: "message-1" });
    expect(replayAgain).toMatchObject({ ok: true });
    expect((disk as { payloads: unknown[] }).payloads).toHaveLength(0);
    expect((disk as { attempts: Array<{ prepared: Record<string, unknown> }> }).attempts
      .find((entry) => entry.prepared.attemptId === "first")?.prepared)
      .not.toHaveProperty("payloadRecordId");
    // A late owner from the pre-replay socket cannot re-settle or resurrect
    // the atomically deleted ciphertext.
    await expect(store.transition("first", ["in-flight"], "settled", {
      outcomeCode: "late-success",
      deletePayload: true,
    })).resolves.toBeNull();
    const restarted = new A2ARemoteDurableStore({ namespace, encryption, random: (size) => Buffer.alloc(size, 8), now });
    await expect(restarted.cleanup()).resolves.toEqual({ orphaned: 0, expired: 0 });
    await expect(restarted.findReplaySource("op")).resolves.toBeNull();
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[1]!.toString()).not.toContain("must-not-serialize");
    expect(bodies[2]!.toString()).not.toContain("also-must-not-serialize");
    expect(approve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls.map(([request]) => request.intendedCredentialRevisionId)).toEqual([11, 12, 13]);
  });

  it.each([
    ["authentication", { status: 401, headers: {}, body: Buffer.alloc(0) }, "authentication-failed"],
    ["terminal extension", { status: 200, headers: { "a2a-extensions": A2A_EXACT_SEND_REPLAY_URI }, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 41, error: { code: -32090, message: "Exact send replay conflict", data: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "EXACT_SEND_REPLAY_CONFLICT", domain: A2A_EXACT_SEND_REPLAY_URI }] } })) }, "conflict"],
    ["remote error", { status: 200, headers: { "a2a-extensions": A2A_EXACT_SEND_REPLAY_URI }, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 41, error: { code: -32001, message: "Remote error" } })) }, "remote-error"],
  ])("atomically deletes the source payload after replay %s settlement", async (_label, terminalResponse, outcome) => {
    let disk: any;
    const store = new A2ARemoteDurableStore({ namespace: { readJson: async <T>(_name: string, fallback: T) => structuredClone((disk ?? fallback) as T), writeJson: async (_name: string, value: unknown) => { disk = structuredClone(value); } }, encryption: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() }, random: (size) => Buffer.alloc(size, 4), now: () => new Date("2026-07-16T00:01:00.000Z") });
    let calls = 0;
    const client = new A2ARemoteClient({
      enabled: true,
      authorizer: { authorize: () => true },
      approver: { approve: async ({ intendedCredentialRevisionId, lineage: approvedLineage, semanticDigestSha256 }) => ({ decisionId: "approval", decidedAt: "2026-07-16T00:00:00.000Z", intendedCredentialRevisionId, lineageDigestSha256: a2aRemoteLineageDigestSha256(approvedLineage), semanticDigestSha256 }) },
      store,
      secretResolver: { prepare: async () => ({ take: () => "secret", zeroize: () => undefined }) },
      controlPlane: { resolve: async ({ intendedCredentialRevisionId }) => snapshot(intendedCredentialRevisionId) },
      transport: { invoke: vi.fn(async () => { calls += 1; if (calls === 1) throw new Error("ambiguous"); return terminalResponse; }) },
      now: () => new Date("2026-07-16T00:01:00.000Z"),
    });
    const authorization = { ownerId: "owner", projectRoot: "/project", profileId: "profile", origin: "user", depth: 0, targetAgentId: 1, interfaceUrl: lineage.interfaceUrl };
    await client.execute({ operationId: "terminal-op", attemptId: "initial", operation: "initial-send", targetLabel: "Agent one", authorization, lineage, intendedCredentialRevisionId: 11, request: { id: 41, method: A2AJsonRpcMethod.SEND_MESSAGE, params: { message: { messageId: "message-1", role: "ROLE_USER", parts: [{ text: "original" }] } } }, messageId: "message-1" });
    await expect(client.execute({ operationId: "terminal-op", attemptId: "replay", operation: "replay", targetLabel: "Agent one", authorization, lineage, intendedCredentialRevisionId: 12, predecessorCredentialRevisionId: 11, request: { id: 99, method: A2AJsonRpcMethod.SEND_MESSAGE, params: { message: { messageId: "message-1", role: "ROLE_USER", parts: [{ text: "ignored" }] } } }, messageId: "message-1" })).resolves.toMatchObject({ ok: false, outcome });
    expect(disk.payloads).toHaveLength(0);
    expect(disk.attempts.find((item: any) => item.prepared.attemptId === "replay")).toMatchObject({ stage: "settled" });
  });

  it("durably records a concurrent different intended revision as NOT_SENT before secrets or sockets", async () => {
    let disk: any;
    const now = () => new Date("2026-07-16T00:00:00.000Z");
    const store = new A2ARemoteDurableStore({
      namespace: {
        readJson: async <T>(_name: string, fallback: T) => structuredClone((disk ?? fallback) as T),
        writeJson: async (_name: string, value: unknown) => { disk = structuredClone(value); },
      },
      encryption: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
      random: (size) => Buffer.alloc(size, 7),
      now,
    });
    let release!: () => void;
    const authorizationWait = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const prepareSecret = vi.fn(async () => ({ take: () => "secret", zeroize: () => undefined }));
    const invoke = vi.fn(async () => ({
      status: 200,
      headers: { "a2a-extensions": A2A_EXACT_SEND_REPLAY_URI },
      body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { message: { messageId: "reply", role: "ROLE_AGENT", parts: [{ text: "ok" }] } } })),
    }));
    const client = new A2ARemoteClient({
      enabled: true,
      authorizer: { authorize: async () => await authorizationWait },
      approver: { approve: async ({ intendedCredentialRevisionId, lineage: approvedLineage, semanticDigestSha256 }) => ({ decisionId: "gate-decision", decidedAt: now().toISOString(), intendedCredentialRevisionId, lineageDigestSha256: a2aRemoteLineageDigestSha256(approvedLineage), semanticDigestSha256 }) },
      store,
      secretResolver: { prepare: prepareSecret },
      controlPlane: { resolve: async ({ intendedCredentialRevisionId }) => snapshot(intendedCredentialRevisionId) },
      transport: { invoke },
      now,
    });
    const authorization = { ownerId: "owner", projectRoot: "/project", profileId: "profile", origin: "user", depth: 0, targetAgentId: 1, interfaceUrl: lineage.interfaceUrl };
    const base = { operationId: "op-race", operation: "initial-send" as const, targetLabel: "Agent one", authorization, lineage, request: { id: 1, method: A2AJsonRpcMethod.SEND_MESSAGE, params: { message: { messageId: "race-message", role: "ROLE_USER", parts: [{ text: "same" }] } } }, messageId: "race-message" };
    const winner = client.execute({ ...base, attemptId: "winner", intendedCredentialRevisionId: 11 });
    const loser = await client.execute({ ...base, attemptId: "loser", intendedCredentialRevisionId: 12 });
    expect(loser).toMatchObject({ ok: false, outcome: "intended-credential-revision-conflict", record: { stage: "NOT_SENT", outcomeCode: "INTENDED_CREDENTIAL_REVISION_CONFLICT" } });
    expect(prepareSecret).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    release();
    await expect(winner).resolves.toMatchObject({ ok: true });
    expect(prepareSecret).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
    expect(disk.attempts).toHaveLength(2);
    expect(disk.attempts.find((entry: any) => entry.prepared.attemptId === "loser")).toMatchObject({ stage: "NOT_SENT", outcomeCode: "INTENDED_CREDENTIAL_REVISION_CONFLICT" });
    expect(disk.attempts.find((entry: any) => entry.prepared.attemptId === "loser").prepared).not.toHaveProperty("payloadRecordId");
    expect(disk.attempts.find((entry: any) => entry.prepared.attemptId === "winner").prepared).toMatchObject({ approvalDecisionId: "gate-decision", approvalDecidedAt: "2026-07-16T00:00:00.000Z" });
  });
});
