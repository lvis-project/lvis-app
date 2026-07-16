import { describe, expect, it, vi } from "vitest";
import type { SettingsService } from "../../data/settings-store.js";
import { createA2ARemoteRuntime } from "../a2a-remote-runtime.js";

const digest = "a".repeat(64);
function settings(features: Record<string, boolean>, secrets: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  const get = vi.fn((key: string) => key === "features" ? features : key === "a2aRemote" ? { agentHubBaseUrl: "https://hub.example.test/", outboundCallerGenerationId: "outbound-generation-1", receiverCallerGenerationId: "receiver-generation-1", extensionSpecDigestSha256: digest, targets: [{ targetAgentId: 1, label: "Agent one", interfaceUrl: "https://agent.example.test/a2a", agentCardDigestSha256: digest, trustKeyId: 2, credentialBindingId: 3, routePolicyVersion: 4, routePolicyDigestSha256: digest, intendedCredentialRevisionId: 5 }], receiverMaxKeysPerGeneration: 10, ...config } : undefined);
  const getEncryptedSecret = vi.fn((key: string) => secrets[key] ?? null);
  return { value: { get, getEncryptedSecret } as unknown as Pick<SettingsService, "get" | "getEncryptedSecret">, get, getEncryptedSecret };
}
const encryption = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() };
const namespace = { readJson: async <T>(_name: string, fallback: T) => fallback, writeJson: async () => undefined };
const agentActionApprover = vi.fn(async () => true);

describe("A2A remote boot runtime", () => {
  it("has zero config, secret, namespace, Hub, DNS, and listener effect when both gates are OFF", () => {
    const value = settings({ a2aLoopbackServer: true });
    expect(createA2ARemoteRuntime({ settings: value.value, agentActionApprover, projectRoot: "/project" })).toBeNull();
    expect(value.get).toHaveBeenCalledTimes(1); expect(value.get).toHaveBeenCalledWith("features"); expect(value.getEncryptedSecret).not.toHaveBeenCalled();
  });
  it("fails closed before runtime creation when an enabled gate lacks OS encryption or config", () => {
    const value = settings({ a2aRemoteRouting: true });
    expect(() => createA2ARemoteRuntime({ settings: value.value, agentActionApprover, projectRoot: "/project", encryption: { ...encryption, isEncryptionAvailable: () => false }, namespace })).toThrow("a2a-remote-os-encryption-unavailable");
    const missing = settings({ a2aRemoteRouting: true }, { "a2a.remote.hub-auth": "hub" }, { outboundCallerGenerationId: "" });
    expect(() => createA2ARemoteRuntime({ settings: missing.value, agentActionApprover, projectRoot: "/project", encryption, namespace })).toThrow("a2a-remote-config-incomplete");
  });
  it("assembles an optional host-owned runtime without opening a socket", () => {
    const value = settings({ a2aRemoteRouting: true }, { "a2a.remote.hub-auth": "hub-secret" });
    const runtime = createA2ARemoteRuntime({ settings: value.value, agentActionApprover, projectRoot: "/project", encryption, namespace });
    expect(runtime?.gates).toEqual({ outboundRouting: true, receiverProfile: false });
    expect(value.getEncryptedSecret).toHaveBeenCalledWith("a2a.remote.hub-auth");
    runtime?.dispose();
  });
});
