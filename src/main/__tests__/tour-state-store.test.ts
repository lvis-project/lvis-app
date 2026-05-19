import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_TOUR_STATE,
  readTourState,
  writeTourState,
  markScenarioComplete,
  dismissScenario,
} from "../tour-state-store.js";

/**
 * Tutorial-C — `~/.lvis/onboarding/tour-state.json` storage tests.
 *
 * Validates the Storage Namespace per Feature contract (project CLAUDE.md):
 *   - File lives under `~/.lvis/onboarding/` — not at root.
 *   - Directory mode 0o700, file mode 0o600 (POSIX; mode bits are not
 *     enforced on Windows, so the mode check skips when `process.platform`
 *     is `"win32"`).
 *   - Read-never-throws: corrupt JSON / missing file → DEFAULT_TOUR_STATE.
 *   - `markScenarioComplete` is idempotent.
 *   - `dismissScenario` records `dismissedAt` but does NOT add to
 *     `completedScenarios`.
 */
describe("tour-state-store", () => {
  let prevLvisHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    prevLvisHome = process.env.LVIS_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "lvis-tour-state-"));
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

  it("returns the default state when no file exists", async () => {
    const state = await readTourState();
    expect(state).toEqual(DEFAULT_TOUR_STATE);
  });

  it("round-trips writeTourState → readTourState", async () => {
    await writeTourState({
      lastSeenScenario: "first-boot-essentials",
      completedScenarios: ["first-boot-essentials"],
      dismissedAt: null,
    });
    const state = await readTourState();
    expect(state.lastSeenScenario).toBe("first-boot-essentials");
    expect(state.completedScenarios).toEqual(["first-boot-essentials"]);
    expect(state.dismissedAt).toBeNull();
  });

  it("falls back to default on corrupt JSON (read-never-throws)", async () => {
    await writeTourState(DEFAULT_TOUR_STATE);
    const path = join(tempDir, "onboarding", "tour-state.json");
    writeFileSync(path, "{ not valid json", "utf-8");
    const state = await readTourState();
    expect(state).toEqual(DEFAULT_TOUR_STATE);
  });

  it("creates the namespace directory under ~/.lvis/onboarding/", async () => {
    await writeTourState({
      lastSeenScenario: null,
      completedScenarios: [],
      dismissedAt: null,
    });
    const dir = join(tempDir, "onboarding");
    const file = join(dir, "tour-state.json");
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(file).isFile()).toBe(true);
    // The file body is the persisted JSON — smoke check that writes
    // land in the namespace directory and nothing else.
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    expect(parsed).toEqual(DEFAULT_TOUR_STATE);
  });

  it("enforces 0o700 directory + 0o600 file modes (POSIX only)", async () => {
    if (process.platform === "win32") return;
    await writeTourState({
      lastSeenScenario: "x",
      completedScenarios: [],
      dismissedAt: null,
    });
    const dir = join(tempDir, "onboarding");
    const file = join(dir, "tour-state.json");
    const dirMode = statSync(dir).mode & 0o777;
    const fileMode = statSync(file).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("markScenarioComplete is idempotent", async () => {
    await markScenarioComplete("a");
    await markScenarioComplete("a");
    const state = await readTourState();
    expect(state.completedScenarios).toEqual(["a"]);
    expect(state.lastSeenScenario).toBe("a");
  });

  it("dismissScenario records dismissedAt without completing", async () => {
    const before = new Date().toISOString();
    const next = await dismissScenario("a");
    expect(next.completedScenarios).toEqual([]);
    expect(next.lastSeenScenario).toBe("a");
    expect(typeof next.dismissedAt).toBe("string");
    // dismissedAt must be ≥ the timestamp captured just before the call.
    expect(next.dismissedAt && next.dismissedAt >= before).toBe(true);
  });

  it("de-dupes corrupted manual edits in completedScenarios", async () => {
    const dir = join(tempDir, "onboarding");
    const path = join(dir, "tour-state.json");
    await writeTourState(DEFAULT_TOUR_STATE);
    writeFileSync(
      path,
      JSON.stringify({
        lastSeenScenario: null,
        completedScenarios: ["a", "a", "b", "b", "a"],
        dismissedAt: null,
      }),
      "utf-8",
    );
    const state = await readTourState();
    expect(state.completedScenarios.sort()).toEqual(["a", "b"]);
  });

  it("rejects markScenarioComplete with an empty scenarioId", async () => {
    await expect(markScenarioComplete("")).rejects.toThrow(
      /invalid-scenario-id/,
    );
  });
});
