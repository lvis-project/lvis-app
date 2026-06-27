/**
 * notificationEvents validation accepts SELF-EMITTED events. A plugin that emits
 * an event (declared in emittedEvents) and lists it in notificationEvents for an
 * OS notification is the event's own source — it needs no eventSubscriptions
 * entry to "receive" it, and (because restricting eventSubscriptions to the bare
 * host broadcast is a deliberate hardening) must NOT be warned for omitting one.
 * The soft warn must fire ONLY when the notification event is in neither
 * eventSubscriptions nor emittedEvents (a dangling reference).
 * The logger routes warn -> console.warn, so we spy on console.warn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifestValidator, parsePluginJson } from "../manifest-validation.js";

describe("manifest notificationEvents — self-emitted events do not warn", () => {
  let workDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "notif-emitted-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    warnSpy.mockRestore();
    await rm(workDir, { recursive: true, force: true });
  });

  async function writeManifest(extra: Record<string, unknown>): Promise<string> {
    const path = join(workDir, "plugin.json");
    await writeFile(
      path,
      JSON.stringify({
        id: "notif-test",
        name: "Notif Test",
        description: "x",
        version: "1.0.0",
        entry: "dist/p.js",
        tools: ["t_one"],
        ...extra,
      }),
    );
    return path;
  }

  function notifWarned(eventName: string): boolean {
    return warnSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === "string" && a.includes("notificationEvents") && a.includes(eventName)),
    );
  }

  it("does NOT warn when the notification event is self-emitted (in emittedEvents) — the local-indexer shape", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      emittedEvents: ["notif-test.scan.completed", "notif-test.folders.changed"],
      eventSubscriptions: [{ type: "host.theme.changed" }],
      notificationEvents: [
        { event: "notif-test.scan.completed" },
        { event: "notif-test.folders.changed" },
      ],
    });
    await parsePluginJson(path, validator);
    expect(notifWarned("notif-test.scan.completed")).toBe(false);
    expect(notifWarned("notif-test.folders.changed")).toBe(false);
  });

  it("does NOT warn when the notification event is subscribed (in eventSubscriptions)", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      eventSubscriptions: [{ type: "host.theme.changed" }, { type: "other.plugin.ping" }],
      notificationEvents: [{ event: "other.plugin.ping" }],
    });
    await parsePluginJson(path, validator);
    expect(notifWarned("other.plugin.ping")).toBe(false);
  });

  it("DOES warn when the notification event is in neither emittedEvents nor eventSubscriptions", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      emittedEvents: ["notif-test.scan.completed"],
      eventSubscriptions: [{ type: "host.theme.changed" }],
      notificationEvents: [{ event: "notif-test.unknown.event" }],
    });
    await parsePluginJson(path, validator);
    expect(notifWarned("notif-test.unknown.event")).toBe(true);
  });
});
