import { parseStrictJson, type StrictJsonLimits } from "../shared/strict-json.js";

export type A2AStrictJsonLimits = StrictJsonLimits;

/** A bounded JSON parser that rejects duplicate and prototype-sensitive keys. */
export function parseA2AStrictJson(bytes: Uint8Array, limits: A2AStrictJsonLimits): unknown {
  try {
    return parseStrictJson(bytes, limits);
  } catch (error) {
    if (error instanceof Error && error.message === "strict-json-size-invalid") {
      throw new Error("a2a-json-size-invalid");
    }
    throw new Error("a2a-json-rejected");
  }
}
