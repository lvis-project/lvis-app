/**
 * Provider-strict lint for plugin tool `inputSchema`s.
 *
 * OpenAI / Azure Foundry validate the *whole* chat request and reject it with a
 * hard `400 invalid_function_parameters` if ANY one function schema is invalid —
 * so a single malformed third-party plugin tool schema takes down the entire
 * turn for every flow that loads it (#1182, meeting v0.5.21 incident: a property
 * declared `"type": ["string","array"]` without `items`).
 *
 * This is a pure structural lint — no plugin-specific knowledge, no plugin ids.
 * The registration path (`pluginToolsForRegistration`) runs it per tool and
 * drops any tool that violates it, so one bad schema is fail-closed for that
 * tool but fail-soft for the turn.
 *
 * Scope note: this is a cheap FAST-PATH for the one high-frequency offender, so
 * the common case never pays a failed provider round-trip. It is deliberately
 * NOT a complete mirror of every provider strict-mode rule — that would always
 * lag the provider. Completeness lives at runtime in `engine/llm/
 * rejected-tool-schema.ts` (provider-as-oracle): on an actual strict-mode 400
 * the offending tool is dropped and the turn retried, with the provider itself
 * as the source of truth. Grow THAT path's coverage, not this rule set.
 *
 * Rule set (start with the high-frequency offender; extend over time):
 *  - `array-missing-items`: any schema node whose `type` includes `"array"`
 *    (single or union) MUST declare `items`. OpenAI/Azure require it.
 */

export interface ToolSchemaViolation {
  /** JSON Pointer (RFC 6901) to the offending schema node. */
  pointer: string;
  /** Stable rule id, e.g. "array-missing-items". */
  rule: string;
  /** Human-readable explanation. */
  message: string;
}

function typeIncludesArray(type: unknown): boolean {
  if (type === "array") return true;
  if (Array.isArray(type)) return type.includes("array");
  return false;
}

/** Escape a property name for use in a JSON Pointer segment (RFC 6901). */
function escapePointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function walk(node: unknown, pointer: string, out: ToolSchemaViolation[]): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const schema = node as Record<string, unknown>;

  // Rule: array-missing-items. `pointer` is an RFC 6901 JSON Pointer — the empty
  // string is the document root (the message prints "(root)" for readability).
  if (typeIncludesArray(schema.type) && schema.items === undefined) {
    out.push({
      pointer,
      rule: "array-missing-items",
      message: `array schema at ${pointer || "(root)"} is missing "items" (OpenAI/Azure reject arrays without an items schema)`,
    });
  }

  // Recurse into the standard schema-bearing keywords.
  const props = schema.properties;
  if (props !== null && typeof props === "object" && !Array.isArray(props)) {
    for (const [key, child] of Object.entries(props as Record<string, unknown>)) {
      walk(child, `${pointer}/properties/${escapePointerSegment(key)}`, out);
    }
  }

  if (Array.isArray(schema.items)) {
    schema.items.forEach((child, i) => walk(child, `${pointer}/items/${i}`, out));
  } else if (schema.items !== undefined) {
    walk(schema.items, `${pointer}/items`, out);
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branch = schema[keyword];
    if (Array.isArray(branch)) {
      branch.forEach((child, i) => walk(child, `${pointer}/${keyword}/${i}`, out));
    }
  }

  const addl = schema.additionalProperties;
  if (addl !== null && typeof addl === "object" && !Array.isArray(addl)) {
    walk(addl, `${pointer}/additionalProperties`, out);
  }
}

/**
 * Lint a plugin tool `inputSchema` for LLM provider-strict-mode compliance.
 * Returns every violation found (empty array = clean). Pure; never throws.
 */
export function lintToolInputSchema(schema: unknown): ToolSchemaViolation[] {
  const violations: ToolSchemaViolation[] = [];
  walk(schema, "", violations);
  return violations;
}
