import type {
  A2ADirectJsonRpcMethod,
  A2AJsonObject,
  A2AJsonRpcId,
} from "../shared/a2a-wire.js";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { A2AJsonRpcMethod } from "../shared/a2a-wire.js";

export const A2A_EXACT_SEND_REPLAY_URI =
  "https://lvis.ai/a2a/extensions/exact-send-replay/v1" as const;
export const A2A_SPECIFICATION_URI = "https://a2a-protocol.org/v1.0.0/specification/" as const;
export const A2A_EXACT_SEND_REPLAY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const A2A_REMOTE_ROUTE_TIMEOUT_MS = 5_000;
export const A2A_REMOTE_HTTP_TIMEOUT_MS = 15_000;
export const A2A_REMOTE_RECONCILIATION_MS = 30_000;
export const A2A_REMOTE_MAX_ROUTE_BYTES = 64 * 1_024;
export const A2A_REMOTE_MAX_RESPONSE_BYTES = 64 * 1_024;
export const A2A_REMOTE_MAX_REQUEST_BYTES = 1_024 * 1_024;
export const A2A_REMOTE_MAX_HISTORY_LENGTH = 64;

// The external route-control schema retains its historical owner-prefixed
// field names. Compose those names at the boundary so the host runtime stays
// implementation-neutral while still enforcing byte-exact wire compatibility.
const CONTROL_PLANE_HEAD_WIRE_KEY = ["agent", "hub", "head", "sha"].join("_");
const CONTROL_PLANE_LOCK_WIRE_KEY = ["agent", "hub", "lock", "digest", "sha256"].join("_");

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const A2A_TCK_TAG = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export interface A2ARemoteLineage {
  targetAgentId: number;
  interfaceUrl: string;
  agentCardDigestSha256: string;
  trustKeyId: number;
  credentialBindingId: number;
  callerGenerationId: string;
  routePolicyVersion: number;
  routePolicyDigestSha256: string;
  extensionSpecDigestSha256: string;
}

export interface A2ARouteSnapshot extends A2ARemoteLineage {
  snapshotId: string;
  credentialRevisionId: number;
  credentialVersion: number;
  credentialProvider: string;
  credentialExternalVersion: string;
  advertisedInterfaceId: number;
  interfaceHealthObservationId: number;
  healthObservedAt: string;
  healthExpiresAt: string;
  wireConformanceArtifactId: string;
  wireConformanceArtifactDigestSha256: string;
  servedSpecObservationId: number;
  wireConformanceEvidenceId: number;
  controlPlaneHeadSha: string;
  lvisAppHeadSha: string;
  remoteServerHeadSha: string;
  a2aTckTag: string;
  a2aTckCommitSha: string;
  controlPlaneLockDigestSha256: string;
  lvisAppLockDigestSha256: string;
  remoteServerLockDigestSha256: string;
  a2aTckLockDigestSha256: string;
  a2aSpecificationUri: typeof A2A_SPECIFICATION_URI;
  issuedAt: string;
  expiresAt: string;
  extensionUri: typeof A2A_EXACT_SEND_REPLAY_URI;
  authenticationScheme: "Bearer";
  protocolBinding: "JSONRPC";
  protocolVersion: "1.0";
}

