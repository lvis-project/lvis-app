import { spawn, type ChildProcess } from "node:child_process";

import { describe, expect, it } from "vitest";

import { createChildTracker } from "./tmp-dir-teardown.js";

/**
 * A child that ignores SIGTERM and never exits on its own.
 *
 * Both properties matter. "Never exits" is what makes a leak observable — a
 * child that would have died anyway proves nothing about the reaper. "Ignores
 * SIGTERM" is what exercises the escalation: without it a polite kill would
 * suffice, and the SIGKILL path would go untested even though it is the one
 * that matters for a child blocked acquiring a lock.
 */
function spawnUnkillableByTerm() {
  return spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM", () => {});'
        + ' setInterval(() => {}, 1000);'
        + ' process.stdout.write("armed");',
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
}

/**
 * Wait until the child has actually installed its SIGTERM handler.
 *
 * Spawning returns before the child has run a line of script, so a reap issued
 * immediately wins the race and kills it with the default disposition — which
 * looks like a passing escalation test while proving the opposite of what it
 * claims. The child announces itself once the handler is armed; this waits for
 * that rather than for a duration.
 */
function whenArmed(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.stdout?.once("data", () => resolve()));
}

/** Ask the OS, rather than trusting the ChildProcess object's own view. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("createChildTracker", () => {
  it("reaps a child the test never killed", async () => {
    const tracker = createChildTracker();
    const child = tracker.track(spawnUnkillableByTerm());
    const { pid } = child;
    expect(pid).toBeTypeOf("number");
    expect(isAlive(pid as number)).toBe(true);

    await tracker.reap();

    expect(child.killed).toBe(true);
    expect(isAlive(pid as number)).toBe(false);
  }, 20_000);

  // Win32 has no signal delivery to emulate an ignored SIGTERM with: `kill`
  // terminates the target outright whatever handler it installed, so the polite
  // step is already the forceful one and there is no escalation to observe. The
  // property that survives the platform — the reaper leaves nothing running —
  // is the test below; this one asserts the mechanism it uses on POSIX.
  it.runIf(process.platform !== "win32")(
    "escalates to SIGKILL when the child ignores SIGTERM",
    async () => {
      const tracker = createChildTracker();
      const child = tracker.track(spawnUnkillableByTerm());
      await whenArmed(child);
      await tracker.reap();
      // SIGTERM was handled and discarded by the child, so the only signal that
      // could have ended it is the escalation.
      expect(child.signalCode).toBe("SIGKILL");
    },
    20_000,
  );

  it("ends a child that installed a SIGTERM handler, on every platform", async () => {
    const tracker = createChildTracker();
    const child = tracker.track(spawnUnkillableByTerm());
    const { pid } = child;
    await whenArmed(child);

    await tracker.reap();

    expect(isAlive(pid as number)).toBe(false);
    expect(child.signalCode).not.toBeNull();
  }, 20_000);

  it("is safe to reap twice and reaps nothing the second time", async () => {
    const tracker = createChildTracker();
    tracker.track(spawnUnkillableByTerm());
    await tracker.reap();
    await expect(tracker.reap()).resolves.toBeUndefined();
  }, 20_000);

  it("does not reap another tracker's children", async () => {
    const mine = createChildTracker();
    const theirs = createChildTracker();
    const ours = mine.track(spawnUnkillableByTerm());
    const other = theirs.track(spawnUnkillableByTerm());

    await mine.reap();

    expect(isAlive(ours.pid as number)).toBe(false);
    expect(isAlive(other.pid as number)).toBe(true);
    await theirs.reap();
  }, 20_000);
});
