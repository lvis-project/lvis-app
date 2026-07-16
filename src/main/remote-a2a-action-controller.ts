import { createHash, randomUUID } from "node:crypto";
import type { A2ARemoteSettings, A2ARemoteTargetSettings } from "../data/settings-store.js";
import { A2AJsonRpcMethod, type A2AJsonObject } from "../shared/a2a-wire.js";
import type { A2ARemoteRuntime } from "./a2a-remote-runtime.js";
import { maskA2AMessage } from "../engine/a2a-subagent-message-codec.js";
import { isA2ATerminalTaskState, type A2ATaskState } from "../shared/a2a.js";

const MAX_INTENT_LENGTH = 8_192;

export interface RemoteA2AActionStatus {
  state: "idle" | "awaiting-approval" | "sent" | "failed";
  operationId?: string;
  taskHandle?: string;
  taskState?: A2ATaskState;
  recoveryEligible?: boolean;
  taskAvailable?: boolean;
  targetAgentId?: number;
  targetLabel?: string;
  outcome?: string;
  updatedAt: string;
}

export interface RemoteA2AActionController {
  listTargets(): ReadonlyArray<Readonly<{ targetAgentId: number; label: string }>>;
  status(): Readonly<RemoteA2AActionStatus>;
  send(input: Readonly<{ targetAgentId: number; intent: string }>): Promise<Readonly<RemoteA2AActionStatus>>;
  get(input: Readonly<{ taskHandle: string }>): Promise<Readonly<RemoteA2AActionStatus>>;
  resume(input: Readonly<{ taskHandle: string; intent: string }>): Promise<Readonly<RemoteA2AActionStatus>>;
  cancel(input: Readonly<{ taskHandle: string }>): Promise<Readonly<RemoteA2AActionStatus>>;
  replay(input: Readonly<{ taskHandle: string }>): Promise<Readonly<RemoteA2AActionStatus>>;
}

export interface CreateRemoteA2AActionControllerOptions {
  runtime: A2ARemoteRuntime;
  config: Readonly<A2ARemoteSettings>;
  projectRoot: string;
  now?: () => Date;
  makeId?: () => string;
}

function targetLineage(target: Readonly<A2ARemoteTargetSettings>, config: Readonly<A2ARemoteSettings>) {
  return Object.freeze({
    targetAgentId: target.targetAgentId,
    interfaceUrl: target.interfaceUrl,
    agentCardDigestSha256: target.agentCardDigestSha256,
    trustKeyId: target.trustKeyId,
    credentialBindingId: target.credentialBindingId,
    callerGenerationId: config.outboundCallerGenerationId,
    routePolicyVersion: target.routePolicyVersion,
    routePolicyDigestSha256: target.routePolicyDigestSha256,
    extensionSpecDigestSha256: config.extensionSpecDigestSha256,
  });
}