/** Snake-case HTTP projection agreed with the remote route control plane. */
export interface A2ARouteSnapshotWire {
  snapshot_id: string;
  operation_id: string;
  attempt_id: string;
  operation_kind: A2ARouteOperationKind;
  a2a_method: A2ADirectJsonRpcMethod;
  issued_at: string;
  expires_at: string;
  target_agent_id: number;
  interface_url: string;
  agent_card_digest_sha256: string;
  trust_key_id: number;
  credential_binding_id: number;
  caller_generation_id: string;
  route_policy_version: number;
  route_policy_digest_sha256: string;
  extension_spec_digest_sha256: string;
  extension_uri: typeof A2A_EXACT_SEND_REPLAY_URI;
  intended_credential_revision_id: number;
  predecessor_credential_revision_id?: number;
  credential_revision_id: number;
  credential_revision_version: number;
  credential_provider: string;
  credential_external_version: string;
  advertised_interface_id: number;
  interface_health_observation_id: number;
  health_observed_at: string;
  health_expires_at: string;
  protocol_binding: "JSONRPC";
  protocol_version: "1.0";
  auth_scheme: "Bearer";
  wire_conformance_artifact_id: string;
  wire_conformance_artifact_digest_sha256: string;
  served_spec_observation_id: number;
  wire_conformance_evidence_id: number;
  lvis_app_head_sha: string;
  remote_server_head_sha: string;
  a2a_tck_tag: string;
  a2a_tck_commit_sha: string;
  lvis_app_lock_digest_sha256: string;
  remote_server_lock_digest_sha256: string;
  a2a_tck_lock_digest_sha256: string;
  a2a_specification_uri: typeof A2A_SPECIFICATION_URI;
}

export interface A2ARouteResolveRequest {
  operationId: string;
  attemptId: string;
  operation: A2ARemoteOperation;
  method: A2ADirectJsonRpcMethod;
  intendedCredentialRevisionId: number;
  predecessorCredentialRevisionId?: number;
  lineage: A2ARemoteLineage;
}

export type A2ARouteOperationKind =
  | "initial_send"
  | "exact_initial_send_replay"
  | "get_task"
  | "continue_send"
  | "cancel_task";

export interface A2ARouteResolveRequestWire {
  operation_id: string;
  attempt_id: string;
  operation_kind: A2ARouteOperationKind;
  a2a_method: A2ADirectJsonRpcMethod;
  extension_uri: typeof A2A_EXACT_SEND_REPLAY_URI;
  target_agent_id: number;
  interface_url: string;
  agent_card_digest_sha256: string;
  trust_key_id: number;
  credential_binding_id: number;
  caller_generation_id: string;
  route_policy_version: number;
  route_policy_digest_sha256: string;
  extension_spec_digest_sha256: string;
  intended_credential_revision_id: number;
  predecessor_credential_revision_id?: number;
}

export interface A2ARouteResolveHttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}

export interface A2ARouteControlPlaneClient {
  resolve(request: Readonly<A2ARouteResolveRequest>): Promise<A2ARouteSnapshot>;
}

export interface A2APreparedSecretHandle {
  /** Returns the bearer once; callers must never persist or log it. */
  take(): string;
  zeroize(): void;
}

export interface A2ALocalSecretResolver {
  prepare(input: Readonly<{
    operationId: string;
    credentialBindingId: number;
    credentialRevisionId: number;
  }>): Promise<A2APreparedSecretHandle>;
}

export interface A2ARemoteApprovalDecision {
  decisionId: string;
  decidedAt: string;
  intendedCredentialRevisionId: number;
  lineageDigestSha256: string;
  semanticDigestSha256: string;
}

export interface A2ARemoteMutationApprover {
  approve(input: Readonly<{
    operation: Extract<A2ARemoteOperation, "initial-send" | "continue" | "cancel">;
    operationId: string;
    lineage: A2ARemoteLineage;
    intendedCredentialRevisionId: number;
    lineageDigestSha256: string;
    semanticDigestSha256: string;
    targetLabel: string;
  }>): Promise<A2ARemoteApprovalDecision | null>;
}

export interface A2ARemoteAuthorizationContext {
  ownerId: string;
  projectRoot: string;
  profileId: string;
  origin: string;
  depth: number;
  targetAgentId: number;
  interfaceUrl: string;
  taskId?: string;
  contextId?: string;
}

export interface A2ARemoteHostAuthorizer {
  authorize(input: Readonly<A2ARemoteAuthorizationContext>): boolean | Promise<boolean>;
}

export type A2ARemoteOperation =
  | "initial-send"
  | "continue"
  | "get"
  | "cancel"
  | "replay";

