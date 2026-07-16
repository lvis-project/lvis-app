import { describe, expect, it, vi } from "vitest";
import { A2AJsonRpcMethod } from "../../shared/a2a-wire.js";
import { A2ARouteControlClient } from "../a2a-route-control-client.js";
import {
  A2A_EXACT_SEND_REPLAY_URI,
  A2A_SPECIFICATION_URI,
  parseA2ARouteSnapshot,
  toA2ARouteResolveRequest,
  type A2ARouteResolveRequest,
} from "../a2a-remote-contracts.js";

const digest = "a".repeat(64);
const input: A2ARouteResolveRequest = {
  operationId: "op-1",
  attemptId: "attempt-1",
  operation: "get",
  method: A2AJsonRpcMethod.GET_TASK,
  intendedCredentialRevisionId: 12,
  lineage: {
    targetAgentId: 1,
    interfaceUrl: "https://agent.example.test/a2a",
    agentCardDigestSha256: digest,
    trustKeyId: 2,
    credentialBindingId: 3,
    callerGenerationId: "generation-1",
    routePolicyVersion: 4,
    routePolicyDigestSha256: digest,
    extensionSpecDigestSha256: digest,
  },
};

const proof = {
  served_spec_observation_id: 7,
  wire_conformance_evidence_id: 8,
  wire_conformance_artifact_id: "artifact-1",
  wire_conformance_artifact_digest_sha256: digest,
  agent_hub_head_sha: "1".repeat(40),
  lvis_app_head_sha: "2".repeat(40),
  remote_server_head_sha: "3".repeat(40),
  a2a_tck_tag: "1.0.0.alpha2",
  a2a_tck_commit_sha: "4".repeat(40),
  agent_hub_lock_digest_sha256: "5".repeat(64),
  lvis_app_lock_digest_sha256: "6".repeat(64),
  remote_server_lock_digest_sha256: "7".repeat(64),
  a2a_tck_lock_digest_sha256: "8".repeat(64),
  a2a_specification_uri: A2A_SPECIFICATION_URI,
} as const;

function hubResponse() {
  return {
    snapshot_id: "snapshot-1",
    ...toA2ARouteResolveRequest(input),
    issued_at: "2026-07-16T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
    credential_revision_id: 12,
    credential_revision_version: 1,
    credential_provider: "vault",
    credential_external_version: "v12",
    advertised_interface_id: 5,
    interface_health_observation_id: 6,
    health_observed_at: "2026-07-16T00:00:00.000Z",
    health_expires_at: "2099-01-01T00:00:00.000Z",
    protocol_binding: "JSONRPC",
    protocol_version: "1.0",
    auth_scheme: "Bearer",
    ...proof,
  };
}

function parse(body: unknown) {
  return parseA2ARouteSnapshot({
    status: 200,
    headers: { "cache-control": "no-store, max-age=0", pragma: "no-cache" },
    body,
  }, input, Date.parse("2026-07-16T00:01:00.000Z"));
}

describe("A2A route-control client plane separation", () => {
  it("posts only the strict route projection with a separate Hub credential", async () => {
    let wireBody = "";
    const transport = { invoke: vi.fn(async (request) => {
      wireBody = Buffer.from(request.body).toString();
      return {
        status: 200,
        headers: { "cache-control": "no-store, max-age=0", pragma: "no-cache" },
        body: Buffer.from(JSON.stringify(hubResponse())),
      };
    }) };
    let zeroized = false;
    const client = new A2ARouteControlClient({
      baseUrl: "https://hub.example.test/",
      transport,
      authResolver: {
        prepare: async () => ({
          take: () => "hub-control-token",
          zeroize: () => { zeroized = true; },
        }),
      },
      now: () => Date.parse("2026-07-16T00:01:00.000Z"),
    });
    await expect(client.resolve(input)).resolves.toMatchObject({
      credentialRevisionId: 12,
      servedSpecObservationId: 7,
      wireConformanceEvidenceId: 8,
      controlPlaneHeadSha: proof.agent_hub_head_sha,
      lvisAppHeadSha: proof.lvis_app_head_sha,
      remoteServerHeadSha: proof.remote_server_head_sha,
      a2aTckTag: "1.0.0.alpha2",
      a2aTckCommitSha: proof.a2a_tck_commit_sha,
      controlPlaneLockDigestSha256: proof.agent_hub_lock_digest_sha256,
      lvisAppLockDigestSha256: proof.lvis_app_lock_digest_sha256,
      remoteServerLockDigestSha256: proof.remote_server_lock_digest_sha256,
      a2aTckLockDigestSha256: proof.a2a_tck_lock_digest_sha256,
      a2aSpecificationUri: A2A_SPECIFICATION_URI,
    });
    expect(transport.invoke).toHaveBeenCalledWith(expect.objectContaining({
      bearer: "hub-control-token",
      plane: "control",
      activateExactReplay: false,
    }));
    expect(Object.keys(JSON.parse(wireBody))).not.toEqual(expect.arrayContaining([
      "task_id", "context_id", "message_id", "body", "owner_token", "secret_reference",
    ]));
    expect(wireBody).not.toMatch(/task-raw|context-raw|message-raw|data-plane-only|owner-token|payload-body/);
    expect(zeroized).toBe(true);
    expect(JSON.parse(wireBody).extension_uri).toBe(A2A_EXACT_SEND_REPLAY_URI);
  });

  it.each(Object.keys(proof))("rejects a Hub snapshot missing required proof field %s", (field) => {
    const body: Record<string, unknown> = { ...hubResponse() };
    delete body[field];
    expect(() => parse(body)).toThrow("a2a-route-snapshot-fields-invalid");
  });

  it.each([
    ["served_spec_observation_id", 0, "a2a-route-snapshot-version-invalid"],
    ["wire_conformance_evidence_id", 1.5, "a2a-route-snapshot-version-invalid"],
    ["agent_hub_head_sha", "A".repeat(40), "a2a-route-snapshot-head-invalid"],
    ["lvis_app_head_sha", "2".repeat(39), "a2a-route-snapshot-head-invalid"],
    ["remote_server_head_sha", "g".repeat(40), "a2a-route-snapshot-head-invalid"],
    ["a2a_tck_commit_sha", "4".repeat(41), "a2a-route-snapshot-head-invalid"],
    ["agent_hub_lock_digest_sha256", "A".repeat(64), "a2a-route-snapshot-digest-invalid"],
    ["remote_server_lock_digest_sha256", "7".repeat(63), "a2a-route-snapshot-digest-invalid"],
    ["a2a_tck_tag", "1.0.0.", "a2a-route-snapshot-tck-tag-invalid"],
    ["a2a_tck_tag", "release/latest", "a2a-route-snapshot-tck-tag-invalid"],
    ["a2a_tck_tag", `1.0.0.${"a".repeat(64)}`, "a2a-route-snapshot-tck-tag-invalid"],
    ["a2a_specification_uri", "https://a2a-protocol.org/latest/specification/", "a2a-route-snapshot-protocol-invalid"],
  ])("rejects malformed Hub proof field %s", (field, value, error) => {
    expect(() => parse({ ...hubResponse(), [field]: value })).toThrow(error as string);
  });

  it("rejects unknown Hub snapshot fields", () => {
    expect(() => parse({ ...hubResponse(), unexpected_proof: true })).toThrow(
      "a2a-route-snapshot-fields-invalid",
    );
  });
});
