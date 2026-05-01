/**
 * Manifest validation — AJV schema validation + hand-rolled MUST/SHOULD checks.
 *
 * Exported for unit testing and reuse by the PluginRuntime class.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// ajv + ajv-formats ship a CJS default export; ESM interop requires the
// `.default ?? module` dance below.
import * as AjvModule from "ajv";
import * as AddFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import type { PluginManifest, InstallPolicy } from "../types.js";

export function normalizeInstallPolicy(
  source: Partial<Pick<PluginManifest, "installPolicy">> | undefined,
): InstallPolicy {
  if (source?.installPolicy === "admin") {
    return "admin";
  }
  return "user";
}

export function getDeclaredEmittedEvents(manifest: PluginManifest): string[] {
  if (!Array.isArray(manifest.emittedEvents)) return [];
  return [...new Set(
    manifest.emittedEvents.filter((e): e is string => typeof e === "string" && e.length > 0),
  )];
}

/**
 * Sprint 4-B §B-1 — lazy-load + compile plugin.schema.json into an AJV
 * validator. AJV is configured with `strict: true` + `allErrors: true` so
 * every violation surfaces in one pass. Compilation failure is logged and
 * returns `null`; readManifest falls back to hand-rolled checks to stay
 * operational.
 */
export async function buildManifestValidator(
  hereFileUrl: string,
): Promise<ValidateFunction | null> {
  try {
    const hereDir = dirname(fileURLToPath(hereFileUrl));
    // dist/src/plugins/runtime -> ../../../../schemas, src/plugins/runtime -> ../../../schemas
    const candidates = [
      resolve(hereDir, "../../../../schemas/plugin.schema.json"),
      resolve(hereDir, "../../../schemas/plugin.schema.json"),
    ];
    let schemaBytes: string | null = null;
    for (const candidate of candidates) {
      try {
        schemaBytes = await readFile(candidate, "utf-8");
        break;
      } catch {
        // try next
      }
    }
    if (!schemaBytes) {
      console.warn("[plugin-runtime] plugin.schema.json not found — AJV validation disabled");
      return null;
    }
    const schema = JSON.parse(schemaBytes);
    // Ajv default export compat for ESM/CJS interop.
    const AjvAny = AjvModule as unknown as { default?: unknown };
    const AjvCtor = (AjvAny.default ?? AjvModule) as new (opts?: unknown) => {
      compile: (schema: unknown) => ValidateFunction;
    };
    // strictRequired=false — if/then branches reference properties declared
    // on the outer `properties` block; AJV's strict mode otherwise flags
    // these as "property not defined inside the same schema object".
    const ajv = new AjvCtor({
      strict: true,
      strictRequired: false,
      allErrors: true,
      allowUnionTypes: true,
    });
    const AddAny = AddFormatsModule as unknown as { default?: unknown };
    const addFormatsFn = (AddAny.default ?? AddFormatsModule) as (a: unknown) => void;
    addFormatsFn(ajv);
    return ajv.compile(schema);
  } catch (err) {
    console.warn(
      "[plugin-runtime] AJV compile failed — falling back to hand-rolled checks:",
      (err as Error).message,
    );
    return null;
  }
}

/**
 * Parse and fully validate a plugin.json manifest file.
 *
 * Runs AJV schema validation (when available) followed by hand-rolled
 * cross-field MUST checks. Throws with a descriptive message on any failure.
 */
