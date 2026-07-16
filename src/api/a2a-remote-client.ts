import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  A2AJsonRpcMethod,
  A2A_JSONRPC_VERSION,
  type A2ADirectJsonRpcResult,
  type A2AJsonObject,
  type A2AJsonRpcFailure,
  type A2AJsonRpcResponse,
} from "../shared/a2a-wire.js";
import {
  A2A_EXACT_SEND_REPLAY_URI,
  A2A_SPECIFICATION_URI,
  A2A_REMOTE_MAX_HISTORY_LENGTH,
  A2A_REMOTE_RECONCILIATION_MS,
  a2aRemoteLineageDigestSha256,
  sameA2ARemoteLineage,
  type A2ALocalSecretResolver,
  type A2ARemoteAuthorizationContext,
  type A2ARemoteHostAuthorizer,
  type A2ARemoteLineage,
  type A2ARemoteMutationApprover,
  type A2ARemoteOperation,
  type A2ARemoteRequestEnvelope,
  type A2ARemoteTransport,
  type A2ARouteControlPlaneClient,
  type A2ARouteSnapshot,
} from "./a2a-remote-contracts.js";
import {
  A2ARemoteDurableStore,
  INTENDED_CREDENTIAL_REVISION_CONFLICT,
  createA2APayloadAad,
  type A2ARemoteAttemptRecord,
} from "./a2a-remote-store.js";
import { parseA2AStrictJson } from "./a2a-strict-json.js";
import { canonicalizeA2ARemoteTask } from "./a2a-task-store.js";

const EXTENSION_ERROR_CODES = new Set([-32090, -32091, -32092, -32093, -32094]);
const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const TCK_TAG = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const EXTENSION_ERRORS: Readonly<Record<number, Readonly<{ message: string; reason: string }>>> = {
  [-32090]: { message: "Exact send replay conflict", reason: "EXACT_SEND_REPLAY_CONFLICT" },
  [-32091]: { message: "Exact send replay retention expired", reason: "EXACT_SEND_REPLAY_RETENTION_EXPIRED" },
  [-32092]: { message: "Exact send replay in progress", reason: "EXACT_SEND_REPLAY_IN_PROGRESS" },
  [-32093]: { message: "Exact send replay outcome unknown", reason: "EXACT_SEND_REPLAY_OUTCOME_UNKNOWN" },
  [-32094]: { message: "Exact send replay capacity exhausted", reason: "EXACT_SEND_REPLAY_CAPACITY_EXHAUSTED" },
};

export interface A2ARemoteClientAuditEvent {
  type: "a2a-remote-operation";
  operation: A2ARemoteOperation;
  outcome:
    | "disabled"
    | "unauthorized"
    | "approval-denied"
    | "prepared"
    | "not-sent"
    | "in-flight"
    | "outcome-unknown"
    | "settled";
  code: string;
}

export interface CreateA2ARemoteClientOptions {
  enabled: boolean;
  authorizer: A2ARemoteHostAuthorizer;
  approver: A2ARemoteMutationApprover;
  store: A2ARemoteDurableStore;
  secretResolver: A2ALocalSecretResolver;
  controlPlane: A2ARouteControlPlaneClient;
  transport: A2ARemoteTransport;
  now?: () => Date;
  makeId?: () => string;
  audit?: (event: Readonly<A2ARemoteClientAuditEvent>) => void;
}

export interface A2ARemoteExecuteInput {
  operationId: string;
  attemptId: string;
  operation: A2ARemoteOperation;
  authorization: A2ARemoteAuthorizationContext;
  lineage: A2ARemoteLineage;
  intendedCredentialRevisionId: number;
  predecessorCredentialRevisionId?: number;
  request: A2ARemoteRequestEnvelope;
  messageId?: string;
  taskHandle?: string;
  /** Main-owned safe label shown in the foreground approval. */
  targetLabel?: string;
}

