/**
 * Manifest validation — host-owned schema SOT + host cross-field MUST/SHOULD
 * checks. The manifest shape is validated against the vendored
 * `schemas/plugin-manifest.schema.json` (ph2 — host owns the schema; no runtime
 * `@lvis/plugin-sdk` import).
 *
 * Exported for unit testing and reuse by the PluginRuntime class.
 */

import { readFile } from "node:fs/promises";
import * as AjvModule from "ajv";
import * as AddFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
// Host-owned manifest-shape SOT (ph2). The schema is imported as a
// bundler-visible JSON module so it inlines into the packaged main bundle —
// no runtime disk read, so no electron-builder `files`/asar gap can leave the
// packaged app unable to resolve it. The `schemas/plugin-manifest.schema.json`
// file is byte-identical to the SDK's former canonical copy; the SDK now
// mirrors from here (host is SOT).
import manifestSchema from "../../../schemas/plugin-manifest.schema.json" with { type: "json" };
import type {
  PluginManifest,
  PluginToolOperationPolicy,
  InstallPolicy,
  Tool,
} from "../types.js";
import { toolVisibility, isModelVisible } from "./tool-visibility.js";
import { createLogger } from "../../lib/logger.js";
import { normalizeAllowedHosts } from "../../main/host-allow-list.js";
import {
  marketplaceProviderPresetIdFromSecretKey,
} from "../../shared/marketplace-package-assets.js";
import { resolvePluginContributionDeclarations } from "../plugin-contributions.js";

// Re-exported here so manifest/plugin-loading consumers can import the
// minAppVersion gate error + IPC code alongside the other manifest contracts.
export { IncompatibleAppVersionError, INCOMPATIBLE_APP_VERSION_CODE } from "../types.js";

/**
 * Stable SemVer pattern (MAJOR.MINOR.PATCH, no leading zeros, no pre-release,
 * no build metadata). This TS const mirrors the `version` / `minAppVersion`
 * pattern in the host-owned `schemas/plugin-manifest.schema.json` (the SOT) and
 * the per-plugin `publish.yml` tag-validation step. Updating any of those copies
 * MUST update the others (cross-repo, see `host-plugin-contract-sync` rule).
 */
export const STABLE_SEMVER_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * #893 — Allow-listed host secret key pattern. A plugin manifest's
 * `hostSecrets.read[]` entries MUST match one of these host-owned LLM secret
 * key shapes. Mirrors the JSON-schema constraint as defence-in-depth so a
 * plugin manifest cannot install a wider allowlist than the schema permits.
 */
const LLM_API_KEY_PATTERN = /^llm\.apiKey\.[a-z]+(?:-[a-z]+)*$/;
const log = createLogger("plugin-runtime");

function isAllowedHostSecretKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (LLM_API_KEY_PATTERN.test(value) ||
      marketplaceProviderPresetIdFromSecretKey(value) !== undefined)
  );
}

export function formatUnknownErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

interface AjvCtor {
  new (opts?: unknown): {
    compile: (schema: unknown) => ValidateFunction;
  };
}

/**
 * Resolve the AJV constructor / `addFormats` across CJS/ESM interop. AJV ships
 * its concrete class as either `module.default` (ESM) or `module.exports`
 * (CJS); the same interop dance the host already uses in `config-schema.ts`.
 */
function resolveAjv(): AjvCtor {
  const mod = AjvModule as unknown as { default?: unknown };
  return (mod.default ?? AjvModule) as AjvCtor;
}

function resolveAddFormats(): (a: unknown) => void {
  const mod = AddFormatsModule as unknown as { default?: unknown };
  return (mod.default ?? AddFormatsModule) as (a: unknown) => void;
}

export function normalizeInstallPolicy(
  source: Partial<Pick<PluginManifest, "installPolicy">> | undefined,
): InstallPolicy {
  if (source?.installPolicy === "admin") {
    return "admin";
  }
  return "user";
}

export function getDeclaredEmittedEvents(manifest: Pick<PluginManifest, "emittedEvents">): string[] {
  if (!Array.isArray(manifest.emittedEvents)) return [];
  return [...new Set(
    manifest.emittedEvents.filter((e): e is string => typeof e === "string" && e.length > 0),
  )];
}

