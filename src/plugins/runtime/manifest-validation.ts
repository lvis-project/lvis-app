/**
 * Manifest validation — SDK schema SOT + host cross-field MUST/SHOULD checks.
 *
 * Exported for unit testing and reuse by the PluginRuntime class.
 */

import { readFile } from "node:fs/promises";
import type { ValidateFunction } from "ajv";
import type {
  PluginManifest,
  InstallPolicy,
  NormalizedManifest,
  Tool,
} from "../types.js";
import { normalizeManifest } from "../types.js";
import { toolVisibility, isModelVisible } from "./tool-visibility.js";
import { createLogger } from "../../lib/logger.js";
import { normalizeAllowedHosts } from "../../main/host-allow-list.js";
import {
  marketplaceProviderPresetIdFromSecretKey,
} from "../../shared/marketplace-package-assets.js";

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
 * `hostSecrets.read[]` entries MUST match one of these host-owned LLM secret
 * key shapes. Mirrors the SDK JSON-schema constraint so a plugin cannot
 * install a wider allowlist via a stale SDK build.
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

function schemaAcceptsNetworkAccessAllowPrivateNetworks(validator: ValidateFunction): boolean {
  const ok = validator({
    id: "private-network-plugin",
    name: "Private Network Plugin",
    version: "1.0.0",
    description: "Private network fixture.",
    publisher: "LVIS",
    entry: "dist/index.js",
    tools: [],
    networkAccess: {
      allowedDomains: ["intranet.example.com"],
      allowPrivateNetworks: true,
      reasoning: "Host-mediated intranet access.",
    },
  });
  return ok === true;
}

function schemaAcceptsMarketplaceProviderHostSecret(validator: ValidateFunction): boolean {
  const ok = validator({
    id: "marketplace-provider-secret",
    name: "Marketplace Provider Secret Plugin",
    version: "1.0.0",
    description: "Marketplace provider secret fixture.",
    publisher: "LVIS",
    entry: "dist/index.js",
    tools: [],
    hostSecrets: {
      read: ["llm.marketplaceProvider.future-router.apiKey"],
    },
  });
  return ok === true;
}

/**
 * #885 v6 — POSITIVE probe: the SDK schema natively ACCEPTS a pure MCP `Tool[]`
 * object carrying explicit `_meta.ui.visibility`. Without a v6 SDK the `oneOf`
 * pure arm is absent and every migrated (or normalized-legacy) manifest would
 * fail load, so this is gated the same way as the other native-field probes.
 */
function schemaAcceptsPureToolObject(validator: ValidateFunction): boolean {
  const ok = validator({
    id: "pure-tool-plugin",
    name: "Pure Tool Plugin",
    version: "1.0.0",
    description: "Pure MCP Tool object fixture.",
    publisher: "LVIS",
    entry: "dist/index.js",
    tools: [
      {
        name: "pure_ping",
        description: "Pure ping tool fixture.",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["model"] } },
      },
    ],
  });
  return ok === true;
}

/**
 * #885 v6 — NEGATIVE-strictness guard (opposite polarity to the accept-probes):
 * the SDK schema must REJECT a pure tool that carries a v6-removed field
 * (`writesToOwnSandbox`/`category`/`workerId`/per-tool `version`). A too-permissive
 * schema would let an untrusted self-claim ride the wire even though the host no
 * longer reads it — the removal must be enforced at the shape boundary, not just
 * dropped by `normalizeManifest`.
 */
function schemaRejectsPureToolWithRemovedField(validator: ValidateFunction): boolean {
  const rejected = validator({
    id: "removed-field-plugin",
    name: "Removed Field Plugin",
    version: "1.0.0",
    description: "Pure tool carrying a removed field fixture.",
    publisher: "LVIS",
    entry: "dist/index.js",
    tools: [
      {
        name: "leaky_tool",
        description: "Declares a removed field.",
        inputSchema: { type: "object", properties: {} },
        writesToOwnSandbox: true,
        _meta: { ui: { visibility: ["model"] } },
      },
    ],
  });
  return rejected === false;
}

