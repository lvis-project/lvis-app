/**
 * Versioned host/LLM contract for foreground reviewer rationale handoff.
 *
 * This module deliberately owns no durable ticket map and grants no authority.
 * The turn orchestrator may carry one sealed control value in memory; the
 * follow-up ticket-store PR will add TTL/CAS/audit persistence behind this
 * contract without changing the provider or executor surface.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ChatInputOrigin } from "../../shared/chat-origin.js";
import type { ToolCategory, ToolSource, ToolTrustOrigin } from "../types.js";
import type {
  PermissionCheckResult,
  ReviewerDispatchOutcome,
} from "../../permissions/permission-manager.js";
import type { RiskVerdict } from "../../permissions/reviewer/risk-classifier.js";
import type { ToolSchema } from "../../engine/llm/types.js";
import { maskSensitiveData } from "../../audit/dlp-filter.js";
import { canonicalStringify } from "../../permissions/user-approval-store.js";

export const RATIONALE_CONTROL_CONTRACT_VERSION = 1 as const;
export const RATIONALE_RESPONSE_TOOL = "permission_rationale";

/**
 * PR(1) is contract-only. Production activation remains a hard NO-GO until
 * PR(2) supplies the server-side one-shot ticket store/CAS enforcement and
 * PR(3) supplies the bounded modal UI.
 */
export const FOREGROUND_RATIONALE_PRODUCTION_ENABLED = false as const;
export const RATIONALE_ACTIVATION_PREREQUISITES = [
  "persistent-ticket-store",
  "server-enforced-allowed-choices",
  "one-shot-resolution-cas",
  "bounded-modal-ui",
] as const;

export type RationaleControlState =
  | "review_required"
  | "rationale_requested"
  | "rationale_ready"
  | "rationale_failed"
  | "user_pending"
  | "allowed_once"
  | "denied"
  | "cancelled"
  | "expired";

export type RationaleControlEvent =
  | "request-rationale"
  | "rationale-ready"
  | "rationale-failed"
  | "prompt-user"
  | "allow-once"
  | "deny"
  | "cancel"
  | "expire";

export interface RequestAnchor {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  anchorId: string;
  sessionId: string;
  turnId: string;
  inputMessageId: string;
  inputOrigin: "user-keyboard";
  sanitizedIntent: string;
  intentDigest: string;
  createdAt: number;
  expiresAt: number;
}
export type RationaleTaint =
  | "none"
  | "file-content"
  | "app-emitted"
  | "plugin-emitted"
  | "agent-message"
  | "queue-auto";

export interface RationaleEligibilityProvenance {
  startedFromUserKeyboard: boolean;
  taint: RationaleTaint;
}

export interface HostRationaleEligibilityContext {
  headless: boolean;
  forceModal: boolean;
  approvalReasonPrefix: string | null;
}

type DeepReadonly<T> =
  T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer U)[]
      ? readonly DeepReadonly<U>[]
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;


export interface ActionIdentity {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  anchorId: string;
  actionDigest: string;
  invocationTrustOrigin: ToolTrustOrigin;
  rationaleProvenance: RationaleEligibilityProvenance;
  toolName: string;
  toolVersion: string;
  source: ToolSource;
  category: ToolCategory;
  pluginId?: string;
  mcpServerId?: string;
  workerId?: string;
  finalInputDigest: string;
  approvalCacheKey?: string;
  canonicalTargets: readonly string[];
  requestedEffects: readonly string[];
  affectedResources: readonly string[];
  requiredAuthority: string;
  policyEpoch: string;
  registryGeneration: string;
  sandboxGeneration: string;
  sandboxExecutionPlan: DeepReadonly<Record<string, unknown>>;
}

export interface SealedRationaleAction {
  toolUseId: string;
  toolName: string;
  originalInput: DeepReadonly<Record<string, unknown>>;
  finalInput: DeepReadonly<Record<string, unknown>>;
}

