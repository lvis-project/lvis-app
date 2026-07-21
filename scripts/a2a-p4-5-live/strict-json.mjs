import { readFileSync } from "node:fs";

const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxDepth: 32,
  maxNodes: 100_000,
  maxMembers: 10_000,
});

export function parseStrictJson(text, label = "JSON", limits = {}) {
  if (typeof text !== "string") throw new TypeError(`${label}: expected UTF-8 text`);
  const effective = { ...DEFAULT_LIMITS, ...limits };
  if (Buffer.byteLength(text, "utf8") > effective.maxBytes) {
    throw new Error(`${label}: exceeds ${effective.maxBytes} byte limit`);
  }

  let index = 0;
  let nodes = 0;

  const fail = (message) => {
    throw new Error(`${label}: ${message} at byte ${Buffer.byteLength(text.slice(0, index), "utf8")}`);
  };
  const skipWhitespace = () => {
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[index])) index += 1;
  };
  const countNode = () => {
    nodes += 1;
    if (nodes > effective.maxNodes) fail(`exceeds ${effective.maxNodes} node limit`);
  };

  function parseString() {
    if (text[index] !== '"') fail("expected string");
    const start = index;
    index += 1;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          fail("invalid string escape");
        }
      }
      if (char === "\\") {
        index += 1;
        const escaped = text[index];
        if (escaped === "u") {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail("invalid unicode escape");
          index += 5;
          continue;
        }
        if (!/["\\/bfnrt]/u.test(escaped ?? "")) fail("invalid string escape");
        index += 1;
        continue;
      }
      if (char.charCodeAt(0) <= 0x1f) fail("unescaped control character");
      index += 1;
    }
    fail("unterminated string");
  }

  function parseNumber() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(index));
    if (!match) fail("invalid number");
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail("non-finite number");
    return value;
  }

  function parseArray(depth) {
    if (depth > effective.maxDepth) fail(`exceeds ${effective.maxDepth} level depth limit`);
    index += 1;
    skipWhitespace();
    const values = [];
    if (text[index] === "]") {
      index += 1;
      return values;
    }
    while (index < text.length) {
      if (values.length >= effective.maxMembers) fail(`array exceeds ${effective.maxMembers} members`);
      values.push(parseValue(depth + 1));
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return values;
      }
      if (text[index] !== ",") fail("expected ',' or ']'");
      index += 1;
      skipWhitespace();
    }
    fail("unterminated array");
  }

  function parseObject(depth) {
    if (depth > effective.maxDepth) fail(`exceeds ${effective.maxDepth} level depth limit`);
    index += 1;
    skipWhitespace();
    const value = Object.create(null);
    const keys = new Set();
    if (text[index] === "}") {
      index += 1;
      return value;
    }
    while (index < text.length) {
      if (keys.size >= effective.maxMembers) fail(`object exceeds ${effective.maxMembers} members`);
      const key = parseString();
      if (keys.has(key)) fail(`duplicate object member ${JSON.stringify(key)}`);
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") fail("expected ':'");
      index += 1;
      skipWhitespace();
      value[key] = parseValue(depth + 1);
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return value;
      }
      if (text[index] !== ",") fail("expected ',' or '}'");
      index += 1;
      skipWhitespace();
    }
    fail("unterminated object");
  }

  function parseValue(depth) {
    countNode();
    const char = text[index];
    if (char === '"') return parseString();
    if (char === "{") return parseObject(depth);
    if (char === "[") return parseArray(depth);
    if (char === "-" || /\d/u.test(char ?? "")) return parseNumber();
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return value;
      }
    }
    fail("unexpected token");
  }

  skipWhitespace();
  if (index === text.length) fail("empty document");
  const value = parseValue(0);
  skipWhitespace();
  if (index !== text.length) fail("trailing data");
  return value;
}

export function readStrictJsonFile(path, label, limits) {
  return parseStrictJson(readFileSync(path, "utf8"), label ?? path, limits);
}
