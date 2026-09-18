import { posix } from "node:path";
import { canonicalStringify } from "../shared/canonical-json.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import type { ToolExecutionResult } from "../tools/types.js";
import {
  WorkloadBrokerConfigurationError,
  assertSecureWorkloadBrokerSocket,
  loadWorkloadBrokerCapabilityFile,
} from "./capability-file.js";
import {
  WorkloadBrokerTransportError,
  getWorkloadBrokerResponseReceipt,
  isIssuedWorkloadBrokerResponseReceipt,
  sendWorkloadBrokerRequest,
} from "./broker-client.js";
export type { WorkloadBrokerResponseReceipt } from "./broker-client.js";
import type {
  WorkloadBrokerCapabilityDocument,
  WorkloadBrokerCorrelation,
  WorkloadBrokerOperation,
  WorkloadBrokerSuccessResults,
  WorkloadIdentity,
  WorkloadExecutionGrantProjection,
  WorkloadOperationPayloads,
} from "./protocol.js";
import { WorkloadExecutionGrantProjectionSchema } from "./protocol.js";
import { WORKLOAD_BROKER_LIMITS } from "./protocol.js";

declare const brokeredWorkloadCapabilityBrand: unique symbol;

export type WorkloadToolOperation = Exclude<WorkloadBrokerOperation, "handshake">;

declare const workloadToolCorrelationAuthorityBrand: unique symbol;
export interface WorkloadToolCorrelationProjection {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly operation: WorkloadToolOperation;
  readonly grant: WorkloadExecutionGrantProjection;
}
export interface WorkloadToolCorrelationAuthority extends WorkloadToolCorrelationProjection {
  readonly [workloadToolCorrelationAuthorityBrand]: true;
}

export interface WorkloadBackgroundParent {
  readonly clientRequestId: string;
  readonly brokerRequestId: string;
  readonly brokerInstanceId: string;
  readonly correlationDigest: string;
  readonly payloadDigest: string;
  readonly admittedReceiptDigest: string;
  readonly terminalReceiptDigest: string;
  readonly executionId: string;
}

export type WorkloadBackgroundActor =
  | {
      readonly kind: "tool-invocation";
      readonly authority: WorkloadToolCorrelationAuthority;
    }
  | {
      readonly kind: "host-cleanup";
      readonly reason: "session-disposal" | "application-shutdown";
    };

export type WorkloadBrokerOperationAuthority =
  | WorkloadToolCorrelationAuthority
  | Readonly<{
      parent: WorkloadBackgroundParent;
      actor: WorkloadBackgroundActor;
    }>;

const issuedToolCorrelationAuthorities = new WeakSet<WorkloadToolCorrelationAuthority>();
const consumedToolCorrelationAuthorities = new WeakSet<WorkloadToolCorrelationAuthority>();
const issuedBackgroundParents = new WeakSet<WorkloadBackgroundParent>();
const issuedCorrelations = new WeakMap<WorkloadBrokerCorrelation, Readonly<{
  operation: WorkloadToolOperation;
  payloadDigest: string;
}>>();

const TOOL_OPERATIONS = Object.freeze({
  bash: ["shell.run", "shell.start"],
  bash_output: ["shell.read"],
  bash_kill: ["shell.kill"],
  read_file: ["file.read"],
  view_image: ["file.read_binary"],
  list_files: ["file.list"],
  glob_files: ["file.glob"],
  grep_files: ["file.grep"],
  write_file: ["file.write"],
  edit_file: ["file.edit"],
  apply_patch: ["file.patch"],
  move_file: ["file.move"],
  copy_path: ["file.copy"],
  extract_archive: ["file.extract"],
  delete_file: ["file.delete"],
} as const satisfies Readonly<Record<string, readonly WorkloadToolOperation[]>>);

function toolAllowsOperation(toolName: string, operation: WorkloadToolOperation): boolean {
  const operations = (TOOL_OPERATIONS as Readonly<
    Record<string, readonly WorkloadToolOperation[] | undefined>
  >)[toolName];
  return operations?.includes(operation) === true;
}

export function issueWorkloadToolCorrelationAuthority(input: {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly operation: WorkloadToolOperation;
  readonly grant: WorkloadExecutionGrantProjection;
}): WorkloadToolCorrelationAuthority {
  if (!toolAllowsOperation(input.toolName, input.operation) ||
      !WorkloadExecutionGrantProjectionSchema.safeParse(input.grant).success) {
    throw new WorkloadBrokerTransportError("correlation-authority-invalid");
  }
  const authority = Object.freeze({ ...input }) as WorkloadToolCorrelationAuthority;
  issuedToolCorrelationAuthorities.add(authority);
  return authority;
}

