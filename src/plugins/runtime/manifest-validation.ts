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

// Re-exported here so manifest/plugin-loading consumers can import the
// minAppVersion gate error + IPC code alongside the other manifest contracts.
export { IncompatibleAppVersionError, INCOMPATIBLE_APP_VERSION_CODE } from "../types.js";

/**
 * Stable SemVer pattern (MAJOR.MINOR.PATCH, no leading zeros, no pre-release,
 * no build metadata). Single source of this regex inside lvis-app — also
 * mirrored in `lvis-plugin-sdk/schemas/plugin-manifest.schema.json` and the
 * per-plugin `publish.yml` tag-validation step. Updating any of those copies
 * MUST update the others (cross-repo, see `host-plugin-contract-sync` rule).
 */
export const STABLE_SEMVER_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * #893 — Allow-listed host secret key pattern. A plugin manifest's
 * `hostSecrets.read[]` entries MUST match this regex so the runtime allowlist
 * only ever points at LLM API keys (the only host-owned secret class plugins
 * may currently request). Mirrors the SDK JSON-schema constraint so a plugin
 * cannot install a wider allowlist via a stale SDK build.
 */
export const HOST_SECRETS_KEY_PATTERN = /^llm\.apiKey\.[a-z-]+$/;
const log = createLogger("plugin-runtime");

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function patchHostSecretsIntoLegacySdkSchema(schema: unknown): unknown {
  const root = asObject(schema) as (JsonObject & { properties?: Record<string, unknown> }) | undefined;
  if (!root?.properties || root.properties.hostSecrets !== undefined) return schema;
  root.properties.hostSecrets = {
    type: "object",
    additionalProperties: false,
    properties: {
      read: {
        type: "array",
        items: {
          type: "string",
          pattern: "^llm\\.apiKey\\.[a-z-]+$",
        },
      },
    },
  };
  return schema;
}

function schemaHasHostSecrets(schema: unknown): boolean {
  const root = asObject(schema);
  const properties = asObject(root?.properties);
  return properties?.hostSecrets !== undefined;
}

/**
 * Locate the `required` array that the SDK schema attaches to each toolSchemas
 * entry (`properties.toolSchemas.additionalProperties.required`). The SDK
 * references the per-tool shape inline today; if a future SDK build factors it
 * into a `$ref`, the pointer is resolved and only the referenced definition's
 * `required` array is returned — never a sibling schema's `required`.
 */
function findToolSchemaRequiredArrays(schema: unknown): string[][] {
  const found: string[][] = [];
  const root = asObject(schema);
  const properties = asObject(root?.properties);
  const toolSchemas = asObject(properties?.toolSchemas);
  const additional = asObject(toolSchemas?.additionalProperties);
  const direct = additional?.required;
  if (Array.isArray(direct) && direct.every((v) => typeof v === "string")) {
    found.push(direct as string[]);
  }
  // Indirect: toolSchemas.additionalProperties may be a `$ref` into $defs.
  // Resolve the pointer and patch ONLY the referenced definition's `required`,
  // not every same-shaped def (which could touch unrelated schemas).
  const refTarget = typeof additional?.$ref === "string" ? additional.$ref : undefined;
  if (refTarget) {
    const req = asObject(resolveJsonPointer(root, refTarget))?.required;
    if (Array.isArray(req) && req.every((v) => typeof v === "string")) {
      found.push(req as string[]);
    }
  }
  return found;
}

/**
 * Resolve a local JSON Pointer `$ref` (e.g. `#/$defs/ToolSchema`) against the
 * root schema. Returns undefined for external refs or a path that does not
 * resolve. Handles the `~1`→`/` and `~0`→`~` pointer escapes.
 */
function resolveJsonPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    const obj = asObject(current);
    if (!obj) return undefined;
    current = obj[segment];
  }
  return current;
}

/**
 * Relax the SDK schema so a toolSchemas entry without `category` validates on
 * the host. The host owns risk classification (default-strict at runtime), so
 * it must tolerate a manifest that omits the declared category ahead of the SDK
 * schema dropping the field. Mutates `schema.properties.toolSchemas.
 * additionalProperties.required` in place, removing `"category"`. No-op when
 * the path or the entry is absent.
 */
function patchCategoryOptionalIntoLegacySdkSchema(schema: unknown): unknown {
  for (const required of findToolSchemaRequiredArrays(schema)) {
    const idx = required.indexOf("category");
    if (idx >= 0) required.splice(idx, 1);
  }
  return schema;
}