export interface RationaleRequiredControl {
  kind: "rationale-required";
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  state: "rationale_requested";
  ticketId: string;
  nonce: string;
  invocationDigest: string;
  round: 1;
  anchor: RequestAnchor;
  action: ActionIdentity;
  sealedAction: SealedRationaleAction;
  eligibilityContext: HostRationaleEligibilityContext;
  reviewerOutcome: Extract<ReviewerDispatchOutcome, "fresh" | "cache">;
  initialVerdict: RiskVerdict;
  reasonCode: "foreground-reviewer-threshold";
}
export interface RationaleProviderEnvelope {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  anchorId: string;
  ticketId: string;
  actionDigest: string;
  round: 1;
  sanitizedIntent: string;
  toolName: string;
  source: ToolSource;
  category: ToolCategory;
  requestedEffects: readonly string[];
  affectedResources: readonly string[];
  requiredAuthority: string;
  reviewerOutcome: "fresh" | "cache";
  initialVerdict: RiskVerdict;
}


export interface RationaleResponse {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  anchorId: string;
  ticketId: string;
  actionDigest: string;
  round: 1;
  suggestion: string;
  scopeAlignment: "aligned" | "unclear" | "outside";
  scopeReasons: readonly string[];
}

export interface RationaleResumeRequest {
  control: RationaleRequiredControl;
  response: RationaleResponse | null;
  rationaleStatus: "ready" | "failed";
}

export const RATIONALE_RESPONSE_SCHEMA: ToolSchema = {
  name: RATIONALE_RESPONSE_TOOL,
  description:
    "Return a user-facing explanation for the single sealed action. This tool cannot change the action or grant permission.",
  inputSchema: {
    type: "object",
    properties: {
      contractVersion: { type: "integer", const: RATIONALE_CONTROL_CONTRACT_VERSION },
      anchorId: { type: "string" },
      ticketId: { type: "string" },
      actionDigest: { type: "string" },
      round: { type: "integer", const: 1 },
      suggestion: { type: "string", maxLength: 500 },
      scopeAlignment: { type: "string", enum: ["aligned", "unclear", "outside"] },
      scopeReasons: {
        type: "array",
        maxItems: 8,
        items: { type: "string", maxLength: 160 },
      },
    },
    required: [
      "contractVersion",
      "anchorId",
      "ticketId",
      "actionDigest",
      "round",
      "suggestion",
      "scopeAlignment",
      "scopeReasons",
    ],
  },
};

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

function sanitizeDisplayText(value: string, maxLength: number): string {
  const normalized = value
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return maskSensitiveData(normalized).masked.slice(0, maxLength);
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value as DeepReadonly<T>;
}


const MAX_CANONICAL_DEPTH = 12;
const MAX_CANONICAL_NODES = 1_024;
const MAX_CANONICAL_BYTES = 64 * 1_024;

function assertCanonicalJson(value: unknown, label: string): void {
  const seen = new WeakSet<object>();
  let nodes = 0;

  const visit = (current: unknown, depth: number, path: string): void => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES) {
      throw new TypeError(label + " exceeds canonical JSON node limit");
    }
    if (depth > MAX_CANONICAL_DEPTH) {
      throw new TypeError(label + " exceeds canonical JSON depth limit");
    }
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        throw new TypeError(path + " must be a finite canonical JSON number");
      }
      return;
    }
    if (typeof current !== "object") {
      throw new TypeError(path + " is not canonical JSON");
    }
    if (seen.has(current)) {
      throw new TypeError(path + " contains a cycle or shared object reference");
    }
    seen.add(current);

    if (Array.isArray(current)) {
      const keys = Object.keys(current);
      if (
        keys.length !== current.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        throw new TypeError(path + " must be a dense JSON array without extra properties");
      }
      current.forEach((child, index) => visit(child, depth + 1, path + "[" + index + "]"));
      return;
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(path + " must use a plain object prototype");
    }
    if (Reflect.ownKeys(current).some((key) => typeof key === "symbol")) {
      throw new TypeError(path + " must not contain symbol keys");
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(path + "." + key + " must be an enumerable data property");
      }
      visit(descriptor.value, depth + 1, path + "." + key);
    }
  };

  visit(value, 0, label);
  if (Buffer.byteLength(canonicalStringify(value), "utf8") > MAX_CANONICAL_BYTES) {
    throw new TypeError(label + " exceeds canonical JSON byte limit");
  }
}

function cloneCanonicalJson<T>(value: T, label: string): DeepReadonly<T> {
  assertCanonicalJson(value, label);
  const cloned = structuredClone(value);
  assertCanonicalJson(cloned, label);
  return deepFreeze(cloned);
}

