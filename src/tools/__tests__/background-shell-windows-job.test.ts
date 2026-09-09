import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { resolveWindowsJobLauncher } from "../../main/windows-job-launcher.js";
import { backgroundShellManager as manager, BashTool } from "../shell-tools.js";

const FIXTURE = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const mode = process.argv[2];
const role = mode === 'leaf' ? 'leaf' : 'root';
fs.writeFileSync(role + '.pid.tmp', String(process.pid));
fs.renameSync(role + '.pid.tmp', role + '.pid');
// Independent bounded cleanup lets a failing ownership test release its own
// descendants without signaling a potentially reused numeric process ID.
setTimeout(() => process.exit(0), 20000);
setInterval(() => { if (fs.existsSync('stop')) process.exit(0); }, 20);
if (role === 'root') {
  const child = spawn(process.execPath, [__filename, 'leaf'], { stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exit(1); });
  if (mode === 'root-exit') {
    const ready = setInterval(() => {
      if (fs.existsSync('leaf.pid')) { clearInterval(ready); process.exit(23); }
    }, 20);
  }
}
`;

describe.skipIf(process.platform !== "win32")("BashTool Windows background job ownership", () => {
  let dir: string;
  let nodeExecutable: string;

  beforeEach(() => {
    dir = "";
    // This suite requires the real native asset; missing build setup must fail.
    expect(existsSync(resolveWindowsJobLauncher())).toBe(true);
    const node = process.env.LVIS_TEST_NODE_EXEC_PATH;
    if (!node || !win32.isAbsolute(node) || !existsSync(node)) {
      throw new Error("Run this suite through test:vitest with a native Node executable");
    }
    nodeExecutable = node;
    dir = realpathSync(mkdtempSync(join(tmpdir(), "lvis background job ")));
    writeFileSync(join(dir, "child fixture.cjs"), FIXTURE);
  });

  function pidFor(role: "root" | "leaf"): number {
    const pid = Number(readFileSync(join(dir, `${role}.pid`), "utf8"));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    return pid;
  }

  function expectGone(pid: number): void {
    try {
      process.kill(pid, 0);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      return;
    }
    throw new Error(`Owned fixture process ${pid} is still alive`);
  }

  afterEach(async () => {
    if (!dir) return;
    manager.disposeSession(dir);
    // The fixture-owned stop file also handles a direct-spawn regression that
    // has already lost its parent before the manager receives disposal.
    writeFileSync(join(dir, "stop"), "stop");
    try {
      await vi.waitFor(() => {
        for (const role of ["root", "leaf"] as const) {
          if (existsSync(join(dir, `${role}.pid`))) expectGone(pidFor(role));
        }
      }, { timeout: 5000 });
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  async function start(mode: "wait" | "root-exit") {
    // Quote paths, not inline program text, so the shell cannot reinterpret
    // the fixture's JavaScript. Native drive paths with forward slashes are
    // understood by both the host path policy and the installed shell.
    const executable = shellQuote(nodeExecutable.replaceAll("\\", "/"));
    const fixture = shellQuote(join(dir, "child fixture.cjs").replaceAll("\\", "/"));
    const command = `${executable} ${fixture} ${shellQuote(mode)}; exit $?`;
    const result = await new BashTool().execute(
      { command, run_in_background: true },
      { cwd: dir, extraAllowedDirectories: [dirname(nodeExecutable)], metadata: { sessionId: dir } },
    );
    expect(result.isError, result.output).toBe(false);
    expect(result.metadata?.backgrounded).toBe(true);
    const shellId = JSON.parse(result.output).shellId as string;
    expect(typeof shellId).toBe("string");
    await vi.waitFor(() => {
      expect(existsSync(join(dir, "root.pid"))).toBe(true);
      expect(existsSync(join(dir, "leaf.pid"))).toBe(true);
      pidFor("root");
      pidFor("leaf");
    }, { timeout: 5000 });
    return { shellId, rootPid: pidFor("root"), leafPid: pidFor("leaf") };
  }

  it.each(["kill", "dispose"] as const)("%s ends the background shell's actual descendant", async (action) => {
    const owned = await start("wait");
    expect(process.kill(owned.leafPid, 0)).toBe(true);
    expect(manager.kill("another-session", owned.shellId)).toBeUndefined();
    expect(process.kill(owned.leafPid, 0)).toBe(true);

    if (action === "kill") expect(manager.kill(dir, owned.shellId)?.status).toBe("killed");
    else expect(manager.disposeSession(dir)).toBe(1);

    await vi.waitFor(() => {
      expectGone(owned.rootPid);
      expectGone(owned.leafPid);
    }, { timeout: 5000 });
  }, 15000);

  it("shell exit closes the job and its remaining descendant before manager disposal", async () => {
    const owned = await start("root-exit");
    await vi.waitFor(() => {
      expect(manager.read(dir, owned.shellId)).toMatchObject({ status: "exited", exitCode: 23 });
      expectGone(owned.rootPid);
      expectGone(owned.leafPid);
    }, { timeout: 5000 });
  }, 15000);
});
