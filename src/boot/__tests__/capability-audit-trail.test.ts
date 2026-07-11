/**
 * M4 — Capability-gate violations produce audit trail entries.
 *
 * Two paths are audited:
 *   1. plugin calls emitEvent() for a namespace requiring a capability it
 *      doesn't declare → boot.ts emit closure writes "plugin_emit_capability_denied".
 *   2. plugin declares eventSubscriptions to a private namespace
 *      (memory.private.*, settings.apiKey.*, audit.*, dlp.*) → plugins.ts
 *      registerManifestEventSubscriptions writes "plugin_subscription_private_denied".
 *
 * Legitimate emissions do NOT audit-log.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRuntime } from "../../plugins/runtime.js";
import { canEmitEvent, requiredCapabilityForEmit } from "../../plugins/capabilities.js";
import { getDeclaredEmittedEvents } from "../../plugins/runtime/manifest-validation.js";
import { registerManifestEventSubscriptions } from "../plugins.js";
import type { AuditEntry } from "../../audit/audit-logger.js";
import { mkdtempSync } from "node:fs";

function collectingAudit() {
  const entries: AuditEntry[] = [];
  return {
    entries,
    logger: { log: (e: AuditEntry) => entries.push(e) },
  };
}

/**
 * Mirror the createHostApi emit closure that gates + audit-logs emit denials.
 * Duplicated here because createHostApi builds it inline. Authorization for a
 * gated namespace is inferred from the manifest's declared emittedEvents; the
 * internal effect label (`required`) is retained for the audit trail.
 */
function makeGuardedEmit(
  runtime: PluginRuntime,
  pluginId: string,
  auditLogger: { log: (e: AuditEntry) => void },
) {
  const emitted: Array<{ type: string; data: unknown }> = [];
  const emit = (type: string, data?: unknown): void => {
    const manifest = runtime.getPluginManifest(pluginId);
    const declaredEmittedEvents = manifest ? getDeclaredEmittedEvents(manifest) : [];
    if (!canEmitEvent(type, declaredEmittedEvents)) {
      const required = requiredCapabilityForEmit(type);
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "plugin",
        type: "error",
        input: `[plugin:${pluginId}] plugin_emit_capability_denied eventType=${type} required=${required} declaredEmittedEvents=${declaredEmittedEvents.join("|")}`,
      });
      return;
    }
    emitted.push({ type, data });
  };
  return { emit, emitted };
}

describe("M4 — capability violation audit trail", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-m4-audit-"));
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePlugin(
    id: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    const toolName = `${id.replace(/-/g, "_")}_ping`;
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return { handlers: { ${toolName}: async () => "pong" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    const manifest = {
      id,
      name: id,
      version: "1.0.0",
      description: "Test fixture.",
      publisher: "Test fixture",
      entry: "entry.mjs",
      tools: [
        {
          name: toolName,
          description: `${toolName} test tool`,
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        },
      ],
      ...extra,
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

  function stubEventCollector() {
    const collected: Array<{ type: string; data: unknown }> = [];
    return {
      engine: {
        collectEvent(type: string, data: unknown) {
          collected.push({ type, data });
        },
      },
      collected,
    };
  }

  it("emitEvent without required capability writes an audit error", async () => {
    await writePlugin("p-no-mail", { emittedEvents: ["custom.ping"] });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { entries, logger } = collectingAudit();
    const { emit, emitted } = makeGuardedEmit(runtime, "p-no-mail", logger);
    emit("email.new", { subject: "hi" });

    expect(emitted).toHaveLength(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("error");
    expect(String(entries[0].input)).toMatch(/plugin_emit_capability_denied/);
    expect(String(entries[0].input)).toMatch(/required=mail-source/);
  });

  it("legitimate emit with the right capability does NOT audit-log", async () => {
    await writePlugin("p-mail", { emittedEvents: ["email.new"] });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { entries, logger } = collectingAudit();
    const { emit, emitted } = makeGuardedEmit(runtime, "p-mail", logger);
    emit("email.new", { subject: "hi" });

    expect(emitted).toHaveLength(1);
    expect(entries).toHaveLength(0);
  });

  it("neutral namespace emit (no capability required) does NOT audit-log", async () => {
    await writePlugin("p-any", { emittedEvents: [] });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { entries, logger } = collectingAudit();
    const { emit, emitted } = makeGuardedEmit(runtime, "p-any", logger);
    emit("custom.something", { x: 1 });

    expect(emitted).toHaveLength(1);
    expect(entries).toHaveLength(0);
  });

  it("private namespace subscription writes an audit error", async () => {
    await writePlugin("p-priv", {
      eventSubscriptions: ["memory.private.leaked"],
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { entries, logger } = collectingAudit();
    const { engine } = stubEventCollector();
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      registerManifestEventSubscriptions(runtime, engine, logger);
    } finally {
      console.warn = origWarn;
    }

    const privEntries = entries.filter((e) =>
      String(e.input).includes("plugin_subscription_private_denied"),
    );
    expect(privEntries).toHaveLength(1);
    expect(String(privEntries[0].input)).toMatch(/memory\.private\.leaked/);
  });

  it("public subscription does NOT audit-log", async () => {
    await writePlugin("p-pub", { eventSubscriptions: ["email.new"] });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { entries, logger } = collectingAudit();
    const { engine } = stubEventCollector();
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      registerManifestEventSubscriptions(runtime, engine, logger);
    } finally {
      console.warn = origWarn;
    }

    expect(entries).toHaveLength(0);
  });
});
