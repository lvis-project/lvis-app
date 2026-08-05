/**
 * Regression guard — `child-process-gone` must not be logged at error level
 * while the app is shutting down.
 *
 * The failure mode is not a crash, it is a worn-out signal. Quitting produces a
 * handful of these events as helpers and utility processes are torn down, and
 * logging every one at error taught anyone reading the log that errors here are
 * routine. A real crash then arrives looking exactly like the noise.
 *
 * Asserted by source inspection rather than by running the handler, for the
 * same reason as the single-instance gate beside it: `src/main.ts` is the entry
 * point and registers Electron listeners at module load, so it cannot be
 * imported in a unit test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("main.ts — child-process-gone log level", () => {
  const source = readFileSync("src/main.ts", "utf-8").replace(/\r\n/g, "\n");

  /** The `app.on("child-process-gone", ...)` callback body. */
  function handlerBody(): string {
    const open = source.indexOf('app.on("child-process-gone"');
    expect(open, "child-process-gone handler not found").toBeGreaterThan(-1);
    // Balance braces from the callback's opening `{` so a later handler cannot
    // leak into the slice and satisfy an assertion about this one.
    const start = source.indexOf("{", open);
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error("unbalanced child-process-gone handler");
  }

  it("is guarded by the shutdown state before it logs", () => {
    const body = handlerBody();

    // Non-vacuous: the handler really does still log both ways, so the
    // assertions below are about which level is chosen and not about a handler
    // that stopped logging.
    expect(body).toMatch(/log\.info\(/);
    expect(body).toMatch(/log\.error\(/);

    expect(body).toMatch(/isAppShutdownStarted\(\)/);
    expect(body).toMatch(/isAppShutdownCompleted\(\)/);
  });

  it("takes the info path before the error path", () => {
    const body = handlerBody();
    const guard = body.search(/isAppShutdownStarted\(\)/);
    const info = body.search(/log\.info\(/);
    const error = body.search(/log\.error\(/);

    // Order is the property: the shutdown check has to precede the info call,
    // and the error call has to come after both, or the guard decides nothing.
    expect(guard).toBeGreaterThan(-1);
    expect(info).toBeGreaterThan(guard);
    expect(error).toBeGreaterThan(info);
  });

  it("still reports a crash outside shutdown at error level", () => {
    const body = handlerBody();
    // The error call must not itself sit inside the shutdown branch — the
    // branch returns, so anything after that return is the non-shutdown path.
    const ret = body.search(/\breturn;/);
    const error = body.search(/log\.error\(/);
    expect(ret).toBeGreaterThan(-1);
    expect(error).toBeGreaterThan(ret);
  });
});
