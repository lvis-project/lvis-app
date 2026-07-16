import { timingSafeEqual } from "node:crypto";
import { safeStorage } from "electron";
import type { SettingsService } from "../data/settings-store.js";
import { isCanonicalA2APublicHttpsOrigin } from "../shared/a2a-public-origin.js";
import type { AgentActionApprover } from "../permissions/agent-action-approver.js";
import type { A2ARequestHandler } from "../api/a2a-router.js";
import { A2ARouteControlClient } from "../api/a2a-route-control-client.js";
import { A2AExactReplayHandler } from "../api/a2a-exact-replay-handler.js";
import { A2AExactReplayStore } from "../api/a2a-exact-replay-store.js";
import { A2ARemoteClient, type A2ARemoteClientResult, type A2ARemoteExecuteInput } from "../api/a2a-remote-client.js";
import { A2ARemoteDurableStore, type A2AOsEncryption, type A2ARemoteOperationRecoveryRoute, type A2ARemoteTaskActionDisposition, type A2ARemoteTaskProjection, type A2ARemoteTaskRoute } from "../api/a2a-remote-store.js";
import { createA2AStrictTransport } from "../api/a2a-remote-transport.js";
import {
  a2aRemoteLineageDigestSha256,
  type A2ARemoteMutationApprover,
} from "../api/a2a-remote-contracts.js";
import { openFeatureNamespace, type FeatureNamespaceHandle } from "./storage/feature-namespace.js";
import { snapshotA2ARemoteGates, type A2ARemoteGateSnapshot } from "./a2a-remote-gates.js";

export const A2A_REMOTE_ROUTE_CONTROL_SECRET_KEY = "a2a.remote.route-control-auth";
export const A2A_REMOTE_RECEIVER_SECRET_KEY = "a2a.remote.receiver-bearer";
export const a2aRemoteDataSecretKey = (bindingId: number, revisionId: number): string => `a2a.remote.data.${bindingId}.${revisionId}`;

export interface A2ARemoteRuntime {
  readonly gates: Readonly<A2ARemoteGateSnapshot>;
  /** One boot-owned single-flight coordinator shared by remote ingress/egress. */
  readonly agentActionApprover: AgentActionApprover;
  execute(input: Readonly<A2ARemoteExecuteInput>): Promise<A2ARemoteClientResult>;
  getTaskProjection(handle: string, ownerId: string): Promise<A2ARemoteTaskProjection | null>;
  getTaskRoute(handle: string, ownerId: string): Promise<A2ARemoteTaskRoute | null>;
  hasTaskAction(handle: string, operation: A2ARemoteExecuteInput["operation"]): Promise<boolean>;
  getOperationRecoveryRoute(handle: string, ownerId: string): Promise<A2ARemoteOperationRecoveryRoute | null>;
  taskActionDisposition(handle: string, operation: A2ARemoteExecuteInput["operation"], ownerId: string): Promise<A2ARemoteTaskActionDisposition>;
  ready(): Promise<void>;
  wrapReceiver(handler: A2ARequestHandler): A2ARequestHandler;
  dispose(): void;
}

export interface CreateA2ARemoteRuntimeOptions {
  settings: Pick<SettingsService, "get" | "getEncryptedSecret">;
  agentActionApprover: AgentActionApprover;
  projectRoot: string;
  gates?: Readonly<A2ARemoteGateSnapshot>;
  encryption?: A2AOsEncryption;
  namespace?: Pick<FeatureNamespaceHandle, "readJson" | "writeJson">;
  audit?: (code: string) => void;
}

interface A2AReceiverExpiryStore {
  expireDue(): Promise<number>;
}

interface A2AOutboundCleanupStore {
  cleanup(): Promise<{ orphaned: number; expired: number }>;
}

export interface A2AReceiverExpiryLifecycle {
  ready(): Promise<void>;
  dispose(): void;
}

type A2AReceiverSweepScheduler = (sweep: () => void) => () => void;

const scheduleReceiverSweep: A2AReceiverSweepScheduler = (sweep) => {
  const timer = setInterval(sweep, 60_000);
  timer.unref();
  return () => clearInterval(timer);
};

/**
 * Starts one boot sweep and one recurring sweep, and returns an idempotent
 * shutdown disposer. Kept as a small seam so timer ownership is provable
 * without opening a listener in unit tests.
 */
