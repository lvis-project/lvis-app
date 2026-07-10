/**
 * Manifest validation — `auth` cross-field check.
 *
 * Verifies the contract documented in architecture.md §9.4a "Plugin-Owned
 * OAuth — Host UI Surface": when a manifest declares `auth`, the three
 * referenced tool names must all live in `uiActions[]` so the same gate
 * runs at load time.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import * as AjvModule from "ajv";
import * as AddFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { parsePluginJson } from "../runtime/manifest-validation.js";

// `buildManifestValidator(hereFileUrl)` resolves `schemas/plugin.schema.json`
// using path arithmetic anchored at `dirname(hereFileUrl)`. That math
// works in production (caller is the runtime module) but proved flaky to
// reproduce reliably from a `__tests__/` invocation across platforms —
// the Linux CI runner's nested `_work/lvis-app/lvis-app/lvis-app` cwd +
// vitest worker `import.meta.url` gave a different `dirname` than the
// macOS dev run, so the validator silently returned `null` and AJV-
// specific assertions became no-ops.
//
// The fix is path-independent: compile AJV inline against `schemas/
// plugin.schema.json` resolved from `process.cwd()`, mirror the same
// AJV options the production builder uses, and pass the compiled
// validator straight to `parsePluginJson` (which accepts a pre-built
// validator). Production code is untouched. Tests still exercise the
// real schema on disk + the real `parsePluginJson` cross-field path.
let TEST_VALIDATOR: ValidateFunction | null = null;
beforeAll(() => {
  const schemaPath = createRequire(import.meta.url).resolve(
    "@lvis/plugin-sdk/schemas/plugin-manifest.schema.json",
  );
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
  const AjvAny = AjvModule as unknown as { default?: unknown };
  const AjvCtor = (AjvAny.default ?? AjvModule) as new (opts?: unknown) => {
    compile: (schema: unknown) => ValidateFunction;
  };
  const ajv = new AjvCtor({
    strict: true,
    strictRequired: false,
    allErrors: true,
    allowUnionTypes: true,
  });
  // Sanity — if a future bundler interop change makes the ESM default
  // resolve weirdly, the cast above could land on the namespace itself
  // and `compile` would not be a function. Fail loudly here instead of
  // letting AJV-specific tests silently pass against a non-functional
  // validator.
  if (typeof ajv.compile !== "function") {
    throw new Error(
      "[manifest-auth.test] Ajv constructor cast did not yield a working ajv instance",
    );
  }
  const AddAny = AddFormatsModule as unknown as { default?: unknown };
  const addFormatsFn = (AddAny.default ?? AddFormatsModule) as (a: unknown) => void;
  if (typeof addFormatsFn !== "function") {
    throw new Error(
      "[manifest-auth.test] addFormats default cast did not yield a callable",
    );
  }
  addFormatsFn(ajv);
  TEST_VALIDATOR = ajv.compile(schema);
});

describe("manifest validation — auth cross-field", () => {
  let testDir: string;
  let manifestPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-auth-manifest-"));
    manifestPath = join(testDir, "plugin.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeManifest(extra: Record<string, unknown>): Promise<void> {
    const merged: Record<string, unknown> = {
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      description: "auth fixture",
      publisher: "tests",
      entry: "dist/hostPlugin.js",
      // Pure v6: auth tools are app-only Tool objects (visibility ["app"]),
      // never model-visible. Tests express the surface as legacy tools[]/uiActions
      // name lists; this helper compiles them into the pure Tool[] the host reads.
      // The leak-rejection test puts an auth name in tools[] → model-visible → the
      // auth-visibility check rejects it.
      tools: [],
      uiActions: { test_status: {}, test_login: {}, test_signout: {} },
      ...extra,
    };
    const names: string[] = Array.isArray(merged.tools)
      ? (merged.tools as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const uiNames =
      merged.uiActions && typeof merged.uiActions === "object"
        ? Object.keys(merged.uiActions as Record<string, unknown>)
        : [];
    const all = [...names, ...uiNames.filter((n) => !names.includes(n))];
    const tools = all.map((name) => ({
      name,
      description: `${name} tool`,
      inputSchema: { type: "object", properties: {} },
      _meta: {
        ui: {
          visibility: [
            ...(names.includes(name) ? ["model"] : []),
            ...(uiNames.includes(name) ? ["app"] : []),
          ],
        },
      },
    }));
    delete merged.uiActions;
    merged.tools = tools;
    await mkdir(testDir, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(merged, null, 2), "utf-8");
  }

  it("accepts manifest with auth tools all in uiActions", async () => {
    await writeManifest({
      auth: {
        label: "Test Account",
        statusTool: "test_status",
        loginTool: "test_login",
        logoutTool: "test_signout",
      },
    });
    const validator = TEST_VALIDATOR;
    const parsed = await parsePluginJson(manifestPath, validator);
    expect(parsed.auth?.statusTool).toBe("test_status");
    expect(parsed.auth?.loginTool).toBe("test_login");
    expect(parsed.auth?.logoutTool).toBe("test_signout");
  });

  it("accepts manifest with auth omitting optional logoutTool", async () => {
    await writeManifest({
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
      },
    });
    const validator = TEST_VALIDATOR;
    const parsed = await parsePluginJson(manifestPath, validator);
    expect(parsed.auth?.logoutTool).toBeUndefined();
  });

  it("#885 v6 — rejects auth.statusTool that resolves to no declared tool", async () => {
    await writeManifest({
      uiActions: { test_login: {}, test_signout: {} }, // statusTool missing
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
        logoutTool: "test_signout",
      },
    });
    const validator = TEST_VALIDATOR;
    // Not in tools[] nor uiActions → after normalize the ref names no tool.
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /auth\.statusTool.*not declared in tools\[\]/,
    );
  });

  it("#885 v6 — rejects auth.loginTool that resolves to no declared tool", async () => {
    await writeManifest({
      uiActions: { test_status: {}, test_signout: {} }, // loginTool missing
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
        logoutTool: "test_signout",
      },
    });
    const validator = TEST_VALIDATOR;
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /auth\.loginTool.*not declared in tools\[\]/,
    );
  });

  it("#885 v6 — rejects auth.logoutTool that resolves to no declared tool when declared", async () => {
    await writeManifest({
      uiActions: { test_status: {}, test_login: {} }, // logoutTool missing
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
        logoutTool: "test_signout",
      },
    });
    const validator = TEST_VALIDATOR;
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /auth\.logoutTool.*not declared in tools\[\]/,
    );
  });

  it("AJV rejects auth missing required statusTool", async () => {
    await writeManifest({
      auth: {
        loginTool: "test_login",
        // statusTool missing — schema says required.
      },
    });
    const validator = TEST_VALIDATOR;
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /schema validation/i,
    );
  });

  it("AJV rejects auth with extra properties (additionalProperties: false)", async () => {
    await writeManifest({
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
        nonsenseField: "boom",
      },
    });
    const validator = TEST_VALIDATOR;
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /schema validation/i,
    );
  });

  it("warns when manifest declares 'auth' but emittedEvents missing ${id}.auth.changed (lvis-plugin-agent-hub#131)", async () => {
    // architecture.md §9.4a: host's `usePluginAuthStatuses` subscribes to
    // `${manifest.id}.auth.changed` literally — without the matching
    // emittedEvents[] entry the host event-bridge skips the renderer
    // forward and the badge stays stuck on the boot snapshot.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeManifest({
        auth: {
          statusTool: "test_status",
          loginTool: "test_login",
          logoutTool: "test_signout",
        },
        // emittedEvents intentionally omitted — replicates the agent-hub
        // 0.4.0 state where the plugin emitted under `agent_hub.*` but the
        // manifest never declared the dash form.
      });
      const validator = TEST_VALIDATOR;
      await parsePluginJson(manifestPath, validator);
      const warnMessages = warnSpy.mock.calls.map((c) => c.join(" "));
      expect(warnMessages.some((m) => m.includes("test-plugin.auth.changed"))).toBe(true);
      expect(warnMessages.some((m) => m.includes("emittedEvents[] is missing"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn when emittedEvents includes the expected ${id}.auth.changed entry", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeManifest({
        auth: {
          statusTool: "test_status",
          loginTool: "test_login",
        },
        emittedEvents: ["test-plugin.auth.changed"],
      });
      const validator = TEST_VALIDATOR;
      await parsePluginJson(manifestPath, validator);
      const warnMessages = warnSpy.mock.calls.map((c) => c.join(" "));
      expect(warnMessages.some((m) => m.includes("auth.changed"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns when emittedEvents declares the WRONG transformed name (the literal #131 regression)", async () => {
    // Pin the exact bug class: manifest id contains a dash but author
    // mirrors their tool prefix (underscore) in the event declaration.
    // Validator must still warn that the dash form is missing.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeManifest({
        auth: {
          statusTool: "test_status",
          loginTool: "test_login",
        },
        // Note the underscore — this would PASS a naive "any auth.changed
        // entry exists" check but still leave the host hook silent because
        // the host subscribes to the literal manifest id (`test-plugin`).
        emittedEvents: ["test_plugin.auth.changed"],
      });
      const validator = TEST_VALIDATOR;
      await parsePluginJson(manifestPath, validator);
      const warnMessages = warnSpy.mock.calls.map((c) => c.join(" "));
      expect(warnMessages.some((m) => m.includes("test-plugin.auth.changed"))).toBe(true);
      expect(warnMessages.some((m) => m.includes("emittedEvents[] is missing"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does NOT warn when manifest does not declare auth (don't pollute non-auth plugins)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeManifest({
        // no `auth` key at all + no emittedEvents — most plugins look
        // like this. The new check must be silent for them.
      });
      const validator = TEST_VALIDATOR;
      await parsePluginJson(manifestPath, validator);
      const warnMessages = warnSpy.mock.calls.map((c) => c.join(" "));
      expect(warnMessages.some((m) => m.includes("auth.changed"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Defense-in-depth — security review MED #1.
  // The cross-field validator only enforces `auth.{statusTool,loginTool,
  // logoutTool} ⊂ uiActions[]`, which means a manifest could route an
  // arbitrary uiActions name (including a destructive one) through the
  // host-rendered "로그인" button. Today the broader `uiActions` allow-
  // list itself does not block destructive verbs (per §2.2 — naming is
  // plugin-author responsibility, host has no name-based gate). These
  // tests pin the *current* posture so any future tightening of the
  // host's destructive-name rule is also surfaced through the auth slot.
  it("does not currently reject destructive-looking tool names in auth (host posture is plugin-author responsibility per §2.2)", async () => {
    await writeManifest({
      // Auth tools stay in uiActions[] only (migrated shape); the point of this
      // test is that a destructive-looking NAME is not name-gated by the host,
      // not the tools[] placement rule.
      tools: [],
      uiActions: { test_status: {}, test_email_delete: {} },
      auth: {
        statusTool: "test_status",
        loginTool: "test_email_delete",
      },
    });
    const validator = TEST_VALIDATOR;
    const parsed = await parsePluginJson(manifestPath, validator);
    expect(parsed.auth?.loginTool).toBe("test_email_delete");
  });

  // architecture.md §9.4a: auth is a host-managed lifecycle, not an LLM
  // capability. Auth tools (statusTool/loginTool/logoutTool) must live in
  // uiActions[] ONLY — never in tools[], which is the LLM-facing surface
  // (projected verbatim to the model). Hard fail: both shipped auth plugins are
  // migrated, so rejecting at load is the sole guard against a regression
  // silently re-exposing auth as an LLM tool (there is no CI gate for it).
  it("REJECTS when an auth tool appears in tools[] (auth must be host-managed, not LLM-callable)", async () => {
    // Override the (migrated) base fixture to re-introduce the leak: an auth
    // tool listed in tools[].
    await writeManifest({
      tools: ["test_login"],
      emittedEvents: ["test-plugin.auth.changed"],
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
        logoutTool: "test_signout",
      },
    });
    const validator = TEST_VALIDATOR;
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /auth tool.*must not appear in tools\[\]|'test_login'/,
    );
  });

  it("does NOT warn when auth tools are only in uiActions[] (migrated state)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeManifest({
        // tools[] holds only non-auth tools; auth tools live in uiActions[].
        tools: ["test_other"],
        uiActions: { test_status: {}, test_login: {}, test_signout: {} },
        emittedEvents: ["test-plugin.auth.changed"],
        auth: {
          statusTool: "test_status",
          loginTool: "test_login",
          logoutTool: "test_signout",
        },
      });
      const validator = TEST_VALIDATOR;
      await parsePluginJson(manifestPath, validator);
      const warnMessages = warnSpy.mock.calls.map((c) => c.join(" "));
      expect(warnMessages.some((m) => m.includes("must not be LLM-callable"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

});
