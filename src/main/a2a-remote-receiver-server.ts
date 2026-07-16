/**
 * Independent P4-5 receiver listener.
 *
 * This listener intentionally does not share the ph3/local-API gate or its
 * task namespace. It exposes only the immutable A2A route family on loopback;
 * a separately administered trusted HTTPS tunnel/terminator is responsible
 * for any public ingress. The configured receiver bearer is checked by the
 * transport before the router reads a request body and again by the exact
 * replay handler before execution.
 */
import type { AppServices } from "../boot.js";
import type { LocalApi } from "../api/local-api.js";
import {
  startLocalApiHttpServer,
  type LocalApiHttpServer,
} from "../api/http-server.js";
import { createStreamBroadcaster } from "../api/stream-broadcaster.js";
import {
  buildSingleFlightAgentActionApprover,
  type AgentActionApprover,
} from "../permissions/agent-action-approver.js";
import { getLvisAppVersion } from "../shared/app-version.js";
import {
  A2A_REMOTE_RECEIVER_SECRET_KEY,
  type A2ARemoteRuntime,
} from "./a2a-remote-runtime.js";
import {
  createA2ALoopbackRuntime,
  type A2ALoopbackRuntime,
  type CreateA2ALoopbackRuntimeOptions,
} from "./a2a-loopback-runtime.js";
import {
  openFeatureNamespace,
  type FeatureNamespaceHandle,
} from "./storage/feature-namespace.js";

export const A2A_REMOTE_RECEIVER_TASK_FEATURE = "a2a-remote-receiver-tasks";

const unreachableLocalApi: LocalApi = Object.freeze({
  dispatch: async () => ({ ok: false as const, error: "channel-not-public" as const }),
});

export interface RemoteA2AReceiverServer {
  readonly port: number;
}

interface RemoteA2AReceiverServerDependencies {
  createRuntime: (
    options: CreateA2ALoopbackRuntimeOptions,
  ) => Promise<A2ALoopbackRuntime | null>;
  startHttpServer: typeof startLocalApiHttpServer;
  openNamespace: (featureId: string) => FeatureNamespaceHandle;
  buildApprover: (
    services: AppServices,
    log?: (message: string) => void,
  ) => AgentActionApprover | undefined;
}

export interface StartRemoteA2AReceiverServerOptions {
  services: AppServices;
  log?: (message: string) => void;
  /** @internal deterministic lifecycle injection for unit tests. */
  dependencies?: Partial<RemoteA2AReceiverServerDependencies>;
}

interface ActiveReceiver {
  server: LocalApiHttpServer;
  runtime: A2ALoopbackRuntime;
}

let activeReceiver: ActiveReceiver | null = null;
let startPromise: Promise<RemoteA2AReceiverServer | null> | null = null;
let stopPromise: Promise<void> | null = null;
let lifecycleGeneration = 0;
let stopped = false;

function defaultBuildApprover(
  services: AppServices,
  log?: (message: string) => void,
): AgentActionApprover | undefined {
  return buildSingleFlightAgentActionApprover(
    services.approvalGate,
    {
      onConcurrent: () => log?.("[a2a-remote-receiver] concurrent approval denied"),
      onError: () => log?.("[a2a-remote-receiver] approval failed closed"),
    },
    { allowOnceOnly: true },
  );
}

function dependencies(
  overrides: Partial<RemoteA2AReceiverServerDependencies> | undefined,
): RemoteA2AReceiverServerDependencies {
  return {
    createRuntime: createA2ALoopbackRuntime,
    startHttpServer: startLocalApiHttpServer,
    openNamespace: openFeatureNamespace,
    buildApprover: defaultBuildApprover,
    ...overrides,
  };
}

function receiverRuntime(services: AppServices): A2ARemoteRuntime | null {
  const runtime = services.a2aRemoteRuntime;
  return runtime?.gates.receiverProfile ? runtime : null;
}

