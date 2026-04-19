/**
 * PR #182 — `allowManagedUnsigned` branch in the uiCallable destructive
 * guard (runtime.ts §B-3).
 *
 * The runtime computes:
 *   managedAndSigned =
 *     parsed.deployment === "managed" &&
 *     (signatureVerifier !== undefined || allowManagedUnsigned)
 *
 * Only when `managedAndSigned` is true may a uiCallable entry use a
 * mutating verb (e.g. `_delete`). This test suite pins every branch of
 * that expression:
 *
 *   1. managed + no verifier + allowManagedUnsigned=false/undefined
 *      → destructive uiCallable is REJECTED (default safe state).
 *   2. managed + no verifier + allowManagedUnsigned=true
 *      → destructive uiCallable is ACCEPTED (dev escape hatch for
 *      workstations that run with LVIS_DEV_SKIP_SIG).
 *   3. deployment !== "managed" + allowManagedUnsigned=true
 *      → still REJECTED (flag does not upgrade a user plugin).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginRuntime } from "../runtime.js";

describe("PluginRuntime — uiCallable allowManagedUnsigned gate", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;
  let auditEntries: Array<{ level: string; message: string; data?: unknown }>;

  beforeEach(async () => {
    testDir = join(
      homedir(),
      ".lvis",
      "test-tmp",
      `lvis-ui-unsigned-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
    auditEntries = [];
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePlugin(id: string, manifestOverrides: Record<string, unknown> = {}): Promise<void> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return { handlers: { "${id}_get": async () => "ok", "${id}_delete": async () => "ok" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    const manifest = {
      id,
      name: id,
      version: "1.0.0",
      entry: "entry.mjs",
      tools: [`${id}_get`, `${id}_delete`],
      ...manifestOverrides,
    };
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify(manifest), "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id, manifestPath: join(pluginDir, "plugin.json") }],
      }),
      "utf-8",
    );
  }

  function makeRuntime(opts: { allowManagedUnsigned?: boolean } = {}): PluginRuntime {
    return new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      allowManagedUnsigned: opts.allowManagedUnsigned,
      auditLog: (level, message, data) => {
        auditEntries.push({ level, message, data });
      },
    });
  }

  it("REJECTS a managed plugin's destructive uiCallable when allowManagedUnsigned is unset and no verifier", async () => {
    await writePlugin("p_managed_default", {
      deployment: "managed",
      uiCallable: ["p_managed_default_delete"],
    });

    const errors: string[] = [];
    const origError = console.error;
    console.error = (msg: unknown) => { errors.push(String(msg)); };
    try {
      // allowManagedUnsigned omitted ⇒ defaults to false; no signatureVerifier wired.
      const runtime = makeRuntime();
      await runtime.load();

      expect(runtime.listPluginIds()).not.toContain("p_managed_default");
      expect(errors.some((e) => /non-read-verb|uiCallable/.test(e))).toBe(true);
      expect(
        auditEntries.some(
          (e) =>
            e.level === "error" &&
            e.message === "plugin_uiCallable_destructive_rejected",
        ),
      ).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  it("ACCEPTS a managed plugin's destructive uiCallable when allowManagedUnsigned=true (no verifier)", async () => {
    await writePlugin("p_managed_allow", {
      deployment: "managed",
      uiCallable: ["p_managed_allow_delete"],
    });

    const runtime = makeRuntime({ allowManagedUnsigned: true });
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p_managed_allow");
    expect(
      auditEntries.some(
        (e) => e.message === "plugin_uiCallable_destructive_rejected",
      ),
    ).toBe(false);
  });

  it("REJECTS a user-deployed plugin's destructive uiCallable even when allowManagedUnsigned=true", async () => {
    // allowManagedUnsigned is a *managed*-only escape hatch. The gate
    // requires deployment === "managed" regardless of the flag, so a
    // user plugin must never be promoted by flipping it on.
    await writePlugin("p_user_allow", {
      deployment: "user",
      uiCallable: ["p_user_allow_delete"],
    });

    const errors: string[] = [];
    const origError = console.error;
    console.error = (msg: unknown) => { errors.push(String(msg)); };
    try {
      const runtime = makeRuntime({ allowManagedUnsigned: true });
      await runtime.load();

      expect(runtime.listPluginIds()).not.toContain("p_user_allow");
      expect(errors.some((e) => /non-read-verb|uiCallable/.test(e))).toBe(true);
      expect(
        auditEntries.some(
          (e) =>
            e.level === "error" &&
            e.message === "plugin_uiCallable_destructive_rejected" &&
            (e.data as { deployment?: string } | undefined)?.deployment === "user",
        ),
      ).toBe(true);
    } finally {
      console.error = origError;
    }
  });
});
