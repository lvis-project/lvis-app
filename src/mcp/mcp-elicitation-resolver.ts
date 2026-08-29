/**
 * MRTR elicitation resolver (milestone `mrtr-input-loop`, the design's
 * "live-resolver step", mcp-alignment-design.md §5a/§8).
 *
 * `McpClient` runs the MRTR `input_required` loop but needs an injected
 * {@link McpInputRequestResolver} to actually gather each `inputRequest`. This is
 * the host's wiring for the ELICITATION case: an `elicitation/create` request
 * from an (untrusted) external MCP server is routed to the host
 * {@link ApprovalGate} as an `agent-action` consent ask, and the user's decision
 * is translated into an MCP `ElicitResult { action, content? }` placed verbatim
 * under `inputResponses[id]` on the retry.
 *
 * Scope (No-Fallback): ELICITATION only.
 *  - `sampling/createMessage` and `roots/list` are DEPRECATED upstream (§8
 *    SEP-2577) and the host does not implement them → a thrown typed error, never
 *    a fabricated response.
 *  - URL-mode elicitation is consent-only. Form-mode elicitation forwards
 *    `requestedSchema` to the renderer approval UI and returns the captured
 *    one-shot `content` with the accept decision.
 *
 * Trust: the request payload comes from an untrusted external server, so the
 * approval is raised with `trustOrigin: "plugin-emitted"` (never reaches the
 * user-keyboard slash dispatcher) and `source: "mcp"` so the audit/UI shows which
 * server is eliciting (the resolver is bound per-server via the factory).
 */
import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalRequestInput,
} from "../permissions/approval-gate.js";
import type { McpInputRequestResolver } from "./mcp-client.js";
import {
  parseElicitationSchema,
  type ElicitationSchemaField,
  type ParsedElicitationSchema,
} from "../shared/mcp-elicitation-schema.js";
import { isRecord } from "../shared/is-record.js";

/** MCP `ElicitResult` (§8). Returned verbatim into `inputResponses[id]`. */
export interface ElicitResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

const ELICITATION_METHOD = "elicitation/create";

/** The single approval-gate method this resolver depends on (keeps it test-seam-able). */
export interface ElicitationApprovalGate {
  requestAndWait(req: ApprovalRequestInput): Promise<ApprovalDecision>;
}

function isElicitation(request: Record<string, unknown>): boolean {
  if (request.method === ELICITATION_METHOD) return true;
  // Tolerate a method-less Elicit shape (mode + message) for forward-compat.
  return (
    request.method === undefined &&
    typeof request.message === "string" &&
    (request.mode === "form" || request.mode === "url" || request.requestedSchema !== undefined)
  );
}

function hasOwnRecordKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidFieldValue(value: unknown, field: ElicitationSchemaField): boolean {
  if (field.enumValues) {
    return field.enumValues.some((candidate) => Object.is(candidate, value));
  }
  if (field.kind === "string") return typeof value === "string";
  if (field.kind === "boolean") return typeof value === "boolean";
  if (field.kind === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function validateElicitationContent(
  schema: ParsedElicitationSchema,
  content: Record<string, unknown>,
): boolean {
  const declaredNames = new Set(schema.fields.map((field) => field.name));
  for (const name of Object.keys(content)) {
    if (!declaredNames.has(name)) return false;
  }
  for (const field of schema.fields) {
    if (!hasOwnRecordKey(content, field.name)) {
      if (field.required) return false;
      continue;
    }
    if (!isValidFieldValue(content[field.name], field)) return false;
  }
  return true;
}

function shouldValidateFormContent(request: Record<string, unknown>): boolean {
  return request.mode === "form" || (request.mode !== "url" && request.requestedSchema !== undefined);
}

/**
 * Build a factory that yields a per-server {@link McpInputRequestResolver}. Bind
 * the serverId per client so the approval surface attributes the elicitation to
 * the correct MCP server.
 */
export function createElicitationResolverFactory(deps: {
  approvalGate: ElicitationApprovalGate;
}): (serverId: string) => McpInputRequestResolver {
  return (serverId: string): McpInputRequestResolver => {
    return async (id: string, request: Record<string, unknown>): Promise<ElicitResult> => {
      if (!isElicitation(request)) {
        const method = typeof request.method === "string" ? request.method : "(unknown)";
        throw new Error(
          `[mcp-elicitation] server '${serverId}' inputRequest '${id}' uses '${method}' — only ` +
            `'elicitation/create' is supported (sampling/roots are deprecated upstream, SEP-2577); ` +
            `not fabricating a response (No-Fallback).`,
        );
      }

      const message =
        typeof request.message === "string" ? request.message : "An MCP server requests your input.";
      const isUrl = request.mode === "url";
      const args = isUrl
        ? { message, url: request.url, elicitationId: request.elicitationId }
        : { message, requestedSchema: request.requestedSchema };

      const decision = await deps.approvalGate.requestAndWait({
        id: randomUUID(),
        category: "agent-action",
        kind: "agent-action",
        allowedChoices: ["allow-once", "deny-once"],
        durableApprovalRecordAllowed: false,
        toolName: `mcp:${serverId}:elicitation`,
        toolCategory: "meta",
        args,
        reason: message,
        source: "mcp",
        createdAt: Date.now(),
        trustOrigin: "plugin-emitted",
        isReadOnly: false,
        mode: "default",
      });

      if (decision.choice !== "allow-once") return { action: "decline" };

      if (shouldValidateFormContent(request)) {
        const schema = parseElicitationSchema(request.requestedSchema);
        if (!schema || !isRecord(decision.elicitationContent)) return { action: "decline" };
        if (!validateElicitationContent(schema, decision.elicitationContent)) {
          return { action: "decline" };
        }
        return { action: "accept", content: decision.elicitationContent };
      }

      return { action: "accept", content: {} };
    };
  };
}