export function issueWorkloadBackgroundParent(
  result: WorkloadBrokerSuccessResults["shell.start"],
): WorkloadBackgroundParent {
  if (!("executionId" in result)) {
    throw new WorkloadBrokerTransportError("background-parent-result-invalid");
  }
  const receipt = getWorkloadBrokerResponseReceipt(result);
  if (receipt?.correlation.operation !== "shell.start") {
    throw new WorkloadBrokerTransportError("background-parent-receipt-invalid");
  }
  if (!isIssuedWorkloadBrokerResponseReceipt(receipt)) {
    throw new WorkloadBrokerTransportError("background-parent-receipt-invalid");
  }
  const parent = Object.freeze({
    clientRequestId: receipt.clientRequestId,
    brokerRequestId: receipt.brokerRequestId,
    brokerInstanceId: receipt.brokerInstanceId,
    correlationDigest: receipt.correlationDigest,
    payloadDigest: receipt.payloadDigest,
    admittedReceiptDigest: receipt.admittedReceiptDigest,
    terminalReceiptDigest: receipt.terminalReceiptDigest,
    executionId: result.executionId,
  });
  issuedBackgroundParents.add(parent);
  return parent;
}

export function createWorkloadToolCorrelation(
  authority: WorkloadToolCorrelationAuthority,
  operation: Exclude<WorkloadToolOperation, "shell.read" | "shell.kill">,
  payload: WorkloadOperationPayloads[typeof operation],
): WorkloadBrokerCorrelation {
  if (!issuedToolCorrelationAuthorities.has(authority) ||
      consumedToolCorrelationAuthorities.has(authority) ||
      authority.operation !== operation) {
    throw new WorkloadBrokerTransportError("correlation-authority-invalid");
  }
  consumedToolCorrelationAuthorities.add(authority);
  const payloadDigest = sha256Hex(canonicalStringify(payload));
  const correlation = Object.freeze({
    version: "lvis-workload-correlation/v1" as const,
    kind: "tool-invocation" as const,
    toolUseId: authority.toolUseId,
    toolName: authority.toolName,
    grant: authority.grant,
    payloadDigest,
    operation,
  });
  issuedCorrelations.set(correlation, Object.freeze({ operation, payloadDigest }));
  return correlation;
}

export function createWorkloadBackgroundCorrelation(
  parent: WorkloadBackgroundParent,
  actor: WorkloadBackgroundActor,
  operation: "shell.read" | "shell.kill",
  payload: WorkloadOperationPayloads[typeof operation],
): WorkloadBrokerCorrelation {
  if (!issuedBackgroundParents.has(parent) ||
      (actor.kind === "tool-invocation" &&
        (!issuedToolCorrelationAuthorities.has(actor.authority) ||
          consumedToolCorrelationAuthorities.has(actor.authority) ||
          actor.authority.operation !== operation)) ||
      (actor.kind === "host-cleanup" && operation !== "shell.kill")) {
    throw new WorkloadBrokerTransportError("background-correlation-authority-invalid");
  }
  const payloadDigest = sha256Hex(canonicalStringify(payload));
  if (actor.kind === "tool-invocation") {
    consumedToolCorrelationAuthorities.add(actor.authority);
  }
  const correlation = Object.freeze({
    version: "lvis-workload-correlation/v1" as const,
    kind: "background-lifecycle" as const,
    parent: Object.freeze({ ...parent }),
    actor: actor.kind === "host-cleanup"
      ? Object.freeze({ ...actor })
      : Object.freeze({
          kind: "tool-invocation" as const,
          toolUseId: actor.authority.toolUseId,
          toolName: actor.authority.toolName,
          operation,
          grant: actor.authority.grant,
        }),
    payloadDigest,
    operation,
  });
  issuedCorrelations.set(correlation, Object.freeze({ operation, payloadDigest }));
  return correlation;
}

export { getWorkloadBrokerResponseReceipt };

export interface WorkloadBrokerBootConfig {
  readonly socketPath: string;
  readonly capabilityPath: string;
}

export interface BrokeredWorkloadCapability {
  readonly [brokeredWorkloadCapabilityBrand]: true;
  readonly version: "brokered-workload-capability/v1";
  readonly workload: Readonly<WorkloadIdentity>;
  readonly expiresAt: string;
  readonly allowedOperations: readonly WorkloadToolOperation[];
}

