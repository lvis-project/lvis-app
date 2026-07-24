/**
 * Manifest validation — `auth` cross-field check.
 *
 * Verifies the contract documented in architecture.md §9.4a "Plugin-Owned
 * OAuth — Host UI Surface": when a manifest declares `auth`, the three
 * referenced Tool objects must be app-only so the same gate runs at load time.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi,
} from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as AjvModule from "ajv";
import * as AddFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { parsePluginJson } from "../runtime/manifest-validation.js";
import { pureTool } from "./test-helpers.js";

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
  // Host-owned manifest schema SOT (ph2).
  const schemaPath = fileURLToPath(
    new URL("../../../schemas/plugin-manifest.schema.json", import.meta.url),
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
  const addFormatsFn = (AddAny.default ?? AddFormatsModule) as (a: unknown,
  ) => void;
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
      tools: [
        pureTool("test_status", ["app"]),
        pureTool("test_login", ["app"]),
        pureTool("test_signout", ["app"]),
      ],
      ...extra,
    };
    merged.tools = Array.isArray(merged.tools)
      ? merged.tools.map((tool) => typeof tool === "string" ? pureTool(tool, ["model"])
      : tool,
        )
      : [];
    await mkdir(testDir, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(merged, null, 2), "utf-8");
  }

  it("accepts a manifest whose auth Tools are app-only", async () => {
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
      tools: [
        pureTool("test_login", ["app"]),
        pureTool("test_signout", ["app"]),
      ],
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
        logoutTool: "test_signout",
      },
    });
    const validator = TEST_VALIDATOR;
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /auth\.statusTool.*not declared in tools\[\]/,
    );
  });

  it("#885 v6 — rejects auth.loginTool that resolves to no declared tool", async () => {
    await writeManifest({
      tools: [
        pureTool("test_status", ["app"]),
        pureTool("test_signout", ["app"]),
      ],
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
      tools: [
        pureTool("test_status", ["app"]),
        pureTool("test_login", ["app"]),
      ],
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

  it("R3 — does NOT warn when emittedEvents omits ${id}.auth.changed (host auto-derives the bridge)", async () => {
    // architecture.md §9.4a: the renderer's `usePluginAuthStatuses` subscribes
    // to `${manifest.id}.auth.changed` literally. R3 — the host now derives +
    // bridges that exact name from `manifest.auth` (see collectPluginEventTypes
    // in boot/steps/ipc-bridge.ts), so an omitted declaration is no longer a
    // problem and the validator must not nag about it.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeManifest({
        auth: {
          statusTool: "test_status",
          loginTool: "test_login",
          logoutTool: "test_signout",
        },
        // emittedEvents intentionally omitted — the burden-reducing case R3
        // targets: the host derives `test-plugin.auth.changed` regardless.
      });
      const validator = TEST_VALIDATOR;
      await parsePluginJson(manifestPath, validator);
      const warnMessages = warnSpy.mock.calls.map((c) => c.join(" "));
      expect(warnMessages.some((m) => m.includes("auth.changed"))).toBe(false);
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

  it("R3 — does NOT warn even when emittedEvents declares the WRONG (underscore) form (#131 class eliminated)", async () => {
    // The exact #131 bug class: manifest id has a dash but the author mirrors
    // their underscore tool prefix in the event declaration. Pre-R3 the
    // validator warned the dash form was missing. R3 — the host derives the
    // correct `test-plugin.auth.changed` from `manifest.auth` regardless of
    // what the author declared, so the badge works and the validator is silent.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeManifest({
        auth: {
          statusTool: "test_status",
          loginTool: "test_login",
        },
        emittedEvents: ["test_plugin.auth.changed"], // underscore — wrong form
      });
      const validator = TEST_VALIDATOR;
      await parsePluginJson(manifestPath, validator);
      const warnMessages = warnSpy.mock.calls.map((c) => c.join(" "));
      expect(warnMessages.some((m) => m.includes("emittedEvents[] is missing")),
      ).toBe(false);
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

  // Tool names do not grant authority. The auth slot is constrained by
  // app-only visibility and the normal Host permission path.
  it("does not currently reject destructive-looking tool names in auth (host posture is plugin-author responsibility per §2.2)", async () => {
    await writeManifest({
      tools: [
        pureTool("test_status", ["app"]),
        pureTool("test_email_delete", ["app"]),
      ],
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
  // capability. Auth Tools must be app-only and never model-visible.
  it("rejects a model-visible auth Tool", async () => {
    await writeManifest({
      tools: [
        pureTool("test_status", ["app"]),
        pureTool("test_login", ["model", "app"]),
        pureTool("test_signout", ["app"]),
      ],
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

  it("does not warn when auth Tools are app-only", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeManifest({
        tools: [
          pureTool("test_other", ["model"]),
          pureTool("test_status", ["app"]),
          pureTool("test_login", ["app"]),
          pureTool("test_signout", ["app"]),
        ],
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
      expect(warnMessages.some((m) => m.includes("must not be LLM-callable")),
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

});
