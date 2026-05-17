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

/**
 * #893 — Allow-listed host secret key pattern. A plugin manifest's
 * `hostSecrets.read[]` entries MUST match this regex so the runtime allowlist
 * only ever points at LLM API keys (the only host-owned secret class plugins
 * may currently request). Mirrors the SDK JSON-schema constraint so a plugin
 * cannot install a wider allowlist via a stale SDK build.
 */
export const HOST_SECRETS_KEY_PATTERN = /^llm\.apiKey\.[a-z-]+$/;
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

  // Sprint 4-B §B-3 — uiCallable ⊂ tools validation.
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