async function startForBoot(
  options: StartRemoteA2AReceiverServerOptions,
  generation: number,
): Promise<RemoteA2AReceiverServer | null> {
  const remote = receiverRuntime(options.services);
  // This return must precede secret access, namespace creation, handler
  // discovery, and listener construction: OFF means exactly zero side effect.
  if (!remote) return null;

  const deps = dependencies(options.dependencies);
  const receiverSecret = options.services.settingsService.getEncryptedSecret(
    A2A_REMOTE_RECEIVER_SECRET_KEY,
  );
  if (!receiverSecret) throw new Error("a2a-remote-receiver-secret-missing");

  const project = options.services.conversationLoop.getSessionProjectContext();
  const runtime = await deps.createRuntime({
    services: options.services,
    project: {
      root: project.projectRoot
        ?? options.services.conversationLoop.getSessionExecutionCwd(),
      ...(project.projectName ? { name: project.projectName } : {}),
    },
    appVersion: getLvisAppVersion(),
    approveAgentAction: deps.buildApprover(options.services, options.log),
    namespace: deps.openNamespace(A2A_REMOTE_RECEIVER_TASK_FEATURE),
    transformHandler: (handler) => remote.wrapReceiver(handler),
  });
  if (!runtime) return null;
  if (generation !== lifecycleGeneration) {
    await runtime.dispose();
    return null;
  }

  let server: LocalApiHttpServer;
  try {
    server = await deps.startHttpServer({
      api: unreachableLocalApi,
      secret: receiverSecret,
      broadcaster: createStreamBroadcaster(),
      a2aRouter: runtime.router,
      routeFamilies: { localApi: false, a2a: true },
      host: "127.0.0.1",
      port: 0,
      log: (message) => options.log?.(`[a2a-remote-receiver] ${message}`),
    });
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  if (generation !== lifecycleGeneration) {
    await server.close();
    await runtime.dispose();
    return null;
  }
  activeReceiver = { server, runtime };
  options.log?.(
    `[a2a-remote-receiver] listening on trusted-tunnel origin 127.0.0.1:${server.port}`,
  );
  return Object.freeze({ port: server.port });
}

export async function maybeStartRemoteA2AReceiverServer(
  options: StartRemoteA2AReceiverServerOptions,
): Promise<RemoteA2AReceiverServer | null> {
  if (stopped) return null;
  if (stopPromise) {
    await stopPromise;
    return null;
  }
  if (activeReceiver) return Object.freeze({ port: activeReceiver.server.port });
  if (startPromise) return await startPromise;
  const pending = startForBoot(options, lifecycleGeneration);
  startPromise = pending;
  try {
    return await pending;
  } finally {
    if (startPromise === pending) startPromise = null;
  }
}

async function stopForShutdown(): Promise<void> {
  stopped = true;
  lifecycleGeneration += 1;
  const pending = startPromise;
  const current = activeReceiver;
  activeReceiver = null;
  if (current) {
    try {
      await current.server.close();
    } finally {
      await current.runtime.dispose();
    }
  }
  if (pending) await pending.catch(() => undefined);
  const late = activeReceiver as ActiveReceiver | null;
  activeReceiver = null;
  if (late) {
    try {
      await late.server.close();
    } finally {
      await late.runtime.dispose();
    }
  }
}

export function stopRemoteA2AReceiverServer(): Promise<void> {
  if (stopPromise) return stopPromise;
  const pending = stopForShutdown();
  const tracked = pending.finally(() => {
    if (stopPromise === tracked) stopPromise = null;
  });
  stopPromise = tracked;
  return tracked;
}

/** @internal Test-only reset; production uses one immutable boot snapshot. */
export function resetRemoteA2AReceiverServerForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("a2a-remote-receiver-test-reset-outside-test");
  }
  if (activeReceiver || startPromise || stopPromise) {
    throw new Error("a2a-remote-receiver-test-reset-while-active");
  }
  lifecycleGeneration += 1;
  stopped = false;
}