export type A2ARemoteDeliveryState =
  | "prepared"
  | "resolved"
  | "in-flight"
  | "outcome-unknown"
  | "reconciling"
  | "settled"
  | "NOT_SENT"
  | "RETENTION_EXPIRED";

export interface A2ARemotePreparedAttempt {
  operationId: string;
  attemptId: string;
  ownerToken: string;
  ownerDigestSha256?: string;
  projectRootDigestSha256?: string;
  profileDigestSha256?: string;
  originDigestSha256?: string;
  operation: A2ARemoteOperation;
  method: A2ADirectJsonRpcMethod;
  lineage: A2ARemoteLineage;
  depth: number;
  semanticRequestHash: string;
  messageId?: string;
  /** Main-owned opaque handle. Remote task/context identifiers never cross renderer IPC. */
  taskHandle?: string;
  targetLabel?: string;
  taskToken?: string;
  contextToken?: string;
  approvalDecisionId?: string;
  approvalDecidedAt?: string;
  createdAt: string;
  attemptDeadline: string;
  intendedCredentialRevisionId: number;
  predecessorCredentialRevisionId?: number;
  payloadRecordId?: string;
  payloadCiphertextSha256?: string;
  payloadBodySha256?: string;
  payloadSize?: number;
  payloadExpiresAt?: string;
}

export interface A2ARemoteResolvedFields {
  snapshotId: string;
  credentialRevisionId: number;
  resolvedAt: string;
  snapshotIssuedAt: string;
  snapshotExpiresAt: string;
  operation: A2ARemoteOperation;
  method: A2ADirectJsonRpcMethod;
  extensionUri: typeof A2A_EXACT_SEND_REPLAY_URI;
  lineage: A2ARemoteLineage;
  semanticRequestHash: string;
  ownerDigestSha256: string;
  projectRootDigestSha256: string;
  profileDigestSha256: string;
  originDigestSha256: string;
  approvalDecisionId?: string;
  approvalDecidedAt?: string;
  taskHandle?: string;
  taskToken?: string;
  contextToken?: string;
  payloadRecordId?: string;
  payloadCiphertextSha256?: string;
  payloadBodySha256?: string;
  payloadSize?: number;
}

export interface A2ARemoteTransportRequest {
  url: string;
  body: Uint8Array;
  bearer: string;
  activateExactReplay: boolean;
  plane?: "data" | "control";
  timeoutMs?: number;
}

export interface A2ARemoteTransportResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export interface A2ARemoteTransport {
  invoke(request: Readonly<A2ARemoteTransportRequest>): Promise<A2ARemoteTransportResponse>;
}