export async function parsePluginJson(
  path: string,
  validator: ValidateFunction | null,
): Promise<PluginManifest> {
  // Sprint 1-A A4 — detailed, per-field error messages shaped as
  //   "Invalid plugin manifest '<pluginId>' at '<fieldPath>': <reason>. Example: <correction>"
  const raw = await readFile(path, "utf-8");
  let parsed: PluginManifest;
  try {
    parsed = JSON.parse(raw) as PluginManifest;
  } catch (err) {
    throw new Error(
      `Invalid plugin manifest '<unknown>' at '${path}': JSON parse error (${(err as Error).message}). ` +
      `Example: {"id":"com.lge.sample","name":"Sample","version":"1.0.0","entry":"dist/index.js","tools":["sample_ping"]}`,
    );
  }
  parsed.installPolicy = normalizeInstallPolicy(parsed);
  const pid = typeof parsed?.id === "string" && parsed.id.length > 0 ? parsed.id : "<unknown>";
  const fail = (fieldPath: string, reason: string, example: string): never => {
    throw new Error(
      `Invalid plugin manifest '${pid}' at '${fieldPath}' (${path}): ${reason}. Example: ${example}`,
    );
  };

  // Phase 5 §4 — ui[] kind-specific required-field soft fallback.
  // Runs BEFORE AJV so a single bad ui entry does not drop the whole
  // plugin. Each invalid entry is stripped out + console.warn'd; other ui
  // entries survive.
  if (Array.isArray(parsed.ui)) {
    const keep: typeof parsed.ui = [];
    for (let i = 0; i < parsed.ui.length; i += 1) {
      const ext = parsed.ui[i] as unknown as Record<string, unknown> | undefined;
      if (!ext || typeof ext !== "object" || Array.isArray(ext)) {
        console.warn(`[manifest:${pid}] ui[${i}] is not an object — dropped`);
        continue;
      }
      const kind = ext.kind;
      const missing: string[] = [];
      if (kind === "embedded-module") {
        if (typeof ext.entry !== "string" || ext.entry.length === 0) missing.push("entry");
        if (typeof ext.exportName !== "string" || ext.exportName.length === 0) missing.push("exportName");
      } else if (kind === "embedded-page") {
        if (typeof ext.page !== "string" || ext.page.length === 0) missing.push("page");
      }
      if (missing.length > 0) {
        for (const f of missing) {
          console.warn(
            `[manifest:${pid}] ui[${i}] kind="${String(kind)}" missing required field "${f}" — dropped`,
          );
        }
        continue;
      }
      keep.push(parsed.ui[i]);
    }
    parsed.ui = keep;
  }

  // Sprint 4-B §B-1 — AJV validation against schemas/plugin.schema.json.
  if (validator && !validator(parsed)) {
    const errs = (validator.errors ?? [])
      .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
      .join("; ");
    throw new Error(
      `[manifest:${pid}] schema validation failed (${path}): ${errs}`,
    );
  }

  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    fail("id", "must be a non-empty string", `"id": "com.lge.meeting-recorder"`);
  }
  if (typeof parsed.version !== "string" || !/^\d+\.\d+\.\d+/.test(parsed.version)) {
    fail("version", "must be a semver string like 'MAJOR.MINOR.PATCH'", `"version": "1.0.0"`);
  }
  if (typeof parsed.entry !== "string" || parsed.entry.length === 0) {
    fail("entry", "must be a non-empty relative path to the plugin ESM entry", `"entry": "dist/index.js"`);
  }
  if (!Array.isArray(parsed.tools)) {
    fail("tools", "must be an array of tool name strings", `"tools": ["sample_ping"]`);
  }
  if (typeof parsed.description !== "string" || parsed.description.length === 0) {
    fail(
      "description",
      "must be a non-empty string (used in inactive-plugin catalog)",
      `"description": "One-line summary of what this plugin does."`,
    );
  }
  if (typeof parsed.publisher !== "string" || parsed.publisher.length === 0) {
    console.warn(
      `[plugin-runtime] plugin '${pid}' at '${path}' is missing publisher field (SHOULD per Phase 1). ` +
      `Add: "publisher": "Your Org"`,
    );
  }

  // Tool names exposed to LLMs must satisfy ^[a-zA-Z_][a-zA-Z0-9_]*$ (vendor requirement).
  const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  for (let i = 0; i < parsed.tools.length; i += 1) {
    const method = parsed.tools[i];
    if (typeof method !== "string") {
      fail(`tools[${i}]`, "must be a string", `"tools": ["meeting_start"]`);
    }
    if (!TOOL_NAME_PATTERN.test(method)) {
      // Backwards-compat: older tests match /Invalid tool name '...'/ — keep that
      // substring so the fresh error message still triggers the same assertion.
      throw new Error(
        `Invalid tool name '${method}' in plugin '${pid}' at 'tools[${i}]' (${path}): ` +
        `tool names must match ^[a-zA-Z_][a-zA-Z0-9_]*$ (start with letter/underscore, then letters/digits/underscores). ` +
        `Example: "tools": ["meeting_start"] (not "meeting.start")`,
      );
    }
  }

  if (parsed.startupTools !== undefined && !Array.isArray(parsed.startupTools)) {
    fail(
      "startupTools",
      "must be an array of strings (each value must appear in tools[])",
      `"startupTools": ["meeting_watch"]`,
    );
  }
  const startupTools = parsed.startupTools ?? [];
  for (let i = 0; i < startupTools.length; i += 1) {
    const startupMethod = startupTools[i];
    if (typeof startupMethod !== "string") {
      fail(
        `startupTools[${i}]`,
        "must be a string",
        `"startupTools": ["meeting_watch"]`,
      );
    }
    if (!parsed.tools.includes(startupMethod)) {
      fail(
        `startupTools[${i}]`,
        `entry '${startupMethod}' is not declared in tools[]`,
        `add "${startupMethod}" to tools[] or remove it from startupTools[]`,
      );
    }
  }

  // Sprint 4-A — surface any remaining testMode flag in a protected plugin manifest.
  if (
    normalizeInstallPolicy(parsed) === "admin" &&
    parsed.config &&
    typeof parsed.config === "object" &&
    (parsed.config as Record<string, unknown>).testMode === true
  ) {
    console.warn(
      `[plugin-runtime] protected plugin '${pid}' has config.testMode=true (${path}). ` +
      `testMode is a development flag and must not ship in production installs — please remove it from the installed manifest.`,
    );
  }

  if (parsed.startupTimeoutMs !== undefined) {
    if (
      typeof parsed.startupTimeoutMs !== "number" ||
      !Number.isInteger(parsed.startupTimeoutMs) ||
      parsed.startupTimeoutMs <= 0
    ) {
      fail(
        "startupTimeoutMs",
        "must be a positive integer (ms)",
        `"startupTimeoutMs": 8000`,
      );
    }
  }

  // Sprint 4-B §B-3 — uiCallable ⊂ tools validation.
  const uiCallable = Array.isArray(parsed.uiCallable) ? parsed.uiCallable : [];
  for (let i = 0; i < uiCallable.length; i += 1) {
    const method = uiCallable[i];
    if (typeof method !== "string") {
      fail(
        `uiCallable[${i}]`,
        "must be a string",
        `"uiCallable": ["meeting_summary_get"]`,
      );
    }
    if (!parsed.tools.includes(method)) {
      fail(
        `uiCallable[${i}]`,
        `entry '${method}' is not declared in tools[]`,
        `add "${method}" to tools[] or remove it from uiCallable[]`,
      );
    }
  }

  // Phase 5 §1 — keywords[].skillId must be in tools[].
  const kw = Array.isArray(parsed.keywords) ? parsed.keywords : [];
  for (let i = 0; i < kw.length; i += 1) {
    const sk = kw[i]?.skillId;
    if (typeof sk !== "string" || !parsed.tools.includes(sk)) {
      fail(
        `keywords[${i}].skillId`,
        `"${String(sk)}" not in tools[]`,
        `add '${String(sk)}' to tools[] or fix the skillId`,
      );
    }
  }

  // Phase 5 §2 — toolSchemas keys must be a subset of tools[].
  const schemaKeys = parsed.toolSchemas ? Object.keys(parsed.toolSchemas) : [];
  for (const k of schemaKeys) {
    if (!parsed.tools.includes(k)) {
      fail(
        `toolSchemas['${k}']`,
        `key not in tools[]`,
        `remove the key or add '${k}' to tools[]`,
      );
    }
  }

  // Phase 5 §3 — notificationEvents[i].event should be in eventSubscriptions (soft warn).
  const subs = Array.isArray(parsed.eventSubscriptions) ? parsed.eventSubscriptions : [];
  const subsTypes = new Set(
    subs.map((s) => (typeof s === "string" ? s : (s as { type: string }).type)),
  );
  const notifEvents = Array.isArray(parsed.notificationEvents) ? parsed.notificationEvents : [];
  for (let i = 0; i < notifEvents.length; i += 1) {
    const e = notifEvents[i]?.event;
    if (typeof e === "string" && !subsTypes.has(e)) {
      console.warn(
        `[manifest:${pid}] notificationEvents[${i}].event '${e}' not declared in eventSubscriptions — OS notification will still fire, but plugin won't receive the event via hostApi.onEvent`,
      );
    }
  }

  return parsed;
}
