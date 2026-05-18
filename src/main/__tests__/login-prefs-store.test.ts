import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_LOGIN_PREFS,
  LOGIN_VARIANTS,
  readLoginPrefs,
  writeLoginPrefs,
} from "../login-prefs-store.js";

/**
 * Tutorial-A — `~/.lvis/login-prefs/` storage tests.
 *
 * Validates:
 *   - Default returned when no file is present (read-never-throws contract).
 *   - Round-trip (writeLoginPrefs → readLoginPrefs).
 *   - Corrupt JSON falls back to the default (read-never-throws).
 *   - Writer creates the namespace directory under `~/.lvis/login-prefs/`
 *     so the Storage Namespace per Feature rule (project CLAUDE.md) is met.
 */
describe("login-prefs-store", () => {
  let prevLvisHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    prevLvisHome = process.env.LVIS_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "lvis-login-prefs-"));
    process.env.LVIS_HOME = tempDir;
  });

  afterEach(() => {
    if (prevLvisHome === undefined) {
      delete process.env.LVIS_HOME;
    } else {
      process.env.LVIS_HOME = prevLvisHome;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns the default variant when no file exists", async () => {
    const prefs = await readLoginPrefs();
    expect(prefs).toEqual(DEFAULT_LOGIN_PREFS);
    expect(LOGIN_VARIANTS).toContain(prefs.loginVariant);
  });

  it("round-trips writeLoginPrefs → readLoginPrefs", async () => {
    await writeLoginPrefs({ loginVariant: "cli-agent" });
    const prefs = await readLoginPrefs();
    expect(prefs.loginVariant).toBe("cli-agent");
  });

  it("falls back to default on corrupt JSON (read-never-throws)", async () => {
    // Seed the file with invalid JSON. The store must not throw.
    await writeLoginPrefs({ loginVariant: "conversational" });
    const path = join(tempDir, "login-prefs", "login-prefs.json");
    writeFileSync(path, "{ not valid json", "utf-8");
    const prefs = await readLoginPrefs();
    expect(prefs).toEqual(DEFAULT_LOGIN_PREFS);
  });

  it("falls back to default when loginVariant is unknown", async () => {
    await writeLoginPrefs({ loginVariant: "conversational" });
    const path = join(tempDir, "login-prefs", "login-prefs.json");
    writeFileSync(
      path,
      JSON.stringify({ loginVariant: "future-variant" }),
      "utf-8",
    );
    const prefs = await readLoginPrefs();
    expect(prefs).toEqual(DEFAULT_LOGIN_PREFS);
  });

  it("creates the namespace directory under ~/.lvis/login-prefs/", async () => {
    await writeLoginPrefs({ loginVariant: "cli-agent" });
    const dir = join(tempDir, "login-prefs");
    const file = join(dir, "login-prefs.json");
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(file).isFile()).toBe(true);
    // The file body is the persisted JSON — used as a smoke check that
    // writes land in the namespace directory and nothing else.
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
      loginVariant: string;
    };
    expect(parsed.loginVariant).toBe("cli-agent");
  });

  it("rejects writes with an unknown loginVariant", async () => {
    await expect(
      writeLoginPrefs({ loginVariant: "future-variant" as never }),
    ).rejects.toThrow(/invalid-login-variant/);
  });
});
