/**
 * Manifest validation — SDK schema SOT + host cross-field MUST/SHOULD checks.
 *
 * Exported for unit testing and reuse by the PluginRuntime class.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
// ajv + ajv-formats ship a CJS default export; ESM interop requires the
// `.default ?? module` dance below.
import * as AjvModule from "ajv";
import * as AddFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import type { PluginManifest, InstallPolicy } from "../types.js";
import { createLogger } from "../../lib/logger.js";

/**
 * Stable SemVer pattern (MAJOR.MINOR.PATCH, no leading zeros, no pre-release,
 * no build metadata). Single source of this regex inside lvis-app — also
 * mirrored in `lvis-plugin-sdk/schemas/plugin-manifest.schema.json` and the
 * per-plugin `publish.yml` tag-validation step. Updating any of those copies
 * MUST update the others (cross-repo, see `host-plugin-contract-sync` rule).
 */
export const STABLE_SEMVER_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const log = createLogger("plugin-runtime");

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
 * Lazy-load + compile the SDK plugin manifest schema into an AJV validator.
 * The SDK schema is the manifest shape SOT; if it cannot be resolved or
 * compiled, plugin loading must fail closed instead of switching validators.
 */
export async function buildManifestValidator(): Promise<ValidateFunction> {
  try {
    const schemaPath = createRequire(import.meta.url).resolve(
      "@lvis/plugin-sdk/schemas/plugin-manifest.schema.json",
    );
    const schemaBytes = await readFile(schemaPath, "utf-8");
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
    throw new Error(`SDK plugin manifest schema unavailable: ${(err as Error).message}`);
  }
}

/**
 * Parse and fully validate a plugin.json manifest file.
 *
 * Runs SDK AJV schema validation followed by host cross-field MUST checks.
 * Throws with a descriptive message on any failure.
 */
export async function parsePluginJson(
  path: string,
  validator: ValidateFunction,
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

  if (!validator) {
    throw new Error("SDK plugin manifest validator is required");
  }

  if (Array.isArray(parsed.ui)) {
    for (let i = 0; i < parsed.ui.length; i += 1) {
      const rawExt = parsed.ui[i] as unknown;
      if (!rawExt || typeof rawExt !== "object" || Array.isArray(rawExt)) {
        fail(`ui[${i}]`, "must be an object", `"ui": [{ "slot": "settings", "kind": "embedded-page", "page": "settings" }]`);
      }
      const ext = rawExt as Record<string, unknown>;
      const kind = ext.kind;
      const missing: string[] = [];
      if (kind === "embedded-module") {
        if (typeof ext.entry !== "string" || ext.entry.length === 0) missing.push("entry");
        if (typeof ext.exportName !== "string" || ext.exportName.length === 0) missing.push("exportName");
      } else if (kind === "embedded-page") {
        if (typeof ext.page !== "string" || ext.page.length === 0) missing.push("page");
      }
      if (missing.length > 0) {
        fail(
          `ui[${i}]`,
          `kind="${String(kind)}" missing required field(s): ${missing.join(", ")}`,
          kind === "embedded-module"
            ? `"ui": [{ "kind": "embedded-module", "entry": "dist/ui.js", "exportName": "PluginUi" }]`
            : `"ui": [{ "kind": "embedded-page", "page": "settings" }]`,
        );
      }
    }
  }

  if (!validator(parsed)) {
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
  // Stable SemVer only — same regex as the SDK schema and the per-plugin
  // publish.yml tag-validation step. Anchored on both ends so `1.2.3.4`,
  // pre-release tags (`1.2.3-rc1`), build metadata (`1.2.3+abc`), and
  // leading zeros (`01.2.3`) all fail at this gate instead of slipping
  // through and tripping the publish workflow later.
  if (typeof parsed.version !== "string" || !STABLE_SEMVER_RE.test(parsed.version)) {
    fail("version", "must be a stable SemVer string MAJOR.MINOR.PATCH (no pre-release or build metadata, no leading zeros)", `"version": "1.0.0"`);
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
    log.warn(
      `plugin '${pid}' at '${path}' is missing publisher field (SHOULD per Phase 1). ` +
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
    log.warn(
      `protected plugin '${pid}' has config.testMode=true (${path}). ` +
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

  // Plugin auth UI surface (architecture.md §9.4a) — auth.{statusTool,
  // loginTool, logoutTool?} must all be members of uiCallable[]. AJV cannot
  // express cross-array membership without a custom keyword, so this lives
  // alongside the other hand-rolled cross-field checks.
  if (parsed.auth) {
    const authToolKeys: Array<"statusTool" | "loginTool" | "logoutTool"> = [
      "statusTool",
      "loginTool",
      "logoutTool",
    ];
    for (const key of authToolKeys) {
      const value = parsed.auth[key];
      if (value === undefined) continue; // logoutTool is optional
      if (typeof value !== "string") {
        fail(
          `auth.${key}`,
          "must be a string",
          `"auth": { "statusTool": "ms_status", "loginTool": "ms_login" }`,
        );
      }
      if (!uiCallable.includes(value)) {
        fail(
          `auth.${key}`,
          `tool '${value}' is not declared in uiCallable[]`,
          `add "${value}" to uiCallable[] (and tools[]) so the host UI surface can invoke it`,
        );
      }
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
      log.warn(
        `notificationEvents[${i}].event '${e}' not declared in eventSubscriptions — OS notification will still fire, but plugin won't receive the event via hostApi.onEvent`,
      );
    }
  }

  return parsed;
}