export type A2ARemoteClientResult =
  | { ok: true; result: A2ADirectJsonRpcResult; record: A2ARemoteAttemptRecord }
  | {
      ok: false;
      outcome:
        | "conflict"
        | "intended-credential-revision-conflict"
        | "retention-expired"
        | "reconciling"
        | "unknown-manual-reconciliation-required"
        | "capacity-manual-intervention-required"
        | "authentication-failed"
        | "authentication-required-out-of-band"
        | "remote-error"
        | "not-sent";
      record?: A2ARemoteAttemptRecord;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function semanticDigest(input: Readonly<A2ARemoteExecuteInput>): string {
  return sha256(canonical({
    method: input.request.method,
    lineage: input.lineage,
    params: input.request.params,
    messageId: input.messageId,
    taskId: input.authorization.taskId,
    contextId: input.authorization.contextId,
  }));
}

function extensionParams(params: A2AJsonObject, intentSha256: string): A2AJsonObject {
  const existing = params.metadata;
  if (existing !== undefined && !isRecord(existing)) throw new Error("a2a-remote-metadata-invalid");
  if (isRecord(existing) && A2A_EXACT_SEND_REPLAY_URI in existing) {
    throw new Error("a2a-remote-extension-metadata-conflict");
  }
  return {
    ...structuredClone(params),
    metadata: {
      ...(isRecord(existing) ? structuredClone(existing) : {}),
      [A2A_EXACT_SEND_REPLAY_URI]: { intentSha256 },
    },
  };
}

function exactReplayApplies(operation: A2ARemoteOperation): boolean {
  return operation === "initial-send" || operation === "replay";
}

function mutation(operation: A2ARemoteOperation): operation is "initial-send" | "continue" | "cancel" {
  return operation === "initial-send" || operation === "continue" || operation === "cancel";
}

function validateOperationMethod(input: A2ARemoteExecuteInput): void {
  const valid = input.operation === "get"
    ? input.request.method === A2AJsonRpcMethod.GET_TASK
    : input.operation === "cancel"
      ? input.request.method === A2AJsonRpcMethod.CANCEL_TASK
      : input.request.method === A2AJsonRpcMethod.SEND_MESSAGE;
  if (!valid || input.request.id === null) throw new Error("a2a-remote-operation-method-invalid");
  if (exactReplayApplies(input.operation) && !input.messageId) {
    throw new Error("a2a-remote-message-id-required");
  }
  if (input.operation === "get" || input.operation === "cancel") {
    const keys = Object.keys(input.request.params);
    const allowed = input.operation === "get" ? new Set(["id", "historyLength", "tenant"]) : new Set(["id", "metadata", "tenant"]);
    if (!keys.every((key) => allowed.has(key)) || !input.authorization.taskId
      || input.request.params.id !== input.authorization.taskId) throw new Error("a2a-remote-task-ownership-invalid");
    if (input.operation === "get" && input.request.params.historyLength !== undefined
      && (!Number.isInteger(input.request.params.historyLength) || (input.request.params.historyLength as number) < 0
        || (input.request.params.historyLength as number) > A2A_REMOTE_MAX_HISTORY_LENGTH)) throw new Error("a2a-remote-history-length-invalid");
  }
  const message = isRecord(input.request.params.message) ? input.request.params.message : undefined;
  if (input.operation === "initial-send" || input.operation === "replay") {
    if (!message || message.messageId !== input.messageId || message.taskId !== undefined) throw new Error("a2a-remote-message-identity-invalid");
  }
  if (input.operation === "continue") {
    if (!message || !input.authorization.taskId || !input.authorization.contextId
      || message.taskId !== input.authorization.taskId || message.contextId !== input.authorization.contextId) throw new Error("a2a-remote-task-ownership-invalid");
  }
}

function responseTaskHistoryLimit(input: Readonly<A2ARemoteExecuteInput>): number {
  if (input.operation !== "get") return A2A_REMOTE_MAX_HISTORY_LENGTH;
  const requested = input.request.params.historyLength;
  // validateOperationMethod already rejects malformed values. Omission keeps
  // the protocol-wide bounded maximum; an explicit value is an exact response
  // upper bound and may intentionally be zero.
  return requested === undefined
    ? A2A_REMOTE_MAX_HISTORY_LENGTH
    : requested as number;
}

function validateSnapshot(snapshot: A2ARouteSnapshot, input: A2ARemoteExecuteInput, now: number): void {
  if (
    !sameA2ARemoteLineage(snapshot, input.lineage)
    || snapshot.credentialRevisionId !== input.intendedCredentialRevisionId
    || snapshot.extensionUri !== A2A_EXACT_SEND_REPLAY_URI
    || snapshot.authenticationScheme !== "Bearer"
    || snapshot.protocolBinding !== "JSONRPC"
    || snapshot.protocolVersion !== "1.0"
    || snapshot.a2aSpecificationUri !== A2A_SPECIFICATION_URI
    || !Number.isSafeInteger(snapshot.servedSpecObservationId)
    || snapshot.servedSpecObservationId <= 0
    || !Number.isSafeInteger(snapshot.wireConformanceEvidenceId)
    || snapshot.wireConformanceEvidenceId <= 0
    || !FULL_COMMIT_SHA.test(snapshot.agentHubHeadSha)
    || !FULL_COMMIT_SHA.test(snapshot.lvisAppHeadSha)
    || !FULL_COMMIT_SHA.test(snapshot.remoteServerHeadSha)
    || !FULL_COMMIT_SHA.test(snapshot.a2aTckCommitSha)
    || snapshot.a2aTckTag.length > 64
    || !TCK_TAG.test(snapshot.a2aTckTag)
    || !SHA256_DIGEST.test(snapshot.agentHubLockDigestSha256)
    || !SHA256_DIGEST.test(snapshot.lvisAppLockDigestSha256)
    || !SHA256_DIGEST.test(snapshot.remoteServerLockDigestSha256)
    || !SHA256_DIGEST.test(snapshot.a2aTckLockDigestSha256)
    || Date.parse(snapshot.issuedAt) > now
    || Date.parse(snapshot.expiresAt) <= now
    || Date.parse(snapshot.healthExpiresAt) <= now
  ) throw new Error("a2a-remote-final-resolve-mismatch");
}

function parseResponseBody(body: Uint8Array): unknown {
  try {
    return parseA2AStrictJson(body, { maxBytes: 1_024 * 1_024 });
  } catch {
    throw new Error("a2a-remote-response-json-invalid");
  }
}

function validateSuccessResult(value: unknown, input: A2ARemoteExecuteInput): A2ADirectJsonRpcResult {
  if (!isRecord(value)) throw new Error("a2a-remote-result-invalid");
  if (input.operation === "initial-send" || input.operation === "replay" || input.operation === "continue") {
    const keys = Object.keys(value);
    if (keys.length !== 1 || (keys[0] !== "message" && keys[0] !== "task")) {
      throw new Error("a2a-remote-send-oneof-invalid");
    }
    if (!isRecord(value[keys[0]!])) throw new Error("a2a-remote-send-oneof-invalid");
    if (input.operation === "continue") {
      const entity = value[keys[0]!] as Record<string, unknown>;
      if (("id" in entity && entity.id !== input.authorization.taskId)
        || ("taskId" in entity && entity.taskId !== input.authorization.taskId)
        || entity.contextId !== input.authorization.contextId) throw new Error("a2a-remote-result-ownership-invalid");
    }
  } else {
    if (value.id !== input.authorization.taskId || (input.authorization.contextId && value.contextId !== input.authorization.contextId)) {
      throw new Error("a2a-remote-result-ownership-invalid");
    }
  }
  return value as A2ADirectJsonRpcResult;
}

function parseJsonRpcResponse(
  value: unknown,
  requestId: A2ARemoteRequestEnvelope["id"],
  input: A2ARemoteExecuteInput,
): A2AJsonRpcResponse<A2ADirectJsonRpcResult> {
  if (!isRecord(value) || value.jsonrpc !== A2A_JSONRPC_VERSION || !isDeepStrictEqual(value.id, requestId)) {
    throw new Error("a2a-remote-response-envelope-invalid");
  }
  if ("result" in value) {
    if (Object.keys(value).sort().join(",") !== "id,jsonrpc,result") {
      throw new Error("a2a-remote-response-envelope-invalid");
    }
    return { jsonrpc: A2A_JSONRPC_VERSION, id: requestId, result: validateSuccessResult(value.result, input) };
  }
  if (!isRecord(value.error) || Object.keys(value).sort().join(",") !== "error,id,jsonrpc") {
    throw new Error("a2a-remote-response-envelope-invalid");
  }
  if (typeof value.error.code !== "number" || typeof value.error.message !== "string") {
    throw new Error("a2a-remote-response-error-invalid");
  }
  return value as unknown as A2AJsonRpcFailure;
}

function extensionFailureOutcome(code: number): Exclude<A2ARemoteClientResult, { ok: true }>["outcome"] {
  switch (code) {
    case -32090: return "conflict";
    case -32091: return "retention-expired";
    case -32092: return "reconciling";
    case -32094: return "capacity-manual-intervention-required";
    default: return "unknown-manual-reconciliation-required";
  }
}

function validateExtensionFailure(error: A2AJsonRpcFailure["error"]): void {
  const expected = EXTENSION_ERRORS[error.code];
  if (!expected || error.message !== expected.message || !isRecord(error)
    || Object.keys(error).sort().join(",") !== "code,data,message" || !Array.isArray(error.data)
    || error.data.length !== 1 || !isRecord(error.data[0])) throw new Error("a2a-remote-extension-error-invalid");
  const info = error.data[0];
  const hasRetryMetadata = error.code === -32092;
  const expectedKeys = hasRetryMetadata ? "@type,domain,metadata,reason" : "@type,domain,reason";
  if (Object.keys(info).sort().join(",") !== expectedKeys
    || info["@type"] !== "type.googleapis.com/google.rpc.ErrorInfo"
    || info.reason !== expected.reason
    || info.domain !== "lvis.ai") throw new Error("a2a-remote-extension-error-invalid");
  if (hasRetryMetadata) {
    if (!isRecord(info.metadata)
      || Object.keys(info.metadata).join(",") !== "retryAfterSeconds"
      || info.metadata.retryAfterSeconds !== "1") throw new Error("a2a-remote-extension-error-invalid");
  }
}

export class A2ARemoteClient {
  private readonly now: () => Date;
  private readonly makeId: () => string;
  private readonly active = new Map<string, { fingerprint: string; baseFingerprint: string; intendedCredentialRevisionId: number; result: Promise<A2ARemoteClientResult> }>();

  constructor(private readonly options: CreateA2ARemoteClientOptions) {
    this.now = options.now ?? (() => new Date());
    this.makeId = options.makeId ?? randomUUID;
  }

  private audit(operation: A2ARemoteOperation, outcome: A2ARemoteClientAuditEvent["outcome"], code: string): void {
    try {
      this.options.audit?.({ type: "a2a-remote-operation", operation, outcome, code });
    } catch {
      // Audit failure cannot widen or alter the wire decision.
    }
  }

  execute(input: Readonly<A2ARemoteExecuteInput>): Promise<A2ARemoteClientResult> {
    const fingerprint = sha256(canonical({
      operation: input.operation, authorization: input.authorization, lineage: input.lineage,
      intendedCredentialRevisionId: input.intendedCredentialRevisionId,
      predecessorCredentialRevisionId: input.predecessorCredentialRevisionId,
      request: input.request, messageId: input.messageId,
      taskHandle: input.taskHandle,
    }));
    const baseFingerprint = sha256(canonical({
      operation: input.operation, authorization: input.authorization, lineage: input.lineage,
      predecessorCredentialRevisionId: input.predecessorCredentialRevisionId,
      request: input.request, messageId: input.messageId,
      taskHandle: input.taskHandle,
    }));
    const existing = this.active.get(input.operationId);
    if (existing) {
      if (existing.fingerprint === fingerprint) return existing.result;
      if (existing.baseFingerprint === baseFingerprint
        && existing.intendedCredentialRevisionId !== input.intendedCredentialRevisionId) {
        return this.recordIntendedRevisionConflict(input);
      }
      return Promise.resolve({ ok: false, outcome: "conflict" });
    }
    const result = this.executeOwned(input).finally(() => {
      if (this.active.get(input.operationId)?.result === result) this.active.delete(input.operationId);
    });
    this.active.set(input.operationId, { fingerprint, baseFingerprint, intendedCredentialRevisionId: input.intendedCredentialRevisionId, result });
    return result;
  }

  private async recordIntendedRevisionConflict(input: Readonly<A2ARemoteExecuteInput>): Promise<A2ARemoteClientResult> {
    const createdAt = this.now();
    const record = await this.options.store.recordNotSent({
      operationId: input.operationId,
      attemptId: input.attemptId,
      ownerToken: this.makeId(),
      ownerDigestSha256: sha256(input.authorization.ownerId),
      projectRootDigestSha256: sha256(input.authorization.projectRoot),
      profileDigestSha256: sha256(input.authorization.profileId),
      originDigestSha256: sha256(input.authorization.origin),
      operation: input.operation,
      method: input.request.method,
      lineage: structuredClone(input.lineage),
      depth: input.authorization.depth,
      semanticRequestHash: sha256(canonical({
        method: input.request.method, lineage: input.lineage, params: input.request.params,
        messageId: input.messageId, taskId: input.authorization.taskId, contextId: input.authorization.contextId,
      })),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.taskHandle ? { taskHandle: input.taskHandle } : {}),
      ...(input.targetLabel ? { targetLabel: input.targetLabel } : {}),
      ...(input.authorization.taskId ? { taskToken: sha256(`${input.authorization.ownerId}\0${input.authorization.taskId}`) } : {}),
      ...(input.authorization.contextId ? { contextToken: sha256(`${input.authorization.ownerId}\0${input.authorization.contextId}`) } : {}),
      createdAt: createdAt.toISOString(),
      attemptDeadline: new Date(createdAt.getTime() + A2A_REMOTE_RECONCILIATION_MS).toISOString(),
      intendedCredentialRevisionId: input.intendedCredentialRevisionId,
      ...(input.predecessorCredentialRevisionId ? { predecessorCredentialRevisionId: input.predecessorCredentialRevisionId } : {}),
    }, INTENDED_CREDENTIAL_REVISION_CONFLICT);
    this.audit(input.operation, "not-sent", INTENDED_CREDENTIAL_REVISION_CONFLICT);
    return { ok: false, outcome: "intended-credential-revision-conflict", record };
  }

  private async executeOwned(input: Readonly<A2ARemoteExecuteInput>): Promise<A2ARemoteClientResult> {
    validateOperationMethod(input);
    if (!this.options.enabled) {
      this.audit(input.operation, "disabled", "gate-off");
      return { ok: false, outcome: "not-sent" };
    }
    if (
      input.authorization.depth !== 0
      || input.authorization.targetAgentId !== input.lineage.targetAgentId
      || input.authorization.interfaceUrl !== input.lineage.interfaceUrl
      || !input.authorization.ownerId
      || !input.authorization.projectRoot
      || !input.authorization.profileId
      || !input.authorization.origin
      || (await this.options.authorizer.authorize(input.authorization)) !== true
    ) {
      this.audit(input.operation, "unauthorized", "host-authorization-failed");
      return { ok: false, outcome: "not-sent" };
    }

    const existingOperation = input.operation !== "replay"
      ? await this.options.store.latestOperation(input.operationId)
      : null;
    if (existingOperation
      && !(existingOperation.stage === "NOT_SENT"
        && existingOperation.outcomeCode === INTENDED_CREDENTIAL_REVISION_CONFLICT)) {
      this.audit(input.operation, "not-sent", "operation-already-journaled");
      return { ok: false, outcome: "conflict" };
    }

    let replaySource: A2ARemoteAttemptRecord | null = null;
    if (input.operation === "replay") {
      replaySource = await this.options.store.findReplaySource(input.operationId);
      const predecessor = await this.options.store.latestResolvedAttempt(input.operationId);
      if (!replaySource?.prepared.payloadRecordId
        || !replaySource.prepared.payloadBodySha256
        || !replaySource.prepared.messageId
        || replaySource.prepared.messageId !== input.messageId
        || !sameA2ARemoteLineage(replaySource.prepared.lineage, input.lineage)
        || !predecessor?.resolved
        || input.predecessorCredentialRevisionId !== predecessor.resolved.credentialRevisionId) {
        const latest = await this.options.store.latestOperation(input.operationId);
        return { ok: false, outcome: latest?.stage === "RETENTION_EXPIRED"
          ? "retention-expired"
          : "unknown-manual-reconciliation-required", ...(latest ? { record: latest } : {}) };
      }
    }

    let approvalDecisionId: string | undefined = replaySource?.prepared.approvalDecisionId;
    let approvalDecidedAt: string | undefined = replaySource?.prepared.approvalDecidedAt;
    const approvedSemanticDigestSha256 = replaySource?.prepared.semanticRequestHash ?? semanticDigest(input);
    if (mutation(input.operation)) {
      if (!input.targetLabel || input.targetLabel.length > 80) throw new Error("a2a-remote-target-label-invalid");
      const approvedLineage = Object.freeze(structuredClone(input.lineage));
      const lineageDigestSha256 = a2aRemoteLineageDigestSha256(approvedLineage);
      let approval;
      try {
        approval = await this.options.approver.approve({
          operation: input.operation,
          operationId: input.operationId,
          lineage: approvedLineage,
          intendedCredentialRevisionId: input.intendedCredentialRevisionId,
          lineageDigestSha256,
          semanticDigestSha256: approvedSemanticDigestSha256,
          targetLabel: input.targetLabel,
        });
      } catch {
        // ApprovalGate denial, timeout-shaped rejection, and thrown failures
        // are one fail-closed decision. Never expose the gate error or advance
        // to journal/secret/control-plane/data-plane work.
        approval = null;
      }
      const semanticStillBound = semanticDigest(input) === approvedSemanticDigestSha256;
      if (!approval
        || approval.intendedCredentialRevisionId !== input.intendedCredentialRevisionId
        || approval.lineageDigestSha256 !== lineageDigestSha256
        || approval.semanticDigestSha256 !== approvedSemanticDigestSha256
        || !sameA2ARemoteLineage(input.lineage, approvedLineage)
        || a2aRemoteLineageDigestSha256(input.lineage) !== lineageDigestSha256
        || !semanticStillBound) {
        this.audit(input.operation, "approval-denied", "foreground-approval-failed");
        return { ok: false, outcome: "not-sent" };
      }
      approvalDecisionId = approval.decisionId;
      approvalDecidedAt = approval.decidedAt;
    }

    let semanticRequestHash = input.operation === "replay" ? "" : approvedSemanticDigestSha256;
    let body = Buffer.alloc(0);
    if (input.operation !== "replay") {
      const params = input.operation === "initial-send" ? extensionParams(input.request.params, semanticRequestHash) : structuredClone(input.request.params);
      body = Buffer.from(JSON.stringify({ jsonrpc: A2A_JSONRPC_VERSION, id: input.request.id, method: input.request.method, params }), "utf8");
    }
    let replayRequestId = input.request.id;
    if (input.operation === "replay") {
      const predecessor = await this.options.store.latestResolvedAttempt(input.operationId);
      if (
        !replaySource?.prepared.payloadRecordId
        || !replaySource.prepared.payloadBodySha256
        || !replaySource.prepared.messageId
        || replaySource.prepared.messageId !== input.messageId
        || !sameA2ARemoteLineage(replaySource.prepared.lineage, input.lineage)
        || !predecessor?.resolved
        || input.predecessorCredentialRevisionId !== predecessor.resolved.credentialRevisionId
      ) {
        body.fill(0);
        return { ok: false, outcome: "unknown-manual-reconciliation-required" };
      }
      const sourceAad = createA2APayloadAad({
        ownerId: input.authorization.ownerId,
        operationId: input.operationId,
        messageId: replaySource.prepared.messageId,
        bodySha256: replaySource.prepared.payloadBodySha256,
        lineage: replaySource.prepared.lineage,
      });
      const recovered = await this.options.store.readPayload(replaySource.prepared.attemptId, sourceAad);
      body.fill(0);
      if (!recovered) {
        const record = await this.options.store.terminalizeUnrecoverableReplay({
          sourceAttemptId: replaySource.prepared.attemptId,
          operationId: input.operationId,
          ownerDigestSha256: sha256(input.authorization.ownerId),
          projectRootDigestSha256: sha256(input.authorization.projectRoot),
          profileDigestSha256: sha256(input.authorization.profileId),
          originDigestSha256: sha256(input.authorization.origin),
          lineage: input.lineage,
          messageId: replaySource.prepared.messageId,
          semanticRequestHash: replaySource.prepared.semanticRequestHash,
        });
        return { ok: false, outcome: "retention-expired", record };
      }
      body = Buffer.from(recovered);
      const sourceEnvelope = parseA2AStrictJson(body, { maxBytes: 1_024 * 1_024 });
      if (!isRecord(sourceEnvelope) || sourceEnvelope.jsonrpc !== A2A_JSONRPC_VERSION
        || sourceEnvelope.method !== A2AJsonRpcMethod.SEND_MESSAGE || !("id" in sourceEnvelope)) {
        body.fill(0);
        return { ok: false, outcome: "unknown-manual-reconciliation-required" };
      }
      replayRequestId = sourceEnvelope.id as A2ARemoteRequestEnvelope["id"];
      semanticRequestHash = replaySource.prepared.semanticRequestHash;
    }
    const createdAt = replaySource ? new Date(replaySource.prepared.createdAt) : this.now();
    const attemptDeadline = replaySource?.prepared.attemptDeadline
      ?? new Date(createdAt.getTime() + A2A_REMOTE_RECONCILIATION_MS).toISOString();
    if (Date.parse(attemptDeadline) <= this.now().getTime()) {
      body.fill(0);
      return { ok: false, outcome: "unknown-manual-reconciliation-required" };
    }
    const ownerToken = this.makeId();
    const prepared = {
      operationId: input.operationId,
      attemptId: input.attemptId,
      ownerToken,
      ownerDigestSha256: sha256(input.authorization.ownerId),
      projectRootDigestSha256: sha256(input.authorization.projectRoot),
      profileDigestSha256: sha256(input.authorization.profileId),
      originDigestSha256: sha256(input.authorization.origin),
      operation: input.operation,
      method: input.request.method,
      lineage: structuredClone(input.lineage),
      depth: input.authorization.depth,
      semanticRequestHash,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.taskHandle ? { taskHandle: input.taskHandle } : {}),
      ...(input.targetLabel ? { targetLabel: input.targetLabel } : {}),
      ...(input.authorization.taskId ? { taskToken: sha256(`${input.authorization.ownerId}\0${input.authorization.taskId}`) } : {}),
      ...(input.authorization.contextId ? { contextToken: sha256(`${input.authorization.ownerId}\0${input.authorization.contextId}`) } : {}),
      ...(approvalDecisionId ? { approvalDecisionId } : {}),
      ...(approvalDecidedAt ? { approvalDecidedAt } : {}),
      createdAt: createdAt.toISOString(),
      attemptDeadline,
      intendedCredentialRevisionId: input.intendedCredentialRevisionId,
      ...(input.predecessorCredentialRevisionId
        ? { predecessorCredentialRevisionId: input.predecessorCredentialRevisionId }
        : {}),
    };
    const aad = input.operation === "initial-send"
      ? createA2APayloadAad({
          ownerId: input.authorization.ownerId,
          operationId: input.operationId,
          messageId: input.messageId!,
          bodySha256: sha256(body),
          lineage: input.lineage,
        })
      : undefined;
    const stored = await this.options.store.prepare(
      prepared,
      input.operation === "initial-send" ? { body, aad: aad! } : undefined,
    );
    if (!stored.ok) {
      if (stored.reason === "intended-revision-conflict") {
        const record = await this.options.store.recordNotSent(prepared, INTENDED_CREDENTIAL_REVISION_CONFLICT);
        this.audit(input.operation, "not-sent", INTENDED_CREDENTIAL_REVISION_CONFLICT);
        return { ok: false, outcome: "intended-credential-revision-conflict", record };
      }
      this.audit(input.operation, "not-sent", stored.reason);
      return { ok: false, outcome: "conflict" };
    }
    this.audit(input.operation, "prepared", stored.duplicate ? "prepared-joined" : "prepared");
    if (stored.duplicate && stored.record.stage !== "prepared") {
      return { ok: false, outcome: stored.record.stage === "outcome-unknown" || stored.record.stage === "reconciling" || stored.record.stage === "in-flight"
        ? "unknown-manual-reconciliation-required" : "conflict", record: stored.record };
    }

    let secret;
    try {
      secret = await this.options.secretResolver.prepare({
        operationId: input.operationId,
        credentialBindingId: input.lineage.credentialBindingId,
        credentialRevisionId: input.intendedCredentialRevisionId,
      });
    } catch {
      const record = await this.options.store.transition(
        input.attemptId, ["prepared"], "NOT_SENT", { outcomeCode: "secret-unavailable", deletePayload: true },
      );
      return { ok: false, outcome: "not-sent", ...(record ? { record } : {}) };
    }

    try {
      let snapshot: A2ARouteSnapshot;
      try {
        snapshot = await this.options.controlPlane.resolve({
          operationId: input.operationId,
          attemptId: input.attemptId,
          operation: input.operation,
          method: input.request.method,
          intendedCredentialRevisionId: input.intendedCredentialRevisionId,
          ...(input.predecessorCredentialRevisionId
            ? { predecessorCredentialRevisionId: input.predecessorCredentialRevisionId }
            : {}),
          lineage: input.lineage,
        });
        validateSnapshot(snapshot, input, this.now().getTime());
      } catch {
        const record = await this.options.store.transition(
          input.attemptId, ["prepared"], "NOT_SENT", { outcomeCode: "final-resolve-rejected", deletePayload: true },
        );
        this.audit(input.operation, "not-sent", "final-resolve-rejected");
        return { ok: false, outcome: "not-sent", ...(record ? { record } : {}) };
      }
      const resolved = await this.options.store.resolveCas(input.attemptId, {
        snapshotId: snapshot.snapshotId,
        credentialRevisionId: snapshot.credentialRevisionId,
        resolvedAt: this.now().toISOString(),
        snapshotIssuedAt: snapshot.issuedAt,
        snapshotExpiresAt: snapshot.expiresAt,
        operation: input.operation,
        method: input.request.method,
        extensionUri: A2A_EXACT_SEND_REPLAY_URI,
        lineage: structuredClone(input.lineage),
        semanticRequestHash,
        ownerDigestSha256: sha256(input.authorization.ownerId),
        projectRootDigestSha256: sha256(input.authorization.projectRoot),
        profileDigestSha256: sha256(input.authorization.profileId),
        originDigestSha256: sha256(input.authorization.origin),
        ...(approvalDecisionId ? { approvalDecisionId } : {}),
        ...(approvalDecidedAt ? { approvalDecidedAt } : {}),
        ...(input.taskHandle ? { taskHandle: input.taskHandle } : {}),
        ...(input.authorization.taskId ? { taskToken: sha256(`${input.authorization.ownerId}\0${input.authorization.taskId}`) } : {}),
        ...(input.authorization.contextId ? { contextToken: sha256(`${input.authorization.ownerId}\0${input.authorization.contextId}`) } : {}),
        ...(stored.record.prepared.payloadRecordId ? { payloadRecordId: stored.record.prepared.payloadRecordId } : {}),
        ...(stored.record.prepared.payloadCiphertextSha256 ? { payloadCiphertextSha256: stored.record.prepared.payloadCiphertextSha256 } : {}),
        ...(stored.record.prepared.payloadBodySha256 ? { payloadBodySha256: stored.record.prepared.payloadBodySha256 } : {}),
        ...(stored.record.prepared.payloadSize ? { payloadSize: stored.record.prepared.payloadSize } : {}),
      });
      if (!resolved) {
        const record = await this.options.store.transition(
          input.attemptId, ["prepared"], "NOT_SENT", { outcomeCode: "resolved-cas-lost", deletePayload: true },
        );
        return { ok: false, outcome: "conflict", ...(record ? { record } : {}) };
      }
      const inFlight = await this.options.store.transition(input.attemptId, ["resolved"], "in-flight");
      if (!inFlight) {
        const record = await this.options.store.transition(input.attemptId, ["resolved"], "NOT_SENT", { outcomeCode: "socket-cas-lost", deletePayload: true });
        return { ok: false, outcome: "not-sent", ...(record ? { record } : {}) };
      }
      this.audit(input.operation, "in-flight", "socket-start");
      let response;
      try {
        response = await this.options.transport.invoke({
          url: snapshot.interfaceUrl,
          body,
          bearer: secret.take(),
          activateExactReplay: exactReplayApplies(input.operation),
        });
      } catch {
        const record = await this.options.store.transition(
          input.attemptId, ["in-flight"], "outcome-unknown", { outcomeCode: "transport-ambiguous" },
        );
        this.audit(input.operation, "outcome-unknown", "transport-ambiguous");
        return { ok: false, outcome: "unknown-manual-reconciliation-required", ...(record ? { record } : {}) };
      }
      try {
      if (response.status === 401 || response.status === 403) {
        const record = await this.options.store.transition(
          input.attemptId, ["in-flight"], "settled", { outcomeCode: "authentication-failed", deletePayload: true },
        );
        return { ok: false, outcome: "authentication-failed", ...(record ? { record } : {}) };
      }
      if (response.status !== 200) throw new Error("a2a-remote-http-status-invalid");
      const extensionEcho = response.headers["a2a-extensions"];
      if (exactReplayApplies(input.operation)) {
        if (extensionEcho !== A2A_EXACT_SEND_REPLAY_URI) throw new Error("a2a-remote-extension-echo-invalid");
      } else if (extensionEcho !== undefined) {
        throw new Error("a2a-remote-unexpected-extension-echo");
      }
      const envelope = parseJsonRpcResponse(
        parseResponseBody(response.body),
        replayRequestId,
        input,
      );
      if ("error" in envelope) {
        const code = envelope.error.code;
        if (EXTENSION_ERROR_CODES.has(code)) {
          validateExtensionFailure(envelope.error);
          const retry = response.headers["retry-after"];
          if ((code === -32092 && retry !== "1") || (code !== -32092 && retry !== undefined)) {
            throw new Error("a2a-remote-retry-header-invalid");
          }
          const outcome = extensionFailureOutcome(code);
          const nextStage = outcome === "reconciling" ? "reconciling" : "settled";
          const record = await this.options.store.transition(
            input.attemptId,
            ["in-flight"],
            nextStage,
            { outcomeCode: outcome, deletePayload: nextStage === "settled", ...(nextStage === "reconciling" ? { retryAfterSeconds: 1 } : {}) },
          );
          return { ok: false, outcome, ...(record ? { record } : {}) };
        }
        const record = await this.options.store.transition(
          input.attemptId, ["in-flight"], "settled", { outcomeCode: "remote-error", deletePayload: true },
        );
        return { ok: false, outcome: "remote-error", ...(record ? { record } : {}) };
      }
      const result = envelope.result;
      const taskValue = isRecord(result) && isRecord(result.task)
        ? result.task
        : (input.operation === "get" || input.operation === "cancel") && isRecord(result)
          ? result
          : undefined;
      const task = taskValue
        ? canonicalizeA2ARemoteTask(taskValue, responseTaskHistoryLimit(input))
        : undefined;
      if (taskValue && !task) throw new Error("a2a-remote-task-projection-invalid");
      const record = await this.options.store.transition(
        input.attemptId,
        ["in-flight"],
        "settled",
        {
          outcomeCode: task?.status.state === "TASK_STATE_AUTH_REQUIRED"
            ? "authentication-required-out-of-band"
            : "success",
          ...(task && input.taskHandle && input.targetLabel ? {
            taskProjection: {
              handle: input.taskHandle,
              ownerId: input.authorization.ownerId,
              targetAgentId: input.authorization.targetAgentId,
              targetLabel: input.targetLabel,
              lineage: input.lineage,
              credentialRevisionId: input.intendedCredentialRevisionId,
              task,
            },
          } : {}),
          deletePayload: true,
        },
      );
      if (!record) throw new Error("a2a-remote-settlement-failed");
      if (task?.status.state === "TASK_STATE_AUTH_REQUIRED") {
        this.audit(input.operation, "settled", "authentication-required-out-of-band");
        return { ok: false, outcome: "authentication-required-out-of-band", record };
      }
      this.audit(input.operation, "settled", "success");
      return { ok: true, result, record };
      } catch {
        const record = await this.options.store.transition(
          input.attemptId, ["in-flight"], "outcome-unknown", { outcomeCode: "post-socket-validation-ambiguous" },
        );
        this.audit(input.operation, "outcome-unknown", "post-socket-validation-ambiguous");
        return { ok: false, outcome: "unknown-manual-reconciliation-required", ...(record ? { record } : {}) };
      }
    } finally {
      secret.zeroize();
      body.fill(0);
    }
  }
}