function cloneBoundedStringList(
  value: readonly string[],
  label: string,
  maxItems: number,
  maxLength: number,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    !value.every(
      (item) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        item.length <= maxLength,
    )
  ) {
    throw new TypeError(label + " exceeds its bounded string-list contract");
  }
  return cloneCanonicalJson(value, label) as readonly string[];
}

function assertBoundedText(value: string, label: string, maxLength: number): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(label + " exceeds its bounded text contract");
  }
}


const TOOL_TRUST_ORIGINS: readonly string[] = [
  "user-keyboard", "plugin-emitted", "app-emitted", "llm-tool-arg",
  "agent-message", "file-content", "queue-auto",
];
const RATIONALE_TAINTS: readonly string[] = [
  "none", "file-content", "app-emitted", "plugin-emitted",
  "agent-message", "queue-auto",
];

function assertExactOwnKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(label + " contains unexpected or missing fields");
  }
}

function assertRationaleProvenance(value: RationaleEligibilityProvenance): void {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.startedFromUserKeyboard !== "boolean" ||
    !RATIONALE_TAINTS.includes(value.taint)
  ) {
    throw new TypeError("invalid rationale provenance");
  }
  assertExactOwnKeys(value, ["startedFromUserKeyboard", "taint"], "rationaleProvenance");
}




function isValidRationaleProvenance(
  value: RationaleEligibilityProvenance,
): boolean {
  try {
    assertRationaleProvenance(value);
    return true;
  } catch {
    return false;
  }
}


function assertHostEligibilityContext(
  value: HostRationaleEligibilityContext,
): void {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.headless !== "boolean" ||
    typeof value.forceModal !== "boolean" ||
    !(
      value.approvalReasonPrefix === null ||
      (
        typeof value.approvalReasonPrefix === "string" &&
        value.approvalReasonPrefix.trim().length > 0 &&
        value.approvalReasonPrefix.length <= 160
      )
    )
  ) {
    throw new TypeError("invalid host rationale eligibility context");
  }
  assertExactOwnKeys(
    value,
    ["headless", "forceModal", "approvalReasonPrefix"],
    "HostRationaleEligibilityContext",
  );
}

export function isRationaleEligibilityContextCurrent(
  control: RationaleRequiredControl,
  current: HostRationaleEligibilityContext,
): boolean {
  try {
    assertHostEligibilityContext(control.eligibilityContext);
    assertHostEligibilityContext(current);
    const expectedInvocationDigest = digest({
      ticketId: control.ticketId,
      nonce: control.nonce,
      toolUseId: control.sealedAction.toolUseId,
      actionDigest: control.action.actionDigest,
      eligibilityContext: control.eligibilityContext,
    });
    return (
      expectedInvocationDigest === control.invocationDigest &&
      canonicalStringify(current) === canonicalStringify(control.eligibilityContext)
    );
  } catch {
    return false;
  }
}

function assertSourceIdentity(
  source: ToolSource,
  pluginId: string | undefined,
  mcpServerId: string | undefined,
  workerId: string | undefined,
): void {
  if (source === "builtin") {
    if (pluginId !== undefined || mcpServerId !== undefined || workerId !== undefined) {
      throw new TypeError("builtin action must not carry plugin/MCP worker identity");
    }
    return;
  }
  if (source === "plugin") {
    if (pluginId === undefined || mcpServerId !== undefined) {
      throw new TypeError("plugin action requires pluginId and forbids mcpServerId");
    }
    return;
  }
  if (source === "mcp") {
    if (mcpServerId === undefined || pluginId !== undefined || workerId !== undefined) {
      throw new TypeError("MCP action requires mcpServerId and forbids plugin worker identity");
    }
    return;
  }
  throw new TypeError("invalid action source");
}

export function createRequestAnchor(input: {
  sessionId: string;
  turnId: string;
  inputMessageId: string;
  inputOrigin: ChatInputOrigin;
  rawIntent: string;
  now?: number;
  ttlMs?: number;
}): RequestAnchor | null {
  if (input.inputOrigin !== "user-keyboard") return null;
  if (![input.sessionId, input.turnId, input.inputMessageId].every(
    (value) => value.trim().length > 0 && value.length <= 256,
  )) {
    return null;
  }
  const sanitizedIntent = sanitizeDisplayText(input.rawIntent, 500);
  if (!sanitizedIntent || sanitizedIntent.startsWith("/")) return null;
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? 10 * 60 * 1000;
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) return null;
  const normalizedIntent = input.rawIntent.normalize("NFC").replace(/\r\n?/g, "\n");
  return deepFreeze({
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    anchorId: randomUUID(),
    sessionId: input.sessionId,
    turnId: input.turnId,
    inputMessageId: input.inputMessageId,
    inputOrigin: "user-keyboard",
    sanitizedIntent,
    intentDigest: digest({ inputOrigin: input.inputOrigin, normalizedIntent }),
    createdAt: now,
    expiresAt: now + ttlMs,
  }) as RequestAnchor;
}


