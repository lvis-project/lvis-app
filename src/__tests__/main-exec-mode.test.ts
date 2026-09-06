/**
 * Structural guards for the headless `--exec` wiring.
 *
 * `main.ts` registers Electron listeners and runs the early-boot environment at
 * module load, so it cannot be imported in a unit test; the branch it owns is
 * asserted by source inspection, the same way the single-instance gate is.
 *
 * Two properties are structural rather than behavioural:
 *
 *  - The branch must quit with `app.quit()`. `app.exit()` skips the `before-quit`
 *    handler, and that handler's `runAppShutdownCleanup` is what flushes the
 *    session transcript and the audit log a headless run just produced.
 *  - `logger.ts` must send its console output to stderr in exec mode. The logger
 *    is constructed from `process.argv` at import time and its console stream is
 *    module-private, so there is no runtime seam to observe; what can be
 *    asserted is that the decision is wired to the one predicate that makes it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mainSource = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf-8")
  .replace(/\r\n/g, "\n");
const loggerSource = readFileSync(resolve(process.cwd(), "src/lib/logger.ts"), "utf-8")
  .replace(/\r\n/g, "\n");

/** Body of the `if (execRequest !== null) { ... }` branch in `main()`. */
function extractExecBranch(text: string): string | null {
  const opener = text.match(/if\s*\(\s*execRequest\s*!==\s*null\s*\)\s*\{/);
  if (!opener || opener.index === undefined) return null;
  const start = opener.index + opener[0].length - 1;
  let depth = 1;
  let i = start + 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return depth === 0 ? text.slice(start + 1, i - 1) : null;
}

describe("main.ts — headless exec branch", () => {
  it("imports the runner from the unit-testable module", () => {
    expect(mainSource).toMatch(
      /import\s*\{[^}]*\brunExecTurn\b[^}]*\}\s*from\s*"\.\/main\/exec-mode\.js"/,
    );
    expect(mainSource).toContain("parseExecFlags(process.argv)");
  });

  it("runs after setServices and before the workspace is opened", () => {
    const setServices = mainSource.indexOf("setServices(services)");
    const execBranch = mainSource.indexOf("if (execRequest !== null)");
    const registerIpc = mainSource.indexOf("windowManager.registerIpc(");

    expect(setServices).toBeGreaterThanOrEqual(0);
    expect(execBranch).toBeGreaterThan(setServices);
    expect(registerIpc).toBeGreaterThan(execBranch);
  });

  it("quits through before-quit cleanup rather than exiting hard", () => {
    const branch = extractExecBranch(mainSource);
    expect(branch, "could not locate the exec branch").not.toBeNull();
    expect(branch!).toMatch(/app\.quit\s*\(\s*\)/);
    expect(branch!, "a hard exit would skip runAppShutdownCleanup").not.toMatch(/app\.exit\s*\(/);
    expect(branch!).toMatch(/process\.exitCode\s*=/);
  });

  it("keeps the plugin-smoke flag on its own path", () => {
    expect(mainSource).toContain("parsePluginSmokeFlag(process.argv)");
  });
});

describe("logger.ts — console destination in exec mode", () => {
  it("asks the exec predicate which descriptor it may use", () => {
    expect(loggerSource).toContain(
      'import { execModeRequested } from "../main/exec-mode.js"',
    );
    expect(loggerSource).toContain("execModeRequested(process.argv)");
  });

  it("sends both the JSON and the pretty console stream to stderr", () => {
    expect(loggerSource).toContain("execHeadless ? process.stderr : process.stdout");
    expect(loggerSource).toContain("destination: process.stderr");
  });
});
