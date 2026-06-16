/**
 * Legacy-plugin → host work-board migration (one-shot, idempotent).
 *
 * Every case points `LVIS_HOME` at a per-test temp dir (mirroring the
 * feature-namespace test harness) so the scan of `~/.lvis/plugins/*​/board.json`
 * and the write to `~/.lvis/work-board/board.json` stay entirely inside the
 * temp root — the real `~/.lvis` is never read or written.
 *
 * Policy under test:
 *   - Runs once when the destination is absent AND exactly one legacy plugin
 *     board exists; returns true and copies (does not move) the source.
 *   - Skips (returns false) when the destination already exists — idempotent.
 *   - Skips + warns when more than one legacy board exists (ambiguous source).
 *   - Skips when the legacy board is not valid JSON.
 *   - Skips when the legacy board parses but is the wrong shape (not an
 *     object with an items array).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateAgentHubBoardToWorkBoard } from "../work-board-migration.js";

const SAMPLE_BOARD = { version: 1, nextId: 3, items: [{ id: 1, title: "legacy task", status: "planned", priority: "medium", created_at: "x", updated_at: "x" }] };

function pluginBoardPath(home: string, pluginId: string): string {
  // Plugins persist under their PluginStorage `data/` subdir.
  return join(home, "plugins", pluginId, "data", "board.json");
}

function writePluginBoard(home: string, pluginId: string, contents: string): string {
  const path = pluginBoardPath(home, pluginId);
  mkdirSync(join(home, "plugins", pluginId, "data"), { recursive: true });
  writeFileSync(path, contents, "utf-8");
  return path;
}

describe("work-board migration", () => {
  let prevLvisHome: string | undefined;
  let home: string;
  let destPath: string;

  beforeEach(() => {
    prevLvisHome = process.env.LVIS_HOME;
    home = mkdtempSync(join(tmpdir(), "lvis-wb-mig-"));
    process.env.LVIS_HOME = home;
    destPath = join(home, "work-board", "board.json");
  });

  afterEach(() => {
    if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = prevLvisHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("migrates once: dest absent + exactly one legacy board → copies + returns true", async () => {
    const legacyPath = writePluginBoard(home, "agent-hub", JSON.stringify(SAMPLE_BOARD));

    const migrated = await migrateAgentHubBoardToWorkBoard();

    expect(migrated).toBe(true);
    expect(existsSync(destPath)).toBe(true);
    expect(JSON.parse(readFileSync(destPath, "utf-8"))).toEqual(SAMPLE_BOARD);
    // COPY, not move — the legacy source is left in place for forensics.
    expect(existsSync(legacyPath)).toBe(true);
    expect(JSON.parse(readFileSync(legacyPath, "utf-8"))).toEqual(SAMPLE_BOARD);
  });

  it("is idempotent: a second run with the dest present skips and returns false", async () => {
    writePluginBoard(home, "agent-hub", JSON.stringify(SAMPLE_BOARD));
    expect(await migrateAgentHubBoardToWorkBoard()).toBe(true);

    // A pre-existing destination is the idempotency marker.
    const second = await migrateAgentHubBoardToWorkBoard();
    expect(second).toBe(false);
  });

  it("skips when the destination already exists (never overwrites host board)", async () => {
    mkdirSync(join(home, "work-board"), { recursive: true });
    const hostBoard = { version: 1, nextId: 1, items: [] };
    writeFileSync(destPath, JSON.stringify(hostBoard), "utf-8");
    writePluginBoard(home, "agent-hub", JSON.stringify(SAMPLE_BOARD));

    const migrated = await migrateAgentHubBoardToWorkBoard();

    expect(migrated).toBe(false);
    // Host board untouched — legacy content was NOT adopted over it.
    expect(JSON.parse(readFileSync(destPath, "utf-8"))).toEqual(hostBoard);
  });

  it("skips + warns when more than one legacy board exists (ambiguous source)", async () => {
    writePluginBoard(home, "agent-hub", JSON.stringify(SAMPLE_BOARD));
    writePluginBoard(home, "work-assistant", JSON.stringify({ version: 1, nextId: 1, items: [] }));

    const migrated = await migrateAgentHubBoardToWorkBoard();

    expect(migrated).toBe(false);
    // Ambiguity → no destination written.
    expect(existsSync(destPath)).toBe(false);
  });

  it("returns false when there is no legacy plugin board at all", async () => {
    // No plugins dir, no board.
    expect(await migrateAgentHubBoardToWorkBoard()).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });

  it("skips when the single legacy board is not valid JSON", async () => {
    writePluginBoard(home, "agent-hub", "{ not valid json");

    const migrated = await migrateAgentHubBoardToWorkBoard();

    expect(migrated).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });

  it.each([
    ["a JSON array", "[]"],
    ["a JSON string", "\"x\""],
    ["a JSON number", "42"],
    ["a JSON null", "null"],
    ["an object whose items is not an array", JSON.stringify({ version: 1, nextId: 1, items: "x" })],
  ])("skips a parseable-but-wrong-shape legacy board (%s)", async (_label, contents) => {
    writePluginBoard(home, "agent-hub", contents);

    const migrated = await migrateAgentHubBoardToWorkBoard();

    // Parseable JSON that is not a board must never be adopted — no dest write.
    expect(migrated).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });
});