function isValidRequestAnchor(anchor: RequestAnchor, now: number): boolean {
  try {
    assertCanonicalJson(anchor, "RequestAnchor");
    assertExactOwnKeys(anchor, [
      "contractVersion", "anchorId", "sessionId", "turnId", "inputMessageId",
      "inputOrigin", "sanitizedIntent", "intentDigest", "createdAt", "expiresAt",
    ], "RequestAnchor");
    for (const [label, value, maxLength] of [
      ["anchorId", anchor.anchorId, 256], ["sessionId", anchor.sessionId, 256],
      ["turnId", anchor.turnId, 256], ["inputMessageId", anchor.inputMessageId, 256],
      ["sanitizedIntent", anchor.sanitizedIntent, 500],
    ] as const) {
      assertBoundedText(value, label, maxLength);
    }
    return (
      anchor.contractVersion === RATIONALE_CONTROL_CONTRACT_VERSION &&
      anchor.inputOrigin === "user-keyboard" &&
      !anchor.sanitizedIntent.startsWith("/") &&
      /^[0-9a-f-]{36}$/i.test(anchor.anchorId) &&
      /^[0-9a-f]{64}$/.test(anchor.intentDigest) &&
      Number.isFinite(now) && Number.isFinite(anchor.createdAt) &&
      Number.isFinite(anchor.expiresAt) && anchor.expiresAt > anchor.createdAt &&
      anchor.createdAt <= now && anchor.expiresAt > now
    );
  } catch {
    return false;
  }
}


function assertActionIdentitySemantics(action: ActionIdentity): void {
  if (action.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION) {
    throw new TypeError("invalid ActionIdentity contract version");
  }
  for (const [label, value, maxLength] of [
    ["anchorId", action.anchorId, 256],
    ["toolName", action.toolName, 256], ["toolVersion", action.toolVersion, 128],
    ["requiredAuthority", action.requiredAuthority, 160], ["policyEpoch", action.policyEpoch, 256],
    ["registryGeneration", action.registryGeneration, 256],
    ["sandboxGeneration", action.sandboxGeneration, 256],
  ] as const) {
    assertBoundedText(value, label, maxLength);
  }
  for (const [label, value] of [
    ["pluginId", action.pluginId], ["mcpServerId", action.mcpServerId],
    ["workerId", action.workerId], ["approvalCacheKey", action.approvalCacheKey],
  ] as const) {
    if (value !== undefined) assertBoundedText(value, label, 512);
  }
  if (
    !TOOL_TRUST_ORIGINS.includes(action.invocationTrustOrigin) ||
    !["read", "write", "shell", "network", "meta"].includes(action.category)
  ) {
    throw new TypeError("invalid action trust origin or category");
  }
  assertRationaleProvenance(action.rationaleProvenance);
  assertSourceIdentity(action.source, action.pluginId, action.mcpServerId, action.workerId);
  cloneBoundedStringList(action.canonicalTargets, "canonicalTargets", 32, 1_024);
  cloneBoundedStringList(action.requestedEffects, "requestedEffects", 8, 160);
  cloneBoundedStringList(action.affectedResources, "affectedResources", 8, 160);
  assertCanonicalJson(action.sandboxExecutionPlan, "sandboxExecutionPlan");
  if (
    !/^[0-9a-f]{64}$/.test(action.finalInputDigest) ||
    !/^[0-9a-f]{64}$/.test(action.actionDigest)
  ) {
    throw new TypeError("invalid ActionIdentity digest");
  }

  const expectedKeys = [
    "contractVersion", "anchorId", "actionDigest",
    "invocationTrustOrigin", "rationaleProvenance", "toolName", "toolVersion",
    "source", "category", "finalInputDigest", "canonicalTargets",
    "requestedEffects", "affectedResources", "requiredAuthority", "policyEpoch",
    "registryGeneration", "sandboxGeneration", "sandboxExecutionPlan",
  ];
  if (action.pluginId !== undefined) expectedKeys.push("pluginId");
  if (action.mcpServerId !== undefined) expectedKeys.push("mcpServerId");
  if (action.workerId !== undefined) expectedKeys.push("workerId");
  if (action.approvalCacheKey !== undefined) expectedKeys.push("approvalCacheKey");
  assertExactOwnKeys(action, expectedKeys, "ActionIdentity");
}

