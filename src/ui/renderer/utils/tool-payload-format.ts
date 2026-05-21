export function formatToolPayloadValue(value: unknown): string {
  if (typeof value === "string") return formatToolPayloadString(value);

  try {
    const formatted = JSON.stringify(expandJsonStrings(value), null, 2);
    if (typeof formatted === "string") return formatted;
  } catch {
    // Fall through to the raw string representation below.
  }

  return String(value);
}

export function formatToolPayloadString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;

  try {
    return JSON.stringify(expandJsonStrings(JSON.parse(trimmed)), null, 2);
  } catch {
    return value;
  }
}

function expandJsonStrings(value: unknown, depth = 0): unknown {
  if (depth > 4) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
    try {
      return expandJsonStrings(JSON.parse(trimmed), depth + 1);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandJsonStrings(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandJsonStrings(item, depth + 1)]),
    );
  }
  return value;
}