/**
 * #885 v6 — NEGATIVE-strictness guard: the SDK schema must REJECT an explicit
 * empty `_meta.ui.visibility: []` (a tool reachable by neither surface). This is
 * the `minItems: 1` gate that guarantees `[]` never reaches `normalizeManifest`
 * or `toolVisibility` — there is exactly ONE resolution for missing visibility
 * (`[]` → REJECT), never a silent widen to governed-dual (SoT §2.2, u2 §1.4.2).
 */
function schemaRejectsEmptyVisibility(validator: ValidateFunction): boolean {
  const rejected = validator({
    id: "empty-visibility-plugin",
    name: "Empty Visibility Plugin",
    version: "1.0.0",
    description: "Pure tool with empty visibility fixture.",
    publisher: "LVIS",
    entry: "dist/index.js",
    tools: [
      {
        name: "unreachable_tool",
        description: "Reachable by neither surface.",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: [] } },
      },
    ],
  });
  return rejected === false;
}

/**
 * #885 v6.1.0 — NEGATIVE-strictness guard: the SDK schema must REJECT a `ui[]`
 * extension declaring the removed `kind:"action"` surface (an icon that
 * dispatched a declared tool with no panel — see `PluginUiExtension` in
 * `../types.ts`). App-invokable behavior is now expressed by a tool's
 * `_meta.ui.visibility`, so a schema that still accepts this shape would let
 * a plugin ship dead-on-arrival config the host can no longer route.
 */
