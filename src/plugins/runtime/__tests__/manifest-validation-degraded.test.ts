/**
 * Backlog #3 — degraded-validator warn log surface.
 *
 * When AJV schema validation is unavailable (validator === null),
 * parsePluginJson must emit a warn log with event: "plugin_validator_degraded"
 * and the plugin id so operators can detect degraded-mode loads in production.
 *
 * In test environments, createLogger() delegates to console.warn, so we spy on
 * console.warn to assert the structured log fields.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePluginJson } from "../manifest-validation.js";

describe("parsePluginJson — degraded-validator warn log", () => {
  let testDir: string;
  let manifestPath: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-degraded-test-"));
    manifestPath = join(testDir, "plugin.json");
    await mkdir(testDir, { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "com.test.degraded",
        name: "Degraded Test",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: ["degraded_ping"],
        description: "Degraded validator test plugin",
        publisher: "Test",
      }),
      "utf-8",
    );
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await rm(testDir, { recursive: true, force: true });
  });

  it("emits warn with event:plugin_validator_degraded when validator is null", async () => {
    await parsePluginJson(manifestPath, null);

    // createLogger() in test mode calls console.warn(prefix + msg, obj, ...)
    // when invoked as log.warn(obj, msg). Find the call that carries the
    // plugin_validator_degraded event field.
    const calls = warnSpy.mock.calls as unknown[][];
    const degradedCall = calls.find((args) =>
      args.some(
        (a) =>
          typeof a === "object" &&
          a !== null &&
          (a as Record<string, unknown>).event === "plugin_validator_degraded",
      ),
    );
    expect(degradedCall).toBeDefined();

    // The structured meta object must include the plugin id.
    const meta = degradedCall!.find(
      (a) =>
        typeof a === "object" &&
        a !== null &&
        (a as Record<string, unknown>).event === "plugin_validator_degraded",
    ) as Record<string, unknown>;
    expect(meta.pluginId).toBe("com.test.degraded");
  });

  it("still returns a valid manifest under degraded mode", async () => {
    const manifest = await parsePluginJson(manifestPath, null);
    expect(manifest.id).toBe("com.test.degraded");
    expect(manifest.version).toBe("1.0.0");
  });

  it("validates toolSchemas category under degraded mode", async () => {
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "com.test.degraded",
        name: "Degraded Test",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: ["degraded_ping"],
        description: "Degraded validator test plugin",
        publisher: "Test",
        toolSchemas: {
          degraded_ping: {
            description: "Degraded ping test tool",
            category: "read",
            inputSchema: { type: "object", properties: {} },
          },
        },
      }),
      "utf-8",
    );

    const manifest = await parsePluginJson(manifestPath, null);

    expect(manifest.toolSchemas?.degraded_ping?.category).toBe("read");
  });

  it("rejects invalid toolSchemas category under degraded mode", async () => {
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "com.test.degraded",
        name: "Degraded Test",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: ["degraded_ping"],
        description: "Degraded validator test plugin",
        publisher: "Test",
        toolSchemas: {
          degraded_ping: {
            description: "Degraded ping test tool",
            category: "side-effect-free",
            inputSchema: { type: "object", properties: {} },
          },
        },
      }),
      "utf-8",
    );

    await expect(parsePluginJson(manifestPath, null)).rejects.toThrow(
      /toolSchemas\['degraded_ping'\]\.category/,
    );
  });

  it("rejects host-only meta category under degraded mode", async () => {
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "com.test.degraded",
        name: "Degraded Test",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: ["degraded_ping"],
        description: "Degraded validator test plugin",
        publisher: "Test",
        toolSchemas: {
          degraded_ping: {
            description: "Degraded ping test tool",
            category: "meta",
            inputSchema: { type: "object", properties: {} },
          },
        },
      }),
      "utf-8",
    );

    await expect(parsePluginJson(manifestPath, null)).rejects.toThrow(
      /toolSchemas\['degraded_ping'\]\.category/,
    );
  });
});