/**
 * Compile the host-owned plugin manifest schema into an AJV validator.
 *
 * ph2 — the manifest-shape SOT is now `schemas/plugin-manifest.schema.json`,
 * vendored into the host and imported as a bundler-visible JSON module (see the
 * top-of-file import). The host no longer imports `@lvis/plugin-sdk` at runtime,
 * so plugin loading no longer depends on the SDK package or its pinned version
 * (which removes the former circular host→SDK runtime edge + validator-version
 * skew). If the schema cannot be compiled, plugin loading must fail closed.
 *
 * AJV options mirror the SDK's former `compileManifestValidator()` exactly
 * (`strict` + `strictRequired:false` + `allErrors` + `allowUnionTypes`, plus
 * `ajv-formats`), so behavior is unchanged from the last host↔SDK-pinned build.
 * The former runtime accept/reject probes (which guarded against a stale SDK
 * schema) are gone — a host-vendored schema cannot be version-skewed — and are
 * re-expressed as test-time assertions against this compiled validator
 * (`manifest-validator-host-sot.test.ts`).
 */
export async function buildManifestValidator(): Promise<ValidateFunction> {
  try {
    const AjvCtor = resolveAjv();
    const ajv = new AjvCtor({
      strict: true,
      strictRequired: false,
      allErrors: true,
      allowUnionTypes: true,
    });
    resolveAddFormats()(ajv);
    return ajv.compile(manifestSchema);
  } catch (err) {
    // Fail closed — an uncompilable schema aborts plugin loading rather than
    // degrading to an unvalidated (permissive) load path.
    throw new Error(
      `Host plugin manifest validator failed to compile: ${formatUnknownErrorMessage(err)}`,
    );
  }
}

/**
 * Materialize a validated manifest into the pure form every host consumer reads
 * (SoT §2.3). Two defaulting sites, both pure (no IO):
 *   1. a tool that omits `_meta.ui.visibility` gets the STANDARD SEP-1865
 *      default `["model","app"]`; an explicit `[]` is REJECTED (R6 fail-closed —
 *      never widened to dual). `tool-visibility.ts` depends on this being the
 *      sole tool-visibility defaulting step, so output tools ALWAYS carry an
 *      explicit non-empty `_meta.ui.visibility`.
 *   2. `name` defaults to `id` when the (schema-optional) manifest omits it, so
 *      a parsed manifest always carries a name at runtime.
 * Formerly a standalone exported helper in `../types.js`; inlined here as the
 * single load-time materializer now that no other consumer needs it.
 */
function materializeManifest(manifest: PluginManifest): PluginManifest {
  const DUAL = ["model", "app"] as const;
  const tools = manifest.tools.map((t): Tool => {
    const vis = t._meta?.ui?.visibility;
    if (vis === undefined) {
      return { ...t, _meta: { ...t._meta, ui: { ...t._meta?.ui, visibility: [...DUAL] } } };
    }
    if (vis.length === 0) {
      throw new Error(
        `[manifest:${manifest.id}] tool '${t.name}': _meta.ui.visibility is [] — ` +
          "a tool must be reachable by ≥1 surface; empty is rejected (SoT §2.2/§2.3)",
      );
    }
    return t;
  });
  return { ...manifest, tools, name: manifest.name ?? manifest.id };
}

