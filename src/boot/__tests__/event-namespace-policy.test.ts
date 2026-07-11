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
import { getDeclaredEmittedEvents } from "../../plugins/runtime/manifest-validation.js";
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

  it("KNOWN_CAPABILITIES is the reduced host-ENFORCED set (Ph1/Ph2)", () => {
    // After the capabilities reduction the enforced vocab is exactly the two
    // strings the host gates on at runtime.
    expect([...KNOWN_CAPABILITIES].sort()).toEqual(
      ["external-auth-consumer", "host:overlay"].sort(),
    );
    // The 5 dead strings, the 4 event-source strings (now inferred from
    // emittedEvents), and worker-client (a live free-form discovery key, not a
    // host-enforced gate) are all gone from the enforced vocab.
    for (const removed of [
      "ms-graph-consumer",
      "background-watcher",
      "document-indexer",
      "lifecycle-observer",
      "routine-provider",
      "worker-client",
      "mail-source",
      "calendar-source",
      "meeting-recorder",
      "knowledge-index",
    ]) {
      expect(KNOWN_CAPABILITIES.has(removed)).toBe(false);
    }
  });

  it("sanity: private + public sets are disjoint", () => {
    for (const priv of PLUGIN_PRIVATE_NAMESPACES) {
      const prefix = priv.split(".")[0];
      expect(PUBLIC_EVENT_NAMESPACES.has(prefix)).toBe(false);
    }
  });

  it("HOST-only namespaces reject plugin emit regardless of declared emittedEvents", () => {
    // `plugin.*` is reserved for host-side emit (lifecycle: plugin.installed,
    // plugin.uninstalled). A plugin spoofing `plugin.installed` could trick
    // work-assistant's onPluginsChanged subscribers into reacting to fake
    // lifecycle. Gate here — the host-only check short-circuits before the
    // emittedEvents inference, so no declaration can unlock a host-only emit.
    expect(canEmitEvent("plugin.installed", [])).toBe(false);
    expect(canEmitEvent("plugin.uninstalled", [])).toBe(false);
    // Even declaring the exact host-only event in emittedEvents does not unlock it.
    expect(canEmitEvent("plugin.installed", ["plugin.installed"])).toBe(false);
    expect(canEmitEvent("plugin.installed", ["email.new", "calendar.event"])).toBe(false);
    expect(canEmitEvent("host.theme.changed", ["host.theme.changed"])).toBe(false);
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
      tools: [
        {
          name: toolName,
          description: `${toolName} test tool`,
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        },
      ],
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

  async function writePlugin(
    id: string,
    emittedEvents: string[],
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
      emittedEvents,
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

  /**
   * Mirrors the createHostApi emitEvent closure for testability, using the
   * production `canEmitEvent` predicate. A plugin that did not DECLARE the gated
   * namespace in `emittedEvents` → drop + warn; a plugin declaring it → pass
   * through. (`required` is the internal effect label used for the warn/audit.)
   */
  function makeEmitGate(runtime: PluginRuntime, pluginId: string) {
    const emitted: Array<{ type: string; data: unknown }> = [];
    const warns: string[] = [];
    const guardedEmit = (type: string, data?: unknown) => {
      const manifest = runtime.getPluginManifest(pluginId);
      const declaredEmittedEvents = manifest ? getDeclaredEmittedEvents(manifest) : [];
      if (!canEmitEvent(type, declaredEmittedEvents)) {
        const required = requiredCapabilityForEmit(type);
        warns.push(
          `plugin:${pluginId} emitEvent('${type}') dropped — missing capability '${required}'`,
        );
        return;
      }
      emitted.push({ type, data });
    };
    return { guardedEmit, emitted, warns };
  }

  it("drops email.* emission from a plugin that did not declare the email namespace", async () => {
    await writePlugin("p-no-mail", ["custom.ping"]); // declares an unrelated namespace
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { guardedEmit, emitted, warns } = makeEmitGate(runtime, "p-no-mail");
    guardedEmit("email.new", { subject: "hi" });

    expect(emitted).toHaveLength(0);
    expect(warns.some((w) => /missing capability 'mail-source'/.test(w))).toBe(true);
  });

  it("passes email.* emission from a plugin declaring email.* in emittedEvents", async () => {
    await writePlugin("p-mail", ["email.new"]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { guardedEmit, emitted, warns } = makeEmitGate(runtime, "p-mail");
    guardedEmit("email.new", { subject: "hi" });

    expect(emitted).toEqual([{ type: "email.new", data: { subject: "hi" } }]);
    expect(warns).toEqual([]);
  });

  it("does not gate emit when the namespace has no EVENT_NAMESPACE_CAPABILITY entry", async () => {
    // Random plugin-owned namespace (neutral) — the emit gate is a no-op.
    // Trust comes from HostApi pluginId binding (the runtime overwrites
    // payload.pluginId with the bound runtime id), not from a declared namespace.
    await writePlugin("p-custom", []);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { guardedEmit, emitted, warns } = makeEmitGate(runtime, "p-custom");
    guardedEmit("custom.event", { foo: 1 });

    expect(emitted).toEqual([{ type: "custom.event", data: { foo: 1 } }]);
    expect(warns).toEqual([]);
  });

  it("loads a plugin declaring legacy/unknown capability strings under the relaxed schema", async () => {
    // worker-client is a live free-form host discovery key; mail-source and an
    // arbitrary unknown string are harmless no-ops. All must VALIDATE + LOAD
    // (free-form schema), not be rejected the way the old closed enum would.
    await writePlugin("p-legacy", [], {
      capabilities: ["worker-client", "mail-source", "totally-legacy-cap"],
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const manifest = runtime.getPluginManifest("p-legacy");
    expect(manifest).toBeDefined();
    expect(manifest?.capabilities).toEqual([
      "worker-client",
      "mail-source",
      "totally-legacy-cap",
    ]);
  });

  it("suppresses email.* emit from a plugin declaring the legacy mail-source CAPABILITY but no emittedEvents (no capability fallback)", async () => {
    // Scenario (c): before the capabilities reduction, email.* emit was gated on
    // the `mail-source` CAPABILITY. Post-reduction, emit authorization is
    // inferred ONLY from `emittedEvents`. A plugin still shipping the legacy
    // capability while declaring NO email.* in emittedEvents must have the emit
    // SUPPRESSED — the capability must not silently re-unlock it. Every (b) test
    // sets no capabilities at all, so a capability-fallback regression would slip
    // past them; this fixture (capabilities include mail-source, emittedEvents
    // empty) is the guard.
    await writePlugin("p-legacy", [], {
      capabilities: ["worker-client", "mail-source", "totally-legacy-cap"],
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const { guardedEmit, emitted, warns } = makeEmitGate(runtime, "p-legacy");
    guardedEmit("email.new", { subject: "hi" });

    expect(emitted).toHaveLength(0);
    expect(warns.some((w) => /missing capability 'mail-source'/.test(w))).toBe(true);
  });
});
