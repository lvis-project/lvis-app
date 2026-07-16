import { describe, expect, it, vi } from "vitest";
import { A2AJsonRpcMethod } from "../../shared/a2a-wire.js";
import { A2AAgentHubClient } from "../a2a-agent-hub-client.js";
import { A2A_EXACT_SEND_REPLAY_URI, type A2ARouteResolveRequest } from "../a2a-remote-contracts.js";

const digest = "a".repeat(64);
describe("Agent Hub route client plane separation", () => {
  it("posts only the strict route projection with a separate Hub credential", async () => {
    const input: A2ARouteResolveRequest = { operationId: "op-1", attemptId: "attempt-1", operation: "get", method: A2AJsonRpcMethod.GET_TASK, intendedCredentialRevisionId: 12, lineage: { targetAgentId: 1, interfaceUrl: "https://agent.example.test/a2a", agentCardDigestSha256: digest, trustKeyId: 2, credentialBindingId: 3, callerGenerationId: "generation-1", routePolicyVersion: 4, routePolicyDigestSha256: digest, extensionSpecDigestSha256: digest } };
    let wireBody = "";
    const transport = { invoke: vi.fn(async (request) => {
      wireBody = Buffer.from(request.body).toString(); const wire = JSON.parse(wireBody);
      const response = { snapshot_id: "snapshot-1", ...wire, issued_at: "2026-07-16T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z", credential_revision_id: 12, credential_revision_version: 1, credential_provider: "vault", credential_external_version: "v12", advertised_interface_id: 5, interface_health_observation_id: 6, health_observed_at: "2026-07-16T00:00:00.000Z", health_expires_at: "2099-01-01T00:00:00.000Z", protocol_binding: "JSONRPC", protocol_version: "1.0", auth_scheme: "Bearer", wire_conformance_artifact_id: "artifact-1", wire_conformance_artifact_digest_sha256: digest };
      return { status: 200, headers: { "cache-control": "no-store, max-age=0", pragma: "no-cache" }, body: Buffer.from(JSON.stringify(response)) };
    }) };
    let zeroized = false;
    const client = new A2AAgentHubClient({ baseUrl: "https://hub.example.test/", transport, authResolver: { prepare: async () => ({ take: () => "hub-control-token", zeroize: () => { zeroized = true; } }) }, now: () => Date.parse("2026-07-16T00:01:00.000Z") });
    await expect(client.resolve(input)).resolves.toMatchObject({ credentialRevisionId: 12 });
    expect(transport.invoke).toHaveBeenCalledWith(expect.objectContaining({ bearer: "hub-control-token", plane: "control", activateExactReplay: false }));
    expect(Object.keys(JSON.parse(wireBody))).not.toEqual(expect.arrayContaining(["task_id", "context_id", "message_id", "body", "owner_token", "secret_reference"]));
    expect(wireBody).not.toMatch(/task-raw|context-raw|message-raw|data-plane-only|owner-token|payload-body/);
    expect(zeroized).toBe(true); expect(JSON.parse(wireBody).extension_uri).toBe(A2A_EXACT_SEND_REPLAY_URI);
  });
});