export function createActionIdentity(input: Omit<ActionIdentity, "contractVersion" | "actionDigest" | "finalInputDigest"> & {
  finalInput: Record<string, unknown>;
}): ActionIdentity {
  for (const [label, value, maxLength] of [
    ["anchorId", input.anchorId, 256],
    ["toolName", input.toolName, 256],
    ["toolVersion", input.toolVersion, 128],
    ["requiredAuthority", input.requiredAuthority, 160],
    ["policyEpoch", input.policyEpoch, 256],
    ["registryGeneration", input.registryGeneration, 256],
    ["sandboxGeneration", input.sandboxGeneration, 256],
  ] as const) {
    assertBoundedText(value, label, maxLength);
  }
  for (const [label, value] of [
    ["pluginId", input.pluginId],
    ["mcpServerId", input.mcpServerId],
    ["workerId", input.workerId],
    ["approvalCacheKey", input.approvalCacheKey],
  ] as const) {
    if (value !== undefined) assertBoundedText(value, label, 512);
  }
  assertRationaleProvenance(input.rationaleProvenance);
  if (
    !TOOL_TRUST_ORIGINS.includes(input.invocationTrustOrigin) ||
    !["read", "write", "shell", "network", "meta"].includes(input.category)
  ) {
    throw new TypeError("invalid action trust origin or category");
  }
  assertSourceIdentity(input.source, input.pluginId, input.mcpServerId, input.workerId);

  const sealedFinalInput = cloneCanonicalJson(input.finalInput, "finalInput");
  const finalInputDigest = digest(sealedFinalInput);
  const snapshot = {
    anchorId: input.anchorId,
    invocationTrustOrigin: input.invocationTrustOrigin,
    rationaleProvenance: cloneCanonicalJson(
      input.rationaleProvenance,
      "rationaleProvenance",
    ),
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    source: input.source,
    category: input.category,
    ...(input.pluginId === undefined ? {} : { pluginId: input.pluginId }),
    ...(input.mcpServerId === undefined ? {} : { mcpServerId: input.mcpServerId }),
    ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
    finalInputDigest,
    ...(input.approvalCacheKey === undefined
      ? {}
      : { approvalCacheKey: input.approvalCacheKey }),
    canonicalTargets: cloneBoundedStringList(
      input.canonicalTargets,
      "canonicalTargets",
      32,
      1_024,
    ),
    requestedEffects: cloneBoundedStringList(
      input.requestedEffects,
      "requestedEffects",
      8,
      160,
    ),
    affectedResources: cloneBoundedStringList(
      input.affectedResources,
      "affectedResources",
      8,
      160,
    ),
    requiredAuthority: input.requiredAuthority,
    policyEpoch: input.policyEpoch,
    registryGeneration: input.registryGeneration,
    sandboxGeneration: input.sandboxGeneration,
    sandboxExecutionPlan: cloneCanonicalJson(
      input.sandboxExecutionPlan,
      "sandboxExecutionPlan",
    ),
  };
  const action = deepFreeze({
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    ...snapshot,
    actionDigest: digest(snapshot),
  }) as ActionIdentity;
  assertActionIdentitySemantics(action);
  return action;
}

export function verifyActionIdentity(action: ActionIdentity): boolean {
  try {
    assertCanonicalJson(action, "ActionIdentity");
    assertActionIdentitySemantics(action);
    const { contractVersion, actionDigest, ...snapshot } = action;
    assertCanonicalJson(snapshot, "ActionIdentity");
    return (
      contractVersion === RATIONALE_CONTROL_CONTRACT_VERSION &&
      /^[0-9a-f]{64}$/.test(actionDigest) &&
      digest(snapshot) === actionDigest
    );
  } catch {
    return false;
  }
}

