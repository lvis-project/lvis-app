/**
 * §9.2 Track B — VSCode-style declarative plugin config schema utilities.
 *
 * Two responsibilities:
 *  1. Compile a `manifest.configSchema` fragment into an AJV validator that
 *     accepts the merged plugin config (defaults + saved overrides + secret
 *     placeholders) for runtime / IPC validation.
 *  2. Identify which schema entries are `format: "secret"` so the renderer
 *     and plugin-config IPC bridge can route them through the encrypted
 *     keychain (`hostApi.setSecret`) instead of cleartext `pluginConfigs`.
 *
 * The schema dialect is JSON Schema draft-07 (matches the existing
 * `toolSchemas` pipeline at architecture.md:2060). The only LVIS-specific
 * extension is the `format: "secret"` UI hint, which AJV accepts as a
 * non-validating string format.
 */

import * as AjvModule from "ajv";
import * as AddFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import type { PluginConfigSchema, PluginConfigSchemaProperty } from "./types.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("plugin-config-schema");

interface AjvCtor {
  new (opts?: unknown): {
    compile: (schema: unknown) => ValidateFunction;
    addFormat: (name: string, def: unknown) => void;
  };
}

/**
 * Resolve the AJV constructor across CJS/ESM interop. AJV ships its
 * concrete class as either `module.default` (ESM) or `module.exports`
 * (CJS); the same dance is already used by `runtime.ts` for manifest
 * validation.
 */
function resolveAjv(): AjvCtor {
  const mod = AjvModule as unknown as { default?: unknown };
  return (mod.default ?? AjvModule) as AjvCtor;
}

function resolveAddFormats(): (a: unknown) => void {
  const mod = AddFormatsModule as unknown as { default?: unknown };
  return (mod.default ?? AddFormatsModule) as (a: unknown) => void;
}

/** Storage key for a plugin-config secret in `lvis-secrets.json`. */
export function pluginSecretKey(pluginId: string, key: string): string {
  return `plugin.${pluginId}.${key}`;
}

/** True when the schema entry should be routed through the encrypted keychain. */
export function isSecretProperty(prop: PluginConfigSchemaProperty | undefined): boolean {
  return Boolean(prop && prop.type === "string" && prop.format === "secret");
}

/**
 * Return the set of keys whose schema entry has `format: "secret"`. These
 * keys MUST be stripped from cleartext `pluginConfigs` and persisted via
 * the host's `setSecret` API instead.
 */
export function listSecretKeys(schema: PluginConfigSchema | undefined): Set<string> {
  const out = new Set<string>();
  if (!schema?.properties) return out;
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (isSecretProperty(prop)) out.add(key);
  }
  return out;
}

/**
 * Compile the `manifest.configSchema` fragment into an AJV validator that
 * accepts the merged config object. Returns `null` (and logs) when AJV
 * compilation fails — callers fall back to the existing
 * `sanitizePluginConfig` path so a bad schema can never wedge boot.
 */
export function compileConfigSchemaValidator(
  schema: PluginConfigSchema,
): ValidateFunction | null {
  try {
    const AjvCtor = resolveAjv();
    const ajv = new AjvCtor({
      strict: false,
      allErrors: true,
      useDefaults: false,
      coerceTypes: false,
    });
    resolveAddFormats()(ajv);
    // `format: "secret"` is an LVIS UI/storage hint, not a validating format.
    // Register it as a no-op so AJV strict-formats does not reject it.
    try {
      ajv.addFormat("secret", { type: "string", validate: () => true });
    } catch {
      // addFormat is idempotent only across separate ajv instances; ignore on re-register.
    }
    const wrapper = {
      type: "object",
      properties: schema.properties,
      required: Array.isArray(schema.required) ? schema.required : undefined,
      additionalProperties: true,
    } as const;
    return ajv.compile(wrapper);
  } catch (err) {
    // eslint-disable-next-line no-console
    log.warn(
      "AJV compile failed — falling back to permissive sanitizer: %s",
      (err as Error).message,
    );
    return null;
  }
}

/**
 * Apply schema-declared `default` values onto a saved config record. Saved
 * values always win over defaults (so user overrides survive). Returns a
 * shallow-copied object — callers should not assume reference identity.
 */
export function applyConfigDefaults(
  schema: PluginConfigSchema | undefined,
  saved: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema?.properties) return { ...saved };
  const out: Record<string, unknown> = { ...saved };
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (out[key] === undefined && prop.default !== undefined) {
      out[key] = prop.default;
    }
  }
  return out;
}

/**
 * Strip `format: "secret"` entries from a config object. Used by the IPC
 * `set` handler so a renderer that mistakenly POSTs a secret in cleartext
 * cannot end up writing it to `lvis-settings.json`. The renderer should
 * call `hostApi.setSecret` directly — the strip is a defence-in-depth
 * net, not the primary path.
 */
export function stripSecretFields(
  schema: PluginConfigSchema | undefined,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema?.properties) return config;
  const secretKeys = listSecretKeys(schema);
  if (secretKeys.size === 0) return config;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (!secretKeys.has(k)) out[k] = v;
  }
  return out;
}