/**
 * True when the SDK schema still REQUIRES a `category` on each toolSchemas
 * entry — i.e. an unpatched schema that would reject a category-less manifest
 * at load.
 */
function schemaRequiresToolCategory(schema: unknown): boolean {
  return findToolSchemaRequiredArrays(schema).some((req) => req.includes("category"));
}

function schemaHasNetworkAccess(schema: unknown): boolean {
  const root = asObject(schema);
  const properties = asObject(root?.properties);
  return properties?.networkAccess !== undefined;
}

// Tier A — networkAccess egress allow-list. Same compatibility seam as
// hostSecrets above: a legacy SDK pin (`package.json` lags `@lvis/plugin-sdk`)
// whose schema predates `networkAccess` would, under root
// `additionalProperties:false`, reject every migrated plugin's manifest as an
// unknown property and silently drop the plugin at load. Inject the field so
// host validation stays in lockstep with the SDK SoT until the pin is bumped.
// Mirrors lvis-plugin-sdk schemas/plugin-manifest.schema.json `networkAccess`.
function patchNetworkAccessIntoLegacySdkSchema(schema: unknown): unknown {
  const root = asObject(schema) as (JsonObject & { properties?: Record<string, unknown> }) | undefined;
  if (!root?.properties || root.properties.networkAccess !== undefined) return schema;
  root.properties.networkAccess = {
    type: "object",
    additionalProperties: false,
    required: ["allowedDomains"],
    properties: {
      allowedDomains: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        uniqueItems: true,
        items: {
          allOf: [
            {
              type: "string",
              pattern: "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$",
              minLength: 3,
              maxLength: 253,
            },
            { not: { enum: ["com", "net", "org", "kr", "co.kr", "or.kr", "go.kr", "io", "ai", "dev", "app"] } },
            { not: { type: "string", pattern: "(^|\\.)xn--" } },
          ],
        },
      },
      reasoning: { type: "string" },
    },
  };
  return schema;
}

export function patchHostCompatibilityIntoLegacySdkSchema(schema: unknown): unknown {
  patchHostSecretsIntoLegacySdkSchema(schema);
  patchCategoryOptionalIntoLegacySdkSchema(schema);
  patchNetworkAccessIntoLegacySdkSchema(schema);
  return schema;
}

async function loadSdkManifestSchema(): Promise<unknown> {
  const schemaPath = createRequire(import.meta.url).resolve(
    "@lvis/plugin-sdk/schemas/plugin-manifest.schema.json",
  );
  const schemaBytes = await readFile(schemaPath, "utf-8");
  return JSON.parse(schemaBytes);
}

function compileAjvValidator(schema: unknown): ValidateFunction {
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
}

