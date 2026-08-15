/**
 * Expand ECMA-262 character-class shorthands inside JSON-Schema `pattern`
 * strings into the explicit character classes they are defined as.
 *
 * WHY THIS EXISTS
 *
 * Self-hosted OpenAI-compatible backends (llama.cpp / llama-server, and the
 * xgrammar-backed vLLM and SGLang servers) do not send a JSON Schema to the
 * model — they COMPILE it into a grammar and constrain decoding with it. Their
 * schema→grammar converters understand explicit character classes (`[0-9]`) but
 * emit shorthand escapes (`\d`, `\w`, `\s`, and the negated forms) into the
 * grammar text verbatim, where the grammar parser then rejects them. The server
 * answers the whole request with
 *
 *     Failed to initialize samplers: failed to parse grammar
 *
 * so ONE tool carrying such a pattern takes down every turn that loads it.
 *
 * The expansion below is an identity on the regex language: each shorthand is
 * replaced by exactly the set ECMA-262 §22.2.1 defines it to be, including the
 * full Unicode whitespace set for `\s`. Nothing is narrowed, so this is
 * normalization rather than a provider workaround, and it is applied on the one
 * request-assembly chokepoint for every vendor instead of behind a vendor
 * branch that could drift from the vendors that actually need it.
 *
 * Schemas with no affected pattern are returned by REFERENCE, so a provider
 * whose tools never use a shorthand receives byte-identical payloads.
 */
import type { ToolSchema } from "./types.js";

/**
 * ECMA-262 `\s`: the union of WhiteSpace and LineTerminator. Written as class
 * BODY text (no brackets) so it can be spliced into either a standalone class
 * or an existing one.
 */
const WHITESPACE_CLASS_BODY =
  "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
const DIGIT_CLASS_BODY = "0-9";
const WORD_CLASS_BODY = "0-9A-Z_a-z";

/** Class body for each shorthand that denotes a POSITIVE set. */
const POSITIVE_SHORTHAND_BODIES: Readonly<Record<string, string>> = {
  d: DIGIT_CLASS_BODY,
  w: WORD_CLASS_BODY,
  s: WHITESPACE_CLASS_BODY,
};

/** Class body for the complement each NEGATED shorthand denotes. */
const NEGATED_SHORTHAND_BODIES: Readonly<Record<string, string>> = {
  D: DIGIT_CLASS_BODY,
  W: WORD_CLASS_BODY,
  S: WHITESPACE_CLASS_BODY,
};

/**
 * `pattern` with every `\d`/`\w`/`\s`/`\D`/`\W`/`\S` rewritten to the character
 * class it denotes, or the SAME string when it contains none.
 *
 * A negated shorthand INSIDE a character class (`[\D]`) is left alone: a
 * complement is not expressible as a member list of the class that contains it,
 * and rewriting it to the positive body would invert the match. That form is
 * vanishingly rare and losing it costs correctness, which this transform will
 * not trade for reach.
 */
export function expandRegexShorthandClasses(pattern: string): string {
  if (!pattern.includes("\\")) return pattern;

  let out = "";
  let changed = false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch !== "\\") {
      // A `]` only closes a class we are actually inside of.
      if (ch === "[" && !inClass) inClass = true;
      else if (ch === "]" && inClass) inClass = false;
      out += ch;
      continue;
    }
    const next = pattern[i + 1];
    if (next === undefined) {
      // Trailing lone backslash: not our business to repair.
      out += ch;
      continue;
    }
    const positive = POSITIVE_SHORTHAND_BODIES[next];
    if (positive !== undefined) {
      out += inClass ? positive : "[" + positive + "]";
      changed = true;
      i++;
      continue;
    }
    const negated = NEGATED_SHORTHAND_BODIES[next];
    if (negated !== undefined && !inClass) {
      out += "[^" + negated + "]";
      changed = true;
      i++;
      continue;
    }
    // Any other escape (`\.`, `\\`, `\[`, `\D` inside a class) passes through
    // WITH its escaped character, so that character is never re-read as a class
    // delimiter on the next iteration.
    out += ch + next;
    i++;
  }
  return changed ? out : pattern;
}

/**
 * `node` with every nested `pattern` expanded, or the SAME reference when no
 * pattern in the subtree changed. Reference equality is the signal callers use
 * to skip rebuilding an unaffected schema.
 */
function expandNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((entry) => {
      const mapped = expandNode(entry);
      if (mapped !== entry) changed = true;
      return mapped;
    });
    return changed ? next : node;
  }
  if (node === null || typeof node !== "object") return node;

  const record = node as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "pattern" && typeof value === "string") {
      const expanded = expandRegexShorthandClasses(value);
      if (expanded !== value) changed = true;
      next[key] = expanded;
      continue;
    }
    const mapped = expandNode(value);
    if (mapped !== value) changed = true;
    next[key] = mapped;
  }
  return changed ? next : node;
}

/**
 * `schemas` with grammar-hostile `pattern` shorthands expanded everywhere they
 * appear. Returns the SAME array reference when nothing needed rewriting.
 */
export function toGrammarSafeToolSchemas(
  schemas: ToolSchema[] | undefined,
): ToolSchema[] | undefined {
  if (!schemas || schemas.length === 0) return schemas;
  let changed = false;
  const next = schemas.map((schema) => {
    const inputSchema = expandNode(schema.inputSchema);
    if (inputSchema === schema.inputSchema) return schema;
    changed = true;
    return { ...schema, inputSchema: inputSchema as ToolSchema["inputSchema"] };
  });
  return changed ? next : schemas;
}
