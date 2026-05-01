/**
 * Manifest validation — `auth` cross-field check.
 *
 * Verifies the contract documented in architecture.md §9.4a "Plugin-Owned
 * OAuth — Host UI Surface": when a manifest declares `auth`, the three
 * referenced tool names must all live in `uiCallable[]`. Mirrors the
 * existing `uiCallable ⊂ tools` cross-check pattern in §B-3 of
 * `manifest-validation.ts` so the same gate runs at load time.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifestValidator, parsePluginJson } from "../runtime/manifest-validation.js";

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
    const base = {
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      description: "auth fixture",
      publisher: "tests",
      entry: "dist/hostPlugin.js",
      tools: ["test_status", "test_login", "test_signout"],
      uiCallable: ["test_status", "test_login", "test_signout"],
      ...extra,
    };
    await mkdir(testDir, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(base, null, 2), "utf-8");
  }

  it("accepts manifest with auth tools all in uiCallable", async () => {
    await writeManifest({
      auth: {
        label: "Test Account",
        statusTool: "test_status",
        loginTool: "test_login",
        logoutTool: "test_signout",
      },
    });
    const validator = await buildManifestValidator(import.meta.url);
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
    const validator = await buildManifestValidator(import.meta.url);
    const parsed = await parsePluginJson(manifestPath, validator);
    expect(parsed.auth?.logoutTool).toBeUndefined();
  });

  it("rejects auth.statusTool not in uiCallable[]", async () => {
    await writeManifest({
      uiCallable: ["test_login", "test_signout"], // statusTool missing
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
        logoutTool: "test_signout",
      },
    });
    const validator = await buildManifestValidator(import.meta.url);
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /auth\.statusTool.*not declared in uiCallable/,
    );
  });

  it("rejects auth.loginTool not in uiCallable[]", async () => {
    await writeManifest({
      uiCallable: ["test_status", "test_signout"], // loginTool missing
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
        logoutTool: "test_signout",
      },
    });
    const validator = await buildManifestValidator(import.meta.url);
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /auth\.loginTool.*not declared in uiCallable/,
    );
  });

  it("rejects auth.logoutTool not in uiCallable[] when declared", async () => {
    await writeManifest({
      uiCallable: ["test_status", "test_login"], // logoutTool missing
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
        logoutTool: "test_signout",
      },
    });
    const validator = await buildManifestValidator(import.meta.url);
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /auth\.logoutTool.*not declared in uiCallable/,
    );
  });

  it("AJV rejects auth missing required statusTool", async () => {
    await writeManifest({
      auth: {
        loginTool: "test_login",
        // statusTool missing
      },
    });
    const validator = await buildManifestValidator(import.meta.url);
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(/schema validation/i);
  });

  it("AJV rejects auth with extra properties (additionalProperties: false)", async () => {
    await writeManifest({
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
        nonsenseField: "boom",
      },
    });
    const validator = await buildManifestValidator(import.meta.url);
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(/schema validation/i);
  });

  // Defense-in-depth — security review MED #1.
  // The cross-field validator only enforces `auth.{statusTool,loginTool,
  // logoutTool} ⊂ uiCallable[]`, which means a manifest could route an
  // arbitrary uiCallable name (including a destructive one) through the
  // host-rendered "로그인" button. Today the broader `uiCallable` allow-
  // list itself does not block destructive verbs (per §2.2 — naming is
  // plugin-author responsibility, host has no name-based gate). These
  // tests pin the *current* posture so any future tightening of the
  // host's destructive-name rule is also surfaced through the auth slot.
  it("does not currently reject destructive-looking tool names in auth (host posture is plugin-author responsibility per §2.2)", async () => {
    await writeManifest({
      tools: ["test_status", "test_email_delete"],
      uiCallable: ["test_status", "test_email_delete"],
      auth: {
        statusTool: "test_status",
        loginTool: "test_email_delete",
      },
    });
    const validator = await buildManifestValidator(import.meta.url);
    const parsed = await parsePluginJson(manifestPath, validator);
    expect(parsed.auth?.loginTool).toBe("test_email_delete");
  });
});