export function isRationaleEligible(input: {
  permission: PermissionCheckResult;
  anchor: RequestAnchor | null | undefined;
  invocationTrustOrigin: ToolTrustOrigin;
  rationaleProvenance: RationaleEligibilityProvenance;
  headless?: boolean;
  forceModal?: boolean;
  approvalReasonPrefix?: string;
  now?: number;
}): input is typeof input & {
  anchor: RequestAnchor;
  permission: PermissionCheckResult & {
    reviewer: {
      route: "foreground-auto";
      verdict: RiskVerdict;
      outcome: "fresh" | "cache";
    };
  };
} {
  const reviewer = input.permission.reviewer;
  const now = input.now ?? Date.now();
  return (
    input.permission.decision === "ask" &&
    input.permission.layer === 5 &&
    reviewer?.route === "foreground-auto" &&
    (reviewer.outcome === "fresh" || reviewer.outcome === "cache") &&
    reviewer.verdict !== undefined &&
    input.headless !== true &&
    input.forceModal !== true &&
    input.permission.forceModal !== true &&
    !input.approvalReasonPrefix &&
    input.anchor !== null &&
    input.anchor !== undefined &&
    isValidRequestAnchor(input.anchor, now) &&
    isValidRationaleProvenance(input.rationaleProvenance) &&
    input.rationaleProvenance.startedFromUserKeyboard === true &&
    input.rationaleProvenance.taint === "none" &&
    // Model-authored tool arguments are the first-round boundary used by the
    // current trust-origin SOT. file-content/app/plugin/agent provenance fails.
    input.invocationTrustOrigin === "llm-tool-arg"
  );
}

export function createRationaleRequiredControl(input: {
  anchor: RequestAnchor;
  action: ActionIdentity;
  sealedAction: SealedRationaleAction;
  eligibilityContext: HostRationaleEligibilityContext;
  permission: PermissionCheckResult & {
    reviewer: {
      route: "foreground-auto";
      verdict: RiskVerdict;
      outcome: "fresh" | "cache";
    };
  };
  now?: number;
}): RationaleRequiredControl {
  const now = input.now ?? Date.now();
  assertHostEligibilityContext(input.eligibilityContext);
  assertBoundedText(input.sealedAction.toolUseId, "sealedAction.toolUseId", 256);
  assertBoundedText(input.sealedAction.toolName, "sealedAction.toolName", 256);
  if (
    !isValidRequestAnchor(input.anchor, now) ||
    input.anchor.anchorId !== input.action.anchorId ||
    !verifyActionIdentity(input.action) ||
    input.sealedAction.toolName !== input.action.toolName ||
    !isRationaleEligible({
      permission: input.permission,
      anchor: input.anchor,
      invocationTrustOrigin: input.action.invocationTrustOrigin,
      rationaleProvenance: input.action.rationaleProvenance,
      headless: input.eligibilityContext.headless,
      forceModal: input.eligibilityContext.forceModal,
      approvalReasonPrefix: input.eligibilityContext.approvalReasonPrefix ?? undefined,
      now,
    })
  ) {
    throw new Error("rationale control does not match an eligible sealed action");
  }

  const anchor = cloneCanonicalJson(input.anchor, "RequestAnchor") as RequestAnchor;
  const action = cloneCanonicalJson(input.action, "ActionIdentity") as ActionIdentity;
  const sealedAction = deepFreeze({
    toolUseId: input.sealedAction.toolUseId,
    toolName: input.sealedAction.toolName,
    originalInput: cloneCanonicalJson(
      input.sealedAction.originalInput,
      "sealedAction.originalInput",
    ),
    finalInput: cloneCanonicalJson(
      input.sealedAction.finalInput,
      "sealedAction.finalInput",
    ),
  }) as SealedRationaleAction;
  const eligibilityContext = cloneCanonicalJson(
    input.eligibilityContext,
    "HostRationaleEligibilityContext",
  ) as HostRationaleEligibilityContext;
  assertHostEligibilityContext(eligibilityContext);
  if (
    !verifyActionIdentity(action) ||
    !isValidRequestAnchor(anchor, now) ||
    anchor.anchorId !== action.anchorId ||
    sealedAction.toolName !== action.toolName ||
    digest(sealedAction.finalInput) !== action.finalInputDigest
  ) {
    throw new Error("sealed rationale action does not match ActionIdentity");
  }

  const ticketId = randomUUID();
  const nonce = randomUUID();
  const invocationDigest = digest({
    ticketId,
    nonce,
    toolUseId: sealedAction.toolUseId,
    actionDigest: action.actionDigest,
    eligibilityContext,
  });
  return deepFreeze({
    kind: "rationale-required",
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    state: "rationale_requested",
    ticketId,
    nonce,
    invocationDigest,
    round: 1,
    anchor,
    action,
    sealedAction,
    eligibilityContext,
    reviewerOutcome: input.permission.reviewer.outcome,
    initialVerdict: cloneCanonicalJson(
      input.permission.reviewer.verdict,
      "initialVerdict",
    ),
    reasonCode: "foreground-reviewer-threshold",
  }) as RationaleRequiredControl;
}