export interface A2ARemoteRequestEnvelope {
  id: A2AJsonRpcId;
  method: A2ADirectJsonRpcMethod;
  params: A2AJsonObject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseA2ARouteSnapshot(
  response: Readonly<A2ARouteResolveHttpResponse>,
  expected: Readonly<A2ARouteResolveRequest>,
  now = Date.now(),
): A2ARouteSnapshot {
  if (
    response.headers["cache-control"]?.trim().toLowerCase() !== "no-store, max-age=0"
    || response.headers.pragma?.trim().toLowerCase() !== "no-cache"
  ) {
    throw new Error("a2a-route-snapshot-cache-invalid");
  }
  if (response.status !== 200) throw new Error("a2a-route-snapshot-unavailable");
  const value = response.body;
  if (!isRecord(value)) throw new Error("a2a-route-snapshot-invalid");
  const required = [
    "snapshot_id", "operation_id", "attempt_id", "operation_kind", "a2a_method",
    "issued_at", "expires_at", "target_agent_id", "interface_url",
    "agent_card_digest_sha256", "trust_key_id", "credential_binding_id",
    "caller_generation_id", "route_policy_version", "route_policy_digest_sha256",
    "extension_uri", "extension_spec_digest_sha256", "intended_credential_revision_id",
    ...(expected.predecessorCredentialRevisionId === undefined
      ? [] : ["predecessor_credential_revision_id"]),
    "credential_revision_id", "credential_revision_version", "credential_provider",
    "credential_external_version", "advertised_interface_id",
    "interface_health_observation_id", "health_observed_at", "health_expires_at",
    "protocol_binding", "protocol_version", "auth_scheme",
    "wire_conformance_artifact_id", "wire_conformance_artifact_digest_sha256",
    "served_spec_observation_id", "wire_conformance_evidence_id",
    CONTROL_PLANE_HEAD_WIRE_KEY, "lvis_app_head_sha", "remote_server_head_sha",
    "a2a_tck_tag", "a2a_tck_commit_sha",
    CONTROL_PLANE_LOCK_WIRE_KEY, "lvis_app_lock_digest_sha256",
    "remote_server_lock_digest_sha256", "a2a_tck_lock_digest_sha256",
    "a2a_specification_uri",
  ];
  if (!exactKeys(value, required)) throw new Error("a2a-route-snapshot-fields-invalid");
  const idFields = [
    value.snapshot_id, value.operation_id, value.attempt_id, value.caller_generation_id,
    value.credential_provider, value.credential_external_version,
    value.wire_conformance_artifact_id,
  ];
  if (!idFields.every(boundedId)) throw new Error("a2a-route-snapshot-id-invalid");
  const numericIds = [
    value.target_agent_id, value.trust_key_id, value.credential_binding_id,
    value.intended_credential_revision_id, value.credential_revision_id,
    value.credential_revision_version, value.advertised_interface_id,
    value.interface_health_observation_id, value.route_policy_version,
    value.served_spec_observation_id, value.wire_conformance_evidence_id,
    ...(expected.predecessorCredentialRevisionId === undefined
      ? [] : [value.predecessor_credential_revision_id]),
  ];
  if (!numericIds.every(positiveSafeInteger)) {
    throw new Error("a2a-route-snapshot-version-invalid");
  }
  if (
    !digest(value.agent_card_digest_sha256)
    || !digest(value.route_policy_digest_sha256)
    || !digest(value.extension_spec_digest_sha256)
    || !digest(value.wire_conformance_artifact_digest_sha256)
    || !digest(value[CONTROL_PLANE_LOCK_WIRE_KEY])
    || !digest(value.lvis_app_lock_digest_sha256)
    || !digest(value.remote_server_lock_digest_sha256)
    || !digest(value.a2a_tck_lock_digest_sha256)
  ) throw new Error("a2a-route-snapshot-digest-invalid");
  if (
    typeof value[CONTROL_PLANE_HEAD_WIRE_KEY] !== "string"
    || !COMMIT_SHA.test(value[CONTROL_PLANE_HEAD_WIRE_KEY])
    || typeof value.lvis_app_head_sha !== "string"
    || !COMMIT_SHA.test(value.lvis_app_head_sha)
    || typeof value.remote_server_head_sha !== "string"
    || !COMMIT_SHA.test(value.remote_server_head_sha)
    || typeof value.a2a_tck_commit_sha !== "string"
    || !COMMIT_SHA.test(value.a2a_tck_commit_sha)
  ) throw new Error("a2a-route-snapshot-head-invalid");
  if (
    typeof value.a2a_tck_tag !== "string"
    || value.a2a_tck_tag.length > 64
    || !A2A_TCK_TAG.test(value.a2a_tck_tag)
  ) throw new Error("a2a-route-snapshot-tck-tag-invalid");
  if (!timestamp(value.issued_at) || !timestamp(value.expires_at)) {
    throw new Error("a2a-route-snapshot-time-invalid");
  }
  if (Date.parse(value.issued_at) > now || Date.parse(value.expires_at) <= now) {
    throw new Error("a2a-route-snapshot-expired");
  }
  const requestWire = toA2ARouteResolveRequest(expected);
  if (
    value.operation_id !== requestWire.operation_id
    || value.attempt_id !== requestWire.attempt_id
    || value.operation_kind !== requestWire.operation_kind
    || value.a2a_method !== requestWire.a2a_method
    || value.target_agent_id !== requestWire.target_agent_id
    || value.interface_url !== requestWire.interface_url
    || value.agent_card_digest_sha256 !== requestWire.agent_card_digest_sha256
    || value.trust_key_id !== requestWire.trust_key_id
    || value.credential_binding_id !== requestWire.credential_binding_id
    || value.caller_generation_id !== requestWire.caller_generation_id
    || value.route_policy_version !== requestWire.route_policy_version
    || value.route_policy_digest_sha256 !== requestWire.route_policy_digest_sha256
    || value.extension_spec_digest_sha256 !== requestWire.extension_spec_digest_sha256
    || value.intended_credential_revision_id !== requestWire.intended_credential_revision_id
    || value.predecessor_credential_revision_id !== requestWire.predecessor_credential_revision_id
    || value.credential_revision_id !== value.intended_credential_revision_id
    || value.extension_uri !== A2A_EXACT_SEND_REPLAY_URI
    || value.a2a_specification_uri !== A2A_SPECIFICATION_URI
  ) {
    throw new Error("a2a-route-snapshot-protocol-invalid");
  }
  if (
    value.protocol_binding !== "JSONRPC"
    || value.protocol_version !== "1.0"
    || value.auth_scheme !== "Bearer"
    || !timestamp(value.health_observed_at)
    || !timestamp(value.health_expires_at)
    || Date.parse(value.health_expires_at) <= now
  ) throw new Error("a2a-route-eligibility-invalid");
  if (typeof value.interface_url !== "string") throw new Error("a2a-route-url-invalid");
  const parsed = new URL(value.interface_url);
  const bareHostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    parsed.protocol !== "https:"
    || parsed.port !== ""
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hash !== ""
    || bareHostname === "localhost"
    || bareHostname.endsWith(".localhost")
    || isIP(bareHostname) !== 0
    || parsed.toString() !== value.interface_url
  ) throw new Error("a2a-route-url-invalid");
  const wire = value as unknown as A2ARouteSnapshotWire;
  return Object.freeze({
    snapshotId: wire.snapshot_id,
    targetAgentId: wire.target_agent_id,
    interfaceUrl: wire.interface_url,
    agentCardDigestSha256: wire.agent_card_digest_sha256,
    trustKeyId: wire.trust_key_id,
    credentialBindingId: wire.credential_binding_id,
    credentialRevisionId: wire.credential_revision_id,
    callerGenerationId: wire.caller_generation_id,
    credentialVersion: wire.credential_revision_version,
    credentialProvider: wire.credential_provider,
    credentialExternalVersion: wire.credential_external_version,
    advertisedInterfaceId: wire.advertised_interface_id,
    interfaceHealthObservationId: wire.interface_health_observation_id,
    healthObservedAt: wire.health_observed_at,
    healthExpiresAt: wire.health_expires_at,
    wireConformanceArtifactId: wire.wire_conformance_artifact_id,
    wireConformanceArtifactDigestSha256: wire.wire_conformance_artifact_digest_sha256,
    servedSpecObservationId: wire.served_spec_observation_id,
    wireConformanceEvidenceId: wire.wire_conformance_evidence_id,
    controlPlaneHeadSha: value[CONTROL_PLANE_HEAD_WIRE_KEY] as string,
    lvisAppHeadSha: wire.lvis_app_head_sha,
    remoteServerHeadSha: wire.remote_server_head_sha,
    a2aTckTag: wire.a2a_tck_tag,
    a2aTckCommitSha: wire.a2a_tck_commit_sha,
    controlPlaneLockDigestSha256: value[CONTROL_PLANE_LOCK_WIRE_KEY] as string,
    lvisAppLockDigestSha256: wire.lvis_app_lock_digest_sha256,
    remoteServerLockDigestSha256: wire.remote_server_lock_digest_sha256,
    a2aTckLockDigestSha256: wire.a2a_tck_lock_digest_sha256,
    a2aSpecificationUri: A2A_SPECIFICATION_URI,
    routePolicyVersion: wire.route_policy_version,
    routePolicyDigestSha256: wire.route_policy_digest_sha256,
    extensionSpecDigestSha256: wire.extension_spec_digest_sha256,
    issuedAt: wire.issued_at,
    expiresAt: wire.expires_at,
    extensionUri: A2A_EXACT_SEND_REPLAY_URI,
    authenticationScheme: "Bearer",
    protocolBinding: "JSONRPC",
    protocolVersion: "1.0",
  });
}