export function createRemoteA2AActionController(
  options: CreateRemoteA2AActionControllerOptions,
): RemoteA2AActionController {
  if (!options.runtime.gates.outboundRouting) throw new Error("a2a-remote-outbound-disabled");
  if (!options.projectRoot) throw new Error("a2a-remote-project-root-required");
  const now = options.now ?? (() => new Date());
  const makeId = options.makeId ?? randomUUID;
  const targets = new Map(options.config.targets.map((target) => [target.targetAgentId, Object.freeze(structuredClone(target))]));
  if (targets.size !== options.config.targets.length || targets.size === 0) throw new Error("a2a-remote-target-registry-invalid");
  let latest: RemoteA2AActionStatus = Object.freeze({ state: "idle", updatedAt: now().toISOString() });
  let pending = false;
  const ownerId = `local-project:${createHash("sha256").update(options.projectRoot).digest("hex")}`;

  const validateHandle = (handle: string) => {
    if (typeof handle !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(handle)) {
      throw new Error("a2a-remote-task-handle-invalid");
    }
  };

  const taskAction = async (
    action: "get" | "continue" | "cancel",
    input: Readonly<{ taskHandle: string; intent?: string }>,
  ): Promise<Readonly<RemoteA2AActionStatus>> => {
    validateHandle(input.taskHandle);
    if (action === "continue" && (typeof input.intent !== "string" || input.intent.trim() !== input.intent
      || input.intent.length < 1 || input.intent.length > MAX_INTENT_LENGTH)) throw new Error("a2a-remote-intent-invalid");
    const route = await options.runtime.getTaskRoute(input.taskHandle, ownerId);
    if (!route) throw new Error("a2a-remote-task-handle-not-found");
    const target = targets.get(route.targetAgentId);
    if (!target || JSON.stringify(targetLineage(target, options.config)) !== JSON.stringify(route.lineage)) {
      throw new Error("a2a-remote-task-route-not-authorized");
    }
    if (action === "continue") {
      const disposition = await options.runtime.taskActionDisposition(input.taskHandle, action, ownerId);
      if (disposition.kind === "blocked") {
        return Object.freeze({ state: "failed", taskHandle: input.taskHandle, targetAgentId: route.targetAgentId, targetLabel: route.targetLabel, taskState: route.state, outcome: `continue-reconciliation-required:${disposition.outcome}`, updatedAt: now().toISOString() });
      }
      if (route.state !== "TASK_STATE_INPUT_REQUIRED") {
        throw new Error("a2a-remote-task-not-input-required");
      }
    }
    if (action === "cancel") {
      const disposition = await options.runtime.taskActionDisposition(input.taskHandle, action, ownerId);
      if (disposition.kind === "success") {
        const projection = disposition.projection;
        if (route.state !== "TASK_STATE_CANCELED"
          || projection.handle !== input.taskHandle
          || projection.targetAgentId !== route.targetAgentId
          || projection.targetLabel !== route.targetLabel
          || projection.state !== "TASK_STATE_CANCELED"
          || projection.terminal !== true) {
          return Object.freeze({ state: "failed", taskHandle: input.taskHandle, targetAgentId: route.targetAgentId, targetLabel: route.targetLabel, taskState: route.state, outcome: "cancel-reconciliation-required:stored-cancel-projection-invalid", updatedAt: now().toISOString() });
        }
        return Object.freeze({
          state: "sent",
          taskHandle: input.taskHandle,
          targetAgentId: route.targetAgentId,
          targetLabel: route.targetLabel,
          taskState: projection.state,
          outcome: "cancel-already-settled",
          updatedAt: now().toISOString(),
        });
      }
      if (disposition.kind === "blocked") {
        return Object.freeze({ state: "failed", taskHandle: input.taskHandle, targetAgentId: route.targetAgentId, targetLabel: route.targetLabel, taskState: route.state, outcome: `cancel-reconciliation-required:${disposition.outcome}`, updatedAt: now().toISOString() });
      }
      if (isA2ATerminalTaskState(route.state)) {
        throw new Error("a2a-remote-task-terminal");
      }
    }
    if (pending) return Object.freeze({ state: "failed", taskHandle: input.taskHandle, targetAgentId: route.targetAgentId, targetLabel: route.targetLabel, outcome: "a2a-remote-busy", updatedAt: now().toISOString() });
    pending = true;
    const operationId = makeId();
    const attemptId = makeId();
    const messageId = action === "continue" ? makeId() : undefined;
    const revisions = [target.intendedCredentialRevisionId, ...(target.replayCredentialRevisionIds ?? [])];
    const intendedCredentialRevisionId = action === "get" ? revisions.at(-1)! : route.credentialRevisionId;
    let request;
    if (action === "get") {
      request = { id: makeId(), method: A2AJsonRpcMethod.GET_TASK, params: { id: route.remoteTaskId, historyLength: 0 } };
    } else if (action === "cancel") {
      request = { id: makeId(), method: A2AJsonRpcMethod.CANCEL_TASK, params: { id: route.remoteTaskId } };
    } else {
      if (!messageId) {
        pending = false;
        throw new Error("a2a-remote-message-id-unavailable");
      }
      const message = maskA2AMessage({ messageId, taskId: route.remoteTaskId, ...(route.remoteContextId ? { contextId: route.remoteContextId } : {}), role: "ROLE_USER", parts: [{ text: input.intent! }] } as never).message;
      request = { id: makeId(), method: A2AJsonRpcMethod.SEND_MESSAGE, params: { message: message as unknown as A2AJsonObject } };
    }
    latest = Object.freeze({ state: action === "get" ? "idle" : "awaiting-approval", operationId, taskHandle: input.taskHandle, taskState: route.state, targetAgentId: route.targetAgentId, targetLabel: route.targetLabel, updatedAt: now().toISOString() });
    try {
      const result = await options.runtime.execute({
        operationId,
        attemptId,
        operation: action,
        taskHandle: input.taskHandle,
        targetLabel: route.targetLabel,
        authorization: {
          ownerId,
          projectRoot: options.projectRoot,
          profileId: "remote-a2a-action-controller",
          origin: "renderer-user-keyboard",
          depth: 0,
          targetAgentId: route.targetAgentId,
          interfaceUrl: target.interfaceUrl,
          taskId: route.remoteTaskId,
          ...(route.remoteContextId ? { contextId: route.remoteContextId } : {}),
        },
        lineage: route.lineage,
        intendedCredentialRevisionId,
        ...(intendedCredentialRevisionId !== route.credentialRevisionId ? { predecessorCredentialRevisionId: route.credentialRevisionId } : {}),
        request,
        ...(messageId ? { messageId } : {}),
      });
      const projection = await options.runtime.getTaskProjection(input.taskHandle, ownerId);
      latest = Object.freeze({
        state: result.ok ? "sent" : "failed",
        operationId,
        taskHandle: input.taskHandle,
        ...(projection ? { taskState: projection.state } : { taskState: route.state }),
        targetAgentId: route.targetAgentId,
        targetLabel: route.targetLabel,
        outcome: result.ok ? "success" : result.outcome,
        updatedAt: now().toISOString(),
      });
    } catch {
      latest = Object.freeze({ state: "failed", operationId, taskHandle: input.taskHandle, taskState: route.state, targetAgentId: route.targetAgentId, targetLabel: route.targetLabel, outcome: "a2a-remote-task-action-failed", updatedAt: now().toISOString() });
    } finally {
      pending = false;
    }
    return Object.freeze(structuredClone(latest));
  };

  const replayAction = async (input: Readonly<{ taskHandle: string }>): Promise<Readonly<RemoteA2AActionStatus>> => {
    validateHandle(input.taskHandle);
    const recovery = await options.runtime.getOperationRecoveryRoute(input.taskHandle, ownerId);
    if (!recovery) throw new Error("a2a-remote-recovery-not-eligible");
    if (recovery.retryNotBefore && Date.parse(recovery.retryNotBefore) > now().getTime()) {
      return Object.freeze({ state: "failed", taskHandle: input.taskHandle, targetAgentId: recovery.targetAgentId, targetLabel: recovery.targetLabel, recoveryEligible: true, outcome: "replay-retry-not-before", updatedAt: now().toISOString() });
    }
    const target = targets.get(recovery.targetAgentId);
    if (!target || JSON.stringify(targetLineage(target, options.config)) !== JSON.stringify(recovery.lineage)) throw new Error("a2a-remote-task-route-not-authorized");
    const revisions = [target.intendedCredentialRevisionId, ...(target.replayCredentialRevisionIds ?? [])];
    const currentIndex = revisions.indexOf(recovery.credentialRevisionId);
    if (currentIndex < 0) throw new Error("a2a-remote-recovery-revision-not-authorized");
    // Exact replay may legitimately reuse the still-active credential
    // revision. Prefer an explicitly configured rotation successor when one
    // exists; otherwise keep the authorized current revision.
    const successor = revisions[currentIndex + 1] ?? recovery.credentialRevisionId;
    if (pending) return Object.freeze({ state: "failed", taskHandle: input.taskHandle, targetAgentId: recovery.targetAgentId, targetLabel: recovery.targetLabel, recoveryEligible: true, outcome: "a2a-remote-busy", updatedAt: now().toISOString() });
    pending = true;
    const attemptId = makeId();
    latest = Object.freeze({ state: "idle", operationId: recovery.operationId, taskHandle: input.taskHandle, targetAgentId: recovery.targetAgentId, targetLabel: recovery.targetLabel, recoveryEligible: true, updatedAt: now().toISOString() });
    try {
      const result = await options.runtime.execute({
        operationId: recovery.operationId,
        attemptId,
        operation: "replay",
        taskHandle: input.taskHandle,
        targetLabel: recovery.targetLabel,
        authorization: { ownerId, projectRoot: options.projectRoot, profileId: "remote-a2a-action-controller", origin: "renderer-user-keyboard", depth: 0, targetAgentId: recovery.targetAgentId, interfaceUrl: target.interfaceUrl },
        lineage: recovery.lineage,
        intendedCredentialRevisionId: successor,
        predecessorCredentialRevisionId: recovery.credentialRevisionId,
        request: { id: makeId(), method: A2AJsonRpcMethod.SEND_MESSAGE, params: { message: { messageId: recovery.messageId, role: "ROLE_USER", parts: [{ text: "[exact replay uses encrypted original bytes]" }] } } },
        messageId: recovery.messageId,
      });
      latest = Object.freeze({ state: result.ok ? "sent" : "failed", operationId: recovery.operationId, taskHandle: input.taskHandle, targetAgentId: recovery.targetAgentId, targetLabel: recovery.targetLabel, recoveryEligible: !result.ok && (result.outcome === "reconciling" || result.outcome === "unknown-manual-reconciliation-required"), outcome: result.ok ? "success" : result.outcome, updatedAt: now().toISOString() });
    } finally {
      pending = false;
    }
    return Object.freeze(structuredClone(latest));
  };

  return Object.freeze({
    listTargets: () => Object.freeze([...targets.values()].map((target) => Object.freeze({
      targetAgentId: target.targetAgentId,
      label: target.label,
    }))),
    status: () => Object.freeze(structuredClone(latest)),
    send: async (input: Readonly<{ targetAgentId: number; intent: string }>) => {
      if (!Number.isSafeInteger(input.targetAgentId) || input.targetAgentId <= 0) throw new Error("a2a-remote-target-invalid");
      if (typeof input.intent !== "string" || input.intent.trim() !== input.intent
        || input.intent.length < 1 || input.intent.length > MAX_INTENT_LENGTH) throw new Error("a2a-remote-intent-invalid");
      const target = targets.get(input.targetAgentId);
      if (!target) throw new Error("a2a-remote-target-not-authorized");
      if (pending) return Object.freeze({ state: "failed", targetAgentId: target.targetAgentId, targetLabel: target.label, outcome: "a2a-remote-busy", updatedAt: now().toISOString() });
      pending = true;
      const operationId = makeId();
      const attemptId = makeId();
      const messageId = makeId();
      const taskHandle = makeId();
      const canonicalMessage = Object.freeze(maskA2AMessage({
        messageId,
        role: "ROLE_USER",
        parts: [{ text: input.intent }],
      }).message);
      latest = Object.freeze({ state: "awaiting-approval", operationId, taskHandle, targetAgentId: target.targetAgentId, targetLabel: target.label, updatedAt: now().toISOString() });
      try {
        const result = await options.runtime.execute({
          operationId,
          attemptId,
          operation: "initial-send",
          taskHandle,
          targetLabel: target.label,
          authorization: {
            ownerId,
            projectRoot: options.projectRoot,
            profileId: "remote-a2a-action-controller",
            origin: "renderer-user-keyboard",
            depth: 0,
            targetAgentId: target.targetAgentId,
            interfaceUrl: target.interfaceUrl,
          },
          lineage: targetLineage(target, options.config),
          intendedCredentialRevisionId: target.intendedCredentialRevisionId,
          request: {
            id: makeId(),
            method: A2AJsonRpcMethod.SEND_MESSAGE,
            params: { message: canonicalMessage as unknown as A2AJsonObject },
          },
          messageId,
        });
        const projection = await options.runtime.getTaskProjection(taskHandle, ownerId);
        latest = Object.freeze({
          state: result.ok ? "sent" : "failed",
          operationId,
          taskHandle,
          ...(projection ? { taskState: projection.state } : {}),
          taskAvailable: Boolean(projection),
          recoveryEligible: !result.ok && (result.outcome === "reconciling" || result.outcome === "unknown-manual-reconciliation-required"),
          targetAgentId: target.targetAgentId,
          targetLabel: target.label,
          outcome: result.ok ? "success" : result.outcome,
          updatedAt: now().toISOString(),
        });
      } catch {
        latest = Object.freeze({
          state: "failed",
          operationId,
          taskHandle,
          targetAgentId: target.targetAgentId,
          targetLabel: target.label,
          outcome: "a2a-remote-send-failed",
          updatedAt: now().toISOString(),
        });
      } finally {
        pending = false;
      }
      return Object.freeze(structuredClone(latest));
    },
    get: (input: Readonly<{ taskHandle: string }>) => taskAction("get", input),
    resume: (input: Readonly<{ taskHandle: string; intent: string }>) => taskAction("continue", input),
    cancel: (input: Readonly<{ taskHandle: string }>) => taskAction("cancel", input),
    replay: (input: Readonly<{ taskHandle: string }>) => replayAction(input),
  });
}
