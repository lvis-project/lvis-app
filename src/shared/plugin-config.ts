export type PluginConfigPrimitive = string | number | boolean | null;
export type PluginConfigValue =
  | PluginConfigPrimitive
  | PluginConfigValue[]
  | { [key: string]: PluginConfigValue };

export type PluginConfigRecord = { [key: string]: PluginConfigValue };

export const PLUGIN_CONFIG_RESERVED_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const PLUGIN_CONFIG_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function sanitizePluginConfigPluginId(pluginId: string): string {
  if (typeof pluginId !== "string") {
    throw new Error("Plugin ID must be a string.");
  }
  const normalized = pluginId.trim();
  if (!normalized) {
    throw new Error("Plugin ID is required.");
  }
  if (normalized === "*" || PLUGIN_CONFIG_RESERVED_KEYS.has(normalized)) {
    throw new Error(`Plugin ID "${normalized}" is reserved.`);
  }
  if (!PLUGIN_CONFIG_ID_RE.test(normalized)) {
    throw new Error(`Plugin ID "${normalized}" has an invalid format.`);
  }
  return normalized;
}

export function sanitizePluginConfigKey(key: string, path = "config"): string {
  if (typeof key !== "string") {
    throw new Error(`${path} key must be a string.`);
  }
  const normalized = key.trim();
  if (!normalized) {
    throw new Error(`${path} key cannot be empty.`);
  }
  if (PLUGIN_CONFIG_RESERVED_KEYS.has(normalized)) {
    throw new Error(`${path}.${normalized} is reserved.`);
  }
  return normalized;
}

export function sanitizePluginConfig(config: unknown, path = "config"): PluginConfigRecord {
  if (!isPlainObject(config)) {
    throw new Error("Plugin config payload must be a plain object.");
  }
  return sanitizePluginConfigObject(config, path);
}

function sanitizePluginConfigObject(
  input: Record<string, unknown>,
  path: string,
): PluginConfigRecord {
  const out: PluginConfigRecord = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = sanitizePluginConfigKey(rawKey, path);
    out[key] = sanitizePluginConfigValue(rawValue, `${path}.${key}`);
  }
  return out;
}

function sanitizePluginConfigValue(value: unknown, path: string): PluginConfigValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must be a finite number.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      sanitizePluginConfigValue(item, `${path}[${index}]`));
  }
  if (isPlainObject(value)) {
    return sanitizePluginConfigObject(value, path);
  }
  throw new Error(
    `${path} must be a JSON-compatible primitive, array, or plain object.`,
  );
}