export interface BrokeredWorkloadProjection {
  readonly version: "brokered-workload-capability/v1";
  readonly workload: Readonly<WorkloadIdentity>;
  readonly expiresAt: string;
  readonly allowedOperations: readonly WorkloadToolOperation[];
}

export type BrokeredWorkloadExecutionResult<K extends WorkloadToolOperation> =
  | WorkloadBrokerSuccessResults[K]
  | ToolExecutionResult;

interface ActiveWorkloadBrokerState {
  readonly config: WorkloadBrokerBootConfig;
  readonly document: WorkloadBrokerCapabilityDocument;
}

let activeState: ActiveWorkloadBrokerState | undefined;
let issuedCapabilities = new WeakMap<BrokeredWorkloadCapability, ActiveWorkloadBrokerState>();

function projectionFor(document: WorkloadBrokerCapabilityDocument): BrokeredWorkloadProjection {
  return Object.freeze({
    version: "brokered-workload-capability/v1" as const,
    workload: document.workload,
    expiresAt: document.expiresAt,
    allowedOperations: Object.freeze(
      document.allowedOperations.filter((operation): operation is WorkloadToolOperation =>
        operation !== "handshake"),
    ),
  });
}

function sameWorkload(left: WorkloadIdentity, right: WorkloadIdentity): boolean {
  return left.id === right.id
    && left.generation === right.generation
    && left.boundaryFingerprint === right.boundaryFingerprint
    && left.imageDigest === right.imageDigest
    && left.cwd === right.cwd
    && left.home === right.home
    && left.platform === right.platform;
}

async function performHandshake(
  state: ActiveWorkloadBrokerState,
  signal?: AbortSignal,
): Promise<void> {
  assertSecureWorkloadBrokerSocket(state.config.socketPath);
  const result = await sendWorkloadBrokerRequest(
    state.document,
    "handshake",
    { workload: state.document.workload },
    signal,
  );
  if (!sameWorkload(result.workload, state.document.workload)
      || result.expiresAt !== state.document.expiresAt
      || result.maxRequestBytes !== state.document.maxRequestBytes
      || result.maxResponseBytes !== state.document.maxResponseBytes
      || result.allowedOperations.length !== state.document.allowedOperations.length
      || result.allowedOperations.some((operation, index) =>
        operation !== state.document.allowedOperations[index])) {
    throw new WorkloadBrokerTransportError("handshake-binding-mismatch");
  }
}

function issueCapability(state: ActiveWorkloadBrokerState): BrokeredWorkloadCapability {
  const projection = projectionFor(state.document);
  const capability = Object.freeze({ ...projection }) as BrokeredWorkloadCapability;
  issuedCapabilities.set(capability, state);
  return capability;
}

function requireCapabilityState(
  capability: BrokeredWorkloadCapability,
): ActiveWorkloadBrokerState {
  const state = issuedCapabilities.get(capability);
  if (!state || state !== activeState) {
    throw new WorkloadBrokerTransportError("capability-invalid");
  }
  if (Date.parse(state.document.expiresAt) <= Date.now()) {
    throw new WorkloadBrokerTransportError("capability-expired");
  }
  return state;
}

/**
 * Activate the exclusive broker route before any host or tool service boots.
 * A configured launch either completes its exact-binding handshake or throws;
 * there is intentionally no degraded local execution mode.
 */
export async function initializeWorkloadBroker(
  config: WorkloadBrokerBootConfig,
  signal?: AbortSignal,
): Promise<BrokeredWorkloadCapability> {
  if (activeState) throw new WorkloadBrokerConfigurationError("already-initialized");
  const document = loadWorkloadBrokerCapabilityFile(config.capabilityPath, config.socketPath);
  const candidate: ActiveWorkloadBrokerState = Object.freeze({
    config: Object.freeze({ ...config }),
    document,
  });
  await performHandshake(candidate, signal);
  activeState = candidate;
  return issueCapability(candidate);
}

export function isWorkloadBrokerActive(): boolean {
  return activeState !== undefined;
}

/** Exact designation predicate; false never grants a local-path alternative. */
export function isActiveWorkloadBrokerCwd(cwd: string): boolean {
  return activeState !== undefined && activeState.document.workload.cwd === cwd;
}

export function getActiveWorkloadBrokerProjection(): BrokeredWorkloadProjection | undefined {
  return activeState === undefined ? undefined : projectionFor(activeState.document);
}

