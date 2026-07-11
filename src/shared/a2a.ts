/**
 * A2A v1.0 core ProtoJSON types and state helpers (types-only; no SDK runtime).
 * Enum values and camelCase fields mirror lf.a2a.v1 at tag v1.0.0.
 */
export type A2AJsonPrimitive = string | number | boolean | null;
export type A2AJsonValue = A2AJsonPrimitive | A2AJsonObject | A2AJsonValue[];
export interface A2AJsonObject { [key: string]: A2AJsonValue }
export type A2ANonEmptyArray<T> = [T, ...T[]];

export const A2ATaskState = {
  UNSPECIFIED: "TASK_STATE_UNSPECIFIED",
  SUBMITTED: "TASK_STATE_SUBMITTED",
  WORKING: "TASK_STATE_WORKING",
  COMPLETED: "TASK_STATE_COMPLETED",
  FAILED: "TASK_STATE_FAILED",
  CANCELED: "TASK_STATE_CANCELED",
  INPUT_REQUIRED: "TASK_STATE_INPUT_REQUIRED",
  REJECTED: "TASK_STATE_REJECTED",
  AUTH_REQUIRED: "TASK_STATE_AUTH_REQUIRED",
} as const;
export const A2A_TASK_STATE_UNSPECIFIED = A2ATaskState.UNSPECIFIED;
export const A2A_TASK_STATE_SUBMITTED = A2ATaskState.SUBMITTED;
export const A2A_TASK_STATE_WORKING = A2ATaskState.WORKING;
export const A2A_TASK_STATE_COMPLETED = A2ATaskState.COMPLETED;
export const A2A_TASK_STATE_FAILED = A2ATaskState.FAILED;
export const A2A_TASK_STATE_CANCELED = A2ATaskState.CANCELED;
export const A2A_TASK_STATE_INPUT_REQUIRED = A2ATaskState.INPUT_REQUIRED;
export const A2A_TASK_STATE_REJECTED = A2ATaskState.REJECTED;
export const A2A_TASK_STATE_AUTH_REQUIRED = A2ATaskState.AUTH_REQUIRED;
export type A2ATaskState = (typeof A2ATaskState)[keyof typeof A2ATaskState];

export const A2A_TASK_STATE_VALUES = [
  A2ATaskState.UNSPECIFIED,
  A2ATaskState.SUBMITTED,
  A2ATaskState.WORKING,
  A2ATaskState.COMPLETED,
  A2ATaskState.FAILED,
  A2ATaskState.CANCELED,
  A2ATaskState.INPUT_REQUIRED,
  A2ATaskState.REJECTED,
  A2ATaskState.AUTH_REQUIRED,
] as const satisfies readonly A2ATaskState[];

export const A2A_TASK_STATE_PROTO_ORDER: Readonly<Record<A2ATaskState, number>> =
  Object.freeze(
    Object.fromEntries(A2A_TASK_STATE_VALUES.map((state, index) => [state, index])) as Record<
      A2ATaskState,
      number
    >,
  );

/** Lifecycle tiers asserted by a2a-tck STREAM-ORDER-001. */
export const A2A_TASK_STATE_TRANSITION_RANK = Object.freeze({
  [A2ATaskState.UNSPECIFIED]: -1,
  [A2ATaskState.SUBMITTED]: 0,
  [A2ATaskState.WORKING]: 1,
  [A2ATaskState.INPUT_REQUIRED]: 1,
  [A2ATaskState.AUTH_REQUIRED]: 1,
  [A2ATaskState.COMPLETED]: 2,
  [A2ATaskState.FAILED]: 2,
  [A2ATaskState.CANCELED]: 2,
  [A2ATaskState.REJECTED]: 2,
} satisfies Readonly<Record<A2ATaskState, number>>);

export type A2AProjectedTaskState = Exclude<
  A2ATaskState,
  typeof A2ATaskState.UNSPECIFIED | typeof A2ATaskState.AUTH_REQUIRED
>;
export const A2A_PROJECTED_TASK_STATE_VALUES = [
  A2ATaskState.SUBMITTED,
  A2ATaskState.WORKING,
  A2ATaskState.COMPLETED,
  A2ATaskState.FAILED,
  A2ATaskState.CANCELED,
  A2ATaskState.INPUT_REQUIRED,
  A2ATaskState.REJECTED,
] as const satisfies readonly A2AProjectedTaskState[];
export const A2A_TERMINAL_TASK_STATE_VALUES = [
  A2ATaskState.COMPLETED,
  A2ATaskState.FAILED,
  A2ATaskState.CANCELED,
  A2ATaskState.REJECTED,
] as const satisfies readonly A2ATaskState[];
export const A2A_INTERRUPTED_TASK_STATE_VALUES = [
  A2ATaskState.INPUT_REQUIRED,
  A2ATaskState.AUTH_REQUIRED,
] as const satisfies readonly A2ATaskState[];

const TASK_STATES = new Set<A2ATaskState>(A2A_TASK_STATE_VALUES);
const PROJECTED_STATES = new Set<A2ATaskState>(A2A_PROJECTED_TASK_STATE_VALUES);
const TERMINAL_STATES = new Set<A2ATaskState>(A2A_TERMINAL_TASK_STATE_VALUES);
const INTERRUPTED_STATES = new Set<A2ATaskState>(A2A_INTERRUPTED_TASK_STATE_VALUES);

