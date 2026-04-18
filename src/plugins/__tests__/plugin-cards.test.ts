/**
 * Phase 1.5 Option C — PluginRuntime.listPluginCards() tests.
 *
 * Verifies catalog shape used by SystemPromptBuilder + request_plugin:
 *   - id / name / description / sampleTools (max 3)
 *   - toolSchemas descriptions are stitched when present
 *   - Falls back to `Plugin: {name}` when toolSchemas absent
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginRuntime } from "../runtime.js";

function writePlugin(root: string, id: string, opts: {
  name: string;
  tools: string[];
  toolSchemas?: Record<string, { description: string; inputSchema: { type: "object"; properties: Record<string, unknown> } }>;
}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    name: opts.name,
    version: "1.0.0",
    entry: "index.mjs",
    tools: opts.tools,
    toolSchemas: opts.toolSchemas,
  };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  const handlers = opts.tools
    .map((t) => `  ${t}: async () => ({ ok: true })`)
    .join(",\n");
  writeFileSync(
    join(dir, "index.mjs"),
    `export default () => ({ handlers: {\n${handlers}\n} });`,
  );
  return join(dir, "plugin.json");
}

describe("PluginRuntime.listPluginCards — Phase 1.5 Option C catalog", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lvis-cards-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns id, name, description, sampleTools (max 3)", async () => {
    const manifestA = writePlugin(tmp, "com.lge.meeting", {
      name: "Meeting",
      tools: ["meeting_start", "meeting_push_chunk", "meeting_stop", "meeting_extra"],
      toolSchemas: {
        meeting_start: { description: "회의 시작", inputSchema: { type: "object", properties: {} } },
        meeting_push_chunk: { description: "오디오 청크 전송", inputSchema: { type: "object", properties: {} } },
        meeting_stop: { description: "회의 종료", inputSchema: { type: "object", properties: {} } },
      },
    });

    const runtime = new PluginRuntime({ hostRoot: tmp, manifestPaths: [manifestA] });
    await runtime.load();

    const cards = runtime.listPluginCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("com.lge.meeting");
    expect(cards[0].name).toBe("Meeting");
    expect(cards[0].sampleTools).toEqual(["meeting_start", "meeting_push_chunk", "meeting_stop"]);
    expect(cards[0].description).toContain("회의 시작");
    expect(cards[0].description).toContain("오디오 청크 전송");
  });

  it("falls back to 'Plugin: {name}' when toolSchemas absent", async () => {
    const manifestA = writePlugin(tmp, "com.lge.plain", {
      name: "Plain",
      tools: ["plain_do"],
    });

    const runtime = new PluginRuntime({ hostRoot: tmp, manifestPaths: [manifestA] });
    await runtime.load();

    const cards = runtime.listPluginCards();
    expect(cards[0].description).toBe("Plugin: Plain");
    expect(cards[0].sampleTools).toEqual(["plain_do"]);
  });
});