export function isIssuedActiveBrokeredWorkloadCapability(
  value: unknown,
): value is BrokeredWorkloadCapability {
  if (typeof value !== "object" || value === null || activeState === undefined) return false;
  const state = issuedCapabilities.get(value as BrokeredWorkloadCapability);
  return state === activeState && Date.parse(state.document.expiresAt) > Date.now();
}

/**
 * Resolve a model-supplied path only in the bound Linux workload namespace.
 * The controller host's cwd, HOME, platform separators, and filesystem never
 * participate in this mapping.
 */
export function resolveBrokeredWorkloadPath(
  capability: BrokeredWorkloadCapability,
  inputPath: string,
): string {
  const state = requireCapabilityState(capability);
  if (inputPath.length === 0
      || inputPath.includes("\0")
      || Buffer.byteLength(inputPath, "utf8") > WORKLOAD_BROKER_LIMITS.maximumPathBytes) {
    throw new WorkloadBrokerTransportError("guest-path-invalid");
  }

  const { cwd, home } = state.document.workload;
  let resolved: string;
  if (inputPath === "~") {
    resolved = home;
  } else if (inputPath.startsWith("~/")) {
    resolved = posix.resolve(home, inputPath.slice(2));
  } else if (inputPath.startsWith("~")) {
    throw new WorkloadBrokerTransportError("guest-path-tilde-user-unsupported");
  } else {
    resolved = posix.isAbsolute(inputPath)
      ? posix.resolve(inputPath)
      : posix.resolve(cwd, inputPath);
  }

  if (!posix.isAbsolute(resolved)
      || posix.normalize(resolved) !== resolved
      || Buffer.byteLength(resolved, "utf8") > WORKLOAD_BROKER_LIMITS.maximumPathBytes) {
    throw new WorkloadBrokerTransportError("guest-path-invalid");
  }
  return resolved;
}

export async function acquireBrokeredWorkloadCapability(
  signal?: AbortSignal,
): Promise<BrokeredWorkloadCapability> {
  const state = activeState;
  if (!state) throw new WorkloadBrokerTransportError("not-configured");
  await performHandshake(state, signal);
  return issueCapability(state);
}

export async function revalidateBrokeredWorkloadCapability(
  capability: BrokeredWorkloadCapability,
  signal?: AbortSignal,
): Promise<BrokeredWorkloadProjection> {
  const state = requireCapabilityState(capability);
  await performHandshake(state, signal);
  return projectionFor(state.document);
}

function errorResult(error: unknown): ToolExecutionResult {
  const transportError = error instanceof WorkloadBrokerTransportError
    ? error
    : error instanceof WorkloadBrokerConfigurationError
      ? new WorkloadBrokerTransportError(error.code)
      : new WorkloadBrokerTransportError("unexpected-failure");
  return {
    output: `Workload broker refused execution (${transportError.code}).`,
    isError: true,
    metadata: {
      source: "workload-broker",
      code: transportError.code,
      retryable: transportError.retryable,
    },
  };
}

/**
 * Execute only through the bound workload broker. Revalidation happens before
 * every operation; any failure becomes a typed tool error and never reaches a
 * local shell or filesystem fallback.
 */
export async function executeBrokeredWorkloadRequest<K extends WorkloadToolOperation>(
  capability: BrokeredWorkloadCapability,
  operation: K,
  payload: WorkloadOperationPayloads[K],
  authority: WorkloadBrokerOperationAuthority,
  signal?: AbortSignal,
): Promise<BrokeredWorkloadExecutionResult<K>> {
  try {
    const state = requireCapabilityState(capability);
    const correlation = "parent" in authority
      ? createWorkloadBackgroundCorrelation(
          authority.parent,
          authority.actor,
          operation as "shell.read" | "shell.kill",
          payload as WorkloadOperationPayloads["shell.read" | "shell.kill"],
        )
      : createWorkloadToolCorrelation(
          authority,
          operation as Exclude<WorkloadToolOperation, "shell.read" | "shell.kill">,
          payload as WorkloadOperationPayloads[Exclude<WorkloadToolOperation, "shell.read" | "shell.kill">],
        );
    await performHandshake(state, signal);
    return await sendWorkloadBrokerRequest(
      state.document,
      operation,
      payload,
      signal,
      correlation,
    );
  } catch (error) {
    return errorResult(error);
  }
}

/** Test isolation only; production never deactivates or swaps an active route. */
export function __resetActiveWorkloadBrokerForTests(): void {
  activeState = undefined;
  issuedCapabilities = new WeakMap();
}
