const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export interface A2AStrictJsonLimits {
  maxBytes: number;
  maxDepth?: number;
  maxNodes?: number;
  maxObjectMembers?: number;
  maxArrayItems?: number;
}

/** A bounded JSON parser that rejects duplicate and prototype-sensitive keys. */
export function parseA2AStrictJson(bytes: Uint8Array, limits: A2AStrictJsonLimits): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxBytes) throw new Error("a2a-json-size-invalid");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const maxDepth = limits.maxDepth ?? 32;
  const maxNodes = limits.maxNodes ?? 4_096;
  const maxMembers = limits.maxObjectMembers ?? 256;
  const maxItems = limits.maxArrayItems ?? 1_024;
  let index = 0;
  let nodes = 0;

  const fail = (): never => { throw new Error("a2a-json-rejected"); };
  const whitespace = (): void => {
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      index += 1;
    }
  };
  const node = (): void => { nodes += 1; if (nodes > maxNodes) fail(); };

  const string = (): string => {
    if (text[index] !== '"') fail();
    const start = index++;
    let escaped = false;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (!escaped && code === 0x22) {
        index += 1;
        try { return JSON.parse(text.slice(start, index)) as string; } catch { return fail(); }
      }
      if (!escaped && code < 0x20) fail();
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
      index += 1;
    }
    return fail();
  };

  const value = (depth: number): unknown => {
    if (depth > maxDepth) fail();
    whitespace();
    node();
    const character = text[index];
    if (character === '"') return string();
    if (character === "{") {
      index += 1;
      whitespace();
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      let count = 0;
      if (text[index] === "}") { index += 1; return result; }
      while (true) {
        whitespace();
        const key = string();
        if (DANGEROUS_KEYS.has(key) || keys.has(key)) fail();
        keys.add(key);
        count += 1;
        if (count > maxMembers) fail();
        whitespace();
        if (text[index++] !== ":") fail();
        result[key] = value(depth + 1);
        whitespace();
        const delimiter = text[index++];
        if (delimiter === "}") return result;
        if (delimiter !== ",") fail();
      }
    }
    if (character === "[") {
      index += 1;
      whitespace();
      const result: unknown[] = [];
      if (text[index] === "]") { index += 1; return result; }
      while (true) {
        if (result.length >= maxItems) fail();
        result.push(value(depth + 1));
        whitespace();
        const delimiter = text[index++];
        if (delimiter === "]") return result;
        if (delimiter !== ",") fail();
      }
    }
    for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(literal, index)) { index += literal.length; return parsed; }
    }
    const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) return fail();
    index += match[0].length;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) fail();
    return parsed;
  };

  const parsed = value(0);
  whitespace();
  if (index !== text.length) fail();
  return parsed;
}