export function createA2AReceiverExpiryLifecycle(
  store: A2AReceiverExpiryStore,
  audit?: (code: string) => void,
  schedule: A2AReceiverSweepScheduler = scheduleReceiverSweep,
): A2AReceiverExpiryLifecycle {
  const initialSweep = store.expireDue().then(() => undefined);
  const cancel = schedule(() => {
    void store.expireDue().catch(() => audit?.("receiver-expiry-sweep-failed"));
  });
  let disposed = false;
  return Object.freeze({
    ready: async () => { await initialSweep; },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancel();
    },
  });
}

export function createA2AOutboundCleanupLifecycle(
  store: A2AOutboundCleanupStore,
  audit?: (code: string) => void,
  schedule: A2AReceiverSweepScheduler = scheduleReceiverSweep,
): A2AReceiverExpiryLifecycle {
  const initialSweep = store.cleanup().then(() => undefined);
  const cancel = schedule(() => {
    void store.cleanup().catch(() => audit?.("outbound-cleanup-sweep-failed"));
  });
  let disposed = false;
  return Object.freeze({
    ready: async () => { await initialSweep; },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancel();
    },
  });
}

function secretHandle(value: string) {
  const bytes = Buffer.from(value, "utf8");
  let taken = false;
  return { take: () => { if (taken) throw new Error("a2a-secret-handle-consumed"); taken = true; return bytes.toString("utf8"); }, zeroize: () => bytes.fill(0) };
}

function authorizedBearer(header: string | undefined, secret: Buffer): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(header.slice(7), "utf8");
  try { return candidate.length === secret.length && timingSafeEqual(candidate, secret); } finally { candidate.fill(0); }
}

