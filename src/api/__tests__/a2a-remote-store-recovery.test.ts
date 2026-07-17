import { describe, expect, it, vi } from "vitest";
import { A2AJsonRpcMethod } from "../../shared/a2a-wire.js";
import { A2ARemoteClient } from "../a2a-remote-client.js";
import { A2A_EXACT_SEND_REPLAY_URI, type A2ARemotePreparedAttempt } from "../a2a-remote-contracts.js";
import { A2ARemoteDurableStore } from "../a2a-remote-store.js";

const digest = "a".repeat(64);
const now = () => new Date("2026-07-16T00:00:00.000Z");
const lineage = { targetAgentId: 1, interfaceUrl: "https://agent.example.test/a2a", agentCardDigestSha256: digest, trustKeyId: 2, credentialBindingId: 3, callerGenerationId: "generation-1", routePolicyVersion: 4, routePolicyDigestSha256: digest, extensionSpecDigestSha256: digest };

function prepared(overrides: Partial<A2ARemotePreparedAttempt> = {}): A2ARemotePreparedAttempt {
  return {
    operationId: "operation-1",
    attemptId: "attempt-1",
    ownerToken: "owner-token-1",
    ownerDigestSha256: digest,
    projectRootDigestSha256: digest,
    profileDigestSha256: digest,
    originDigestSha256: digest,
    operation: "get",
    method: A2AJsonRpcMethod.GET_TASK,
    lineage,
    depth: 0,
    semanticRequestHash: digest,
    taskHandle: "task_handle_123456",
    targetLabel: "Agent one",
    taskToken: digest,
    createdAt: "2026-07-16T00:00:00.000Z",
    attemptDeadline: "2026-07-16T00:01:00.000Z",
    intendedCredentialRevisionId: 1,
    ...overrides,
  };
}

function attempt(value: A2ARemotePreparedAttempt) {
  return { prepared: value, stage: "prepared", updatedAt: "2026-07-16T00:00:00.000Z" };
}

describe("A2A remote startup recovery fence", () => {
  it("migrates the domain-shaped v2 replay identifier to the reviewed UUID URN", async () => {
    const current = prepared();
    const legacyIdentifier = new URL(
      "/a2a/extensions/exact-send-replay/v1",
      `https://${["legacy", "example", "test"].join(".")}`,
    ).href;
    const files = new Map<string, unknown>([["client-state.json", {
      version: 2,
      attempts: [{
        prepared: current,
        stage: "settled",
        resolved: {
          snapshotId: "snapshot-1",
          credentialRevisionId: current.intendedCredentialRevisionId,
          resolvedAt: "2026-07-16T00:00:00.000Z",
          snapshotIssuedAt: "2026-07-16T00:00:00.000Z",
          snapshotExpiresAt: "2099-01-01T00:00:00.000Z",
          operation: current.operation,
          method: current.method,
          extensionUri: legacyIdentifier,
          lineage: current.lineage,
          semanticRequestHash: current.semanticRequestHash,
          ownerDigestSha256: current.ownerDigestSha256,
          projectRootDigestSha256: current.projectRootDigestSha256,
          profileDigestSha256: current.profileDigestSha256,
          originDigestSha256: current.originDigestSha256,
          taskHandle: current.taskHandle,
          taskToken: current.taskToken,
        },
        outcomeCode: "completed",
        updatedAt: "2026-07-16T00:00:00.000Z",
      }],
      payloads: [],
      tasks: [],
    }]]);
    const audit = vi.fn();
    const store = new A2ARemoteDurableStore({
      namespace: {
        readJson: async <T>(name: string, fallback: T) => structuredClone((files.get(name) ?? fallback) as T),
        writeJson: async (name: string, value: unknown) => { files.set(name, structuredClone(value)); },
      },
      encryption: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
      now,
      audit,
    });

    const migrated = await store.getAttempt(current.attemptId);

    expect(migrated?.resolved?.extensionUri).toBe(A2A_EXACT_SEND_REPLAY_URI);
    expect(files.get("client-state.json")).toMatchObject({
      version: 3,
      attempts: [{ resolved: { extensionUri: A2A_EXACT_SEND_REPLAY_URI } }],
    });
    expect(audit).toHaveBeenCalledWith({ reason: "state-migrated", count: 1 });
    expect(files.has("client-state.quarantine.json")).toBe(false);
  });

  it.each([
    ["invalid", [{ ...attempt(prepared()), prepared: { ...prepared(), ownerDigestSha256: undefined } }]],
    ["duplicate", [attempt(prepared()), attempt(prepared())]],
    ["cross-owner", [attempt(prepared()), attempt(prepared({ attemptId: "attempt-2", ownerToken: "owner-token-2", ownerDigestSha256: "b".repeat(64) }))]],
    ["expired", [attempt(prepared({ attemptDeadline: "2026-07-15T23:59:59.000Z" }))]],
    ["conflicting", [attempt(prepared()), attempt(prepared({ attemptId: "attempt-2", ownerToken: "owner-token-2" }))]],
  ])("quarantines %s restart state and performs zero outbound I/O", async (_name, attempts) => {
    const files = new Map<string, unknown>([["client-state.json", { version: 3, attempts, payloads: [], tasks: [] }]]);
    const audit = vi.fn();
    const store = new A2ARemoteDurableStore({
      namespace: {
        readJson: async <T>(name: string, fallback: T) => structuredClone((files.get(name) ?? fallback) as T),
        writeJson: async (name: string, value: unknown) => { files.set(name, structuredClone(value)); },
      },
      encryption: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
      now,
      audit,
    });
    const prepareSecret = vi.fn();
    const resolve = vi.fn();
    const invoke = vi.fn();
    const client = new A2ARemoteClient({
      enabled: true,
      authorizer: { authorize: () => true },
      approver: { approve: vi.fn() },
      store,
      secretResolver: { prepare: prepareSecret },
      controlPlane: { resolve },
      transport: { invoke },
      now,
    });
    await expect(client.execute({
      operationId: "fresh-operation",
      attemptId: "fresh-attempt",
      operation: "get",
      taskHandle: "task_handle_123456",
      targetLabel: "Agent one",
      authorization: { ownerId: "owner", projectRoot: "/project", profileId: "profile", origin: "user", depth: 0, targetAgentId: 1, interfaceUrl: lineage.interfaceUrl, taskId: "remote-task" },
      lineage,
      intendedCredentialRevisionId: 1,
      request: { id: 1, method: A2AJsonRpcMethod.GET_TASK, params: { id: "remote-task", historyLength: 0 } },
    })).rejects.toThrow("a2a-remote-recovery-quarantined");
    expect(prepareSecret).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith({ reason: "startup-quarantine", count: expect.any(Number) });
    expect(files.get("client-state.quarantine.json")).toMatchObject({ version: 1, entries: expect.any(Array) });
  });
});
