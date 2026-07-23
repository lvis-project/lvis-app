import { createHash } from "node:crypto";
import { canonicalStringify } from "../shared/canonical-json.js";
import type { ToolCategory } from "./types.js";
import type {
  GovernedRiskFloor,
  PluginToolOperationPolicy,
} from "../plugins/types.js";

export type {
  GovernedRiskFloor,
  PluginToolOperationPolicy,
} from "../plugins/types.js";

type PluginToolOperationRule = PluginToolOperationPolicy["operations"][string];

export interface ResolvedPluginOperation {
  operation: string;
  rule: PluginToolOperationRule;
  intentHash: string;
}

export interface PluginOperationInvocationContext {
  ownerVersion: string;
  generationId: string;
  /** Host-owned receipt scope. App calls use the renderer session; other calls use the executor session. */
  appSessionId: string;
  accountHash: string;
  /** True only for UI/MCP-App writes that must consume an opaque one-shot grant. */
  appGrantRequired: boolean;
  grantToken?: string;
}

class PluginOperationPolicyError extends Error {
  constructor(message: string) {
    super(`[plugin-operation-policy] ${message}`);
    this.name = "PluginOperationPolicyError";
  }
}

function assertJsonClean(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PluginOperationPolicyError("input contains a non-finite number");
    return;
  }
  if (typeof value !== "object") {
    throw new PluginOperationPolicyError(`input contains non-JSON value '${typeof value}'`);
  }
  if (seen.has(value)) throw new PluginOperationPolicyError("input contains a cycle");
  if (Array.isArray(value)) {
    seen.add(value);
    for (const item of value) assertJsonClean(item, seen);
    seen.delete(value);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new PluginOperationPolicyError("input must contain only plain JSON objects");
  }
  seen.add(value);
  for (const entry of Object.values(value as Record<string, unknown>)) assertJsonClean(entry, seen);
  seen.delete(value);
}

export function pluginOperationIntentHash(input: Record<string, unknown>): string {
  assertJsonClean(input);
  return createHash("sha256")
    .update("plugin-operation-intent/v1\0")
    .update(canonicalStringify(input))
    .digest("hex");
}

export function resolvePluginOperation(
  policy: PluginToolOperationPolicy,
  input: Record<string, unknown>,
  origin: "model" | "ui" | "mcp-app" | "plugin",
): ResolvedPluginOperation {
  if (policy.discriminant !== "operation") {
    throw new PluginOperationPolicyError("unsupported discriminant");
  }
  if (!Object.prototype.hasOwnProperty.call(input, "operation") || typeof input.operation !== "string") {
    throw new PluginOperationPolicyError("top-level string 'operation' is required");
  }
  const operation = input.operation;
  const rule = policy.operations[operation];
  if (!rule) throw new PluginOperationPolicyError(`unknown operation '${operation}'`);
  if ((origin === "ui" || origin === "mcp-app") && rule.appVisible !== true) {
    throw new PluginOperationPolicyError(`operation '${operation}' is not app-visible`);
  }
  return { operation, rule, intentHash: pluginOperationIntentHash(input) };
}

const RISK_WEIGHT: Record<GovernedRiskFloor, number> = {
  read: 0.1,
  write: 0.6,
  network: 0.7,
  shell: 0.9,
};

export function maxOperationRisk(
  ...categories: Array<ToolCategory | GovernedRiskFloor>
): ToolCategory {
  let winner: GovernedRiskFloor = "read";
  for (const category of categories) {
    if (category === "meta") throw new PluginOperationPolicyError("meta risk is not valid for governed operations");
    if (RISK_WEIGHT[category] > RISK_WEIGHT[winner]) winner = category;
  }
  return winner;
}