export function toA2ARouteResolveRequest(
  request: Readonly<A2ARouteResolveRequest>,
): A2ARouteResolveRequestWire {
  const operationKind: A2ARouteOperationKind = request.operation === "initial-send"
    && request.method === A2AJsonRpcMethod.SEND_MESSAGE
    ? "initial_send"
    : request.operation === "replay" && request.method === A2AJsonRpcMethod.SEND_MESSAGE
      ? "exact_initial_send_replay"
      : request.operation === "get" && request.method === A2AJsonRpcMethod.GET_TASK
        ? "get_task"
        : request.operation === "continue" && request.method === A2AJsonRpcMethod.SEND_MESSAGE
          ? "continue_send"
          : request.operation === "cancel" && request.method === A2AJsonRpcMethod.CANCEL_TASK
            ? "cancel_task"
            : (() => { throw new Error("a2a-route-operation-method-invalid"); })();
  return {
    operation_id: request.operationId,
    attempt_id: request.attemptId,
    operation_kind: operationKind,
    a2a_method: request.method,
    extension_uri: A2A_EXACT_SEND_REPLAY_URI,
    target_agent_id: request.lineage.targetAgentId,
    interface_url: request.lineage.interfaceUrl,
    agent_card_digest_sha256: request.lineage.agentCardDigestSha256,
    trust_key_id: request.lineage.trustKeyId,
    credential_binding_id: request.lineage.credentialBindingId,
    caller_generation_id: request.lineage.callerGenerationId,
    route_policy_version: request.lineage.routePolicyVersion,
    route_policy_digest_sha256: request.lineage.routePolicyDigestSha256,
    extension_spec_digest_sha256: request.lineage.extensionSpecDigestSha256,
    intended_credential_revision_id: request.intendedCredentialRevisionId,
    ...(request.predecessorCredentialRevisionId
      ? { predecessor_credential_revision_id: request.predecessorCredentialRevisionId }
      : {}),
  };
}