export function toRationaleProviderEnvelope(
  control: RationaleRequiredControl,
): RationaleProviderEnvelope {
  const projectBounded = (values: readonly string[], label: string) => {
    if (values.length > 8) {
      throw new Error(label + " exceeds the provider contract");
    }
    const projected = values.map((value) => sanitizeDisplayText(value, 160));
    if (projected.some((value) => !value)) {
      throw new Error(label + " contains an empty provider projection");
    }
    return projected;
  };
  const reason =
    sanitizeDisplayText(control.initialVerdict.reason, 500) ||
    "Reviewer requested confirmation.";
  return deepFreeze({
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    anchorId: control.anchor.anchorId,
    ticketId: control.ticketId,
    actionDigest: control.action.actionDigest,
    round: 1,
    sanitizedIntent: control.anchor.sanitizedIntent,
    toolName: control.action.toolName,
    source: control.action.source,
    category: control.action.category,
    requestedEffects: projectBounded(
      control.action.requestedEffects,
      "requestedEffects",
    ),
    affectedResources: projectBounded(
      control.action.affectedResources,
      "affectedResources",
    ),
    requiredAuthority: sanitizeDisplayText(control.action.requiredAuthority, 160),
    reviewerOutcome: control.reviewerOutcome,
    initialVerdict: {
      level: control.initialVerdict.level,
      reason,
    },
  }) as RationaleProviderEnvelope;
}

export function transitionRationaleState(
  state: RationaleControlState,
  event: RationaleControlEvent,
): RationaleControlState {
  if (event === "expire" && !["allowed_once", "denied", "cancelled", "expired"].includes(state)) {
    return "expired";
  }
  const key = state + ":" + event;
  const transitions: Record<string, RationaleControlState> = {
    "review_required:request-rationale": "rationale_requested",
    "rationale_requested:rationale-ready": "rationale_ready",
    "rationale_requested:rationale-failed": "rationale_failed",
    "rationale_ready:prompt-user": "user_pending",
    "rationale_failed:prompt-user": "user_pending",
    "user_pending:allow-once": "allowed_once",
    "user_pending:deny": "denied",
    "user_pending:cancel": "cancelled",
  };
  const next = transitions[key];
  if (!next) throw new Error("invalid rationale state transition: " + key);
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseRationaleResponse(
  input: unknown,
  control: RationaleRequiredControl,
): RationaleResponse | null {
  if (!isRecord(input)) return null;
  if (
    input.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
    input.anchorId !== control.anchor.anchorId ||
    input.ticketId !== control.ticketId ||
    input.actionDigest !== control.action.actionDigest ||
    input.round !== 1 ||
    typeof input.suggestion !== "string" ||
    input.suggestion.length === 0 ||
    input.suggestion.length > 500 ||
    !["aligned", "unclear", "outside"].includes(String(input.scopeAlignment)) ||
    !Array.isArray(input.scopeReasons) ||
    input.scopeReasons.length > 8 ||
    !input.scopeReasons.every(
      (reason) =>
        typeof reason === "string" &&
        reason.length > 0 &&
        reason.length <= 160,
    )
  ) {
    return null;
  }
  const suggestion = sanitizeDisplayText(input.suggestion, 500);
  const scopeReasons = input.scopeReasons.map((reason) => sanitizeDisplayText(reason, 160));
  if (!suggestion || scopeReasons.some((reason) => !reason)) return null;

  return deepFreeze({
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    anchorId: control.anchor.anchorId,
    ticketId: control.ticketId,
    actionDigest: control.action.actionDigest,
    round: 1,
    suggestion,
    scopeAlignment: input.scopeAlignment as RationaleResponse["scopeAlignment"],
    scopeReasons,
  }) as RationaleResponse;
}