function schemaRejectsUiActionKind(validator: ValidateFunction): boolean {
  const rejected = validator({
    id: "ui-action-kind-plugin",
    name: "UI Action Kind Plugin",
    version: "1.0.0",
    description: "Removed ui[].kind=\"action\" fixture.",
    publisher: "LVIS",
    entry: "dist/index.js",
    tools: [],
    ui: [
      { id: "a", slot: "sidebar", kind: "action", title: "x", tool: "t" },
    ],
  });
  return rejected === false;
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
 * Lazy-load + compile the SDK plugin manifest schema into an AJV validator.
 * The SDK schema is the manifest shape SOT; if it cannot be resolved or
 * compiled, plugin loading must fail closed. Do not mutate the SDK schema in
 * the host. As of @lvis/plugin-sdk v6.1.0, the helper must natively accept
 * every host-required manifest field (`networkAccess.allowPrivateNetworks`,
 * marketplace-provider secret grants, AND the pure MCP `Tool[]` object with
 * `_meta.ui.visibility`), and must be strict enough to REJECT a pure tool
 * carrying a v6-removed field, an empty `visibility: []`, or a `ui[]`
 * extension declaring the removed `kind:"action"` surface (the
 * negative-strictness guards below).
 */
export async function buildManifestValidator(): Promise<ValidateFunction> {
  type SdkModule = { compileManifestValidator?: () => ValidateFunction };
  let sdk: SdkModule;
  try {
    sdk = (await import("@lvis/plugin-sdk")) as unknown as SdkModule;
  } catch (err) {
    throw new Error(`SDK plugin manifest validator unavailable: ${formatUnknownErrorMessage(err)}`);
  }

  if (typeof sdk.compileManifestValidator !== "function") {
    throw new Error(
      "SDK plugin manifest validator unavailable: @lvis/plugin-sdk does not export compileManifestValidator(); update @lvis/plugin-sdk to v6.0.0 or newer.",
    );
  }

  let validator: ValidateFunction;
  try {
    validator = sdk.compileManifestValidator();
  } catch (err) {
    throw new Error(
      `SDK plugin manifest validator failed to compile: ${formatUnknownErrorMessage(err)}`,
    );
  }
  const missingNativeFields = [
    schemaAcceptsNetworkAccessAllowPrivateNetworks(validator)
      ? ""
      : "networkAccess.allowPrivateNetworks",
    schemaAcceptsMarketplaceProviderHostSecret(validator)
      ? ""
      : "llm.marketplaceProvider.<presetId>.apiKey",
    schemaAcceptsPureToolObject(validator) ? "" : "pure MCP Tool[] object (_meta.ui.visibility)",
  ].filter(Boolean);
  if (missingNativeFields.length > 0) {
    throw new Error(
      `SDK plugin manifest validator is missing native support for ${missingNativeFields.join(", ")}; update @lvis/plugin-sdk to v6.1.0 or newer.`,
    );
  }
  // Separate negative-strictness assertions (opposite polarity to the accept
  // gate above — each must REJECT). A too-permissive schema would let a removed
  // self-claim field, an unreachable empty-visibility tool, or a removed ui[]
  // surface through the shape boundary; fail closed loudly so the contract
  // can't silently regress.
  const strictnessGaps = [
    schemaRejectsPureToolWithRemovedField(validator)
      ? ""
      : "a pure tool carrying a removed field (writesToOwnSandbox/category/workerId/version) must be rejected",
    schemaRejectsEmptyVisibility(validator)
      ? ""
      : "an empty _meta.ui.visibility: [] must be rejected (minItems:1)",
    schemaRejectsUiActionKind(validator)
      ? ""
      : "a ui extension declaring the removed kind:\"action\" must be rejected",
  ].filter(Boolean);
  if (strictnessGaps.length > 0) {
    throw new Error(
      `SDK plugin manifest validator is too permissive: ${strictnessGaps.join("; ")}; update @lvis/plugin-sdk to v6.1.0 or newer.`,
    );
  }
  return validator;
}

/**
 * Parse and fully validate a plugin.json manifest file.
 *
 * Runs SDK AJV schema validation, then compiles the (legacy or pure) manifest
 * to the pure v6 form via `normalizeManifest` (the SINGLE legacy-shape reader,
 * SoT §3.1), then runs host cross-field MUST checks against the normalized
 * `Tool[]`. Returns the {@link NormalizedManifest} every host consumer reads.
 * Throws with a descriptive message on any failure.
 */
export async function parsePluginJson(
  path: string,
  validator: ValidateFunction,
): Promise<NormalizedManifest> {
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
    // #885 v6 — `tools` is a `oneOf` (legacy `string[]` | pure `Tool[]`). When the
    // author WROTE the pure form (`tools[0]` is an object), the legacy arm's
    // "/tools/N must be string" + the "must match exactly one schema in oneOf"
    // errors are pure NOISE that bury the real pure-arm violation. Filter them so
    // the user sees only the actionable pure-arm error(s).
    // `validator` is an AJV type-guard, so inside this `!validator(parsed)` block
    // TS narrows `parsed` to `never` — read `tools` back through a cast.
    const toolsRaw = (parsed as { tools?: unknown }).tools;
    const isPureShape = Array.isArray(toolsRaw) && typeof toolsRaw[0] === "object";
    const filteredAjvErrors = isPureShape
      ? rawAjvErrors.filter(
          (e) =>
            !(e.keyword === "type" && /^\/tools\/\d+$/.test(e.instancePath) && e.message === "must be string") &&
            !(e.keyword === "oneOf" && e.instancePath === "/tools"),
        )
      : rawAjvErrors;
    // Never let the filter swallow the entire message (defensive — a pure-shape
    // failure always retains ≥1 pure-arm error, but fall back if it somehow does not).
    const ajvErrors = filteredAjvErrors.length > 0 ? filteredAjvErrors : rawAjvErrors;
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
  // installed SDK validator may still accept the legacy shape during the migration
  // window, so this host-side guard is the loud, author-facing fail-closed point.
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

  // #885 v6 — materialize each tool's `_meta.ui.visibility` into the pure
  // `NormalizedManifest` every host check below reads (the standard
  // `["model","app"]` default is filled in here, an explicit `[]` is rejected).
  // From here on all tool checks read the normalized `manifest.tools: Tool[]` —
  // never `parsed.tools`.
  const manifest = normalizeManifest(parsed);

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

  // #885 v6 — keywords[].skillId must name a MODEL-VISIBLE tool (a skill keyword
  // maps to an LLM-invocable tool). Replaces the old `parsed.tools.includes(sk)`
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
        `"${String(sk)}" must name a model-visible tool (a skill keyword maps to an LLM-invocable tool)`,
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
