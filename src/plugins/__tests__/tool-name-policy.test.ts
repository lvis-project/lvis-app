/** Tool names never grant or remove authority based on verb suffixes. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  makeTestPluginRuntime,
  makeTestPluginRuntimeFixture,
  pureTool,
  writeTestPlugin,
  writeTestPluginRegistry,
  type TestPluginRuntimeFixture,
} from "./test-helpers.js";

describe("PluginRuntime — Tool name policy", () => {
  let fixture: TestPluginRuntimeFixture;
  let auditEntries: Array<{ level: string; message: string; data?: unknown }>;

  beforeEach(async () => {
    fixture = await makeTestPluginRuntimeFixture({ prefix: "lvis-ui-unsigned-" });
    auditEntries = [];
  });

  afterEach(async () => {
    await rm(fixture.rootDir, { recursive: true, force: true });
  });

  async function writePlugin(id: string, manifestOverrides: Record<string, unknown> = {}): Promise<void> {
    const toolPrefix = id.replaceAll("-", "_");
    const { manifestPath } = await writeTestPlugin(fixture, {
      id,
      entrySource: `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "${toolPrefix}_get": async () => "ok",
      "${toolPrefix}_delete": async () => "ok",
    },
    start: async () => {},
    stop: async () => {},
      };
}`,
      tools: [
        pureTool(`${toolPrefix}_get`),
        pureTool(`${toolPrefix}_delete`),
      ],
      manifest: manifestOverrides,
    });
    await writeTestPluginRegistry(fixture, [{ id, manifestPath }]);
  }

  function runtimeWithAudit() {
    return makeTestPluginRuntime(fixture, {
      auditLog: (level, message, data) => {
        auditEntries.push({ level, message, data });
      },
    });
  }

  it("managed plugin with any suffix loads successfully (no verifier needed)", async () => {
    await writePlugin("p-managed-default", {
      installPolicy: "admin",
    });

    const runtime = runtimeWithAudit();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p-managed-default");
  });

  it("user plugin with any suffix loads successfully", async () => {
    await writePlugin("p-user-delete", {
      installPolicy: "user",
    });

    const runtime = runtimeWithAudit();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p-user-delete");
  });

  it("does not emit a synthetic destructive-name rejection", async () => {
    await writePlugin("p-audit-check", {
      installPolicy: "user",
    });

    const runtime = runtimeWithAudit();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p-audit-check");
    expect(
      auditEntries.some(
        (e) => e.message.includes("destructive") && e.message.includes("rejected"),
      ),
    ).toBe(false);
  });
});