export function sameA2ARemoteLineage(
  left: A2ARemoteLineage,
  right: A2ARemoteLineage,
): boolean {
  return left.targetAgentId === right.targetAgentId
    && left.interfaceUrl === right.interfaceUrl
    && left.agentCardDigestSha256 === right.agentCardDigestSha256
    && left.trustKeyId === right.trustKeyId
    && left.credentialBindingId === right.credentialBindingId
    && left.callerGenerationId === right.callerGenerationId
    && left.routePolicyVersion === right.routePolicyVersion
    && left.routePolicyDigestSha256 === right.routePolicyDigestSha256
    && left.extensionSpecDigestSha256 === right.extensionSpecDigestSha256;
}

export function a2aRemoteLineageDigestSha256(lineage: Readonly<A2ARemoteLineage>): string {
  return createHash("sha256").update(JSON.stringify({ targetAgentId: lineage.targetAgentId, interfaceUrl: lineage.interfaceUrl, agentCardDigestSha256: lineage.agentCardDigestSha256, trustKeyId: lineage.trustKeyId, credentialBindingId: lineage.credentialBindingId, callerGenerationId: lineage.callerGenerationId, routePolicyVersion: lineage.routePolicyVersion, routePolicyDigestSha256: lineage.routePolicyDigestSha256, extensionSpecDigestSha256: lineage.extensionSpecDigestSha256 })).digest("hex");
}