/**
 * Parse and fully validate a plugin.json manifest file.
 *
 * Runs SDK AJV schema validation, then materializes each tool's surface
 * visibility and the `name` default via `materializeManifest` (SoT §3.1), then
 * runs host cross-field MUST checks against the pure `Tool[]`. Returns the
 * fully-materialized {@link PluginManifest} every host consumer reads. Throws
 * with a descriptive message on any failure.
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

  const networkAccessRaw: unknown = parsed.networkAccess;
  if (
    networkAccessRaw &&
    typeof networkAccessRaw === "object" &&
    !Array.isArray(networkAccessRaw)
  ) {
    const allowedDomainsRaw = (networkAccessRaw as { allowedDomains?: unknown }).allowedDomains;
    if (
      Array.isArray(allowedDomainsRaw) &&
      allowedDomainsRaw.every((entry): entry is string => typeof entry === "string")
    ) {
      try {
        parsed.networkAccess = {
          ...parsed.networkAccess,
          allowedDomains: normalizeAllowedHosts(allowedDomainsRaw),
        };
      } catch (err) {
        fail(
          "networkAccess.allowedDomains",
          err instanceof Error ? err.message : String(err),
          `"networkAccess": { "allowedDomains": ["api.example.com"], "reasoning": "Why this plugin needs host-mediated egress." }`,
        );
      }
    }
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
    // Enrich the error so users can act on it. Pre-fix AJV's default text
    // for additional-properties was "/ must NOT have additional properties"
    // — never named WHICH property was rejected, leaving users stuck (#737).
    // Now we name the offending field(s) and append a reinstall hint when
    // it's the additional-property case (typical when SDK schema tightens
    // and a stale plugin install carries a deprecated field).
    const rawAjvErrors = validator.errors ?? [];
    const ajvErrors = rawAjvErrors;
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
    fail(
      "tools",
      "must be an array of pure MCP tool objects",
      `"tools": [{ "name": "sample_ping", "inputSchema": { "type": "object", "properties": {} } }]`,
    );
  }
  // #885 Phase R — pure v6 only. Each `tools[]` entry MUST be an MCP Tool OBJECT.
  // A pre-v6 manifest declared `tools` as a list of name STRINGS (paired with the
  // now-removed `toolSchemas`/`uiActions` maps). Reject it here with an actionable
  // message instead of letting it fall through to the downstream tool-name loop,
  // which would spread a bare string into a nameless object and throw the
  // confusing "Invalid tool name 'undefined'" (security-review nitpick a). The
  // Host and SDK schemas both reject that legacy shape. Keep this host-side guard
  // as a loud, author-facing error if validation is ever invoked with a custom
  // validator that is accidentally more permissive than the Host source of truth.
  const preV6ToolIdx = (parsed.tools as unknown[]).findIndex(
    (t) => typeof t !== "object" || t === null || Array.isArray(t),
  );
  if (preV6ToolIdx !== -1) {
    fail(
      `tools[${preV6ToolIdx}]`,
      "must be an MCP Tool object — this plugin targets a pre-v6 contract " +
        "(legacy tools[] name strings + toolSchemas/uiActions); upgrade to @lvis/plugin-sdk v6",
      `"tools": [{ "name": "sample_ping", "inputSchema": { "type": "object", "properties": {} } }]`,
    );
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

  // #885 v6 — materialize each tool's `_meta.ui.visibility` (and the `name`
  // default) into the pure `PluginManifest` every host check below reads (the
  // standard `["model","app"]` default is filled in here, an explicit `[]` is
  // rejected). From here on all tool checks read `manifest.tools: Tool[]` —
  // never `parsed.tools`.
  const manifest = materializeManifest(parsed);

  // Contribution paths and owner-local IDs are security-bearing cross-field
  // contracts that JSON Schema alone cannot normalize or collision-check.
  // Validate them before any runtime or subsystem can observe the manifest.
  resolvePluginContributionDeclarations(manifest);

  // Tool names exposed to LLMs must satisfy ^[a-zA-Z_][a-zA-Z0-9_]*$ (vendor
  // requirement — kept as defence-in-depth vs a stale SDK schema, same rationale
  // as the hostSecrets/version re-checks). One pass also builds the by-name index
  // reused by the auth/keyword cross-field checks and REJECTS duplicate names:
  // the old three-map shape got name-uniqueness for free (object keys), but two
  // `tools[]` objects may now share a `name`, which would throw at runtime in the
  // loader methodMap and make the auth/keyword lookups ambiguous (u2 §1.4.1).
  const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  const byName = new Map<string, Tool>();
  for (let i = 0; i < manifest.tools.length; i += 1) {
    const tool = manifest.tools[i];
    const name = tool?.name;
    if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid tool name '${String(name)}' in plugin '${pid}' at 'tools[${i}].name' (${path}): ` +
        `tool names must match ^[a-zA-Z_][a-zA-Z0-9_]*$ (start with letter/underscore, then letters/digits/underscores). ` +
        `Example: "tools": [{ "name": "sample_tool", ... }] (not "sample.tool")`,
      );
    }
    if (byName.has(name)) {
      fail(`tools[${i}].name`, `duplicate tool name '${name}'`, `each tools[] entry needs a unique name`);
    }
    byName.set(name, tool);
  }

  // Signed operation restrictions are colocated on each pure MCP Tool. This
  // preserves manifest==wire and prevents a second tool-name keyed action map.
  const operationPolicies = new Map<string, PluginToolOperationPolicy>();
  for (const [toolName, tool] of byName) {
    const policy = tool._meta?.["lvisai/operationPolicy"];
    if (!policy) continue;
    operationPolicies.set(toolName, policy);
    const policyPath = `tools.${toolName}._meta.lvisai/operationPolicy`;
    if (policy.discriminant !== "operation") {
      fail(`${policyPath}.discriminant`, "must equal 'operation'", `"discriminant": "operation"`);
    }
    const operationNames = Object.keys(policy.operations ?? {});
    if (operationNames.length === 0) {
      fail(`${policyPath}.operations`, "must declare at least one operation", `"operations": { "list": { "kind": "read", "minimumRisk": "read" } }`);
    }
    const inputSchema = tool.inputSchema as { required?: unknown; properties?: Record<string, unknown> };
    if (!Array.isArray(inputSchema.required) || !inputSchema.required.includes("operation")) {
      fail(`tools.${toolName}.inputSchema.required`, "must require the top-level operation discriminant", `"required": ["operation"]`);
    }
    const operationSchema = inputSchema.properties?.operation as { type?: unknown; const?: unknown; enum?: unknown } | undefined;
    if (!operationSchema || operationSchema.type !== "string") {
      fail(`tools.${toolName}.inputSchema.properties.operation`, "must be a top-level string schema", `"operation": { "type": "string", "enum": [${operationNames.map((name) => JSON.stringify(name)).join(", ")}] }`);
    }
    const governedOperationSchema = operationSchema as { type: "string"; const?: unknown; enum?: unknown };
    const schemaOperations = Array.isArray(governedOperationSchema.enum)
      ? governedOperationSchema.enum.filter((value): value is string => typeof value === "string")
      : typeof governedOperationSchema.const === "string"
        ? [governedOperationSchema.const]
        : [];
    if (
      schemaOperations.length !== operationNames.length ||
      [...schemaOperations].sort().some((name, index) => name !== [...operationNames].sort()[index])
    ) {
      fail(`tools.${toolName}.inputSchema.properties.operation`, "enum/const must exactly match lvisai/operationPolicy operations", `use exactly ${JSON.stringify(operationNames.sort())}`);
    }
    const visibility = toolVisibility(tool);
    for (const [operation, rule] of Object.entries(policy.operations)) {
      if (rule.appVisible === true && !visibility.includes("app")) {
        fail(`${policyPath}.operations.${operation}.appVisible`, "cannot expand a Tool that is not app-visible", `set tools[]. _meta.ui.visibility to include "app" or remove appVisible`);
      }
    }
    for (const [operation, rule] of Object.entries(policy.operations)) {
      if (!rule.requiresRead) continue;
      const readTool = byName.get(rule.requiresRead.tool);
      const readPolicy = operationPolicies.get(rule.requiresRead.tool) ??
        readTool?._meta?.["lvisai/operationPolicy"];
      if (!readTool || !readPolicy) {
        fail(`${policyPath}.operations.${operation}.requiresRead.tool`, "must reference a declared Tool with lvisai/operationPolicy", `reference a governed tool in tools[]`);
      }
      for (const readOperation of rule.requiresRead.operations) {
        if (readPolicy!.operations[readOperation]?.kind !== "read") {
          fail(`${policyPath}.operations.${operation}.requiresRead.operations`, `'${readOperation}' must reference a read operation`, `choose a kind='read' operation from '${rule.requiresRead.tool}'`);
        }
      }
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

  // #885 v6 — auth trio visibility (u2-host-consumers §1.2). Enforces that each
  // auth-lifecycle tool is app-only-visibility — never model-visible — with ONE
  // intra-object array read per auth ref. This single rule consolidates the pre-v6
  // #1554 leak guard (auth must never be model-callable) and the pre-v6
  // auth-must-be-app-visible check (a dual method is now ONE object with visibility
  // ["model","app"], so the old overlap shape no longer exists). Each ref must name
  // a declared tool whose visibility is EXACTLY ["app"]: `exactlyApp` folds app ∈
  // vis (UI-invokable) AND model ∉ vis (#1554: never model-callable). A dual
  // ["model","app"] auth tool is REJECTED — that IS the load-bearing #1554
  // invariant ("a 'model' tool NEVER reaches the app-only dispatch path"), now
  // enforced at declaration time. `toolVisibility` is a pure reader
  // (normalize already materialized any omitted visibility to dual UPSTREAM), so
  // an auth tool that forgot to declare visibility arrives here as explicit dual
  // → fails `exactlyApp` → rejected (fail-closed; a silently-defaulted auth tool
  // must never become model-callable). See architecture.md §9.4a.
  if (manifest.auth) {
    for (const key of ["statusTool", "loginTool", "logoutTool"] as const) {
      const ref = manifest.auth[key];
      if (ref === undefined) continue; // logoutTool is optional
      if (typeof ref !== "string") {
        fail(
          `auth.${key}`,
          "must be a string",
          `"auth": { "statusTool": "ms_status", "loginTool": "ms_login" }`,
        );
      }
      const tool = byName.get(ref);
      if (!tool) {
        fail(
          `auth.${key}`,
          `references tool '${ref}' which is not declared in tools[]`,
          `add a tools[] entry named '${ref}' with "_meta": { "ui": { "visibility": ["app"] } }`,
        );
      }
      // `fail()` returns never; re-assert the binding — narrowing through the
      // local `fail` arrow is lossy in this file (see the hostSecrets re-assert).
      const authTool: Tool = tool as Tool;
      const vis = toolVisibility(authTool);
      const exactlyApp = vis.length === 1 && vis[0] === "app";
      if (!exactlyApp) {
        fail(
          `auth.${key}`,
          `tool '${ref}' must have visibility exactly ["app"] (host-managed auth is UI-only, never model-callable) — got ${JSON.stringify(vis)}`,
          `set "_meta": { "ui": { "visibility": ["app"] } } on the '${ref}' tool`,
        );
      }
    }

    // architecture.md §9.4a: when `auth` is declared, the renderer's
    // `usePluginAuthStatuses` hook subscribes to `${manifest.id}.auth.changed`
    // (literal id, NO `_`↔`-` normalization). R3 (0.5.2) — the host now
    // AUTO-DERIVES that exact event name and registers the renderer bridge
    // whenever `auth` is present (`collectPluginEventTypes` in
    // boot/steps/ipc-bridge.ts), so the author no longer has to re-list the
    // fixed derived string in emittedEvents[]. The old soft-warn that nagged
    // for a missing `${id}.auth.changed` declaration is therefore removed —
    // even an author who declares the WRONG (underscore-mirrored) form still
    // gets the correct dash-form bridge from the host, eliminating the #131
    // regression class entirely.

    // NOTE (#885 v6): the old #1554 `auth ∉ tools[]` hard-fail is folded into
    // the `exactlyApp` visibility check above — an auth tool declared with
    // model-visibility (the pure-form analog of "appears in tools[]") is
    // rejected by `exactlyApp` (`model ∉ vis` required). No separate leak guard.
  }

  // #885 v6 — keywords[].skillId must name a MODEL-VISIBLE tool (a keyword
  // preloads that exact Tool into the model's turn scope). Replaces the old
  // `parsed.tools.includes(sk)`
  // string membership with a normalized-Tool[] lookup + visibility read. The
  // legacy `toolSchemas` key ⊆ all-declared-tools check is DELETED — structurally
  // impossible now that every tool IS its own object (no separate schema map).
  const kw = Array.isArray(parsed.keywords) ? parsed.keywords : [];
  for (let i = 0; i < kw.length; i += 1) {
    const sk = kw[i]?.skillId;
    const tool = typeof sk === "string" ? byName.get(sk) : undefined;
    if (!tool || !isModelVisible(tool)) {
      fail(
        `keywords[${i}].skillId`,
        `"${String(sk)}" must name a model-visible tool for keyword preload`,
        `add a tools[] entry '${String(sk)}' whose visibility includes "model", or fix the skillId`,
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
        if (!isAllowedHostSecretKey(keyStr)) {
          fail(
            `hostSecrets.read[${i}]`,
            `value '${keyStr}' does not match the allowed host-secret pattern (manifest_schema). Accepted forms are \`llm.apiKey.<vendor>\` and \`llm.marketplaceProvider.<presetId>.apiKey\``,
            `"hostSecrets": { "read": ["llm.apiKey.openai", "llm.marketplaceProvider.future-router.apiKey"] }`,
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

  // notificationEvents[i].event must resolve to an event the plugin actually
  // knows about: one it SUBSCRIBES to (eventSubscriptions → received via
  // hostApi.onEvent) OR one it EMITS itself (emittedEvents → the plugin is the
  // source, so it needs no subscription). A self-emitted notification event is
  // legitimate and must NOT warn — restricting eventSubscriptions to the bare
  // host broadcast is a deliberate hardening, so requiring a self-emitted event
  // to also be subscribed would force a contract violation. Soft-warn only when
  // the event is in NEITHER set (a dangling reference the plugin can't service).
  const subs = Array.isArray(parsed.eventSubscriptions) ? parsed.eventSubscriptions : [];
  const knownTypes = new Set([
    ...subs.map((s) => (typeof s === "string" ? s : (s as { type: string }).type)),
    ...getDeclaredEmittedEvents(parsed as PluginManifest),
  ]);
  const notifEvents = Array.isArray(parsed.notificationEvents) ? parsed.notificationEvents : [];
  for (let i = 0; i < notifEvents.length; i += 1) {
    const e = notifEvents[i]?.event;
    if (typeof e === "string" && !knownTypes.has(e)) {
      log.warn(
        `Plugin manifest '${pid}': notificationEvents[${i}].event '${e}' not declared in eventSubscriptions or emittedEvents — OS notification will still fire, but the plugin neither subscribes to nor emits this event, so it cannot service it via hostApi.onEvent`,
      );
    }
  }

  return manifest;
}
