/**
 * config-loader unit tests — Tier A4.
 *
 * Uses real tempdirs via `mkdtempSync` + `writeFileSync` (no fs mocks) so we
 * exercise the actual safeParse / JSON path. Only the public helper
 * `loadHooksConfigFromPaths` is used so tests stay independent of homedir().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHooksConfigFromPaths, EMPTY_HOOKS_CONFIG } from "../config-loader.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "lvis-hooks-"));
  mkdirSync(join(workDir, "user"));
  mkdirSync(join(workDir, "admin"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeJson(path: string, body: unknown): void {
  writeFileSync(path, JSON.stringify(body), "utf-8");
}

describe("loadHooksConfigFromPaths", () => {
  it("missing files return empty hook arrays", () => {
    const cfg = loadHooksConfigFromPaths({
      adminPath: join(workDir, "admin", "nope.json"),
      userPath: join(workDir, "user", "nope.json"),
    });
    expect(cfg.preToolUse).toEqual([]);
    expect(cfg.postToolUse).toEqual([]);
    // Sanity: EMPTY_HOOKS_CONFIG has same shape.
    expect(cfg).toEqual(EMPTY_HOOKS_CONFIG);
  });

  it("parses a valid user config", () => {
    const userPath = join(workDir, "user", "hooks.json");
    writeJson(userPath, {
      preToolUse: [
        { type: "command", command: "echo u", blockOnFailure: false },
      ],
      postToolUse: [],
    });

    const cfg = loadHooksConfigFromPaths({ adminPath: null, userPath });
    expect(cfg.preToolUse).toHaveLength(1);
    expect(cfg.preToolUse[0]).toMatchObject({ type: "command", command: "echo u" });
  });

  it("admin + user merge puts admin hooks first", () => {
    const adminPath = join(workDir, "admin", "hooks.json");
    const userPath = join(workDir, "user", "hooks.json");
    writeJson(adminPath, {
      preToolUse: [
        { type: "command", command: "echo admin", blockOnFailure: true },
      ],
      postToolUse: [
        { type: "http", url: "http://admin.local/post", headers: {} },
      ],
    });
    writeJson(userPath, {
      preToolUse: [
        { type: "command", command: "echo user", blockOnFailure: false },
      ],
      postToolUse: [],
    });

    const cfg = loadHooksConfigFromPaths({ adminPath, userPath });
    expect(cfg.preToolUse).toHaveLength(2);
    expect(cfg.preToolUse[0]).toMatchObject({ command: "echo admin" });
    expect(cfg.preToolUse[1]).toMatchObject({ command: "echo user" });
    expect(cfg.postToolUse).toHaveLength(1);
    expect(cfg.postToolUse[0]).toMatchObject({ type: "http", url: "http://admin.local/post" });
  });

  it("invalid JSON logs warning and returns empty", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const userPath = join(workDir, "user", "hooks.json");
    writeFileSync(userPath, "{not-json", "utf-8");

    const cfg = loadHooksConfigFromPaths({ adminPath: null, userPath });
    expect(cfg.preToolUse).toEqual([]);
    expect(cfg.postToolUse).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("schema violation logs warning and returns empty", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const userPath = join(workDir, "user", "hooks.json");
    writeJson(userPath, {
      preToolUse: [{ type: "bogus", command: "x" }],
      postToolUse: [],
    });

    const cfg = loadHooksConfigFromPaths({ adminPath: null, userPath });
    expect(cfg.preToolUse).toEqual([]);
    expect(cfg.postToolUse).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(msg).toMatch(/invalid hooks\.json/);
  });
});