export function isA2ATaskState(value: unknown): value is A2ATaskState {
  return typeof value === "string" && TASK_STATES.has(value as A2ATaskState);
}
export function isA2AProjectedTaskState(value: unknown): value is A2AProjectedTaskState {
  return typeof value === "string" && PROJECTED_STATES.has(value as A2ATaskState);
}
export function isA2ATerminalTaskState(state: A2ATaskState): boolean {
  return TERMINAL_STATES.has(state);
}
export function isA2AInterruptedTaskState(state: A2ATaskState): boolean {
  return INTERRUPTED_STATES.has(state);
}
export function canTransitionA2ATaskState(from: A2ATaskState, to: A2ATaskState): boolean {
  if (to === A2ATaskState.UNSPECIFIED) return false;
  if (isA2ATerminalTaskState(from)) return from === to;
  return A2A_TASK_STATE_TRANSITION_RANK[to] >= A2A_TASK_STATE_TRANSITION_RANK[from];
}

export const A2ARole = {
  UNSPECIFIED: "ROLE_UNSPECIFIED",
  USER: "ROLE_USER",
  AGENT: "ROLE_AGENT",
} as const;
export const A2A_ROLE_UNSPECIFIED = A2ARole.UNSPECIFIED;
export const A2A_ROLE_USER = A2ARole.USER;
export const A2A_ROLE_AGENT = A2ARole.AGENT;
export type A2ARole = (typeof A2ARole)[keyof typeof A2ARole];
export const A2A_ROLE_VALUES = [
  A2ARole.UNSPECIFIED,
  A2ARole.USER,
  A2ARole.AGENT,
] as const satisfies readonly A2ARole[];

interface A2APartBase {
  metadata?: A2AJsonObject;
  filename?: string;
  mediaType?: string;
}
export type A2ATextPart = A2APartBase & {
  text: string; raw?: never; url?: never; data?: never;
};
export type A2ARawFilePart = A2APartBase & {
  text?: never; raw: string; url?: never; data?: never;
};
export type A2AUrlFilePart = A2APartBase & {
  text?: never; raw?: never; url: string; data?: never;
};
export type A2AFilePart = A2ARawFilePart | A2AUrlFilePart;
export type A2ADataPart = A2APartBase & {
  text?: never; raw?: never; url?: never; data: A2AJsonValue;
};
export type A2APart = A2ATextPart | A2AFilePart | A2ADataPart;

export interface A2AMessage {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: A2ARole;
  parts: A2ANonEmptyArray<A2APart>;
  metadata?: A2AJsonObject;
  extensions?: string[];
  referenceTaskIds?: string[];
}
export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2ANonEmptyArray<A2APart>;
  metadata?: A2AJsonObject;
  extensions?: string[];
}
export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  /** ISO 8601 UTC timestamp (ProtoJSON Timestamp). */
  timestamp?: string;
}
export type A2AProjectedTaskStatus = Omit<A2ATaskStatus, "state"> & {
  state: A2AProjectedTaskState;
};
export interface A2ATask {
  id: string;
  contextId?: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: A2AJsonObject;
}
/** v1.0 removed the legacy final field. */
export interface A2ATaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: A2ATaskStatus;
  metadata?: A2AJsonObject;
}

export type A2ASubAgentRunState =
  | "submitted" | "running" | "waiting" | "done"
  | "error" | "interrupted" | "rejected";
export const A2A_SUB_AGENT_RUN_STATE_MAP = Object.freeze({
  submitted: A2ATaskState.SUBMITTED,
  running: A2ATaskState.WORKING,
  waiting: A2ATaskState.INPUT_REQUIRED,
  done: A2ATaskState.COMPLETED,
  error: A2ATaskState.FAILED,
  interrupted: A2ATaskState.CANCELED,
  rejected: A2ATaskState.REJECTED,
} satisfies Readonly<Record<A2ASubAgentRunState, A2AProjectedTaskState>>);
export function projectSubAgentRunState(state: A2ASubAgentRunState): A2AProjectedTaskState {
  return A2A_SUB_AGENT_RUN_STATE_MAP[state];
}

export interface A2ASubAgentResultLike {
  ok: boolean;
  stopReason?: string;
  suspension?: { reason: "budget" | "question"; prompt?: string; resumeId: string };
  /** Temporary compatibility alias for pre-suspension results. */
  incomplete?: boolean;
  resumeExhausted?: boolean;
}
/** Approval/plugin-auth waits remain running/WORKING and never project AUTH_REQUIRED. */
export function projectSubAgentResultState(
  result: A2ASubAgentResultLike,
): A2AProjectedTaskState {
  if (result.resumeExhausted || result.stopReason === "blocked") {
    return A2ATaskState.REJECTED;
  }
  if (result.stopReason === "interrupted") return A2ATaskState.CANCELED;
  if (!result.ok) return A2ATaskState.FAILED;
  if (result.suspension || result.incomplete === true || result.stopReason === "round-cap") {
    return A2ATaskState.INPUT_REQUIRED;
  }
  return A2ATaskState.COMPLETED;
}
