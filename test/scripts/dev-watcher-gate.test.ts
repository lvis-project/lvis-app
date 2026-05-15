import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForAllFirstBuilds } from "../../scripts/lib/dev-watcher-gate.mjs";

describe("waitForAllFirstBuilds", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "watcher-gate-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makeLog() {
    const lines: string[] = [];
    return { log: (tag: string, msg: string) => lines.push(`[${tag}] ${msg}`), lines };
  }

  it("returns true when every watcher's output exists with mtime >= since", async () => {
    const a = join(workDir, "a.js");
    const b = join(workDir, "b.css");
    await writeFile(a, "x");
    await writeFile(b, "y");

    const since = Date.now() - 10_000; // safely in the past
    const watchers = [
      { tag: "a", label: "Output A", output: a },
      { tag: "b", label: "Output B", output: b },
    ];

    const { log, lines } = makeLog();
    const ok = await waitForAllFirstBuilds(watchers, since, log, { timeoutMs: 1_000, sleepMs: 20 });

    expect(ok).toBe(true);
    expect(lines.some((l) => l.includes("OK a"))).toBe(true);
    expect(lines.some((l) => l.includes("OK b"))).toBe(true);
    expect(lines.some((l) => l.includes("all watchers ready"))).toBe(true);
  });

  it("returns false when an output stays missing past the timeout", async () => {
    const a = join(workDir, "a.js");
    await writeFile(a, "x");

    const since = Date.now() - 10_000;
    const watchers = [
      { tag: "a", label: "Output A", output: a },
      { tag: "missing", label: "Missing", output: join(workDir, "never.js") },
    ];

    const { log, lines } = makeLog();
    const ok = await waitForAllFirstBuilds(watchers, since, log, { timeoutMs: 250, sleepMs: 50 });

    expect(ok).toBe(false);
    expect(lines.some((l) => l.includes("FAIL missing"))).toBe(true);
  });

  it("rejects stale outputs with mtime < since (incremental output from prior session)", async () => {
    const a = join(workDir, "a.js");
    await writeFile(a, "stale");
    // Backdate mtime to 10 seconds ago
    const past = new Date(Date.now() - 10_000);
    await utimes(a, past, past);

    // Launcher starts NOW — stale file's mtime is older than this baseline
    const since = Date.now();
    const watchers = [{ tag: "a", label: "Output A", output: a }];

    const { log } = makeLog();
    const ok = await waitForAllFirstBuilds(watchers, since, log, { timeoutMs: 250, sleepMs: 50 });

    expect(ok).toBe(false);
  });

  it("succeeds when a missing output appears mid-poll (simulates first build)", async () => {
    const a = join(workDir, "a.js");
    const since = Date.now();
    const watchers = [{ tag: "a", label: "Output A", output: a }];

    const { log } = makeLog();
    // Spawn the file 200ms in (within timeout)
    setTimeout(() => {
      void writeFile(a, "first build");
    }, 200);

    const ok = await waitForAllFirstBuilds(watchers, since, log, { timeoutMs: 1_500, sleepMs: 50 });
    expect(ok).toBe(true);
  });

  it("logs remaining watchers in deterministic insertion order", async () => {
    const a = join(workDir, "a.js");
    await writeFile(a, "x");

    const since = Date.now() - 10_000;
    const watchers = [
      { tag: "a", label: "A", output: a },
      { tag: "b", label: "B", output: join(workDir, "b.js") },
      { tag: "c", label: "C", output: join(workDir, "c.js") },
    ];

    const { log, lines } = makeLog();
    // a will succeed immediately; b and c will time out.
    await waitForAllFirstBuilds(watchers, since, log, { timeoutMs: 200, sleepMs: 50 });

    const startLine = lines.find((l) => l.includes("waiting for first build"));
    expect(startLine).toBeDefined();
    // Insertion order: a b c
    expect(startLine).toMatch(/a b c/);
  });
});
