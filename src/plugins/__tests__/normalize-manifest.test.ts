/**
 * #885 Plugin Contract v6 — manifest materialization.
 *
 * The visibility + `name` defaulting that used to live in a standalone exported
 * helper is now inlined into `parsePluginJson` (the single load-time
 * materializer). These cases pin that behavior end-to-end through the parser:
 * a validated pure `Tool[]` passes through, an omitted `_meta.ui.visibility` is
 * filled with the standard `["model","app"]` default, an explicit `[]` is
 * REJECTED (fail-closed, never widened to dual), and `name` defaults to `id`.
 *
 * A permissive validator is used so a fixture reaches the host-side materializer
 * directly — the real SDK schema rejects `visibility: []` upstream at its
 * `minItems:1` gate, but the host keeps its own fail-closed backstop and that is
 * what these tests exercise.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { parsePluginJson } from "../runtime/manifest-validation.js";
import type { PluginManifest, Tool } from "../types.js";

/** Accept any object so a fixture reaches parsePluginJson's structural checks + materialization. */
function permissiveValidator() {
  return new Ajv().compile({ type: "object", additionalProperties: true });
}

describe("parsePluginJson — manifest materialization (visibility + name defaults)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manifest-materialize-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function parse(manifest: Record<string, unknown>): Promise<PluginManifest> {
    const path = join(workDir, "plugin.json");
    await writeFile(path, JSON.stringify(manifest));
    return parsePluginJson(path, permissiveValidator());
  }

  function base(tools: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "test-plugin",
      name: "Test",
      version: "1.0.0",
      entry: "index.js",
      description: "test plugin",
      publisher: "tests",
      tools,
      ...over,
    };
  }

  it("passes an explicit-visibility tool through unchanged", async () => {
    const tool: Tool = {
      name: "p",
      description: "pure tool",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["model"] } },
    };
    const out = await parse(base([tool]));
    expect(out.tools).toEqual([tool]);
  });

  it("returns an empty Tool[] for an empty tools array", async () => {
    const out = await parse(base([]));
    expect(out.tools).toEqual([]);
  });

  it('materializes absent visibility to the standard ["model","app"]', async () => {
    const noMeta = { name: "x", inputSchema: { type: "object", properties: {} } };
    const metaNoVis = {
      name: "y",
      inputSchema: { type: "object", properties: {} },
      _meta: { "xyz.lvis/pathFields": ["p"] },
    };
    const out = await parse(base([noMeta, metaNoVis]));
    expect(out.tools[0]._meta?.ui?.visibility).toEqual(["model", "app"]);
    expect(out.tools[1]._meta?.ui?.visibility).toEqual(["model", "app"]);
    expect(out.tools[1]._meta?.["xyz.lvis/pathFields"]).toEqual(["p"]); // preserved
  });

  it("default is governed — never yields an app-only (bypass) tool", async () => {
    const out = await parse(
      base([{ name: "x", inputSchema: { type: "object", properties: {} } }]),
    );
    const vis = out.tools[0]._meta?.ui?.visibility ?? [];
    const isUiOnly = vis.includes("app") && !vis.includes("model");
    expect(isUiOnly).toBe(false);
  });

  it("keeps a declared pathFields _meta key alongside explicit visibility", async () => {
    const tool = {
      name: "read_file",
      inputSchema: { type: "object", properties: { path: {} } },
      _meta: { ui: { visibility: ["model"] }, "xyz.lvis/pathFields": ["path"] },
    };
    const out = await parse(base([tool]));
    expect(out.tools[0]._meta?.["xyz.lvis/pathFields"]).toEqual(["path"]);
    expect(out.tools[0]._meta?.ui?.visibility).toEqual(["model"]);
  });

  it("REJECTS an explicit empty visibility [] (R6 — never widened to dual)", async () => {
    const bad = {
      name: "z",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: [] } },
    };
    await expect(parse(base([bad]))).rejects.toThrow(/visibility is \[\]/);
  });

  it("defaults name to id when the manifest omits name", async () => {
    const out = await parse(
      base(
        [
          {
            name: "x",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model"] } },
          },
        ],
        { name: undefined },
      ),
    );
    expect(out.name).toBe("test-plugin");
  });
});
