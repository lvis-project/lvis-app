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
 *    session transcript and the audit log a headless run just produced. The
 *    exit code itself is applied by a `will-quit` handler with `app.exit()`,
 *    because Electron's `quit()` ends the process with 0 regardless of
 *    `process.exitCode`.
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
const windowSource = readFileSync(resolve(process.cwd(), "src/main/main-window.ts"), "utf-8")
  .replace(/\r\n/g, "\n");
const bootSource = readFileSync(resolve(process.cwd(), "src/boot.ts"), "utf-8")
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
    expect(mainSource).toContain("parseExecFlags(process.argv, launchCwd)");
  });

  it("captures the launch directory before the workspace anchor moves the process", () => {
    const capture = mainSource.indexOf("const launchCwd = execModeRequested(process.argv) ? process.cwd() : null;");
    const anchor = mainSource.indexOf("runEarlyBootEnv();");
    expect(capture).toBeGreaterThanOrEqual(0);
    expect(anchor).toBeGreaterThan(capture);
  });

  it("hands the runner the workspace project authorization the app uses everywhere", () => {
    expect(mainSource).toContain("isAuthorizedProjectRoot: isAuthorizedWorkspaceProjectRoot,");
    expect(mainSource).toContain("waitForRelease: waitForExecRelease,");
  });

  it("exits non-zero when bootstrap fails before the turn, keeping a more specific code", () => {
    expect(mainSource).toContain(
      "if (execRequest !== null && process.exitCode === undefined) {",
    );
    const guard = mainSource.indexOf("if (execRequest !== null && process.exitCode === undefined) {");
    const bootstrapFailed = mainSource.indexOf('"bootstrap failed"');
    expect(bootstrapFailed).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(bootstrapFailed);
    expect(mainSource.slice(guard, guard + 200)).toContain("process.exitCode = EXEC_FAILURE_EXIT_CODE;");
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

  it("drains the shutdown hooks before the guards that can return early", () => {
    // The hooks replaced a set of `prependOnceListener`s, which fired ahead of
    // this handler and on every quit — including one that arrives while boot is
    // still running, where `getServices()` is still null and the guards below
    // return without starting the ordered cleanup.
    const handler = mainSource.indexOf('app.on("before-quit"');
    expect(handler).toBeGreaterThanOrEqual(0);
    const body = mainSource.slice(handler, mainSource.indexOf("\n});", handler));
    const hooks = body.indexOf("runShutdownHooks()");
    const servicesGuard = body.indexOf("if (!getServices()");
    expect(hooks).toBeGreaterThanOrEqual(0);
    expect(servicesGuard).toBeGreaterThan(hooks);
  });

  it("carries the chosen exit code through will-quit, after before-quit cleanup", () => {
    const handler = mainSource.indexOf('app.on("will-quit"');
    expect(handler).toBeGreaterThanOrEqual(0);
    const body = mainSource.slice(handler, handler + 400);
    expect(body, "desktop launches keep Electron's own exit").toMatch(/execRequest === null/);
    expect(body, "a run that chose no code keeps Electron's own exit").toMatch(
      /typeof process\.exitCode !== "number"/,
    );
    expect(body, "the default quit must be replaced by the chosen code").toMatch(/event\.preventDefault\(\)/);
    expect(body).toMatch(/app\.exit\(process\.exitCode\)/);
  });

  it("exits the lock-held case hard, before whenReady, with the retry code", () => {
    const lock = mainSource.indexOf("if (!gotSingleInstanceLock) {");
    const block = mainSource.slice(lock, mainSource.indexOf("} else {", lock));
    expect(block).toContain("app.exit(EXEC_LOCKED_EXIT_CODE)");
    expect(block).not.toContain("process.exitCode = EXEC_LOCKED_EXIT_CODE");
  });

  it("rejects a malformed command line before a window exists", () => {
    const usageBranch = mainSource.indexOf('"error" in execRequest');
    const createWindow = mainSource.indexOf("createWindow({");
    expect(usageBranch).toBeGreaterThanOrEqual(0);
    expect(createWindow).toBeGreaterThan(usageBranch);
  });

  it("derives the launch mode once and hands the same fact to the window and to boot", () => {
    expect(mainSource).toContain(
      'const bootLaunch = execRequest === null ? "interactive" : "headless";',
    );
    expect(mainSource).toContain('createWindow({ headless: bootLaunch === "headless" });');
    // Both consumers read the derived const. Re-testing `execRequest` at
    // either site would let the window and the services disagree about which
    // kind of run this is.
    expect(mainSource).toContain(
      "bootstrap(projectRoot, getMainWindow(), () => getMainWindow(), bootLaunch)",
    );
  });

  it("reports a held single-instance lock instead of exiting silently", () => {
    const lockBranch = mainSource.match(/if \(!gotSingleInstanceLock\) \{[\s\S]*?\n\} else \{/);
    expect(lockBranch, "could not locate the single-instance branch").not.toBeNull();
    expect(lockBranch![0]).toContain("EXEC_LOCKED_EXIT_CODE");
    // Synchronous on purpose: the branch hard-exits right after, and
    // `process.stderr` is asynchronous on a macOS pipe.
    expect(lockBranch![0]).toMatch(/writeSync\(\s*2,/);
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

describe("main-window.ts — headless creation allocates no window", () => {
  it("returns before checking desktop assets or constructing a renderer", () => {
    const start = windowSource.indexOf("export function createWindow(");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = windowSource.slice(start);
    const guard = body.indexOf("if (options.headless) return;");
    const preload = body.indexOf("const preloadPath");
    const window = body.indexOf("new BrowserWindow(");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(preload).toBeGreaterThan(guard);
    expect(window).toBeGreaterThan(preload);
  });
});

describe("boot.ts — a headless run reports nobody at the desk", () => {
  /** Body of the `isDeskAttended` closure, so a match elsewhere cannot stand in. */
  function deskAttendedBody(): string {
    const start = bootSource.indexOf("isDeskAttended: () => {");
    expect(start, "isDeskAttended closure not found in boot.ts").toBeGreaterThan(-1);
    const end = bootSource.indexOf("\n      },", start);
    expect(end).toBeGreaterThan(start);
    return bootSource.slice(start, end);
  }

  it("answers no from the launch mode before consulting the window", () => {
    const body = deskAttendedBody();
    // Window visibility is a proxy that reports whatever the boot window
    // happens to be doing. It read `true` while a bootstrap splash was up, and
    // `second-instance` / `activate` can still reveal that window mid-run.
    expect(body.indexOf("if (headless) return false;")).toBeGreaterThan(-1);
    expect(body.indexOf("if (headless) return false;")).toBeLessThan(
      body.indexOf("getMainWindow()"),
    );
  });

  it("still asks the window when a launch has an operator", () => {
    // The guard must narrow the headless case only — an interactive launch
    // that drops to `false` would route every tier-3 escalation of a running
    // app into the deferred queue instead of asking the user.
    expect(deskAttendedBody()).toContain("win.isVisible() && !win.isMinimized()");
  });
});
