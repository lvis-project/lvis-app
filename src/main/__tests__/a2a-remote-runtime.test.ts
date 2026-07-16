import { describe, expect, it, vi } from "vitest";
import type { SettingsService } from "../../data/settings-store.js";
import { buildSingleFlightAgentActionApprover } from "../../permissions/agent-action-approver.js";
import {
  createA2AOutboundCleanupLifecycle,
  createA2AReceiverExpiryLifecycle,
  createA2ARemoteRuntime,
} from "../a2a-remote-runtime.js";

const digest = "a".repeat(64);
function settings(features: Record<string, boolean>, secrets: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  const get = vi.fn((key: string) => key === "features" ? features : key === "a2aRemote" ? { routeControlBaseUrl: "https://hub.example.test/", receiverPublicOrigin: "https://receiver.lvis.ai/", outboundCallerGenerationId: "outbound-generation-1", receiverCallerGenerationId: "receiver-generation-1", extensionSpecDigestSha256: digest, targets: [{ targetAgentId: 1, label: "Agent one", interfaceUrl: "https://agent.example.test/a2a", agentCardDigestSha256: digest, trustKeyId: 2, credentialBindingId: 3, routePolicyVersion: 4, routePolicyDigestSha256: digest, intendedCredentialRevisionId: 5 }], receiverMaxKeysPerGeneration: 10, ...config } : undefined);
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
    const missing = settings({ a2aRemoteRouting: true }, { "a2a.remote.route-control-auth": "control" }, { outboundCallerGenerationId: "" });
    expect(() => createA2ARemoteRuntime({ settings: missing.value, agentActionApprover, projectRoot: "/project", encryption, namespace })).toThrow("a2a-remote-config-incomplete");
    const receiverMissingOrigin = settings({ a2aRemoteReceiver: true }, { "a2a.remote.receiver-bearer": "receiver" }, { receiverPublicOrigin: "" });
    expect(() => createA2ARemoteRuntime({ settings: receiverMissingOrigin.value, agentActionApprover, projectRoot: "/project", encryption, namespace })).toThrow("a2a-remote-config-incomplete");
    const receiverInvalidOrigin = settings({ a2aRemoteReceiver: true }, { "a2a.remote.receiver-bearer": "receiver" }, { receiverPublicOrigin: "https://receiver.internal/" });
    expect(() => createA2ARemoteRuntime({ settings: receiverInvalidOrigin.value, agentActionApprover, projectRoot: "/project", encryption, namespace })).toThrow("a2a-remote-config-incomplete");
  });
  it("assembles an optional host-owned runtime without opening a socket", () => {
    const value = settings({ a2aRemoteRouting: true }, { "a2a.remote.route-control-auth": "control-secret" });
    const runtime = createA2ARemoteRuntime({ settings: value.value, agentActionApprover, projectRoot: "/project", encryption, namespace });
    expect(runtime?.gates).toEqual({ outboundRouting: true, receiverProfile: false });
    expect(runtime?.agentActionApprover).toBe(agentActionApprover);
    expect(value.getEncryptedSecret).toHaveBeenCalledWith("a2a.remote.route-control-auth");
    runtime?.dispose();
  });

  it("shares one boot-owned single-flight approver across concurrent remote directions", async () => {
    let release!: () => void;
    const decision = new Promise<{ requestId: string; choice: "allow-once" }>((resolve) => {
      release = () => resolve({ requestId: "shared-approval", choice: "allow-once" });
    });
    const requestAndWait = vi.fn(async () => await decision);
    const shared = buildSingleFlightAgentActionApprover({ requestAndWait } as never)!;
    const value = settings(
      { a2aRemoteRouting: true, a2aRemoteReceiver: true },
      { "a2a.remote.route-control-auth": "control-secret", "a2a.remote.receiver-bearer": "receiver-secret" },
    );
    const runtime = createA2ARemoteRuntime({
      settings: value.value,
      agentActionApprover: shared,
      projectRoot: "/project",
      encryption,
      namespace,
    })!;
    expect(runtime.agentActionApprover).toBe(shared);

    const outbound = runtime.agentActionApprover({
      toolName: "a2a-remote-initial-send",
      args: { target: "outbound" },
      reason: "Approve outbound remote mutation?",
      trustOrigin: "user-keyboard",
    });
    await Promise.resolve();
    await expect(runtime.agentActionApprover({
      toolName: "a2a-remote-receiver",
      args: { target: "inbound" },
      reason: "Approve inbound remote mutation?",
      trustOrigin: "a2a-remote-wire",
    })).resolves.toBeNull();
    expect(requestAndWait).toHaveBeenCalledOnce();

    release();
    await expect(outbound).resolves.toMatchObject({ decisionId: "shared-approval" });
    await runtime.ready();
    runtime.dispose();
  });

  it("owns receiver expiry from boot sweep through idempotent shutdown", async () => {
    const expireDue = vi.fn(async () => 0);
    const cancel = vi.fn();
    let scheduledSweep: (() => void) | undefined;
    const lifecycle = createA2AReceiverExpiryLifecycle(
      { expireDue },
      undefined,
      (sweep) => {
        scheduledSweep = sweep;
        return cancel;
      },
    );

    await lifecycle.ready();
    expect(expireDue).toHaveBeenCalledOnce();
    scheduledSweep?.();
    await vi.waitFor(() => expect(expireDue).toHaveBeenCalledTimes(2));
    lifecycle.dispose();
    lifecycle.dispose();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retries redacted outbound cleanup sweeps and disposes the timer", async () => {
    const cleanup = vi.fn()
      .mockResolvedValueOnce({ orphaned: 1, expired: 1 })
      .mockRejectedValueOnce(new Error("private-cleanup-detail"))
      .mockResolvedValueOnce({ orphaned: 0, expired: 0 });
    const audit = vi.fn();
    const cancel = vi.fn();
    let sweep: (() => void) | undefined;
    const lifecycle = createA2AOutboundCleanupLifecycle(
      { cleanup },
      audit,
      (callback) => { sweep = callback; return cancel; },
    );
    await lifecycle.ready();
    sweep?.();
    await vi.waitFor(() => expect(audit).toHaveBeenCalledWith("outbound-cleanup-sweep-failed"));
    expect(JSON.stringify(audit.mock.calls)).not.toContain("private-cleanup-detail");
    sweep?.();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(3));
    lifecycle.dispose();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
