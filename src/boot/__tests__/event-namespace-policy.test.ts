/**
 * Event subscription namespace allowlist + capability emit gate.
 *
 * Covers:
 *  1. private namespace subscription is rejected (memory.private.*)
 *  2. known public namespace subscription is accepted silently
 *  3. unknown neutral namespace is allowed with a warning (drift signal)
 *  4. cross-capability leak guard: plugin lacking `mail-source` emits
 *     `email.new` → capability check returns required cap, manifest lookup
 *     fails, event is dropped.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRuntime } from "../../plugins/runtime.js";
import {
  canEmitEvent,
  classifySubscription,
  requiredCapabilityForEmit,
  PLUGIN_PRIVATE_NAMESPACES,
  PUBLIC_EVENT_NAMESPACES,
  KNOWN_CAPABILITIES,
} from "../../plugins/capabilities.js";
import { registerManifestEventSubscriptions } from "../plugins.js";
import { mkdtempSync } from "node:fs";

describe("capabilities module namespace policy", () => {
  it("classifies private namespaces as 'private'", () => {
    expect(classifySubscription("memory.private.user_doc")).toBe("private");
    expect(classifySubscription("settings.apiKey.openai")).toBe("private");
    expect(classifySubscription("audit.call")).toBe("private");
    expect(classifySubscription("dlp.redact")).toBe("private");
  });

  it("classifies known public namespaces as 'public'", () => {
    expect(classifySubscription("meeting.started")).toBe("public");
    expect(classifySubscription("meeting.transcript.updated")).toBe("public");
    expect(classifySubscription("email.new")).toBe("public");
    expect(classifySubscription("calendar.event")).toBe("public");
    expect(classifySubscription("index.scan_done")).toBe("public");
    expect(classifySubscription("host.theme.changed")).toBe("public");
  });

  it("classifies everything else as 'neutral'", () => {
    expect(classifySubscription("random.event")).toBe("neutral");
    expect(classifySubscription("foobar")).toBe("neutral");
    expect(classifySubscription("host.secret.changed")).toBe("neutral");
    // task.* was retired 2026-05-11 — host owner removed in Phase 4
    expect(classifySubscription("task.created")).toBe("neutral");
    // Plugin-owned namespaces stay neutral by design — host is
    // intentionally agnostic to plugin ids (open-source-readiness).
    // A subscribing plugin pays a one-line load-time drift warn.
    expect(classifySubscription("agent_hub.work_item.due_soon")).toBe("neutral");
  });

  it("maps event namespace → required capability for emit", () => {
    expect(requiredCapabilityForEmit("email.new")).toBe("mail-source");
    expect(requiredCapabilityForEmit("meeting.started")).toBe("meeting-recorder");
    expect(requiredCapabilityForEmit("meeting.transcript.updated")).toBe("meeting-recorder");
    expect(requiredCapabilityForEmit("calendar.event")).toBe("calendar-source");
    expect(requiredCapabilityForEmit("index.scan_done")).toBe("knowledge-index");
    expect(requiredCapabilityForEmit("random.event")).toBeUndefined();
  });

  it("KNOWN_CAPABILITIES contains all documented entries", () => {
    for (const cap of [
      "ms-graph-consumer",
      "external-auth-consumer",
      "mail-source",
      "calendar-source",
      "meeting-recorder",
      "knowledge-index",
      "background-watcher",
      "worker-client",
      "document-indexer",
    ]) {
      expect(KNOWN_CAPABILITIES.has(cap)).toBe(true);
    }
  });

  it("sanity: private + public sets are disjoint", () => {
    for (const priv of PLUGIN_PRIVATE_NAMESPACES) {
      const prefix = priv.split(".")[0];
      expect(PUBLIC_EVENT_NAMESPACES.has(prefix)).toBe(false);
    }
  });

  it("HOST-only namespaces reject plugin emit regardless of declared capabilities", () => {
    // `plugin.*` is reserved for host-side emit (lifecycle: plugin.installed,
    // plugin.uninstalled). A plugin spoofing `plugin.installed` could trick
    // work-assistant's onPluginsChanged subscribers into reacting to fake
    // lifecycle. Gate here.
    expect(canEmitEvent("plugin.installed", [])).toBe(false);
    expect(canEmitEvent("plugin.uninstalled", [])).toBe(false);
    expect(canEmitEvent("plugin.installed", ["mail-source", "calendar-source"])).toBe(false);
    // Sentinel host-only capability would not unlock either; no capability
    // declarable in a plugin manifest grants `plugin.*` emit.
    expect(canEmitEvent("plugin.installed", ["host-internal-cap-that-does-not-exist"])).toBe(false);
    expect(canEmitEvent("host.theme.changed", ["meeting-recorder"])).toBe(false);
  });
});

describe("registerManifestEventSubscriptions namespace gate", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-event-ns-"));
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePlugin(
    id: string,
    eventSubscriptions: string[],
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
      tools: [toolName],
      eventSubscriptions,
      ...extra,
    };
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify(manifest), "utf-8");
    await mkdir(join(testDir, "plugins"), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id, manifestPath: join(pluginDir, "plugin.json") }],
      }),
      "utf-8",
    );
  }

  function stubEventCollector(): {
    engine: { collectEvent(type: string, data: unknown): void };
    collected: Array<{ type: string; data: unknown }>;
  } {
    const collected: Array<{ type: string; data: unknown }> = [];
    const engine = {
      collectEvent(type: string, data: unknown) {
        collected.push({ type, data });
      },
    };
    return { engine, collected };
  }

  it("rejects subscription to a private namespace with warn", async () => {
    await writePlugin("p-priv", ["memory.private.leaked"]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => warns.push(String(msg));
    try {
      const { engine } = stubEventCollector();
      registerManifestEventSubscriptions(runtime, engine);
    } finally {
      console.warn = orig;
    }
    expect(
      warns.some((w) => /memory\.private\.leaked/.test(w) && /private namespace/.test(w)),
    ).toBe(true);
  });

  it("accepts a known public subscription silently", async () => {
    await writePlugin("p-pub", ["email.new"]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => warns.push(String(msg));
    try {
      const { engine } = stubEventCollector();
      registerManifestEventSubscriptions(runtime, engine);
    } finally {
      console.warn = orig;
    }
    // No namespace warning for email.new (public namespace).
    expect(warns.some((w) => /email\.new/.test(w))).toBe(false);
  });

  it("accepts explicit host public events silently while keeping host namespace closed", async () => {
    await writePlugin("p-host-theme", ["host.theme.changed"]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => warns.push(String(msg));
    try {
      const { engine } = stubEventCollector();
      registerManifestEventSubscriptions(runtime, engine);
    } finally {
      console.warn = orig;
    }
    expect(warns.some((w) => /host\.theme\.changed/.test(w))).toBe(false);
  });

  it("allows unknown neutral subscription with a drift warning", async () => {
    await writePlugin("p-neutral", ["custom.thing"]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => warns.push(String(msg));
    try {
      const { engine } = stubEventCollector();
      registerManifestEventSubscriptions(runtime, engine);
    } finally {
      console.warn = orig;
    }
    expect(
      warns.some((w) => /custom\.thing/.test(w) && /outside public allowlist/.test(w)),
    ).toBe(true);
  });
});

describe("capability emit gate", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-event-emit-"));
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePlugin(id: string, capabilities: string[]): Promise<void> {
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
      tools: [toolName],
      capabilities,
    };
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify(manifest), "utf-8");
    await mkdir(join(testDir, "plugins"), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id, manifestPath: join(pluginDir, "plugin.json") }],
      }),
      "utf-8",
    );
  }

  /**
   * Mirrors the boot.ts emitEvent closure for testability. Plugin lacking the
   * required capability → drop + warn. Plugin declaring it → pass through.
   */
  function makeEmitGate(runtime: PluginRuntime, pluginId: string) {
    const emitted: Array<{ type: string; data: unknown }> = [];
    const warns: string[] = [];
    const guardedEmit = (type: string, data?: unknown) => {
      const required = requiredCapabilityForEmit(type);
      if (required) {
        const manifest = runtime.getPluginManifest(pluginId);
        if (!manifest?.capabilities?.includes(required)) {
          warns.push(
            `plugin:${pluginId} emitEvent('${type}') dropped — missing capability '${required}'`,
          );
          return;
        }
      }
      emitted.push({ type, data });
    };
    return { guardedEmit, emitted, warns };
  }

  it("drops email.* emission from a plugin lacking mail-source capability", async () => {
    await writePlugin("p-no-mail", ["worker-client"]); // unrelated cap
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { guardedEmit, emitted, warns } = makeEmitGate(runtime, "p-no-mail");
    guardedEmit("email.new", { subject: "hi" });

    expect(emitted).toHaveLength(0);
    expect(warns.some((w) => /missing capability 'mail-source'/.test(w))).toBe(true);
  });

  it("passes email.* emission from a plugin declaring mail-source", async () => {
    await writePlugin("p-mail", ["mail-source"]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { guardedEmit, emitted, warns } = makeEmitGate(runtime, "p-mail");
    guardedEmit("email.new", { subject: "hi" });

    expect(emitted).toEqual([{ type: "email.new", data: { subject: "hi" } }]);
    expect(warns).toEqual([]);
  });

  it("does not gate emit when the namespace has no EVENT_NAMESPACE_CAPABILITY entry", async () => {
    // Random plugin-owned namespace (neutral) — capability emit gate
    // is a no-op. Trust comes from HostApi pluginId binding (the
    // runtime overwrites payload.pluginId with the bound runtime id),
    // not from a manifest-declared capability.
    await writePlugin("p-custom", []);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { guardedEmit, emitted, warns } = makeEmitGate(runtime, "p-custom");
    guardedEmit("custom.event", { foo: 1 });

    expect(emitted).toEqual([{ type: "custom.event", data: { foo: 1 } }]);
    expect(warns).toEqual([]);
  });
});