function wrapSdkValidatorWithHostCompatibility(
  sdkValidator: ValidateFunction,
  hostValidator: ValidateFunction,
): ValidateFunction {
  const wrapped = ((data: unknown) => {
    if (sdkValidator(data)) {
      wrapped.errors = null;
      return true;
    }
    const sdkErrors = sdkValidator.errors ?? null;
    if (hostValidator(data)) {
      wrapped.errors = null;
      return true;
    }
    wrapped.errors = hostValidator.errors ?? sdkErrors;
    return false;
  }) as ValidateFunction;
  return wrapped;
}

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
 *
 * PR #894 review B5 — when the SDK exposes a `compileManifestValidator()`
 * helper, prefer it so host + SDK never drift apart on AJV options. The
 * helper is intentionally optional; older SDK builds (pre-#893 follow-up)
 * fall through to the local AJV compile path with a one-shot warn so
 * operators see the drift signal in logs.
 */
export async function buildManifestValidator(): Promise<ValidateFunction> {
  const sdkSchema = await loadSdkManifestSchema();
  // Host-compat wrap is needed when the shipped SDK schema lags ANY host-
  // required manifest field — missing hostSecrets, missing networkAccess (Tier
  // A egress allow-list), or still mandating a per-tool `category`. Under root
  // `additionalProperties:false` the SDK's own validator would reject migrated
  // manifests, and the host classifies risk itself (default-strict) so a
  // category-less manifest MUST still load. Wrap with the host-local validator
  // (OR semantics) whenever any of these holds.
  const hostCompatibilityNeeded =
    !schemaHasHostSecrets(sdkSchema) ||
    !schemaHasNetworkAccess(sdkSchema) ||
    schemaRequiresToolCategory(sdkSchema);

  try {
    // Prefer SDK helper when available so AJV options stay in lockstep.
    type SdkModule = { compileManifestValidator?: () => ValidateFunction };
    const sdk = (await import("@lvis/plugin-sdk")) as unknown as SdkModule;
    if (typeof sdk.compileManifestValidator === "function") {
      const sdkValidator = sdk.compileManifestValidator();
      if (!hostCompatibilityNeeded) return sdkValidator;
      log.warn(
        "SDK manifest schema lacks host compatibility extensions — wrapping compileManifestValidator() with host-local AJV compatibility. Update @lvis/plugin-sdk to keep manifest validation in lockstep.",
      );
      return wrapSdkValidatorWithHostCompatibility(
        sdkValidator,
        compileAjvValidator(patchHostCompatibilityIntoLegacySdkSchema(sdkSchema)),
      );
    }
    log.warn(
      "SDK does not export compileManifestValidator() — falling back to host-local AJV compile. Update @lvis/plugin-sdk to keep manifest validation in lockstep.",
    );
  } catch (err) {
    // SDK import itself failed (rare — host always depends on SDK for
    // types). Fall through to the local compile so plugin loading isn't
    // blocked on an SDK packaging quirk.
    log.warn(`SDK validator import failed, using host-local AJV: ${(err as Error).message}`);
  }
  try {
    return compileAjvValidator(patchHostCompatibilityIntoLegacySdkSchema(sdkSchema));
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
  // Detailed, per-field error messages shaped as
  //   "Invalid plugin manifest '<pluginId>' at '<fieldPath>': <reason>. Example: <correction>"
  const raw = await readFile(path, "utf-8");
  let parsed: PluginManifest;
  try {
    parsed = JSON.parse(raw) as PluginManifest;
  } catch (err) {
    throw new Error(
      `Invalid plugin manifest '<unknown>' at '${path}': JSON parse error (${(err as Error).message}). ` +
      `Example: {"id":"com.example.sample","name":"Sample","version":"1.0.0","entry":"dist/index.js","tools":["sample_ping"]}`,
    );
  }
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
      } else if (kind === "action") {
        if (typeof ext.tool !== "string" || ext.tool.length === 0) missing.push("tool");
      }
      if (missing.length > 0) {
        fail(
          `ui[${i}]`,
          `kind="${String(kind)}" missing required field(s): ${missing.join(", ")}`,
          kind === "embedded-module"
            ? `"ui": [{ "kind": "embedded-module", "entry": "dist/ui.js", "exportName": "PluginUi" }]`
            : kind === "action"
              ? `"ui": [{ "kind": "action", "tool": "open_inbox" }]`
              : `"ui": [{ "kind": "embedded-page", "page": "settings" }]`,
        );
      }
    }
  }

  if (!validator(parsed)) {
    // Enrich the error so users can act on it. Pre-fix AJV's default text
    // for additional-properties was "/ must NOT have additional properties"
    // — never named WHICH property was rejected, leaving users stuck (#737).
    // Now we name the offending field(s) and append a reinstall hint when
    // it's the additional-property case (typical when SDK schema tightens
    // and a stale plugin install carries a deprecated field).
    const ajvErrors = validator.errors ?? [];
    const additionalProps: string[] = [];
    for (const e of ajvErrors) {
      if (e.keyword === "additionalProperties") {
        const extra = (e.params as { additionalProperty?: string } | undefined)?.additionalProperty;
        if (typeof extra === "string") additionalProps.push(extra);
      }
    }
    const errs = ajvErrors
      .map((e) => {
        if (e.keyword === "additionalProperties") {
          const extra = (e.params as { additionalProperty?: string } | undefined)?.additionalProperty;
          return `${e.instancePath || "/"} unknown property: '${extra ?? "?"}'`;
        }
        // Preserve AJV's `params` for non-additionalProperties errors so
        // users see the actionable detail (allowed enum values, expected
        // type, regex pattern, etc.). Pre-fix dropped params silently —
        // a `pattern` mismatch on `version` would say "must match pattern"
        // without showing the pattern itself.
        const base = `${e.instancePath || "/"} ${e.message ?? ""}`.trim();
        const params = e.params && typeof e.params === "object" && Object.keys(e.params).length > 0
          ? ` (${JSON.stringify(e.params)})`
          : "";
        return `${base}${params}`;
      })
      .join("; ");
    const hint =
      additionalProps.length > 0
        ? ` — the manifest contains ${additionalProps.length === 1 ? "a field" : "fields"} that the current SDK schema no longer allows. The plugin may need an update — try reinstalling from the marketplace.`
        : "";
    throw new Error(
      `[manifest:${pid}] schema validation failed (${path}): ${errs}${hint}`,
    );
  }
  parsed.installPolicy = normalizeInstallPolicy(parsed);

  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    fail("id", "must be a non-empty string", `"id": "com.example.meeting-recorder"`);
  }
  // PR #894 review B8 — reject malformed dotted ids that create ambiguity
  // in the `plugin.<pluginId>.*` secret namespace, the audit log
  // `[plugin:${id}]` prefix, and the host-secret allowlist key parser.
  //   - Leading/trailing dots produce empty segments (`plugin..foo.bar`)
  //   - Consecutive dots (`..`) make audit log greps unparseable
  // Reason tag is `manifest_schema` to match the supply-chain audit tag.
  // Normal dot-segmented ids (`com.example.meeting-recorder`) remain valid
  // per the SDK schema's "dot-format recommended" convention.
  if (
    typeof parsed.id === "string" &&
    (parsed.id.startsWith(".") ||
      parsed.id.endsWith(".") ||
      parsed.id.includes(".."))
  ) {
    fail(
      "id",
      `value '${parsed.id}' has malformed dot segments (leading/trailing/consecutive dots) — manifest_schema. Dotted ids are allowed (e.g. 'com.example.foo'), but each segment must be non-empty`,
      `"id": "com.example.meeting-recorder"`,
    );
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
      `plugin '${pid}' at '${path}' is missing publisher field (SHOULD). ` +
      `Add: "publisher": "Your Org"`,
    );
  }

  // Tool names exposed to LLMs must satisfy ^[a-zA-Z_][a-zA-Z0-9_]*$ (vendor requirement).
  const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  for (let i = 0; i < parsed.tools.length; i += 1) {
    const method = parsed.tools[i];
    if (typeof method !== "string") {
      fail(`tools[${i}]`, "must be a string", `"tools": ["sample_tool"]`);
    }
    if (!TOOL_NAME_PATTERN.test(method)) {
      throw new Error(
        `Invalid tool name '${method}' in plugin '${pid}' at 'tools[${i}]' (${path}): ` +
        `tool names must match ^[a-zA-Z_][a-zA-Z0-9_]*$ (start with letter/underscore, then letters/digits/underscores). ` +
        `Example: "tools": ["sample_tool"] (not "sample.tool")`,
      );
    }
  }

  // Surface any remaining testMode flag in a protected plugin manifest.
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

  // `startupTimeoutMs` 는 *plugin instance.start() lifecycle hook 의 timeout* 만
  // 통제한다 — manifest 의 tool name list 자동 invoke 메커니즘 (runManifestStartupTools,
  // 2026-05-14 폐기) 의 잔재가 아님. plugin self-start 가 SoT 인 모델에서 host runtime
  // 의 `Promise.race` 에 묶이는 유일한 시간 가드.
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

  // §B-3 — uiCallable structural validation. UI-callable methods may be
  // runtime-only and therefore do not need to appear in tools[]; tools[] is
  // the LLM-facing registration surface.
  const uiCallable = Array.isArray(parsed.uiCallable) ? parsed.uiCallable : [];
  for (let i = 0; i < uiCallable.length; i += 1) {
    const method = uiCallable[i];
    if (typeof method !== "string") {
      fail(
        `uiCallable[${i}]`,
        "must be a string",
        `"uiCallable": ["summary_get"]`,
      );
    }
    if (!TOOL_NAME_PATTERN.test(method)) {
      throw new Error(
        `Invalid UI-callable method name '${method}' in plugin '${pid}' at 'uiCallable[${i}]' (${path}): ` +
        `method names must match ^[a-zA-Z_][a-zA-Z0-9_]*$ (start with letter/underscore, then letters/digits/underscores). ` +
        `Example: "uiCallable": ["sample_upload_chunk"] (not "sample.upload.chunk")`,
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
        `add "${value}" to uiCallable[] so the host UI surface can invoke it`,
        );
      }
    }

    // architecture.md §9.4a: when `auth` is declared, the host's
    // `usePluginAuthStatuses` hook subscribes to `${manifest.id}.auth.changed`
    // (literal id, no `_`↔`-` normalization). The plugin must therefore
    // declare and emit that exact event name — otherwise the badge stays
    // stuck on the boot-time `unauthed` snapshot even after a successful
    // login. The bug class: a plugin whose manifest id is `foo-bar` (dash)
    // accidentally declares + emits `foo_bar.auth.changed` (underscore,
    // mirroring its tool prefix), and the host hook never matches.
    //
    // Soft warn (not hard fail) to match the `notificationEvents` drift
    // pattern below — catches the bug class without breaking already-loaded
    // plugins that haven't migrated. Scope is intentionally limited to
    // `auth.changed`: other emittedEvents names live in plugin-owned
    // namespaces that the host treats as `neutral` (architecture.md §9.4a),
    // so universal name validation would overreach.
    // Defensive: AJV + the early `pid` guard at the top of this function
    // already pin `parsed.id` to a non-empty string in the normal flow,
    // but skipping the warn when the guard somehow doesn't hold avoids
    // embedding `undefined.auth.changed` in the log line.
    if (typeof parsed.id === "string" && parsed.id.length > 0) {
      const expectedAuthEvent = `${parsed.id}.auth.changed`;
      const declaredEmits = getDeclaredEmittedEvents(parsed);
      if (!declaredEmits.includes(expectedAuthEvent)) {
        log.warn(
          `manifest declares 'auth' but emittedEvents[] is missing '${expectedAuthEvent}' — host badge will not refresh after login. Add "${expectedAuthEvent}" to emittedEvents[] and emit it from the loginTool/logoutTool/auth-state-change paths. See architecture.md §9.4a for the auth-event contract.`,
        );
      }
    }
  }

  // keywords[].skillId must be in tools[].
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

  // toolSchemas keys must be a subset of tools[].
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

  // #893 — hostSecrets.read[] schema enforcement. The SDK JSON-schema mirrors
  // this rule, but we re-check at host load time so a plugin shipped with a
  // stale SDK schema cannot grant itself a wider allowlist by adding a
  // non-`llm.apiKey.*` entry. Reason tag is `manifest_schema` to mirror the
  // host's other supply-chain-visibility audit tags.
  const hostSecretsRaw: unknown = (parsed as { hostSecrets?: unknown }).hostSecrets;
  if (hostSecretsRaw !== undefined) {
    if (
      hostSecretsRaw === null ||
      typeof hostSecretsRaw !== "object" ||
      Array.isArray(hostSecretsRaw)
    ) {
      fail(
        "hostSecrets",
        "must be an object with optional `read` array",
        `"hostSecrets": { "read": ["llm.apiKey.openai"] }`,
      );
    }
    const readListRaw: unknown = (hostSecretsRaw as { read?: unknown }).read;
    if (readListRaw !== undefined) {
      if (!Array.isArray(readListRaw)) {
        fail(
          "hostSecrets.read",
          "must be an array of strings",
          `"hostSecrets": { "read": ["llm.apiKey.openai"] }`,
        );
      }
      const readArr = readListRaw as unknown[];
      for (let i = 0; i < readArr.length; i += 1) {
        const key = readArr[i];
        if (typeof key !== "string") {
          fail(
            `hostSecrets.read[${i}]`,
            "must be a string",
            `"hostSecrets": { "read": ["llm.apiKey.openai"] }`,
          );
        }
        // `fail()` returns `never`, but TS's narrowing through the
        // arrow-function call path is sometimes lossy — re-assert via a
        // local typed binding so the regex test below sees `key: string`.
        const keyStr: string = key as string;
        if (!HOST_SECRETS_KEY_PATTERN.test(keyStr)) {
          fail(
            `hostSecrets.read[${i}]`,
            `value '${keyStr}' does not match the allowed host-secret pattern (manifest_schema). Only \`llm.apiKey.<vendor>\` keys are accepted`,
            `"hostSecrets": { "read": ["llm.apiKey.openai"] }`,
          );
        }
      }
    }
  }

  // Plugin↔app minimum-version gate — re-validate the format at host load even
  // though the SDK JSON-schema mirrors the same `pattern` (same rationale as
  // hostSecrets above: a plugin shipped against a stale SDK schema must not
  // smuggle a non-SemVer `minAppVersion`). The host enforces compatibility at
  // install + load against this value, so a malformed string would make the
  // `compareSemver` gate fail-closed silently — fail loud here instead.
  const requiresRaw: unknown = (parsed as { requires?: unknown }).requires;
  if (requiresRaw && typeof requiresRaw === "object" && !Array.isArray(requiresRaw)) {
    const minAppVersionRaw: unknown = (requiresRaw as { minAppVersion?: unknown }).minAppVersion;
    if (minAppVersionRaw !== undefined) {
      if (typeof minAppVersionRaw !== "string" || !STABLE_SEMVER_RE.test(minAppVersionRaw)) {
        fail(
          "requires.minAppVersion",
          "must be a stable SemVer string MAJOR.MINOR.PATCH (no range, pre-release, build metadata, or leading zeros) — manifest_schema",
          `"requires": { "minAppVersion": "1.4.0" }`,
        );
      }
    }
  }

  // notificationEvents[i].event should be in eventSubscriptions (soft warn).
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