export function createA2ARemoteRuntime(options: CreateA2ARemoteRuntimeOptions): A2ARemoteRuntime | null {
  const gates = options.gates ?? snapshotA2ARemoteGates(options.settings);
  if (!gates.outboundRouting && !gates.receiverProfile) return null;
  const encryption = options.encryption ?? safeStorage;
  if (!encryption.isEncryptionAvailable()) throw new Error("a2a-remote-os-encryption-unavailable");
  const config = options.settings.get("a2aRemote");
  if (!config.extensionSpecDigestSha256
    || (gates.outboundRouting && !config.outboundCallerGenerationId)
    || (gates.receiverProfile && (!config.receiverCallerGenerationId
      || !isCanonicalA2APublicHttpsOrigin(config.receiverPublicOrigin)))) {
    throw new Error("a2a-remote-config-incomplete");
  }
  if (gates.outboundRouting && (!config.routeControlBaseUrl || config.targets.length === 0 || !options.settings.getEncryptedSecret(A2A_REMOTE_ROUTE_CONTROL_SECRET_KEY))) throw new Error("a2a-remote-outbound-config-incomplete");
  const receiverValue = gates.receiverProfile ? options.settings.getEncryptedSecret(A2A_REMOTE_RECEIVER_SECRET_KEY) : null;
  if (gates.receiverProfile && !receiverValue) throw new Error("a2a-remote-receiver-secret-missing");
  const namespace = options.namespace ?? openFeatureNamespace("a2a-remote");
  const transport = createA2AStrictTransport();
  const store = gates.outboundRouting ? new A2ARemoteDurableStore({
    namespace,
    encryption,
    audit: (event) => options.audit?.(`store:${event.reason}:${event.count}`),
  }) : null;
  const approver: A2ARemoteMutationApprover = {
    approve: async (input) => {
      const lineage = Object.freeze(structuredClone(input.lineage));
      const lineageDigestSha256 = a2aRemoteLineageDigestSha256(lineage);
      if (lineageDigestSha256 !== input.lineageDigestSha256) return null;
      const receipt = await options.agentActionApprover({ toolName: `a2a-remote-${input.operation}`, args: { operation: input.operation, targetLabel: input.targetLabel, semanticDigestSha256: input.semanticDigestSha256, lineage, lineageDigestSha256, intendedCredentialRevisionId: input.intendedCredentialRevisionId }, reason: "Send this DLP-processed message directly to the approved remote A2A agent?", trustOrigin: "user-keyboard" });
      return receipt ? { decisionId: receipt.decisionId, decidedAt: receipt.decidedAt, intendedCredentialRevisionId: input.intendedCredentialRevisionId, lineageDigestSha256, semanticDigestSha256: input.semanticDigestSha256 } : null;
    },
  };
  const client = gates.outboundRouting && store ? new A2ARemoteClient({
    enabled: true,
    authorizer: { authorize: (input) => input.depth === 0 && input.projectRoot === options.projectRoot && config.targets.some((entry) => entry.targetAgentId === input.targetAgentId && entry.interfaceUrl === input.interfaceUrl) },
    approver,
    store,
    secretResolver: { prepare: async ({ credentialBindingId, credentialRevisionId }) => { const value = options.settings.getEncryptedSecret(a2aRemoteDataSecretKey(credentialBindingId, credentialRevisionId)); if (!value) throw new Error("a2a-remote-data-secret-missing"); return secretHandle(value); } },
    controlPlane: new A2ARouteControlClient({ baseUrl: config.routeControlBaseUrl, authResolver: { prepare: async () => { const value = options.settings.getEncryptedSecret(A2A_REMOTE_ROUTE_CONTROL_SECRET_KEY); if (!value) throw new Error("a2a-remote-route-control-secret-missing"); return secretHandle(value); } } }),
    transport,
    audit: (event) => options.audit?.(`${event.operation}:${event.outcome}:${event.code}`),
  }) : null;
  const receiverSecret = receiverValue ? Buffer.from(receiverValue, "utf8") : null;
  const receiverStore = gates.receiverProfile ? new A2AExactReplayStore({ namespace, encryption, maxKeysPerGeneration: config.receiverMaxKeysPerGeneration }) : null;
  const receiverExpiry = receiverStore
    ? createA2AReceiverExpiryLifecycle(receiverStore, options.audit)
    : null;
  const outboundCleanup = store
    ? createA2AOutboundCleanupLifecycle(store, options.audit)
    : null;
  const ready = (async () => {
    await outboundCleanup?.ready();
    await receiverExpiry?.ready();
  })();
  let disposed = false;
  return Object.freeze({
    gates,
    agentActionApprover: options.agentActionApprover,
    ready: async () => { await ready; },
    execute: async (input: Readonly<A2ARemoteExecuteInput>) => {
      if (disposed || !client) throw new Error("a2a-remote-outbound-disabled");
      await ready;
      if (input.lineage.callerGenerationId !== config.outboundCallerGenerationId) throw new Error("a2a-remote-caller-generation-mismatch");
      return await client.execute(input);
    },
    getTaskProjection: async (handle: string, ownerId: string) => {
      if (disposed || !store) throw new Error("a2a-remote-outbound-disabled");
      return await store.getTaskProjection(handle, ownerId);
    },
    getTaskRoute: async (handle: string, ownerId: string) => {
      if (disposed || !store) throw new Error("a2a-remote-outbound-disabled");
      return await store.getTaskRoute(handle, ownerId);
    },
    hasTaskAction: async (handle: string, operation: A2ARemoteExecuteInput["operation"]) => {
      if (disposed || !store) throw new Error("a2a-remote-outbound-disabled");
      return await store.hasTaskAction(handle, operation);
    },
    getOperationRecoveryRoute: async (handle: string, ownerId: string) => {
      if (disposed || !store) throw new Error("a2a-remote-outbound-disabled");
      return await store.getOperationRecoveryRoute(handle, ownerId);
    },
    taskActionDisposition: async (handle: string, operation: A2ARemoteExecuteInput["operation"], ownerId: string) => {
      if (disposed || !store) throw new Error("a2a-remote-outbound-disabled");
      return await store.taskActionDisposition(handle, operation, ownerId);
    },
    wrapReceiver: (handler: A2ARequestHandler) => {
      if (disposed || !receiverStore || !receiverSecret) throw new Error("a2a-remote-receiver-disabled");
      const wrapped = new A2AExactReplayHandler({ enabled: true, handler, store: receiverStore, authenticator: { authenticate: async (authorization) => authorizedBearer(authorization, receiverSecret) ? { callerGenerationId: config.receiverCallerGenerationId } : null }, specificationDigestSha256: config.extensionSpecDigestSha256 });
      return Object.freeze({
        id: wrapped.id,
        card: wrapped.card,
        handle: wrapped.handle.bind(wrapped),
        handleWire: async (...args: Parameters<NonNullable<A2ARequestHandler["handleWire"]>>) => {
          await ready;
          return await wrapped.handleWire!(...args);
        },
      });
    },
    dispose: () => { disposed = true; outboundCleanup?.dispose(); receiverExpiry?.dispose(); receiverSecret?.fill(0); },
  });
}
