import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { getManagedChildProcessCount } from "../../main/managed-child-processes.js";
import { backgroundShellManager as manager, BashTool } from "../shell-tools.js";

describe.skipIf(process.platform === "win32")("background shell descendant ownership", () => {
  let dir: string;
  let trackedBefore: number;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "lvis-background-descendants-")));
    trackedBefore = getManagedChildProcessCount();
  });

  afterEach(async () => {
    manager.disposeSession(dir);
    manager.disposeSession(`${dir}-other`);
    await cleanupTmpDir(dir);
  });

  async function start(parentExits: boolean, sessionId = dir, prefix = "", inheritOutput = false) {
    // The bounded child self-exits even if a regressed cleanup path leaks it.
    // Separate PID probes establish liveness even when pipes are redirected.
    const outputRedirect = inheritOutput ? "" : ">/dev/null 2>&1";
    const command = `sleep 8 ${outputRedirect} & printf '%s' "$!" > ${prefix}child.pid; ` +
      `printf '%s' "$$" > ${prefix}parent.pid; ` + (parentExits ? "exit 0" : "wait");
    const result = await new BashTool().execute(
      { command, run_in_background: true },
      { cwd: dir, extraAllowedDirectories: [], metadata: { sessionId } },
    );
    expect(result.isError).toBe(false);
    expect(result.metadata?.backgrounded).toBe(true);
    const shellId = JSON.parse(result.output).shellId as string;
    await vi.waitFor(() => {
      for (const name of ["child", "parent"]) {
        const file = join(dir, `${prefix}${name}.pid`);
        expect(existsSync(file)).toBe(true);
        const pid = Number(readFileSync(file, "utf8"));
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
      }
    });
    return {
      shellId,
      childPid: Number(readFileSync(join(dir, `${prefix}child.pid`), "utf8")),
      parentPid: Number(readFileSync(join(dir, `${prefix}parent.pid`), "utf8")),
    };
  }

  function expectGone(pid: number) {
    // Signal zero only probes the PID emitted by this test's own shell.
    expect(() => process.kill(pid, 0)).toThrow();
  }

  it.each(["kill", "dispose"] as const)("%s stops the owned descendant but leaves another session running", async (action) => {
    const owned = await start(false);
    const other = await start(false, `${dir}-other`, "other-");
    expect(process.kill(owned.childPid, 0)).toBe(true);
    expect(manager.kill(`${dir}-other`, owned.shellId)).toBeUndefined();

    if (action === "kill") expect(manager.kill(dir, owned.shellId)?.status).toBe("killed");
    else expect(manager.disposeSession(dir)).toBe(1);

    await vi.waitFor(() => {
      expectGone(owned.parentPid);
      expectGone(owned.childPid);
    });
    expect(process.kill(other.childPid, 0)).toBe(true);
    expect(manager.read(`${dir}-other`, other.shellId)?.status).toBe("running");
    manager.disposeSession(`${dir}-other`);
    await vi.waitFor(() => expectGone(other.childPid));
    expect(getManagedChildProcessCount()).toBe(trackedBefore);
  });

  it("cleans descendants retaining output pipes when the parent exits", async () => {
    const owned = await start(true, dir, "", true);
    await vi.waitFor(() => {
      expectGone(owned.parentPid);
      expectGone(owned.childPid);
      expect(manager.read(dir, owned.shellId)?.status).toBe("exited");
    });
    expect(getManagedChildProcessCount()).toBe(trackedBefore);
  });

  it.each(["kill", "dispose"] as const)("cleans descendants when the parent exits before %s", async (action) => {
    const owned = await start(true);
    await vi.waitFor(() => expect(manager.read(dir, owned.shellId)?.status).toBe("exited"));
    expectGone(owned.parentPid);
    await vi.waitFor(() => expectGone(owned.childPid));
    expect(getManagedChildProcessCount()).toBe(trackedBefore);

    const signal = vi.spyOn(process, "kill");
    try {
      if (action === "kill") manager.kill(dir, owned.shellId);
      else manager.disposeSession(dir);
      // A released handle cannot safely re-signal its old numeric process ID.
      expect(signal).not.toHaveBeenCalled();
    } finally {
      signal.mockRestore();
    }
  });
});
