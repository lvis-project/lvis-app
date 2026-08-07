/**
 * Single authority for which MCP `elicitation/create` `requestedSchema` shapes
 * the host supports.
 *
 * Two consumers used to answer that question independently:
 *  - the renderer approval dialog, which decides whether to render a form at all
 *    (and disables approval when it cannot), and
 *  - the main-process elicitation resolver, which re-validates the captured
 *    content before returning `{ action: "accept", content }` to the server.
 *
 * A producer/validator pair that each re-derive "is this schema supported?" can
 * drift silently: both sides keep passing their own unit tests while the
 * end-to-end request becomes undecidable. So support is decided here once, and
 * both sides consume the same parsed result. The renderer layers display-only
 * concerns (labels) on top; it must never re-decide support.
 */

/** Field types the host can render and validate. */
export type ElicitationFieldKind = "string" | "number" | "integer" | "boolean";

/** JSON scalars admissible as `enum` members. */
export type ElicitationEnumValue = string | number | boolean | null;

export type ElicitationSchemaField = {
  name: string;
  /** Declared `type`; defaults to `"string"` for enum-only fields. */
  kind: ElicitationFieldKind;
  required: boolean;
  /** Present only when the property declared a non-empty `enum`. */
  enumValues?: readonly ElicitationEnumValue[];
  /** Display-only passthroughs, trimmed; absent when blank or non-string. */
  title?: string;
  description?: string;
  /** Raw `default`, unvalidated — consumers decide whether it is usable. */
  defaultValue?: unknown;
};

export type ParsedElicitationSchema = {
  fields: readonly ElicitationSchemaField[];
};

const MAX_ELICITATION_FIELDS = 12;

const ELICITATION_FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isElicitationEnumValue(value: unknown): value is ElicitationEnumValue {
  if (value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" || typeof value === "boolean";
}

function parseEnumValues(value: unknown): readonly ElicitationEnumValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return undefined;
  if (!value.every(isElicitationEnumValue)) return undefined;
  return value;
}

function supportedKind(value: unknown): ElicitationFieldKind | undefined {
  if (value === "string" || value === "number" || value === "integer" || value === "boolean") {
    return value;
  }
  return undefined;
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse a server-supplied `requestedSchema`. Returns `undefined` when the schema
 * is not supported — the whole schema, never a partial field list, because a
 * partial form would silently drop data the server asked for.
 *
 * Note that an `enum` member is admissible whenever it is a JSON scalar. Empty
 * strings are ordinary members; rendering them is the renderer's problem, not a
 * reason to reject the request the user is being asked to answer.
 */
export function parseElicitationSchema(rawSchema: unknown): ParsedElicitationSchema | undefined {
  if (!isRecord(rawSchema) || rawSchema.type !== "object" || !isRecord(rawSchema.properties)) {
    return undefined;
  }

  const entries = Object.entries(rawSchema.properties);
  if (entries.length > MAX_ELICITATION_FIELDS) return undefined;

  let requiredNames: Set<string>;
  if (rawSchema.required === undefined) {
    requiredNames = new Set();
  } else if (
    Array.isArray(rawSchema.required) &&
    rawSchema.required.every((name) => typeof name === "string")
  ) {
    requiredNames = new Set<string>(rawSchema.required);
  } else {
    return undefined;
  }

  const fields: ElicitationSchemaField[] = [];
  for (const [name, rawProperty] of entries) {
    if (!ELICITATION_FIELD_NAME_RE.test(name) || !isRecord(rawProperty)) return undefined;

    const enumValues = rawProperty.enum === undefined ? undefined : parseEnumValues(rawProperty.enum);
    if (rawProperty.enum !== undefined && enumValues === undefined) return undefined;

    const declaredKind = supportedKind(rawProperty.type);
    if (rawProperty.type !== undefined && declaredKind === undefined) return undefined;

    const kind = declaredKind ?? (enumValues ? "string" : undefined);
    if (kind === undefined) return undefined;

    const title = trimmedString(rawProperty.title);
    const description = trimmedString(rawProperty.description);

    fields.push({
      name,
      kind,
      required: requiredNames.has(name),
      ...(enumValues ? { enumValues } : {}),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(rawProperty.default !== undefined ? { defaultValue: rawProperty.default } : {}),
    });
  }

  const declaredNames = new Set(fields.map((field) => field.name));
  for (const requiredName of requiredNames) {
    if (!declaredNames.has(requiredName)) return undefined;
  }

  return { fields };
}
